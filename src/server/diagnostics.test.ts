import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  findCrashes,
  formatLogs,
  listLine,
  logArgs,
  logPredicate,
  matchesReport,
  mentionsDevice,
  parseExecutable,
  parseIps,
  predicateString,
  privacyArgs,
  summarizeIps,
  tailLogs,
  validateUrl,
} from "./diagnostics"

const UDID = "AAAA-1111"

const ips = (extra: Record<string, unknown> = {}, bundleID = "com.example.app") =>
  `${JSON.stringify({
    app_name: "Demo",
    bundleID,
    app_version: "1.2",
    build_version: "34",
    timestamp: "2026-11-10 10:00:00.00 +0700",
  })}\n${JSON.stringify(
    {
      procName: "Demo",
      captureTime: "2026-11-10 10:00:00.1 +0700",
      procPath: `/Users/x/Library/Developer/CoreSimulator/Devices/${UDID}/data/Demo`,
      exception: { type: "EXC_BAD_ACCESS", signal: "SIGSEGV", codes: "0x1, 0x2" },
      termination: { namespace: "SIGNAL", indicator: "Segmentation fault" },
      faultingThread: 1,
      threads: [
        { frames: [{ imageIndex: 0, symbol: "idle", symbolLocation: 1 }] },
        {
          name: "main",
          frames: [
            { imageIndex: 1, symbol: "crashHere", symbolLocation: 24 },
            { imageIndex: 0, imageOffset: 4096 },
            { imageIndex: 0, symbol: "start", symbolLocation: 3 },
          ],
        },
      ],
      usedImages: [{ name: "libsystem" }, { name: "Demo" }],
      ...extra,
    },
    null,
    2,
  )}`

describe("log predicate", () => {
  test("escapes quotes and backslashes", () => {
    expect(predicateString('a"b\\c')).toBe('"a\\"b\\\\c"')
  })

  test("bundle id matches executable or subsystem", () => {
    expect(logPredicate({ bundleId: "com.x.app", executable: "App" })).toBe(
      '(process == "App" OR subsystem == "com.x.app")',
    )
  })

  test("bundle id without executable uses the subsystem", () => {
    expect(logPredicate({ bundleId: "com.x.app" })).toBe('(subsystem == "com.x.app")')
  })

  test("process only, and nothing", () => {
    expect(logPredicate({ process: 'We"ird' })).toBe('process == "We\\"ird"')
    expect(logPredicate({})).toBeUndefined()
  })
})

describe("parseExecutable", () => {
  test("reads the plist-ish appinfo output", () => {
    const out = `{\n    ApplicationType = User;\n    CFBundleExecutable = MyApp;\n    CFBundleIdentifier = "com.x.app";\n}`
    expect(parseExecutable(out)).toBe("MyApp")
  })

  test("reads quoted names and XML", () => {
    expect(parseExecutable('CFBundleExecutable = "My App";')).toBe("My App")
    expect(parseExecutable("<key>CFBundleExecutable</key>\n<string>Foo</string>")).toBe("Foo")
    expect(parseExecutable("nothing")).toBeUndefined()
  })
})

describe("logArgs", () => {
  test("builds the arguments and clamps since", () => {
    expect(logArgs("U", { since: 99_999, level: "debug", predicate: "p" })).toEqual([
      "simctl",
      "spawn",
      "U",
      "log",
      "show",
      "--style",
      "compact",
      "--last",
      "3600s",
      "--info",
      "--debug",
      "--predicate",
      "p",
    ])
    expect(logArgs("U", {})).toContain("60s")
    expect(logArgs("U", { level: "info" })).toContain("--info")
    expect(logArgs("U", { level: "info" })).not.toContain("--debug")
  })
})

