import { existsSync, readFileSync } from "node:fs"
import { readdir, rm, stat } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { run, runWithInput } from "./exec"

export interface HubOptions {
  readonly hubCli?: unknown
}

const PACKAGE_CLI = new URL(
  "../../node_modules/expo-device-hub/vendor/serve-sim/dist/serve-sim.js",
  import.meta.url,
)

const NODE = () => process.env.OPENCODE_SIMULATOR_NODE?.trim() || "node"

export function resolveServeSim(options: HubOptions = {}): string | undefined {
  const configured = typeof options.hubCli === "string" ? options.hubCli : undefined
  const candidates = [
    configured,
    process.env.OPENCODE_SIMULATOR_HUB,
    PACKAGE_CLI.pathname,
    join(homedir(), ".config", "opencode", "node_modules", "expo-device-hub", "vendor", "serve-sim", "dist", "serve-sim.js"),
  ]
  return candidates.find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)))
}

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function serveSimPort(udid: string): number | undefined {
  try {
    const state = JSON.parse(
      readFileSync(join(tmpdir(), "serve-sim", `server-${udid}.json`), "utf8"),
    ) as { port?: unknown; pid?: unknown }
    if (typeof state.port !== "number") return undefined
    // serve-sim leaves its state file behind when a hub is killed; do not report
    // a port that no process owns.
    if (typeof state.pid === "number" && !isAlive(state.pid)) return undefined
    return state.port
  } catch {
    return undefined
  }
}

/**
 * Remove serve-sim state and log files whose process is gone, plus logs older
 * than a week. Runs once when the server part loads.
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

const cli = (options: HubOptions, args: readonly string[], udid: string) => {
  const entry = resolveServeSim(options)
  if (!entry) throw new Error("serve-sim CLI not found. Set options.hubCli or OPENCODE_SIMULATOR_HUB.")
  return { command: NODE(), args: [entry, ...args, "-d", udid] }
}

export async function serveSimType(
  udid: string,
  text: string,
  options: HubOptions & { signal?: AbortSignal } = {},
): Promise<void> {
  const { command, args } = cli(options, ["type", "--stdin"], udid)
  await runWithInput(command, args, text, { signal: options.signal })
}

export async function serveSimButton(
  udid: string,
  button: string,
  options: HubOptions & { signal?: AbortSignal } = {},
): Promise<void> {
  const { command, args } = cli(options, ["button", button], udid)
  await run(command, args, { signal: options.signal })
}

export async function serveSimRotate(
  udid: string,
  orientation: string,
  options: HubOptions & { signal?: AbortSignal } = {},
): Promise<void> {
  const { command, args } = cli(options, ["rotate", orientation], udid)
  await run(command, args, { signal: options.signal })
}

export async function serveSimUi(
  udid: string,
  args: readonly string[],
  options: HubOptions & { signal?: AbortSignal } = {},
): Promise<string> {
  const { command, args: cliArgs } = cli(options, ["ui", ...args], udid)
  const result = await run(command, cliArgs, { signal: options.signal })
  return result.stdout.trim()
}

export async function serveSimSoftwareKeyboard(
  udid: string,
  options: HubOptions & { signal?: AbortSignal } = {},
): Promise<void> {
  const { command, args } = cli(options, ["software-keyboard"], udid)
  await run(command, args, { signal: options.signal })
}

export async function serveSimGesture(
  udid: string,
  events: ReadonlyArray<Record<string, unknown>>,
  options: HubOptions & { signal?: AbortSignal } = {},
): Promise<void> {
  const { command, args } = cli(options, ["gesture", JSON.stringify(events)], udid)
  await run(command, args, { signal: options.signal })
}

export async function serveSimTap(
  udid: string,
  x: number,
  y: number,
  options: HubOptions & { signal?: AbortSignal } = {},
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
  options: HubOptions & { signal?: AbortSignal } = {},
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

export function serveSimAx(udid: string): Promise<unknown> {
  const port = serveSimPort(udid)
  if (!port) return Promise.reject(new Error("serve-sim is not running for this simulator."))
  return fetch(`http://127.0.0.1:${port}/helper/${encodeURIComponent(udid)}/ax`).then(async (response) => {
    if (!response.ok) throw new Error(`serve-sim /ax returned ${response.status}.`)
    return response.json()
  })
}
