import { readdir, readFile, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { run } from "./exec"

export const LOG_LEVELS = ["default", "info", "debug"] as const
export type LogLevel = (typeof LOG_LEVELS)[number]

export const PRIVACY_ACTIONS = ["grant", "revoke", "reset"] as const
export type PrivacyAction = (typeof PRIVACY_ACTIONS)[number]

export const PRIVACY_SERVICES = [
  "all",
  "calendar",
  "contacts-limited",
  "contacts",
  "location",
  "location-always",
  "photos-add",
  "photos",
  "media-library",
  "microphone",
  "motion",
  "reminders",
  "siri",
] as const
export type PrivacyService = (typeof PRIVACY_SERVICES)[number]

export const LOG_DEFAULT_SECONDS = 60
export const LOG_MAX_SECONDS = 3_600
export const LOG_DEFAULT_LINES = 200
export const LOG_MAX_LINES = 2_000

export const CRASH_LIST_LIMIT = 20
export const CRASH_SCAN_FILES = 200
export const CRASH_MAX_BYTES = 8 * 1024 * 1024
export const CRASH_DEFAULT_FRAMES = 15
export const CRASH_MAX_FRAMES = 60
export const CRASH_DEFAULT_MINUTES = 1_440

const clampInt = (value: number | undefined, fallback: number, max: number): number => {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(1, Math.floor(value)))
}

/** Escape a value for a double-quoted NSPredicate string literal. */
export const predicateString = (value: string): string =>
  `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`

export interface LogPredicateInput {
  readonly bundleId?: string
  readonly executable?: string
  readonly process?: string
}

/** Build the `log show` predicate, or undefined when nothing narrows it. */
export const logPredicate = (input: LogPredicateInput): string | undefined => {
  const parts: string[] = []
  const executable = input.executable?.trim()
  const bundleId = input.bundleId?.trim()
  const process = input.process?.trim()
  if (bundleId) {
    const own = [
      ...(executable ? [`process == ${predicateString(executable)}`] : []),
      `subsystem == ${predicateString(bundleId)}`,
    ]
    parts.push(`(${own.join(" OR ")})`)
  }
  if (process) parts.push(`process == ${predicateString(process)}`)
  return parts.length === 0 ? undefined : parts.join(" AND ")
}

/** Pull CFBundleExecutable out of `simctl appinfo` output (plist-ish or XML). */
export const parseExecutable = (output: string): string | undefined => {
  const plist = /CFBundleExecutable\s*=\s*"?([^";\n]+?)"?\s*;/.exec(output)
  if (plist?.[1]) return plist[1].trim()
  const xml = /<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/.exec(output)
  return xml?.[1]?.trim() || undefined
}

export const logArgs = (
  udid: string,
  options: {
    readonly since?: number
    readonly level?: LogLevel
    readonly predicate?: string
  },
): string[] => {
  const seconds = clampInt(options.since, LOG_DEFAULT_SECONDS, LOG_MAX_SECONDS)
  const args = [
    "simctl",
    "spawn",
    udid,
    "log",
    "show",
    "--style",
    "compact",
    "--last",
    `${seconds}s`,
  ]
  if (options.level === "info" || options.level === "debug") args.push("--info")
  if (options.level === "debug") args.push("--debug")
  if (options.predicate) args.push("--predicate", options.predicate)
  return args
}

export interface LogTail {
  readonly text: string
  readonly total: number
  readonly shown: number
  readonly truncated: boolean
}

const ENTRY_START = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/

/** Group physical lines into log entries; continuations attach to the previous entry. */
export const logEntries = (raw: string): string[] => {
  const entries: string[] = []
  for (const line of raw.split("\n")) {
    if (ENTRY_START.test(line)) entries.push(line)
    else if (entries.length > 0 && line.trim() !== "") entries[entries.length - 1] += `\n${line}`
    // Anything before the first entry (banner, header, cut-off lines) is dropped.
  }
  return entries
}

