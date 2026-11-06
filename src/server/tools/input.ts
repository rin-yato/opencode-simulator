import { findRows, readSnapshot } from "../accessibility"
import { pressButton, rotate, scroll, tapPoint, tapRow, tapSelector, typeText } from "../actions"
import { run } from "../exec"
import {
  bootedDevice,
  define,
  errorText,
  ok,
  partial,
  SHARE_SCHEMA,
  SIM_OPTIONS,
  UDID_SCHEMA,
  type SimulatorContext,
  type ToolEditor,
  type ToolRuntime,
} from "./context"

interface TapInput {
  readonly udid?: string
  readonly share?: boolean
  readonly id?: string
  readonly label?: string
  readonly value?: string
  readonly text?: string
  readonly elementType?: string
  readonly wait?: number
  readonly nth?: number
  readonly x?: number
  readonly y?: number
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

interface ScrollInput {
  readonly udid?: string
  readonly share?: boolean
  readonly direction: "up" | "down"
  readonly amount?: number
}

interface TypeInput {
  readonly udid?: string
  readonly share?: boolean
  readonly text: string
  readonly submit?: boolean
}

interface ButtonInput {
  readonly udid?: string
  readonly share?: boolean
  readonly button: "home" | "lock" | "side-button" | "siri" | "apple-pay"
  readonly duration?: number
}

interface RotateInput {
  readonly udid?: string
  readonly share?: boolean
  readonly orientation: "portrait" | "portrait_upside_down" | "landscape_left" | "landscape_right"
}

export function registerInputTools(editor: ToolEditor, simulator: SimulatorContext): void {
  editor.add({
    name: "tap",
    description:
      "Tap a control by text, label, id, or value; or tap x/y (normalized 0..1, or logical points from sim_ui). Prefer text or id. If text matches several visible controls, pass nth or a more specific selector. Off-screen targets fail; scroll first.",
    input: {
      type: "object",
      properties: {
        udid: UDID_SCHEMA,
        share: SHARE_SCHEMA,
        text: { type: "string", description: "Substring matched against label, id, or value." },
        id: { type: "string", description: "Exact AXUniqueId." },
        label: { type: "string", description: "Exact AXLabel." },
        value: { type: "string", description: "Exact AXValue." },
        elementType: { type: "string", description: "Narrow selectors, e.g. Button or TextField." },
        wait: {
          type: "number",
          minimum: 0,
          maximum: 30,
          description: "Seconds to wait for a selector or text target.",
        },
        nth: {
          type: "integer",
          minimum: 1,
          description: "Pick the Nth visible match when text is ambiguous (1-based).",
        },
        x: {
          type: "number",
          minimum: 0,
          description: "Normalized x 0..1, or logical points when either coordinate is >1.",
        },
        y: {
          type: "number",
          minimum: 0,
          description: "Normalized y 0..1, or logical points when either coordinate is >1.",
        },
      },
      additionalProperties: false,
    },
    options: SIM_OPTIONS,
    execute: define(async (input: TapInput, context: ToolRuntime) => {
      const device = await bootedDevice(simulator, context, input.udid, input.share)
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
        if (!snapshot.screen) throw new Error("Could not determine the simulator screen size.")
        const normalized = input.x <= 1 && input.y <= 1
        const x = Math.round(normalized ? input.x * snapshot.screen.width : input.x)
        const y = Math.round(normalized ? input.y * snapshot.screen.height : input.y)
        await tapPoint(device.udid, x, y, { ...simulator.hub, signal: context.signal })
        return ok(`tapped ${x},${y}`, { udid: device.udid, x, y })
      }

      if (input.text) {
        const text = input.text
        const deadline = Date.now() + (input.wait ?? 0) * 1_000
        const rowsFor = async () =>
          findRows((await readSnapshot(device.udid, { signal: context.signal })).rows, text)
        let rows = await rowsFor()
        while (rows.every((row) => !row.visible) && Date.now() < deadline) {
          await sleep(250)
          rows = await rowsFor()
        }
        if (rows.length === 0) {
          throw new Error(`No accessibility row matches ${JSON.stringify(input.text)}.`)
        }

        const visible = rows.filter((row) => row.visible)
        const interactive = visible.filter((row) => row.interactive)
        const candidates = interactive.length > 0 ? interactive : visible
        if (candidates.length === 0) {
          const direction = rows[0]?.direction ?? "off-screen"
          throw new Error(`"${input.text}" is ${direction} the fold; scroll first.`)
        }
        if (candidates.length > 1 && input.nth === undefined) {
          throw new Error(
            `${candidates.length} visible controls match ${JSON.stringify(input.text)}. Pass nth or a more specific id/label.`,
          )
        }
        const row = candidates[Math.max(0, (input.nth ?? 1) - 1)]
        if (!row) {
          throw new Error(
            `No visible match for ${JSON.stringify(input.text)} at nth=${input.nth ?? 1}.`,
          )
        }
        if (!row.visible)
          throw new Error(`"${input.text}" is ${row.direction} the fold; scroll first.`)
        const result = await tapRow(device.udid, row, {
          ...simulator.hub,
          signal: context.signal,
        })
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
          { ...simulator.hub, signal: context.signal },
        )
        return ok(result, { udid: device.udid })
      } catch (cause) {
        // AXe may be unavailable; resolve the selector through the tree and tap
        // the row's logical point instead.
        const snapshot = await readSnapshot(device.udid, { signal: context.signal })
        const row = snapshot.rows.find(
          (candidate) =>
            (input.id && candidate.uid === input.id) ||
            (input.label && candidate.label === input.label) ||
            (input.value && candidate.value === input.value),
        )
        if (!row || !row.visible) throw cause
        const result = await tapRow(device.udid, row, {
          ...simulator.hub,
          signal: context.signal,
        })
        return ok(result, {
          udid: device.udid,
          tap: row.tap,
          query: input.id ?? input.label ?? input.value ?? "",
        })
      }
    }),
  })

  editor.add({
    name: "scroll",
    description:
      "Scroll the foreground content up or down with a swipe. down reveals content below; up reveals content above. Re-read with sim_ui afterwards.",
    input: {
      type: "object",
      properties: {
        udid: UDID_SCHEMA,
        share: SHARE_SCHEMA,
        direction: {
          type: "string",
          enum: ["up", "down"],
          description: "down reveals content below.",
        },
        amount: {
          type: "integer",
          minimum: 1,
          maximum: 5,
          default: 1,
          description: "Number of swipes.",
        },
      },
      required: ["direction"],
      additionalProperties: false,
    },
    options: SIM_OPTIONS,
    execute: define(async (input: ScrollInput, context: ToolRuntime) => {
      const device = await bootedDevice(simulator, context, input.udid, input.share)
      const result = await scroll(device.udid, input.direction, input.amount ?? 1, {
        ...simulator.hub,
        signal: context.signal,
      })
      return ok(result, { udid: device.udid })
    }),
  })

  editor.add({
    name: "type",
    description:
      "Type text into the focused field. US keyboard characters only. Set submit=true to press Return afterwards.",
    input: {
      type: "object",
      properties: {
        udid: UDID_SCHEMA,
        share: SHARE_SCHEMA,
        text: { type: "string" },
        submit: { type: "boolean", default: false },
      },
      required: ["text"],
      additionalProperties: false,
    },
    options: SIM_OPTIONS,
    execute: define(async (input: TypeInput, context: ToolRuntime) => {
      const device = await bootedDevice(simulator, context, input.udid, input.share)
      await typeText(device.udid, input.text, { ...simulator.hub, signal: context.signal })
      let submitError = ""
      if (input.submit) {
        try {
          await run("axe", ["key", "40", "--udid", device.udid], {
            signal: context.signal,
            timeout: 10_000,
          })
        } catch (cause) {
          submitError = `submit failed: ${errorText(cause)}`
        }
      }
      const content = [
        `typed ${input.text.length} character(s)`,
        ...(input.submit ? [submitError || "pressed Return"] : []),
      ].join("\n")
      return submitError
        ? partial(content, { udid: device.udid })
        : ok(content, { udid: device.udid })
    }),
  })

  editor.add({
    name: "button",
    description: "Press a hardware button: home, lock, side-button, siri, or apple-pay.",
    input: {
      type: "object",
      properties: {
        udid: UDID_SCHEMA,
        share: SHARE_SCHEMA,
        button: { type: "string", enum: ["home", "lock", "side-button", "siri", "apple-pay"] },
        duration: {
          type: "number",
          minimum: 0,
          maximum: 10,
          description: "Hold duration in seconds.",
        },
      },
      required: ["button"],
      additionalProperties: false,
    },
    options: SIM_OPTIONS,
    execute: define(async (input: ButtonInput, context: ToolRuntime) => {
      const device = await bootedDevice(simulator, context, input.udid, input.share)
      await pressButton(device.udid, input.button, input.duration, {
        ...simulator.hub,
        signal: context.signal,
      })
      return ok(`pressed ${input.button}`, { udid: device.udid })
    }),
  })

  editor.add({
    name: "rotate",
    description:
      "Rotate the simulator to portrait, portrait_upside_down, landscape_left, or landscape_right. Requires the Simulator panel to be open so serve-sim is running.",
    input: {
      type: "object",
      properties: {
        udid: UDID_SCHEMA,
        share: SHARE_SCHEMA,
        orientation: {
          type: "string",
          enum: ["portrait", "portrait_upside_down", "landscape_left", "landscape_right"],
        },
      },
      required: ["orientation"],
      additionalProperties: false,
    },
    options: SIM_OPTIONS,
    execute: define(async (input: RotateInput, context: ToolRuntime) => {
      const device = await bootedDevice(simulator, context, input.udid, input.share)
      await rotate(device.udid, input.orientation, { ...simulator.hub, signal: context.signal })
      return ok(`rotated ${input.orientation}`, { udid: device.udid })
    }),
  })
}