describe("tailLogs", () => {
  const entry = (i: number) => `2026-11-11 10:00:0${i}.000 Df SpringBoard[1:2] [x] entry ${i}`
  const raw = [
    "\tcom.apple.frontboard.visibility",
    "]>",
    "Timestamp               Ty Process[PID:TID]",
    entry(1),
    `${entry(2)} <a:`,
    "\tcontinued",
    "]>",
    entry(3),
    "",
  ].join("\n")

  test("drops leading orphans and the header, groups continuations", () => {
    const tail = tailLogs(raw, {})
    expect(tail.total).toBe(3)
    expect(tail.text.startsWith(entry(1))).toBe(true)
    expect(tail.text).toContain("<a:\n\tcontinued\n]>")
    expect(tail.text).not.toContain("Timestamp ")
  })

  test("max counts entries and notes truncation", () => {
    const tail = tailLogs(raw, { max: 2 })
    expect(tail.shown).toBe(2)
    expect(tail.text.startsWith(entry(2))).toBe(true)
    expect(tail.text.endsWith(entry(3))).toBe(true)
    expect(tail.truncated).toBe(true)
    expect(formatLogs(tail)).toContain("last 2 of 3 entries")
  })

  test("grep matches continuation text and returns whole entries", () => {
    const tail = tailLogs(raw, { grep: "CONTINUED" })
    expect(tail.shown).toBe(1)
    expect(tail.text.startsWith(entry(2))).toBe(true)
    expect(tail.text).toContain("]>")
  })

  test("reports empty output", () => {
    expect(formatLogs(tailLogs("", {}))).toBe("No log entries matched.")
    expect(formatLogs(tailLogs("orphan\n]>", {}))).toBe("No log entries matched.")
  })
})

describe("ips", () => {
  test("parses header and body, rejects junk", () => {
    expect(parseIps(ips())?.header.bundleID).toBe("com.example.app")
    expect(parseIps("not json")).toBeUndefined()
    expect(parseIps("{}\nnot json")).toBeUndefined()
  })

  test("summarizes the crashed thread", () => {
    const report = parseIps(ips())!
    const out = summarizeIps(report, "/tmp/x.ips", 2)
    expect(out).toContain("Process: Demo")
    expect(out).toContain("Bundle: com.example.app")
    expect(out).toContain("Version: 1.2 (34)")
    expect(out).toContain("Exception: EXC_BAD_ACCESS (SIGSEGV) codes 0x1, 0x2")
    expect(out).toContain("Termination: SIGNAL: Segmentation fault")
    expect(out).toContain("Crashed thread (main):")
    expect(out).toContain("#0 Demo crashHere+24")
    expect(out).toContain("#1 libsystem <unsymbolicated>+4096")
    expect(out).toContain("… 1 more frames")
    expect(out).toContain("File: /tmp/x.ips")
  })

  test("includes the last exception backtrace", () => {
    const report = parseIps(
      ips({ lastExceptionBacktrace: [{ imageIndex: 1, symbol: "raise", symbolLocation: 5 }] }),
    )!
    expect(summarizeIps(report, "/p")).toContain("Last exception backtrace:\n  #0 Demo raise+5")
  })

  test("filters by bundle id and process", () => {
    const report = parseIps(ips())!
    expect(matchesReport(report, {})).toBe(true)
    expect(matchesReport(report, { bundleId: "com.example.app" })).toBe(true)
    expect(matchesReport(report, { bundleId: "other" })).toBe(false)
    expect(matchesReport(report, { process: "Demo" })).toBe(true)
    expect(matchesReport(report, { process: "Nope" })).toBe(false)
  })
})

const systemIps = (udid: string) =>
  `${JSON.stringify({ app_name: "MobileSafari", bundleID: "com.apple.mobilesafari", app_version: "26.5", build_version: "8624.2" })}\n${JSON.stringify(
    {
      procName: "MobileSafari",
      parentProc: "launchd_sim",
      coalitionName: `com.apple.CoreSimulator.SimDevice.${udid}`,
      captureTime: "2026-11-11 10:40:46.0 +0700",
      exception: { type: "EXC_CRASH", signal: "SIGSEGV" },
      termination: { namespace: "SIGNAL", indicator: "Segmentation fault: 11", byProc: "zsh" },
      faultingThread: 0,
      threads: [
        {
          triggered: true,
          queue: "com.apple.main-thread",
          frames: [{ imageIndex: 0, symbol: "mach_msg2_trap", symbolLocation: 8 }],
        },
      ],
      usedImages: [{ name: "libsystem_kernel.dylib" }],
    },
    null,
    2,
  )}`