/** Group into entries, grep them, and keep the last `max` entries. */
export const tailLogs = (
  raw: string,
  options: { readonly grep?: string; readonly max?: number },
): LogTail => {
  const max = clampInt(options.max, LOG_DEFAULT_LINES, LOG_MAX_LINES)
  const needle = options.grep?.toLowerCase()
  let entries = logEntries(raw)
  if (needle) entries = entries.filter((entry) => entry.toLowerCase().includes(needle))
  const kept = entries.slice(-max)
  return {
    text: kept.join("\n"),
    total: entries.length,
    shown: kept.length,
    truncated: entries.length > kept.length,
  }
}

export const formatLogs = (tail: LogTail): string => {
  if (tail.shown === 0) return "No log entries matched."
  const note = tail.truncated
    ? `\n[showing the last ${tail.shown} of ${tail.total} entries; narrow with since, process, or grep]`
    : ""
  return `${tail.text}${note}`
}

export async function readLogs(
  udid: string,
  options: {
    readonly bundleId?: string
    readonly process?: string
    readonly since?: number
    readonly level?: LogLevel
    readonly grep?: string
    readonly max?: number
    readonly signal?: AbortSignal
  },
): Promise<LogTail> {
  let executable: string | undefined
  if (options.bundleId?.trim()) {
    try {
      const info = await run("xcrun", ["simctl", "appinfo", udid, options.bundleId.trim()], {
        signal: options.signal,
      })
      executable = parseExecutable(info.stdout)
    } catch {
      // Not installed: the subsystem match still works.
    }
  }
  const predicate = logPredicate({
    bundleId: options.bundleId,
    executable,
    process: options.process,
  })
  const result = await run("xcrun", logArgs(udid, { ...options, predicate }), {
    timeout: 60_000,
    signal: options.signal,
  })
  return tailLogs(result.stdout, options)
}

/* Crash reports */

