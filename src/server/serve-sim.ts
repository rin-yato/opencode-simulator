import { existsSync, readFileSync } from "node:fs"
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

export function serveSimPort(udid: string): number | undefined {
  try {
    const state = JSON.parse(
      readFileSync(join(tmpdir(), "serve-sim", `server-${udid}.json`), "utf8"),
    ) as { port?: unknown }
    return typeof state.port === "number" ? state.port : undefined
  } catch {
    return undefined
  }
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
