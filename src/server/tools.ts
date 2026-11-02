import { basename } from "node:path"
import { pathToFileURL } from "node:url"
import { Plugin } from "@opencode/plugin"
import { resolveDevice } from "./devices"
import { findRows, formatMatches, formatSnapshot, readSnapshot, resolveRow } from "./ax"
import {
  launchApp,
  pressButton,
  rotate,
  screenshot,
  scroll,
  tapPoint,
  tapRow,
  tapSelector,
  typeText,
} from "./actions"
import { run } from "./exec"
import { serveSimPort, type HubOptions } from "./serve-sim"

interface Common {
  readonly udid?: string
}

interface UiInput extends Common {
  readonly mode?: "visible" | "interactive" | "all"
  readonly max?: number
  readonly find?: string
}

interface TapInput extends Common {
  readonly id?: string
  readonly label?: string
  readonly value?: string
  readonly text?: string
  readonly elementType?: string
  readonly wait?: number
  readonly x?: number
  readonly y?: number
}

interface ScrollInput extends Common {
  readonly direction: "up" | "down"
  readonly amount?: number
}

interface TypeInput extends Common {
  readonly text: string
  readonly submit?: boolean
}

interface ButtonInput extends Common {
  readonly button: "home" | "lock" | "side-button" | "siri" | "apple-pay"
  readonly duration?: number
}

interface RotateInput extends Common {
  readonly orientation: "portrait" | "portrait_upside_down" | "landscape_left" | "landscape_right"
}

interface ScreenshotInput extends Common {
  readonly width?: number
  readonly format?: "jpeg" | "png"
}

interface WaitInput extends Common {
  readonly text: string
  readonly timeout?: number
  readonly interval?: number
}

interface LaunchInput extends Common {
  readonly bundleId: string
  readonly terminate?: boolean
  readonly args?: readonly string[]
}

const udid = {
  type: "string",
  description: "Simulator UDID or exact name. Defaults to the only booted simulator.",
} as const

const options = { namespace: "sim", codemode: true } as const

const errorText = (cause: unknown): string => {
  const message = cause instanceof Error ? cause.message : String(cause)
  return message.length > 2_000 ? `${message.slice(0, 2_000)}…` : message
}

const fail = (cause: unknown) => ({
  content: `ERROR: ${errorText(cause)}`,
  metadata: { ok: false },
})