export interface IpsReport {
  readonly header: Record<string, unknown>
  readonly body: Record<string, unknown>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined

/** Parse a .ips file: a JSON header line, then a JSON body. */
export const parseIps = (text: string): IpsReport | undefined => {
  const newline = text.indexOf("\n")
  if (newline < 0) return undefined
  try {
    const header: unknown = JSON.parse(text.slice(0, newline))
    const body: unknown = JSON.parse(text.slice(newline + 1))
    if (!isRecord(header) || !isRecord(body)) return undefined
    return { header, body }
  } catch {
    return undefined
  }
}

export const reportProcess = (report: IpsReport): string | undefined =>
  str(report.header.app_name) ?? str(report.body.procName)

export const reportBundleId = (report: IpsReport): string | undefined =>
  str(report.header.bundleID) ??
  str((report.body.bundleInfo as Record<string, unknown> | undefined)?.CFBundleIdentifier)

const SIM_DEVICE_PREFIX = "com.apple.coresimulator.simdevice."

/**
 * True when the report belongs to this device. System apps live under the
 * runtime root and have no device path, but their coalition is the SimDevice.
 */
export const mentionsDevice = (text: string, udid: string, report?: IpsReport): boolean => {
  const id = udid.toLowerCase()
  const coalition = str(report?.body.coalitionName)?.toLowerCase()
  if (coalition?.startsWith(SIM_DEVICE_PREFIX)) return coalition === `${SIM_DEVICE_PREFIX}${id}`
  const lower = text.toLowerCase()
  return (
    lower.includes(`coresimulator/devices/${id}`) || lower.includes(`${SIM_DEVICE_PREFIX}${id}`)
  )
}

export const matchesReport = (
  report: IpsReport,
  filter: { readonly bundleId?: string; readonly process?: string },
): boolean => {
  if (filter.bundleId && reportBundleId(report) !== filter.bundleId) return false
  if (filter.process) {
    const names = [str(report.header.app_name), str(report.body.procName)]
    if (!names.includes(filter.process)) return false
  }
  return true
}

const exceptionText = (body: Record<string, unknown>): string | undefined => {
  const exception = body.exception
  if (!isRecord(exception)) return undefined
  const parts = [str(exception.type), str(exception.signal) && `(${str(exception.signal)})`]
  const codes = str(exception.codes)
  if (codes) parts.push(`codes ${codes}`)
  const text = parts.filter(Boolean).join(" ")
  return text || undefined
}

const terminationText = (body: Record<string, unknown>): string | undefined => {
  const termination = body.termination
  if (!isRecord(termination)) return undefined
  const reasons = Array.isArray(termination.reasons)
    ? termination.reasons.filter((value): value is string => typeof value === "string").join("; ")
    : undefined
  const text = [
    str(termination.namespace),
    str(termination.indicator),
    str(termination.reason),
    reasons,
  ]
    .filter(Boolean)
    .join(": ")
  const by = str(termination.byProc)
  if (!text) return undefined
  return by ? `${text} (by ${by})` : text
}

const imageName = (body: Record<string, unknown>, index: unknown): string => {
  const images = body.usedImages
  if (typeof index !== "number" || !Array.isArray(images)) return "?"
  const image = images[index]
  return (isRecord(image) && str(image.name)) || "?"
}

const formatFrames = (body: Record<string, unknown>, frames: unknown, limit: number): string[] => {
  if (!Array.isArray(frames)) return []
  const lines: string[] = []
  for (const [n, frame] of frames.slice(0, limit).entries()) {
    if (!isRecord(frame)) continue
    const image = imageName(body, frame.imageIndex)
    const symbol = str(frame.symbol)
    if (symbol) {
      const location = typeof frame.symbolLocation === "number" ? `+${frame.symbolLocation}` : ""
      lines.push(`#${n} ${image} ${symbol}${location}`)
    } else {
      const offset = typeof frame.imageOffset === "number" ? `+${frame.imageOffset}` : ""
      lines.push(`#${n} ${image} <unsymbolicated>${offset}`)
    }
  }
  if (frames.length > limit) lines.push(`… ${frames.length - limit} more frames`)
  return lines
}

const crashedThread = (body: Record<string, unknown>): unknown => {
  const threads = body.threads
  if (!Array.isArray(threads)) return undefined
  const index = typeof body.faultingThread === "number" ? body.faultingThread : undefined
  const triggered = threads.find((thread) => isRecord(thread) && thread.triggered === true)
  return (index === undefined ? undefined : threads[index]) ?? triggered
}

const reportTime = (report: IpsReport): string | undefined =>
  str(report.body.captureTime) ?? str(report.header.timestamp)

export const summarizeIps = (
  report: IpsReport,
  path: string,
  frames = CRASH_DEFAULT_FRAMES,
): string => {
  const limit = clampInt(frames, CRASH_DEFAULT_FRAMES, CRASH_MAX_FRAMES)
  const body = report.body
  const lines: string[] = []
  const add = (label: string, value: string | undefined) => {
    if (value) lines.push(`${label}: ${value}`)
  }
  add("Process", reportProcess(report))
  add("Bundle", reportBundleId(report))
  const version = str(report.header.app_version)
  const build = str(report.header.build_version)
  add(
    "Version",
    version && build && build !== version ? `${version} (${build})` : (version ?? build),
  )
  add("Time", reportTime(report))
  add("Exception", exceptionText(body))
  add("Termination", terminationText(body))
  const asi = body.asi
  if (isRecord(asi)) {
    const messages = Object.values(asi)
      .flat()
      .filter((value): value is string => typeof value === "string")
    add("Application info", messages.join(" | ").slice(0, 500))
  }

  const thread = crashedThread(body)
  if (isRecord(thread)) {
    const name = str(thread.name) ?? str(thread.queue)
    lines.push(`Crashed thread${name ? ` (${name})` : ""}:`)
    lines.push(...formatFrames(body, thread.frames, limit).map((line) => `  ${line}`))
  }

  const last = body.lastExceptionBacktrace
  if (Array.isArray(last) && last.length > 0) {
    lines.push("Last exception backtrace:")
    lines.push(...formatFrames(body, last, limit).map((line) => `  ${line}`))
  }
  lines.push(`File: ${path}`)
  return lines.join("\n")
}

export interface CrashEntry {
  readonly path: string
  readonly name: string
  readonly mtimeMs: number
  readonly report: IpsReport
}

export const listLine = (entry: CrashEntry, position: number): string => {
  const parts = [
    `${position}.`,
    entry.name,
    reportTime(entry.report) ?? new Date(entry.mtimeMs).toISOString(),
    reportProcess(entry.report) ?? "?",
    exceptionText(entry.report.body) ?? "no exception",
  ]
  return parts.join(" | ")
}

export const crashDirectory = (): string => join(homedir(), "Library", "Logs", "DiagnosticReports")

/**
 * Crash reports for one simulator, newest first. Scans the newest
 * `CRASH_SCAN_FILES` files and skips anything unreadable, and any file that would take the bytes read past `CRASH_MAX_BYTES`.
 */
export async function findCrashes(
  udid: string,
  options: {
    readonly bundleId?: string
    readonly process?: string
    readonly sinceMinutes?: number
    readonly directory?: string
    readonly now?: number
  } = {},
): Promise<CrashEntry[]> {
  const directory = options.directory ?? crashDirectory()
  const minutes = clampInt(options.sinceMinutes, CRASH_DEFAULT_MINUTES, 60 * 24 * 365)
  const cutoff = (options.now ?? Date.now()) - minutes * 60_000

  let names: string[]
  try {
    names = (await readdir(directory)).filter((name) => name.endsWith(".ips"))
  } catch {
    return []
  }

  const files: { path: string; name: string; mtimeMs: number; size: number }[] = []
  for (const name of names) {
    const path = join(directory, name)
    try {
      const info = await stat(path)
      if (info.isFile() && info.mtimeMs >= cutoff)
        files.push({ path, name, mtimeMs: info.mtimeMs, size: info.size })
    } catch {}
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs)

  const found: CrashEntry[] = []
  let bytes = 0
  for (const file of files.slice(0, CRASH_SCAN_FILES)) {
    // A file that would push the total past the budget is skipped unread.
    if (bytes + file.size > CRASH_MAX_BYTES) continue
    try {
      const text = await readFile(file.path, "utf8")
      bytes += file.size
      const report = parseIps(text)
      if (!report || !mentionsDevice(text, udid, report) || !matchesReport(report, options))
        continue
      found.push({ ...file, report })
    } catch {}
  }
  return found
}

/* URLs and privacy */

/** Validate a URL with a scheme. Custom schemes and https links both pass. */
export const validateUrl = (value: string): string => {
  const url = value.trim()
  if (!url) throw new Error("url is required.")
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(
      `Not a valid URL: ${url}. Include a scheme, e.g. myapp://path or https://example.com.`,
    )
  }
  if (!/^[a-z][a-z0-9+.-]*:$/i.test(parsed.protocol)) {
    throw new Error(`URL has no scheme: ${url}`)
  }
  return url
}

