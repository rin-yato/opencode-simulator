import { describe, expect, test } from "bun:test"
import { MAX_BITRATE, STREAM_DEFAULTS, resolveStreamOptions } from "./stream-options"

describe("stream options", () => {
  test("defaults to WebRTC at the ceiling bitrate and native frame rate", () => {
    expect(resolveStreamOptions()).toEqual({
      transport: "webrtc",
      bitrate: 16_000_000,
      fps: 60,
      maxDimension: 0,
    })
    expect(resolveStreamOptions()).toEqual(STREAM_DEFAULTS)
  })

  test("accepts HTTP and clamps numeric options", () => {
    expect(
      resolveStreamOptions({
        streamTransport: "http",
        streamBitrate: 1,
        streamFps: 999,
        streamMaxDimension: 9999,
      }),
    ).toEqual({
      transport: "http",
      bitrate: 100_000,
      fps: 140,
      maxDimension: 4096,
    })
  })

  test("the bitrate ceiling is 16 Mbps", () => {
    expect(MAX_BITRATE).toBe(16_000_000)
    expect(resolveStreamOptions({ streamBitrate: 50_000_000 }).bitrate).toBe(16_000_000)
  })

  test("ignores unknown or non-numeric values", () => {
    expect(
      resolveStreamOptions({
        streamTransport: "quic",
        streamBitrate: "lots",
        streamFps: Number.NaN,
        streamMaxDimension: -10,
      }),
    ).toEqual(STREAM_DEFAULTS)
  })

  test("integer values are truncated", () => {
    expect(resolveStreamOptions({ streamFps: 29.9, streamBitrate: 1_000_000.9 }).fps).toBe(29)
    expect(resolveStreamOptions({ streamBitrate: 1_000_000.9 }).bitrate).toBe(1_000_000)
  })
})