describe("system app crashes", () => {
  test("match by coalitionName when there is no device path", () => {
    const text = systemIps(UDID)
    const report = parseIps(text)!
    expect(mentionsDevice(text, UDID, report)).toBe(true)
    expect(mentionsDevice(text, "AAAA-1111".toLowerCase(), report)).toBe(true)
    expect(mentionsDevice(text, "BBBB-2222", report)).toBe(false)
  })

  test("a SimDevice coalition for another device wins over a path mention", () => {
    const text = systemIps("BBBB-2222")
    const report = parseIps(text)!
    expect(mentionsDevice(`${text} CoreSimulator/Devices/${UDID}`, UDID, report)).toBe(false)
  })

  test("raw text fallback accepts the coalition string", () => {
    expect(mentionsDevice(`x com.apple.CoreSimulator.SimDevice.${UDID}`, UDID)).toBe(true)
  })

  test("summary names the process, exception, and who terminated it", () => {
    const out = summarizeIps(parseIps(systemIps(UDID))!, "/p")
    expect(out).toContain("Process: MobileSafari")
    expect(out).toContain("Exception: EXC_CRASH (SIGSEGV)")
    expect(out).toContain("Termination: SIGNAL: Segmentation fault: 11 (by zsh)")
    expect(out).toContain("Crashed thread (com.apple.main-thread):")
    expect(out).toContain("#0 libsystem_kernel.dylib mach_msg2_trap+8")
  })
})

describe("findCrashes", () => {
  let dir: string | undefined
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  test("keeps only this device's reports, newest first, skipping junk", async () => {
    dir = await mkdtemp(join(tmpdir(), "crash-"))
    const write = async (name: string, text: string, ageMinutes: number) => {
      const path = join(dir!, name)
      await writeFile(path, text)
      const when = new Date(Date.now() - ageMinutes * 60_000)
      await utimes(path, when, when)
    }
    await write("old.ips", ips(), 30)
    await write("new.ips", ips(), 5)
    await write("other.ips", ips().replaceAll(UDID, "BBBB-2222"), 1)
    await write("junk.ips", `junk ${UDID}`.replace(UDID, `CoreSimulator/Devices/${UDID}`), 2)
    await write("stale.ips", ips(), 60 * 48)
    await write("note.txt", ips(), 1)
    await write("safari.ips", systemIps(UDID), 3)

    const all = await findCrashes(UDID, { directory: dir })
    expect(all.map((entry) => entry.name)).toEqual(["safari.ips", "new.ips", "old.ips"])
    expect(listLine(all[1]!, 2)).toContain("new.ips | 2026-11-10")
    expect(await findCrashes(UDID, { directory: dir, bundleId: "nope" })).toEqual([])
    expect(await findCrashes(UDID, { directory: join(dir, "missing") })).toEqual([])
  })

  test("device match is case-insensitive", () => {
    expect(mentionsDevice("x CoreSimulator/Devices/aaaa-1111/y", "AAAA-1111")).toBe(true)
    expect(mentionsDevice("CoreSimulator/Devices/other", "AAAA-1111")).toBe(false)
  })
})

describe("validateUrl", () => {
  test("accepts custom schemes and https", () => {
    expect(validateUrl("myapp://item/1")).toBe("myapp://item/1")
    expect(validateUrl(" https://example.com/a ")).toBe("https://example.com/a")
  })

  test("rejects empty and scheme-less input", () => {
    expect(() => validateUrl("")).toThrow()
    expect(() => validateUrl("example.com/path")).toThrow()
    expect(() => validateUrl("not a url")).toThrow()
  })
})

describe("privacyArgs", () => {
  test("builds grant and reset arguments", () => {
    expect(privacyArgs("U", { action: "grant", service: "photos", bundleId: "com.x" })).toEqual([
      "simctl",
      "privacy",
      "U",
      "grant",
      "photos",
      "com.x",
    ])
    expect(privacyArgs("U", { action: "reset", service: "all" })).toEqual([
      "simctl",
      "privacy",
      "U",
      "reset",
      "all",
    ])
  })

  test("validates action, service, and bundle id", () => {
    expect(() => privacyArgs("U", { action: "grant", service: "photos" })).toThrow("bundleId")
    expect(() => privacyArgs("U", { action: "revoke", service: "location" })).toThrow("bundleId")
    expect(() => privacyArgs("U", { action: "nuke", service: "photos" })).toThrow("action")
    expect(() =>
      privacyArgs("U", { action: "grant", service: "notifications", bundleId: "x" }),
    ).toThrow("Notifications")
  })
})