export const privacyArgs = (
  udid: string,
  input: { readonly action: string; readonly service: string; readonly bundleId?: string },
): string[] => {
  if (!(PRIVACY_ACTIONS as readonly string[]).includes(input.action)) {
    throw new Error(`action must be one of: ${PRIVACY_ACTIONS.join(", ")}.`)
  }
  if (!(PRIVACY_SERVICES as readonly string[]).includes(input.service)) {
    throw new Error(
      `service must be one of: ${PRIVACY_SERVICES.join(", ")}. Notifications are not supported by simctl privacy.`,
    )
  }
  const bundleId = input.bundleId?.trim()
  if (input.action !== "reset" && !bundleId) {
    throw new Error(`bundleId is required to ${input.action} a permission.`)
  }
  return ["simctl", "privacy", udid, input.action, input.service, ...(bundleId ? [bundleId] : [])]
}

export async function openUrl(udid: string, url: string, signal?: AbortSignal): Promise<string> {
  const valid = validateUrl(url)
  await run("xcrun", ["simctl", "openurl", udid, valid], { signal })
  return valid
}

export async function setPrivacy(
  udid: string,
  input: { readonly action: string; readonly service: string; readonly bundleId?: string },
  signal?: AbortSignal,
): Promise<void> {
  await run("xcrun", privacyArgs(udid, input), { signal })
}
