import { readSnapshot } from "./accessibility"
import { run } from "./exec"
import { serveSimPort, serveSimSoftwareKeyboard, serveSimUi, type HubOptions } from "./serve-sim"

export const UI_SETTINGS = [
  "appearance",
  "liquid-glass",
  "text-size",
  "reduce-motion",
  "increase-contrast",
  "reduce-transparency",
  "color-filter",
  "show-borders",
  "voiceover",
  "hardware-keyboard",
] as const

export type UiSetting = (typeof UI_SETTINGS)[number]

export type KeyboardState = "show" | "hide" | "toggle"

export interface StatusBarInput {
  readonly clear?: boolean
  readonly time?: string
  readonly batteryState?: "charging" | "charged" | "discharging"
  readonly batteryLevel?: number
  readonly wifiBars?: number
  readonly cellularBars?: number
  readonly dataNetwork?: string
  readonly operatorName?: string
}

interface SettingOptions extends HubOptions {
  readonly signal?: AbortSignal
}

export async function readSettings(udid: string, options: SettingOptions = {}): Promise<string> {
  const raw = await serveSimUi(udid, ["status", "--json"], options)
  const parsed = JSON.parse(raw) as Record<string, string>
  return Object.entries(parsed)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")
}

export async function readSetting(
  udid: string,
  setting: UiSetting,
  options: SettingOptions = {},
): Promise<string> {
  const value = await serveSimUi(udid, [setting], options)
  return `${setting}=${value}`
}

export async function setSetting(
  udid: string,
  setting: UiSetting,
  value: string,
  options: SettingOptions = {},
): Promise<string> {
  await serveSimUi(udid, [setting, value], options)
  return `set ${setting}=${value}`
}

async function keyboardVisible(udid: string, signal?: AbortSignal): Promise<boolean> {
  const snapshot = await readSnapshot(udid, { signal })
  return snapshot.rows.some(
    (row) =>
      row.visible &&
      (row.uid === "shift" ||
        row.uid === "delete" ||
        row.uid === "emoji" ||
        /^(shift|delete|emoji)$/i.test(row.label)),
  )
}

export async function softwareKeyboard(
  udid: string,
  state: KeyboardState,
  options: SettingOptions = {},
): Promise<string> {
  if (!serveSimPort(udid)) {
    throw new Error("serve-sim is not running for this simulator. Open the Simulator panel first.")
  }

  const visible = await keyboardVisible(udid, options.signal)
  if (state === "toggle") {
    await serveSimSoftwareKeyboard(udid, options)
    return `software keyboard ${visible ? "hidden" : "shown"}`
  }

  const wanted = state === "show"
  if (visible === wanted) return `software keyboard already ${wanted ? "shown" : "hidden"}`
  await serveSimSoftwareKeyboard(udid, options)
  return `software keyboard ${wanted ? "shown" : "hidden"}`
}

export async function statusBar(
  udid: string,
  input: StatusBarInput,
  options: { signal?: AbortSignal } = {},
): Promise<string> {
  if (input.clear) {
    await run("xcrun", ["simctl", "status_bar", udid, "clear"], {
      signal: options.signal,
      timeout: 15_000,
    })
    return "cleared status bar overrides"
  }

  const flags: string[] = []
  const add = (flag: string, value: string | number | undefined) => {
    if (value === undefined) return
    flags.push(flag, String(value))
  }
  add("--time", input.time)
  add("--batteryState", input.batteryState)
  add("--batteryLevel", input.batteryLevel)
  add("--wifiBars", input.wifiBars)
  add("--cellularBars", input.cellularBars)
  add("--dataNetwork", input.dataNetwork)
  add("--operatorName", input.operatorName)

  if (!flags.length) {
    const result = await run("xcrun", ["simctl", "status_bar", udid, "list"], {
      signal: options.signal,
      timeout: 15_000,
    })
    const lines = result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("=") && line !== "Current Status Bar Overrides:")
    return lines.length ? lines.join("\n") : "no status bar overrides"
  }

  await run("xcrun", ["simctl", "status_bar", udid, "override", ...flags], {
    signal: options.signal,
    timeout: 15_000,
  })
  return `overrode status bar: ${flags.join(" ")}`
}
