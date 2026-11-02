import { existsSync, readFileSync } from "node:fs"
import { readdir, rm, stat } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { run, runWithInput, type RunResult } from "./exec"

export interface HubOptions {
  readonly hubCli?: unknown
}

const PACKAGE_CLI = fileURLToPath(
  new URL("../../node_modules/expo-device-hub/vendor/serve-sim/dist/serve-sim.js", import.meta.url),
)

const nodeBinary = () => process.env.OPENCODE_SIMULATOR_NODE?.trim() || "node"

/** Locate the vendored serve-sim CLI. */
export function resolveServeSim(options: HubOptions = {}): string | undefined {
  const configured = typeof options.hubCli === "string" ? options.hubCli : undefined
  const candidates = [
    configured,
    process.env.OPENCODE_SIMULATOR_HUB,
    PACKAGE_CLI,
    join(
      homedir(),
      ".config",
      "opencode",
      "node_modules",
      "expo-device-hub",
      "vendor",
      "serve-sim",
      "dist",
      "serve-sim.js",
    ),
  ]
  return candidates.find((candidate): candidate is string =>
    Boolean(candidate && existsSync(candidate)),
  )
}

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * The port of a running serve-sim hub for this simulator, if any. The hub
 * writes `$TMPDIR/serve-sim/server-<udid>.json`; a stale file from a dead
 * process is ignored.
 */
export function serveSimPort(udid: string): number | undefined {
  try {
    const state = JSON.parse(
      readFileSync(join(tmpdir(), "serve-sim", `server-${udid}.json`), "utf8"),
    ) as { port?: unknown; pid?: unknown }
    if (typeof state.port !== "number") return undefined
    if (typeof state.pid === "number" && !isAlive(state.pid)) return undefined
    return state.port
  } catch {
    return undefined
  }
}

/**
 * Remove serve-sim state files whose process is gone, plus logs older than a
 * week. Runs once when the server part loads.
 */
export async function cleanServeSimState(): Promise<void> {
  const directory = join(tmpdir(), "serve-sim")
  let entries: string[]
  try {
    entries = await readdir(directory)
  } catch {
    return
  }
  const now = Date.now()
  await Promise.all(
    entries.map(async (name) => {
      const path = join(directory, name)
      try {
        if (name.startsWith("server-") && name.endsWith(".json")) {
          const state = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown }
          if (typeof state.pid === "number" && !isAlive(state.pid)) await rm(path, { force: true })
          return
        }
        if (name.endsWith(".log")) {
          const info = await stat(path)
          if (now - info.mtimeMs > 7 * 24 * 60 * 60 * 1_000) await rm(path, { force: true })
        }
      } catch {}
    }),
  )
}

interface ServeSimOptions extends HubOptions {
  readonly signal?: AbortSignal
}

/** Run the serve-sim CLI against one simulator. */
async function invoke(
  udid: string,
  args: readonly string[],
  options: ServeSimOptions,
  input?: string,
): Promise<RunResult> {
  const entry = resolveServeSim(options)
  if (!entry)
    throw new Error("serve-sim CLI not found. Set options.hubCli or OPENCODE_SIMULATOR_HUB.")
  const full = [entry, ...args, "-d", udid]
  return input === undefined
    ? run(nodeBinary(), full, { signal: options.signal })
    : runWithInput(nodeBinary(), full, input, { signal: options.signal })
}

export async function serveSimType(
  udid: string,
  text: string,
  options: ServeSimOptions = {},
): Promise<void> {
  await invoke(udid, ["type", "--stdin"], options, text)
}

export async function serveSimButton(
  udid: string,
  button: string,
  options: ServeSimOptions = {},
): Promise<void> {
  await invoke(udid, ["button", button], options)
}

export async function serveSimRotate(
  udid: string,
  orientation: string,
  options: ServeSimOptions = {},
): Promise<void> {
  await invoke(udid, ["rotate", orientation], options)
}

export async function serveSimUi(
  udid: string,
  args: readonly string[],
  options: ServeSimOptions = {},
): Promise<string> {
  const result = await invoke(udid, ["ui", ...args], options)
  return result.stdout.trim()
}

export async function serveSimSoftwareKeyboard(
  udid: string,
  options: ServeSimOptions = {},
): Promise<void> {
  await invoke(udid, ["software-keyboard"], options)
}

async function serveSimGesture(
  udid: string,
  events: ReadonlyArray<Record<string, unknown>>,
  options: ServeSimOptions = {},
): Promise<void> {
  await invoke(udid, ["gesture", JSON.stringify(events)], options)
}

export async function serveSimTap(
  udid: string,
  x: number,
  y: number,
  options: ServeSimOptions = {},
): Promise<void> {
  await serveSimGesture(
    udid,
    [
      { type: "begin", x, y },
      { type: "end", x, y },
    ],
    options,
  )
}

export async function serveSimSwipe(
  udid: string,
  start: { x: number; y: number },
  end: { x: number; y: number },
  options: ServeSimOptions = {},
): Promise<void> {
  const steps = 8
  const events: Record<string, unknown>[] = [{ type: "begin", x: start.x, y: start.y }]
  for (let index = 1; index <= steps; index += 1) {
    const t = index / steps
    events.push({
      type: "move",
      x: start.x + (end.x - start.x) * t,
      y: start.y + (end.y - start.y) * t,
    })
  }
  events.push({ type: "end", x: end.x, y: end.y })
  await serveSimGesture(udid, events, options)
}

/** Read the accessibility tree through a running hub. */
export async function serveSimAx(udid: string): Promise<unknown> {
  const port = serveSimPort(udid)
  if (!port) return Promise.reject(new Error("serve-sim is not running for this simulator."))
  const response = await fetch(`http://127.0.0.1:${port}/helper/${encodeURIComponent(udid)}/ax`)
  if (!response.ok) throw new Error(`serve-sim /ax returned ${response.status}.`)
  return response.json()
}
