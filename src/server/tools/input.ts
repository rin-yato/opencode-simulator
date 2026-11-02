import { readSnapshot, resolveRow } from "../accessibility"
import { pressButton, rotate, scroll, tapPoint, tapRow, tapSelector, typeText } from "../actions"
import { run } from "../exec"
import {
  currentDevice,
  define,
  ok,
  SIM_OPTIONS,
  UDID_SCHEMA,
  type SimulatorContext,
  type ToolEditor,
  type ToolRuntime,
} from "./context"

interface TapInput {
  readonly udid?: string
  readonly id?: string
  readonly label?: string
  readonly value?: string
  readonly text?: string
  readonly elementType?: string
  readonly wait?: number
  readonly x?: number
  readonly y?: number
}

interface ScrollInput {
  readonly udid?: string
  readonly direction: "up" | "down"
  readonly amount?: number
}

interface TypeInput {
  readonly udid?: string
  readonly text: string
  readonly submit?: boolean
}

interface ButtonInput {
  readonly udid?: string
  readonly button: "home" | "lock" | "side-button" | "siri" | "apple-pay"
  readonly duration?: number
}

interface RotateInput {
  readonly udid?: string
  readonly orientation: "portrait" | "portrait_upside_down" | "landscape_left" | "landscape_right"
}

export function registerInputTools(editor: ToolEditor, simulator: SimulatorContext): void {
  editor.add({
    name: "tap",
    description:
      "Tap a control by text, label, id, or value; or tap normalized x/y (0..1). Prefer text or id. Reads and resolves the accessibility tree when needed. Off-screen targets fail; scroll first.",
    input: {
      type: "object",
      properties: {
        udid: UDID_SCHEMA,
        text: { type: "string", description: "Substring matched against label, id, or value." },
        id: { type: "string", description: "Exact AXUniqueId." },
        label: { type: "string", description: "Exact AXLabel." },
        value: { type: "string", description: "Exact AXValue." },
        elementType: { type: "string", description: "Narrow selectors, e.g. Button or TextField." },
        wait: {
          type: "number",
          minimum: 0,
          maximum: 30,
          description: "Seconds to wait for a selector target.",
        },
        x: { type: "number", minimum: 0, maximum: 1, description: "Normalized x, 0..1." },
        y: { type: "number", minimum: 0, maximum: 1, description: "Normalized y, 0..1." },
      },
      additionalProperties: false,
    },
    options: SIM_OPTIONS,
    execute: define(async (input: TapInput, context: ToolRuntime) => {
      const device = await currentDevice(simulator, context, input.udid)
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
        const x = Math.round(input.x * snapshot.screen.width)
        const y = Math.round(input.y * snapshot.screen.height)
        await tapPoint(device.udid, x, y, { ...simulator.hub, signal: context.signal })
        return ok(`tapped ${x},${y}`, { udid: device.udid, x, y })
      }

      if (input.text) {
        const snapshot = await readSnapshot(device.udid, { signal: context.signal })
        const row = resolveRow(snapshot.rows, input.text)
        if (!row) throw new Error(`No accessibility row matches ${JSON.stringify(input.text)}.`)
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
      const device = await currentDevice(simulator, context, input.udid)
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
        text: { type: "string" },
        submit: { type: "boolean", default: false },
      },
      required: ["text"],
      additionalProperties: false,
    },
    options: SIM_OPTIONS,
    execute: define(async (input: TypeInput, context: ToolRuntime) => {
      const device = await currentDevice(simulator, context, input.udid)
      await typeText(device.udid, input.text, { ...simulator.hub, signal: context.signal })
      if (input.submit) {
        await run("axe", ["key", "40", "--udid", device.udid], {
          signal: context.signal,
          timeout: 10_000,
        })
      }
      return ok(
        `typed ${input.text.length} character(s)${input.submit ? " and pressed Return" : ""}`,
        { udid: device.udid },
      )
    }),
  })

  editor.add({
    name: "button",
    description: "Press a hardware button: home, lock, side-button, siri, or apple-pay.",
    input: {
      type: "object",
      properties: {
        udid: UDID_SCHEMA,
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
      const device = await currentDevice(simulator, context, input.udid)
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
      "Rotate the simulator to portrait, portrait_upside_down, landscape_left, or landscape_right.",
    input: {
      type: "object",
      properties: {
        udid: UDID_SCHEMA,
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
      const device = await currentDevice(simulator, context, input.udid)
      await rotate(device.udid, input.orientation, { ...simulator.hub, signal: context.signal })
      return ok(`rotated ${input.orientation}`, { udid: device.udid })
    }),
  })
}
