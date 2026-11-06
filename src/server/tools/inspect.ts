import { basename } from "node:path"
import { pathToFileURL } from "node:url"
import {
  findRows,
  formatMatches,
  formatSnapshot,
  readSnapshot,
  type UiSnapshot,
} from "../accessibility"
import { run } from "../exec"
import { serveSimPort } from "../serve-sim"
import { screenshot } from "../screenshot"
import {
  bootedDevice,
  currentDevice,
  define,
  ok,
  SHARE_SCHEMA,
  SIM_OPTIONS,
  UDID_SCHEMA,
  type SimulatorContext,
  type ToolEditor,
  type ToolRuntime,
} from "./context"

interface StatusInput {
  readonly udid?: string
  readonly share?: boolean
}

interface UiInput {
  readonly udid?: string
  readonly share?: boolean
  readonly mode?: "visible" | "interactive" | "all"
  readonly max?: number
  readonly find?: string
}

interface WaitInput {
  readonly udid?: string
  readonly share?: boolean
  readonly text: string
  readonly timeout?: number
  readonly interval?: number
}

interface ScreenshotInput {
  readonly udid?: string
  readonly share?: boolean
  readonly width?: number
  readonly format?: "jpeg" | "png"
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export function registerInspectionTools(editor: ToolEditor, simulator: SimulatorContext): void {
  editor.add({
    name: "status",
    description:
      "Show the booted simulator, owner/managed state, current app, screen size, AXe availability, serve-sim port, panel state, release state, and whether the agent session is running. Start here if a tap or read fails.",
    input: {
      type: "object",
      properties: { udid: UDID_SCHEMA, share: SHARE_SCHEMA },
      additionalProperties: false,
    },
    options: SIM_OPTIONS,
    execute: define(async (input: StatusInput, context: ToolRuntime) => {
      const device = await currentDevice(simulator, context, input.udid, input.share)
      let snapshot: UiSnapshot | undefined
      let snapshotError = ""
      try {
        snapshot = await readSnapshot(device.udid, { signal: context.signal })
      } catch (cause) {
        // A freshly booted device can reject the AX read for a moment; the rest
        // of the status is still useful.
        snapshotError =
          (cause instanceof Error ? cause.message : String(cause)).split("\n")[0] ?? ""
      }

      const port = serveSimPort(device.udid)
      let axeVersion = "missing"
      try {
        const version = await run("axe", ["--version"], { signal: context.signal, timeout: 5_000 })
        axeVersion = version.stdout.trim()
      } catch {}

      const screen = snapshot?.screen
        ? `${Math.round(snapshot.screen.width)}x${Math.round(snapshot.screen.height)}`
        : "unknown"
      const panel = simulator.pool.panelState(context.sessionID)
      const panelDevice = simulator.pool.panelDevice(context.sessionID)
      const running = simulator.pool.isRunning(context.sessionID)
      const release = simulator.pool.releaseState(context.sessionID)
      const managed = simulator.pool.isManaged(device.udid)
      return ok(
        [
          `device=${device.name}`,
          `udid=${device.udid}`,
          `state=${device.state}`,
          `managed=${managed ? "yes" : "no"}`,
          `panel=${panel}`,
          ...(panelDevice && panelDevice !== device.udid ? [`panel-device=${panelDevice}`] : []),
          `release=${release}`,
          `session=${running ? "running" : "idle"}`,
          `app=${snapshot?.app || "-"}`,
          `screen=${screen}`,
          `axe=${axeVersion}${snapshotError ? ` (UI read failed: ${snapshotError})` : ""}`,
          `serve-sim=${port ? `http://127.0.0.1:${port}` : "not running"}`,
        ].join("\n"),
        {
          udid: device.udid,
          app: snapshot?.app,
          port,
          panel,
          panelDevice,
          running,
          release,
          managed,
        },
      )
    }),
  })

  editor.add({
    name: "ui",
    description:
      "Read the current screen as a compact action table. Each interactive row has a logical tap point that sim_tap accepts. Use find for one control; use mode=interactive for the next action; screenshots only for visual questions.",
    input: {
      type: "object",
      properties: {
        udid: UDID_SCHEMA,
        share: SHARE_SCHEMA,
        mode: {
          type: "string",
          enum: ["visible", "interactive", "all"],
          description:
            "visible = on-screen rows (default), interactive = all controls, all = debug dump.",
        },
        max: { type: "integer", minimum: 1, maximum: 200, default: 40 },
        find: { type: "string", description: "Case-insensitive substring of label, id, or value." },
      },
      additionalProperties: false,
    },
    options: SIM_OPTIONS,
    execute: define(async (input: UiInput, context: ToolRuntime) => {
      const device = await bootedDevice(simulator, context, input.udid, input.share)
      const snapshot = await readSnapshot(device.udid, {
        includeAll: input.mode === "all",
        signal: context.signal,
      })
      if (input.find) {
        return ok(formatMatches(snapshot.rows, input.find), {
          udid: device.udid,
          app: snapshot.app,
        })
      }
      return ok(formatSnapshot(snapshot, input.mode ?? "visible", input.max ?? 40), {
        udid: device.udid,
        app: snapshot.app,
      })
    }),
  })

  editor.add({
    name: "wait",
    description:
      "Wait for text to appear on screen. Returns PASS with the matching row, or FAIL with whether it is off-screen. Use after a tap instead of sleeping.",
    input: {
      type: "object",
      properties: {
        udid: UDID_SCHEMA,
        share: SHARE_SCHEMA,
        text: { type: "string", description: "Case-insensitive substring of label, id, or value." },
        timeout: { type: "number", minimum: 0.1, maximum: 60, default: 5 },
        interval: { type: "number", minimum: 0.1, maximum: 5, default: 0.3 },
      },
      required: ["text"],
      additionalProperties: false,
    },
    options: SIM_OPTIONS,
    execute: define(async (input: WaitInput, context: ToolRuntime) => {
      const device = await bootedDevice(simulator, context, input.udid, input.share)
      const started = Date.now()
      const timeout = (input.timeout ?? 5) * 1_000
      const interval = (input.interval ?? 0.3) * 1_000
      const deadline = started + timeout
      let last = ""

      while (true) {
        const snapshot = await readSnapshot(device.udid, { signal: context.signal })
        const row = findRows(snapshot.rows, input.text)[0]
        if (row?.visible) {
          const label = JSON.stringify(row.label || row.uid || row.value)
          return ok(`PASS ${row.kind} ${label} tap=${row.tap || "-"}`, {
            udid: device.udid,
            seconds: ((Date.now() - started) / 1_000).toFixed(2),
          })
        }
        if (row) last = `present but ${row.direction} the fold; scroll first`
        if (Date.now() >= deadline) break
        await sleep(interval)
      }
      return {
        content: `FAIL ${JSON.stringify(input.text)}${last ? ` (${last})` : " not found"}`,
        metadata: { ok: false, status: "timeout", pass: false, udid: device.udid },
      }
    }),
  })

  editor.add({
    name: "screenshot",
    description:
      "Capture the simulator to a small JPEG (800px by default) and return it for visual inspection. Prefer sim_ui for text; screenshots cost image tokens.",
    input: {
      type: "object",
      properties: {
        udid: UDID_SCHEMA,
        share: SHARE_SCHEMA,
        width: { type: "integer", minimum: 200, maximum: 2000, default: 800 },
        format: { type: "string", enum: ["jpeg", "png"], default: "jpeg" },
      },
      additionalProperties: false,
    },
    options: SIM_OPTIONS,
    execute: define(async (input: ScreenshotInput, context: ToolRuntime) => {
      const device = await bootedDevice(simulator, context, input.udid, input.share)
      const result = await screenshot(device.udid, {
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
    }),
  })
}