const ok = (content: string, metadata: Record<string, unknown> = {}) => ({
  content,
  metadata: { ok: true, ...metadata },
})

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export async function registerTools(ctx: Plugin.Context, hub: HubOptions): Promise<void> {
  await ctx.tool.transform((editor) => {
    editor.namespace({
      name: "sim",
      description: "Inspect and control the local iOS Simulator.",
    })

    editor.add({
      name: "status",
      description:
        "Show the booted simulator, current app, screen size, AXe availability, and serve-sim port. Start here if a tap or read fails.",
      input: {
        type: "object",
        properties: { udid },
        additionalProperties: false,
      },
      options,
      execute: async (raw, context) => {
        try {
          const input = raw as Common
          const device = await resolveDevice(input.udid, { signal: context.signal })
          const snapshot = await readSnapshot(device.udid, { signal: context.signal })
          const port = serveSimPort(device.udid)
          let axeVersion = "missing"
          try {
            const version = await run("axe", ["--version"], { signal: context.signal, timeout: 5_000 })
            axeVersion = version.stdout.trim()
          } catch {}
          return ok(
            [
              `device=${device.name}`,
              `udid=${device.udid}`,
              `state=${device.state}`,
              `app=${snapshot.app || "-"}`,
              `screen=${snapshot.screen ? `${Math.round(snapshot.screen.width)}x${Math.round(snapshot.screen.height)}` : "unknown"}`,
              `axe=${axeVersion}`,
              `serve-sim=${port ? `http://127.0.0.1:${port}` : "not running"}`,
            ].join("\n"),
            { udid: device.udid, app: snapshot.app, port },
          )
        } catch (cause) {
          return fail(cause)
        }
      },
    })

    editor.add({
      name: "ui",
      description:
        "Read the current screen as a compact action table (typically under 1 KB). Each interactive row has a logical tap point. Use find for one control; use mode=interactive for the next action; screenshots only for visual questions.",
      input: {
        type: "object",
        properties: {
          udid,
          mode: {
            type: "string",
            enum: ["visible", "interactive", "all"],
            description: "visible = on-screen rows (default), interactive = all controls, all = debug dump.",
          },
          max: { type: "integer", minimum: 1, maximum: 200, default: 40 },
          find: { type: "string", description: "Case-insensitive substring of label, id, or value." },
        },
        additionalProperties: false,
      },
      options,
      execute: async (raw, context) => {
        try {
          const input = raw as UiInput
          const device = await resolveDevice(input.udid, { signal: context.signal })
          const snapshot = await readSnapshot(device.udid, {
            includeAll: input.mode === "all",
            signal: context.signal,
          })
          if (input.find) {
            return ok(formatMatches(snapshot.rows, input.find), { udid: device.udid, app: snapshot.app })
          }
          return ok(formatSnapshot(snapshot, input.mode ?? "visible", input.max ?? 40), {
            udid: device.udid,
            app: snapshot.app,
          })
        } catch (cause) {
          return fail(cause)
        }
      },
    })

    editor.add({
      name: "tap",
      description:
        "Tap a control by text, label, id, or value; or tap normalized x/y (0..1). Prefer text or id. Reads and resolves the accessibility tree when needed. Off-screen targets fail; scroll first.",
      input: {
        type: "object",
        properties: {
          udid,
          text: { type: "string", description: "Substring matched against label, id, or value." },
          id: { type: "string", description: "Exact AXUniqueId." },
          label: { type: "string", description: "Exact AXLabel." },
          value: { type: "string", description: "Exact AXValue." },
          elementType: { type: "string", description: "Narrow selectors, e.g. Button or TextField." },
          wait: { type: "number", minimum: 0, maximum: 30, description: "Seconds to wait for a selector target." },
          x: { type: "number", minimum: 0, maximum: 1, description: "Normalized x, 0..1." },
          y: { type: "number", minimum: 0, maximum: 1, description: "Normalized y, 0..1." },
        },
        additionalProperties: false,
      },
      options,
      execute: async (raw, context) => {
        try {
          const input = raw as TapInput
          const device = await resolveDevice(input.udid, { signal: context.signal })
          const point = input.x !== undefined || input.y !== undefined
          const selector = Boolean(input.id || input.label || input.value)
          const modes = [point, selector, Boolean(input.text)].filter(Boolean).length
          if (modes !== 1) {
            throw new Error("Use exactly one target: text, id/label/value, or x and y.")
          }

          if (point) {
            if (input.x === undefined || input.y === undefined) {
              throw new Error("Both x and y are required for a point tap.")
            }
            const snapshot = await readSnapshot(device.udid, { signal: context.signal })
            const screen = snapshot.screen
            if (!screen) throw new Error("Could not determine the simulator screen size.")
            const logicalX = Math.round(input.x * screen.width)
            const logicalY = Math.round(input.y * screen.height)
            await tapPoint(device.udid, logicalX, logicalY, { ...hub, signal: context.signal })
            return ok(`tapped ${logicalX},${logicalY}`, { udid: device.udid, x: logicalX, y: logicalY })
          }

          if (input.text) {
            const snapshot = await readSnapshot(device.udid, { signal: context.signal })
            const row = resolveRow(snapshot.rows, input.text)
            if (!row) throw new Error(`No accessibility row matches ${JSON.stringify(input.text)}.`)
            if (!row.visible) throw new Error(`"${input.text}" is ${row.direction} the fold; scroll first.`)
            const result = await tapRow(device.udid, row, { ...hub, signal: context.signal })
            return ok(result, { udid: device.udid, tap: row.tap })
          }

          try {
            const result = await tapSelector(
              device.udid,
              {
                id: input.id,
                label: input.label,
                value: input.value,
                elementType: input.elementType,
                wait: input.wait,
              },
              { ...hub, signal: context.signal },
            )
            return ok(result, { udid: device.udid })
          } catch (cause) {
            // AXe may be unavailable; resolve the selector through the tree and tap a point.
            const snapshot = await readSnapshot(device.udid, { signal: context.signal })
            const query = input.id ?? input.label ?? input.value ?? ""
            const row = snapshot.rows.find(
              (candidate) =>
                (input.id && candidate.uid === input.id) ||
                (input.label && candidate.label === input.label) ||
                (input.value && candidate.value === input.value),
            )
            if (!row || !row.visible) throw cause
            const result = await tapRow(device.udid, row, { ...hub, signal: context.signal })
            return ok(result, { udid: device.udid, tap: row.tap, query })
          }
        } catch (cause) {
          return fail(cause)
        }
      },
    })

    editor.add({
      name: "scroll",
      description:
        "Scroll the foreground content up or down with a swipe. down reveals content below; up reveals content above. Re-read with sim_ui afterwards.",
      input: {
        type: "object",
        properties: {
          udid,
          direction: { type: "string", enum: ["up", "down"], description: "down reveals content below." },
          amount: { type: "integer", minimum: 1, maximum: 5, default: 1, description: "Number of swipes." },
        },
        required: ["direction"],
        additionalProperties: false,
      },
      options,
      execute: async (raw, context) => {
        try {
          const input = raw as ScrollInput
          const device = await resolveDevice(input.udid, { signal: context.signal })
          const result = await scroll(device.udid, input.direction, input.amount ?? 1, {
            ...hub,
            signal: context.signal,
          })
          return ok(result, { udid: device.udid })
        } catch (cause) {
          return fail(cause)
        }
      },
    })

    editor.add({
      name: "type",
      description:
        "Type text into the focused field. US keyboard characters only. Set submit=true to press Return afterwards.",
      input: {
        type: "object",
        properties: {
          udid,
          text: { type: "string" },
          submit: { type: "boolean", default: false },
        },
        required: ["text"],
        additionalProperties: false,
      },
      options,
      execute: async (raw, context) => {
        try {
          const input = raw as TypeInput
          const device = await resolveDevice(input.udid, { signal: context.signal })
          await typeText(device.udid, input.text, { ...hub, signal: context.signal })
          if (input.submit) {
            await run("axe", ["key", "40", "--udid", device.udid], {
              signal: context.signal,
              timeout: 10_000,
            })
          }
          return ok(`typed ${input.text.length} character(s)${input.submit ? " and pressed Return" : ""}`, {
            udid: device.udid,
          })
        } catch (cause) {
          return fail(cause)
        }
      },
    })

    editor.add({
      name: "button",
      description: "Press a hardware button: home, lock, side-button, siri, or apple-pay.",
      input: {
        type: "object",
        properties: {
          udid,
          button: {
            type: "string",
            enum: ["home", "lock", "side-button", "siri", "apple-pay"],
          },
          duration: { type: "number", minimum: 0, maximum: 10, description: "Hold duration in seconds." },
        },
        required: ["button"],
        additionalProperties: false,
      },
      options,
      execute: async (raw, context) => {
        try {
          const input = raw as ButtonInput
          const device = await resolveDevice(input.udid, { signal: context.signal })
          await pressButton(device.udid, input.button, input.duration, {
            ...hub,
            signal: context.signal,
          })
          return ok(`pressed ${input.button}`, { udid: device.udid })
        } catch (cause) {
          return fail(cause)
        }
      },
    })

    editor.add({
      name: "rotate",
      description: "Rotate the simulator to portrait, portrait_upside_down, landscape_left, or landscape_right.",
      input: {
        type: "object",
        properties: {
          udid,
          orientation: {
            type: "string",
            enum: ["portrait", "portrait_upside_down", "landscape_left", "landscape_right"],
          },
        },
        required: ["orientation"],
        additionalProperties: false,
      },
      options,
      execute: async (raw, context) => {
        try {
          const input = raw as RotateInput
          const device = await resolveDevice(input.udid, { signal: context.signal })
          await rotate(device.udid, input.orientation, { ...hub, signal: context.signal })
          return ok(`rotated ${input.orientation}`, { udid: device.udid })
        } catch (cause) {
          return fail(cause)
        }
      },
    })

    editor.add({
      name: "screenshot",
      description:
        "Capture the simulator to a small JPEG (800px by default) and return it for visual inspection. Prefer sim_ui for text; screenshots cost image tokens.",
      input: {
        type: "object",
        properties: {
          udid,
          width: { type: "integer", minimum: 200, maximum: 2000, default: 800 },
          format: { type: "string", enum: ["jpeg", "png"], default: "jpeg" },
        },
        additionalProperties: false,
      },
      options,
      execute: async (raw, context) => {
        try {
          const input = raw as ScreenshotInput
          const device = await resolveDevice(input.udid, { signal: context.signal })
          const result = await screenshot(device.udid, {
            ...hub,
            signal: context.signal,
            width: input.width ?? 800,
            format: input.format ?? "jpeg",
          })
          return {
            content: [
              {
                type: "text" as const,
                text: `Screenshot ${result.width}x${result.height}: ${result.path}`,
              },
              {
                type: "file" as const,
                uri: pathToFileURL(result.path).href,
                mime: result.mime,
                name: basename(result.path),
              },
            ],
            metadata: {
              ok: true,
              udid: device.udid,
              path: result.path,
              width: result.width,
              height: result.height,
            },
          }
        } catch (cause) {
          return fail(cause)
        }
      },
    })

    editor.add({
      name: "wait",
      description:
        "Wait for text to appear on screen. Returns PASS with the matching row, or FAIL with whether it is off-screen. Use after a tap instead of sleeping.",
      input: {
        type: "object",
        properties: {
          udid,
          text: { type: "string", description: "Case-insensitive substring of label, id, or value." },
          timeout: { type: "number", minimum: 0.1, maximum: 60, default: 5 },
          interval: { type: "number", minimum: 0.1, maximum: 5, default: 0.3 },
        },
        required: ["text"],
        additionalProperties: false,
      },
      options,
      execute: async (raw, context) => {
        try {
          const input = raw as WaitInput
          const device = await resolveDevice(input.udid, { signal: context.signal })
          const deadline = Date.now() + (input.timeout ?? 5) * 1_000
          const interval = (input.interval ?? 0.3) * 1_000
          let last = ""
          while (true) {
            const snapshot = await readSnapshot(device.udid, { signal: context.signal })
            const row = findRows(snapshot.rows, input.text)[0]
            if (row?.visible) {
              return ok(
                `PASS ${row.kind} ${JSON.stringify(row.label || row.uid || row.value)} tap=${row.tap || "-"}`,
                { udid: device.udid, seconds: ((Date.now() - (deadline - (input.timeout ?? 5) * 1_000)) / 1000).toFixed(2) },
              )
            }
            if (row) {
              last = `present but ${row.direction} the fold; scroll first`
            }
            if (Date.now() >= deadline) break
            await sleep(interval)
          }
          return ok(`FAIL ${JSON.stringify(input.text)}${last ? ` (${last})` : " not found"}`, {
            udid: device.udid,
            pass: false,
          })
        } catch (cause) {
          return fail(cause)
        }
      },
    })

    editor.add({
      name: "launch",
      description: "Terminate and relaunch an app by bundle id on the simulator.",
      input: {
        type: "object",
        properties: {
          udid,
          bundleId: { type: "string", description: "Bundle identifier, e.g. com.melis.app." },
          terminate: { type: "boolean", default: true },
          args: { type: "array", items: { type: "string" }, description: "Launch arguments." },
        },
        required: ["bundleId"],
        additionalProperties: false,
      },
      options,
      execute: async (raw, context) => {
        try {
          const input = raw as LaunchInput
          const device = await resolveDevice(input.udid, { signal: context.signal })
          const result = await launchApp(device.udid, input.bundleId, {
            ...hub,
            signal: context.signal,
            terminate: input.terminate,
            args: input.args,
          })
          return ok(result, { udid: device.udid, bundleId: input.bundleId })
        } catch (cause) {
          return fail(cause)
        }
      },
    })
  })
}
