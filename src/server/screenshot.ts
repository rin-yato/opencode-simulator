import { randomUUID } from "node:crypto"
import { chmod, mkdir, readdir, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { run } from "./exec"

export interface Screenshot {
  readonly path: string
  readonly mime: string
  readonly width: number
  readonly height: number
}

export interface ScreenshotOptions {
  readonly signal?: AbortSignal
  readonly width?: number
  readonly format?: "jpeg" | "png"
}

export const SCREENSHOT_DIRECTORY = join(tmpdir(), "opencode-simulator")

const RETENTION_MS = 24 * 60 * 60 * 1_000
const PRUNE_INTERVAL_MS = 5 * 60 * 1_000
const MAX_FILES = 200
let lastPrune = 0

/**
 * Screenshots are disposable: keep the last day, capped at 200 files. The scan
 * is throttled so a burst of captures does not rescan the directory.
 */
async function pruneScreenshots(): Promise<void> {
  const now = Date.now()
  if (now - lastPrune < PRUNE_INTERVAL_MS) return
  lastPrune = now
  try {
    const entries = await readdir(SCREENSHOT_DIRECTORY)
    const files: { path: string; mtime: number }[] = []
    for (const name of entries) {
      if (!name.endsWith(".jpg") && !name.endsWith(".png")) continue
      const path = join(SCREENSHOT_DIRECTORY, name)
      try {
        const info = await stat(path)
        files.push({ path, mtime: info.mtimeMs })
      } catch {}
    }
    files.sort((a, b) => b.mtime - a.mtime)
    await Promise.all(
      files.map((file, index) => {
        const expired = now - file.mtime > RETENTION_MS
        if (!expired && index < MAX_FILES) return undefined
        return rm(file.path, { force: true }).catch(() => {})
      }),
    )
  } catch {}
}

const imageSize = async (path: string, signal?: AbortSignal) => {
  const { stdout } = await run("sips", ["-g", "pixelWidth", "-g", "pixelHeight", path], { signal })
  const width = Number(/pixelWidth:\s*(\d+)/.exec(stdout)?.[1] ?? 0)
  const height = Number(/pixelHeight:\s*(\d+)/.exec(stdout)?.[1] ?? 0)
  return { width, height }
}

export async function screenshot(
  udid: string,
  options: ScreenshotOptions = {},
): Promise<Screenshot> {
  await mkdir(SCREENSHOT_DIRECTORY, { recursive: true, mode: 0o700 })
  await chmod(SCREENSHOT_DIRECTORY, 0o700).catch(() => {})
  await pruneScreenshots()

  const stamp = Date.now()
  const suffix = randomUUID().slice(0, 8)
  const png = join(SCREENSHOT_DIRECTORY, `${udid}-${stamp}-${suffix}.png`)
  const format = options.format ?? "jpeg"
  const width = options.width ?? 800
  await run("xcrun", ["simctl", "io", udid, "screenshot", png], {
    signal: options.signal,
    timeout: 30_000,
  })
  await chmod(png, 0o600).catch(() => {})

  const source = await imageSize(png, options.signal)
  if (format === "png" && source.width <= width) {
    return { path: png, mime: "image/png", width: source.width, height: source.height }
  }

  const output = join(
    SCREENSHOT_DIRECTORY,
    `${udid}-${stamp}-${suffix}.${format === "png" ? "png" : "jpg"}`,
  )
  const args = ["--resampleWidth", String(width)]
  if (format === "jpeg") args.push("-s", "format", "jpeg", "-s", "formatOptions", "80")
  args.push(png, "--out", output)
  await run("sips", args, { signal: options.signal })
  await chmod(output, 0o600).catch(() => {})
  if (output !== png) await rm(png, { force: true })

  const scale = source.width > 0 ? Math.min(1, width / source.width) : 1
  return {
    path: output,
    mime: format === "png" ? "image/png" : "image/jpeg",
    width: Math.round(source.width * scale),
    height: Math.round(source.height * scale),
  }
}
