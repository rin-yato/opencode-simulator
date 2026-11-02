import {
  readSetting,
  readSettings,
  setSetting,
  softwareKeyboard,
  statusBar,
  UI_SETTINGS,
  type KeyboardState,
  type StatusBarInput,
  type UiSetting,
} from "../ui-settings"
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

interface SettingsInput {
  readonly udid?: string
  readonly setting?: UiSetting
  readonly value?: string
}

interface KeyboardInput {
  readonly udid?: string
  readonly state?: KeyboardState
}

interface StatusBarToolInput extends StatusBarInput {
  readonly udid?: string
}

export function registerSettingsTools(editor: ToolEditor, simulator: SimulatorContext): void {
  editor.add({
    name: "settings",
    description:
      "Read or change simulator-wide UI settings: appearance, text-size, reduce-motion, increase-contrast, reduce-transparency, color-filter, show-borders, voiceover, hardware-keyboard, liquid-glass. Call with no setting to list everything; with setting only to read one; with setting and value to change it.",
    input: {
      type: "object",
      properties: {
        udid: UDID_SCHEMA,
        setting: {
          type: "string",
          enum: [...UI_SETTINGS],
          description: "Setting to read or change. Omit to list all settings.",
        },
        value: {
          type: "string",
          description:
            "New value. Examples: dark, light, large, extra-large, on, off, grayscale, tinted. Omit to read the current value.",
        },
      },
      additionalProperties: false,
    },
    options: SIM_OPTIONS,
    execute: define(async (input: SettingsInput, context: ToolRuntime) => {
      const device = await currentDevice(simulator, context, input.udid)
      if (!input.setting) {
        const output = await readSettings(device.udid, {
          ...simulator.hub,
          signal: context.signal,
        })
        return ok(output, { udid: device.udid })
      }
      if (input.value === undefined) {
        const output = await readSetting(device.udid, input.setting, {
          ...simulator.hub,
          signal: context.signal,
        })
        return ok(output, { udid: device.udid, setting: input.setting })
      }
      const output = await setSetting(device.udid, input.setting, input.value, {
        ...simulator.hub,
        signal: context.signal,
      })
      return ok(output, { udid: device.udid, setting: input.setting, value: input.value })
    }),
  })

  editor.add({
    name: "keyboard",
    description:
      "Show, hide, or toggle the on-screen software keyboard. Requires the Simulator panel to be open so serve-sim is running. Focus a text field first with sim_tap.",
    input: {
      type: "object",
      properties: {
        udid: UDID_SCHEMA,
        state: {
          type: "string",
          enum: ["show", "hide", "toggle"],
          default: "toggle",
          description: "show and hide are idempotent; toggle flips the current state.",
        },
      },
      additionalProperties: false,
    },
    options: SIM_OPTIONS,
    execute: define(async (input: KeyboardInput, context: ToolRuntime) => {
      const device = await currentDevice(simulator, context, input.udid)
      const state = input.state ?? "toggle"
      const output = await softwareKeyboard(device.udid, state, {
        ...simulator.hub,
        signal: context.signal,
      })
      return ok(output, { udid: device.udid, state })
    }),
  })

  editor.add({
    name: "statusbar",
    description:
      "Override the simulator status bar for deterministic screenshots: time, battery, wifi/cellular bars, carrier. Call with no values to list current overrides, or clear: true to remove them.",
    input: {
      type: "object",
      properties: {
        udid: UDID_SCHEMA,
        clear: { type: "boolean", description: "Remove all status bar overrides." },
        time: { type: "string", description: 'Fixed time, e.g. "9:41".' },
        batteryState: { type: "string", enum: ["charging", "charged", "discharging"] },
        batteryLevel: { type: "integer", minimum: 0, maximum: 100 },
        wifiBars: { type: "integer", minimum: 0, maximum: 3 },
        cellularBars: { type: "integer", minimum: 0, maximum: 4 },
        dataNetwork: {
          type: "string",
          enum: [
            "hide",
            "wifi",
            "3g",
            "4g",
            "lte",
            "lte-a",
            "lte+",
            "5g",
            "5g+",
            "5g-uwb",
            "5g-uc",
          ],
        },
        operatorName: { type: "string", description: "Carrier name; empty string clears it." },
      },
      additionalProperties: false,
    },
    options: SIM_OPTIONS,
    execute: define(async (input: StatusBarToolInput, context: ToolRuntime) => {
      const device = await currentDevice(simulator, context, input.udid)
      const output = await statusBar(device.udid, input, { signal: context.signal })
      return ok(output, { udid: device.udid })
    }),
  })
}
