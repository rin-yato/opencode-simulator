import type { StreamOptions, StreamTransport } from "./stream-options"

/**
 * serve-sim's preview client falls back to Google's public STUN servers when
 * the server sends no ICE servers. The hub only streams over loopback, so give
 * it a loopback STUN address instead: the client gets a non-empty list, never
 * contacts a public server, and host candidates still connect directly.
 */
export const LOOPBACK_STUN = "stun:127.0.0.1:3478"

export interface HubArgsInput {
  /** The CLI's own leading arguments, such as the script path. */
  readonly cliArgs: readonly string[]
  readonly port: number
  readonly device: string
  readonly transport: StreamTransport
  readonly stream: StreamOptions
}

/**
 * The serve-sim command line for one device.
 *
 * - `--single-device` locks the preview to the requested simulator. Without it
 *   serve-sim streams whichever simulator booted first.
 * - `--max-dimension` caps the captured size, which is what the encoder pays
 *   for. A panel never shows more pixels than that.
 * - `--disable-share` drops the Share button: it copies a loopback URL that is
 *   useless outside this machine.
 * - `--quiet` keeps the human banner off stdout. Startup phase lines still go
 *   to the log.
 * - H.264 settings only matter over WebRTC. They are left off for HTTP so the
 *   fallback path stays on serve-sim's own defaults.
 */
export const buildHubArgs = (input: HubArgsInput): string[] => {
  const args = [
    ...input.cliArgs,
    "--host",
    "127.0.0.1",
    "--port",
    String(input.port),
    "--single-device",
    input.device,
    "--transport",
    input.transport,
    "--max-dimension",
    String(input.stream.maxDimension),
    "--disable-share",
    "--quiet",
  ]
  if (input.transport === "webrtc") {
    args.push(
      "--webrtc-codec",
      "h264",
      "--stun-url",
      LOOPBACK_STUN,
      "--video-bitrate",
      String(input.stream.bitrate),
      "--video-fps",
      String(input.stream.fps),
    )
  }
  return args
}

/**
 * The environment for the hub process. The hub runs under the user's Node, so
 * Electron's own variables mean nothing to it, and its output goes to a log
 * file, not a terminal.
 */
export const buildHubEnv = (base: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(base)) {
    if (key.startsWith("ELECTRON_")) continue
    env[key] = value
  }
  env.NO_COLOR = "1"
  delete env.FORCE_COLOR
  return env
}

export interface StartupPhase {
  readonly phase: string
  readonly status: string
  readonly durationMs?: number
}

const PHASE_LINE = /^\[startup\]\s+(\{.*\})\s*$/

/**
 * Parse one `[startup] {...}` line serve-sim prints while it boots a device.
 * Anything else returns undefined.
 */
export const parseStartupPhase = (line: string): StartupPhase | undefined => {
  const match = PHASE_LINE.exec(line.trim())
  if (!match?.[1]) return undefined
  try {
    const value = JSON.parse(match[1]) as Record<string, unknown>
    if (typeof value.phase !== "string" || typeof value.status !== "string") return undefined
    return {
      phase: value.phase,
      status: value.status,
      ...(typeof value.durationMs === "number" ? { durationMs: value.durationMs } : {}),
    }
  } catch {
    return undefined
  }
}

/** Splits a stream into complete lines, keeping the unfinished tail for the next chunk. */
export const lineBuffer = (onLine: (line: string) => void) => {
  let tail = ""
  return (chunk: string) => {
    const parts = (tail + chunk).split(/\r?\n/)
    tail = parts.pop() ?? ""
    // A runaway line with no newline must not grow without bound.
    if (tail.length > 8_192) tail = tail.slice(-8_192)
    for (const line of parts) if (line.trim()) onLine(line)
  }
}
