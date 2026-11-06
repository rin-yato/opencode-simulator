export type StreamTransport = "http" | "webrtc"

export const STREAM_DEFAULTS = {
  transport: "webrtc",
  /**
   * A ceiling, not a constant: WebRTC backs off when the encoder is idle. 16
   * Mbps is plenty for a 60 fps H.264 screen over loopback and leaves the
   * encoder headroom on a busy machine.
   */
  bitrate: 16_000_000,
  /** Native capture rate. Lower it to cut encoder and battery use. */
  fps: 60,
  /** 0 keeps the simulator's native resolution. */
  maxDimension: 0,
} as const satisfies StreamOptions

export interface StreamOptions {
  readonly transport: StreamTransport
  readonly bitrate: number
  readonly fps: number
  readonly maxDimension: number
}

export const MIN_BITRATE = 100_000
export const MAX_BITRATE = 16_000_000

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Math.trunc(value)))

const numberOption = (value: unknown, fallback: number, min: number, max: number) =>
  typeof value === "number" && Number.isFinite(value) ? clamp(value, min, max) : fallback

/**
 * Hub stream settings from the plugin's `opencode.json` options. The defaults
 * are WebRTC at a 16 Mbps ceiling and the native frame rate; an explicit
 * option only exists so a user can trade quality for CPU, or go back to HTTP.
 */
export const resolveStreamOptions = (
  options: Readonly<Record<string, unknown>> = {},
): StreamOptions => ({
  transport: options.streamTransport === "http" ? "http" : STREAM_DEFAULTS.transport,
  bitrate: numberOption(options.streamBitrate, STREAM_DEFAULTS.bitrate, MIN_BITRATE, MAX_BITRATE),
  fps: numberOption(options.streamFps, STREAM_DEFAULTS.fps, 1, 140),
  maxDimension: numberOption(options.streamMaxDimension, STREAM_DEFAULTS.maxDimension, 0, 4096),
})
