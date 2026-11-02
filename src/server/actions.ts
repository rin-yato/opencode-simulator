import { mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { run, runWithInput } from "./exec"
import { readSnapshot, type UiRow } from "./ax"
import {
  serveSimButton,
  serveSimRotate,
  serveSimSwipe,
  serveSimTap,
  serveSimType,
  type HubOptions,
} from "./serve-sim"

export interface ActionOptions extends HubOptions {
  readonly signal?: AbortSignal
}

export async function tapPoint(
  udid: string,
  x: number,
  y: number,
  options: ActionOptions = {},
): Promise<void> {
  let primaryError: unknown
  try {
    await run("axe", ["tap", "-x", String(x), "-y", String(y), "--udid", udid], {
      signal: options.signal,
      timeout: 15_000,
    })
    return
  } catch (cause) {
    primaryError = cause
  }
  try {
    const screen = await screenSize(udid, options.signal)
    await serveSimTap(udid, x / screen.width, y / screen.height, options)
  } catch {
    throw primaryError instanceof Error ? primaryError : new Error(String(primaryError))
  }
}

export async function tapSelector(
  udid: string,
  selector: { id?: string; label?: string; value?: string; elementType?: string; wait?: number },
  options: ActionOptions = {},
): Promise<string> {
  const args = ["tap"]
  if (selector.id) args.push("--id", selector.id)
  else if (selector.label) args.push("--label", selector.label)
  else if (selector.value) args.push("--value", selector.value)
  if (selector.elementType) args.push("--element-type", selector.elementType)
  if (selector.wait && selector.wait > 0) args.push("--wait-timeout", String(selector.wait))
  args.push("--udid", udid)
  await run("axe", args, { signal: options.signal, timeout: 15_000 + (selector.wait ?? 0) * 1000 })
  const target = selector.id ?? selector.label ?? selector.value ?? "element"
  return `tapped ${target}`
}

export async function tapRow(
  udid: string,
  row: UiRow,
  options: ActionOptions = {},
): Promise<string> {
  const point = row.tap.split(",").map(Number)
  const x = point[0]
  const y = point[1]
  if (x === undefined || y === undefined || !Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error(`Row "${row.label || row.uid || row.kind}" has no tap point. It may be off-screen.`)
  }
  await tapPoint(udid, x, y, options)
  return `tapped ${row.kind} ${row.label || row.uid || row.value || ""} at ${x},${y}`
}

export async function screenSize(
  udid: string,
  signal?: AbortSignal,
): Promise<{ width: number; height: number }> {
  const snapshot = await readSnapshot(udid, { signal })
  if (!snapshot.screen) {
    throw new Error("Could not determine the simulator screen size from the accessibility tree.")
  }
  return snapshot.screen
}

export async function swipe(
  udid: string,
  start: { x: number; y: number },
  end: { x: number; y: number },
  options: ActionOptions = {},
): Promise<void> {
  let primaryError: unknown
  try {
    await run(
      "axe",
      [
        "swipe",
        "--start-x",
        String(start.x),
        "--start-y",
        String(start.y),
        "--end-x",
        String(end.x),
        "--end-y",
        String(end.y),
        "--duration",
        "0.5",
        "--udid",
        udid,
      ],
      { signal: options.signal, timeout: 15_000 },
    )
    return
  } catch (cause) {
    primaryError = cause
  }
  try {
    const screen = await screenSize(udid, options.signal)
    await serveSimSwipe(
      udid,
      { x: start.x / screen.width, y: start.y / screen.height },
      { x: end.x / screen.width, y: end.y / screen.height },
      options,
    )
  } catch {
    throw primaryError instanceof Error ? primaryError : new Error(String(primaryError))
  }
}

export async function scroll(
  udid: string,
  direction: "up" | "down",
  amount: number,
  options: ActionOptions = {},
): Promise<string> {
  const screen = await screenSize(udid, options.signal)
  const x = Math.round(screen.width / 2)
  const high = Math.round(screen.height * 0.72)
  const low = Math.round(screen.height * 0.28)
  const start = direction === "down" ? high : low
  const end = direction === "down" ? low : high
  for (let index = 0; index < amount; index += 1) {
    await swipe(udid, { x, y: start }, { x, y: end }, options)
  }
  return `scrolled ${direction} ${amount}x`
}

export async function typeText(
  udid: string,
  text: string,
  options: ActionOptions = {},
): Promise<void> {
  let primaryError: unknown
  try {
    await runWithInput("axe", ["type", "--stdin", "--udid", udid], text, {
      signal: options.signal,
      timeout: 30_000,
    })
    return
  } catch (cause) {
    primaryError = cause
  }
  try {
    await serveSimType(udid, text, options)
  } catch {
    throw primaryError instanceof Error ? primaryError : new Error(String(primaryError))
  }
}

export async function pressButton(
  udid: string,
  button: string,
  duration: number | undefined,
  options: ActionOptions = {},
): Promise<void> {
  // serve-sim's HID path reaches SpringBoard without focusing the Simulator.
  try {
    await serveSimButton(udid, button, options)
    return
  } catch {}

  // AXe's hardware button path only lands when Simulator.app is frontmost;
  // otherwise it exits 0 and does nothing.
  await run("open", ["-a", "Simulator"], { signal: options.signal, timeout: 10_000 }).catch(() => {})
  await new Promise((resolve) => setTimeout(resolve, 400))

  const args = ["button", button]
  if (duration && duration > 0) args.push("--duration", String(duration))
  args.push("--udid", udid)
  await run("axe", args, { signal: options.signal, timeout: 15_000 })
}

export async function rotate(
  udid: string,
  orientation: string,
  options: ActionOptions = {},
): Promise<void> {
  await serveSimRotate(udid, orientation, options)
}

export interface Screenshot {
  readonly path: string
  readonly mime: string
  readonly width: number
  readonly height: number
}

export async function screenshot(
  udid: string,
  options: ActionOptions & { width?: number; format?: "jpeg" | "png" } = {},
): Promise<Screenshot> {
  const directory = join(tmpdir(), "opencode-simulator")
  await mkdir(directory, { recursive: true })
  const stamp = Date.now()
  const png = join(directory, `${udid}-${stamp}.png`)
  const format = options.format ?? "jpeg"
  const width = options.width ?? 800
  await run("xcrun", ["simctl", "io", udid, "screenshot", png], {
    signal: options.signal,
    timeout: 30_000,
  })

  const dimensions = await run("sips", ["-g", "pixelWidth", "-g", "pixelHeight", png], {
    signal: options.signal,
  })
  const widthMatch = dimensions.stdout.match(/pixelWidth:\s*(\d+)/)
  const heightMatch = dimensions.stdout.match(/pixelHeight:\s*(\d+)/)
  const sourceWidth = widthMatch ? Number(widthMatch[1]) : 0
  const sourceHeight = heightMatch ? Number(heightMatch[1]) : 0

  if (format === "png" && sourceWidth <= width) {
    return { path: png, mime: "image/png", width: sourceWidth, height: sourceHeight }
  }

  const output = join(directory, `${udid}-${stamp}.${format === "png" ? "png" : "jpg"}`)
  const args = ["--resampleWidth", String(width)]
  if (format === "jpeg") args.push("-s", "format", "jpeg", "-s", "formatOptions", "80")
  args.push(png, "--out", output)
  await run("sips", args, { signal: options.signal })
  if (output !== png) await rm(png, { force: true })

  const scale = sourceWidth > 0 ? Math.min(1, width / sourceWidth) : 1
  return {
    path: output,
    mime: format === "png" ? "image/png" : "image/jpeg",
    width: Math.round(sourceWidth * scale),
    height: Math.round(sourceHeight * scale),
  }
}

export async function launchApp(
  udid: string,
  bundleId: string,
  options: ActionOptions & { terminate?: boolean; args?: readonly string[] } = {},
): Promise<string> {
  if (options.terminate !== false) {
    try {
      await run("xcrun", ["simctl", "terminate", udid, bundleId], {
        signal: options.signal,
        timeout: 15_000,
      })
    } catch {
      // The app may not be running; launch is the next step either way.
    }
  }
  const result = await run(
    "xcrun",
    ["simctl", "launch", udid, bundleId, ...(options.args ?? [])],
    { signal: options.signal, timeout: 30_000 },
  )
  return result.stdout.trim() || `launched ${bundleId}`
}
