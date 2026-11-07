import { describe, expect, test } from "bun:test"
import { LOOPBACK_STUN, buildHubArgs, buildHubEnv, lineBuffer, parseStartupPhase } from "./hub-args"
import { STREAM_DEFAULTS } from "./stream-options"

const base = {
  cliArgs: ["/cli/serve-sim.js"],
  port: 4100,
  device: "UDID-1",
  stream: STREAM_DEFAULTS,
} as const

describe("hub args", () => {
  test("locks the hub to one device on loopback", () => {
    const args = buildHubArgs({ ...base, transport: "webrtc" })
    expect(args.slice(0, 1)).toEqual(["/cli/serve-sim.js"])
    expect(args).toContain("--single-device")
    expect(args[args.indexOf("--single-device") + 1]).toBe("UDID-1")
    expect(args[args.indexOf("--host") + 1]).toBe("127.0.0.1")
    expect(args[args.indexOf("--port") + 1]).toBe("4100")
  })

  test("drops the Share button and the human banner", () => {
    const args = buildHubArgs({ ...base, transport: "http" })
    expect(args).toContain("--disable-share")
    expect(args).toContain("--quiet")
  })

  test("WebRTC gets the H.264 settings and the loopback STUN", () => {
    const args = buildHubArgs({ ...base, transport: "webrtc" })
    expect(args[args.indexOf("--webrtc-codec") + 1]).toBe("h264")
    expect(args[args.indexOf("--stun-url") + 1]).toBe(LOOPBACK_STUN)
    expect(args[args.indexOf("--video-bitrate") + 1]).toBe("16000000")
    expect(args[args.indexOf("--video-fps") + 1]).toBe("60")
  })

  test("HTTP leaves the WebRTC settings off", () => {
    const args = buildHubArgs({ ...base, transport: "http" })
    expect(args[args.indexOf("--transport") + 1]).toBe("http")
    for (const flag of ["--webrtc-codec", "--stun-url", "--video-bitrate", "--video-fps"]) {
      expect(args).not.toContain(flag)
    }
  })

  test("passes the stream options through", () => {
    const args = buildHubArgs({
      ...base,
      transport: "webrtc",
      stream: { transport: "webrtc", bitrate: 4_000_000, fps: 30, maxDimension: 1280 },
    })
    expect(args[args.indexOf("--max-dimension") + 1]).toBe("1280")
    expect(args[args.indexOf("--video-bitrate") + 1]).toBe("4000000")
    expect(args[args.indexOf("--video-fps") + 1]).toBe("30")
  })
})

describe("hub env", () => {
  test("drops Electron variables and keeps the rest", () => {
    const env = buildHubEnv({
      PATH: "/usr/bin",
      ELECTRON_RUN_AS_NODE: "1",
      ELECTRON_NO_ATTACH_CONSOLE: "1",
      HOME: "/Users/me",
    })
    expect(env.PATH).toBe("/usr/bin")
    expect(env.HOME).toBe("/Users/me")
    expect(Object.keys(env).some((key) => key.startsWith("ELECTRON_"))).toBe(false)
  })

  test("turns color off, even when the parent forces it", () => {
    const env = buildHubEnv({ FORCE_COLOR: "3" })
    expect(env.NO_COLOR).toBe("1")
    expect(env.FORCE_COLOR).toBeUndefined()
  })

  test("does not change the environment it was given", () => {
    const base = { ELECTRON_RUN_AS_NODE: "1" }
    buildHubEnv(base)
    expect(base).toEqual({ ELECTRON_RUN_AS_NODE: "1" })
  })
})

describe("startup phases", () => {
  test("parses a completed phase", () => {
    expect(
      parseStartupPhase(
        '[startup] {"phase":"loader-arming","device":"X","status":"complete","durationMs":1790}',
      ),
    ).toEqual({ phase: "loader-arming", status: "complete", durationMs: 1790 })
  })

  test("parses a phase that has not finished", () => {
    expect(parseStartupPhase('[startup] {"phase":"cli","version":"0.13.0"}')).toBeUndefined()
    expect(parseStartupPhase('[startup] {"phase":"http-listener","status":"started"}')).toEqual({
      phase: "http-listener",
      status: "started",
    })
  })

  test("ignores other output and broken JSON", () => {
    expect(parseStartupPhase("[capture] Framebuffer: 1206x2622")).toBeUndefined()
    expect(parseStartupPhase("[startup] {not json}")).toBeUndefined()
    expect(parseStartupPhase("")).toBeUndefined()
  })

  test("line buffer joins chunks and drops blank lines", () => {
    const lines: string[] = []
    const push = lineBuffer((line) => lines.push(line))
    push("one\ntw")
    push("o\r\n\nthree")
    expect(lines).toEqual(["one", "two"])
    push("\n")
    expect(lines).toEqual(["one", "two", "three"])
  })

  test("line buffer bounds a line with no newline", () => {
    const lines: string[] = []
    const push = lineBuffer((line) => lines.push(line))
    push("x".repeat(100_000))
    push("\n")
    expect(lines).toHaveLength(1)
    expect(lines[0]!.length).toBeLessThanOrEqual(8_192)
  })
})
