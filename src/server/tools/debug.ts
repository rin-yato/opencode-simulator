import {
  CRASH_DEFAULT_FRAMES,
  CRASH_LIST_LIMIT,
  findCrashes,
  formatLogs,
  listLine,
  LOG_LEVELS,
  openUrl,
  PRIVACY_ACTIONS,
  PRIVACY_SERVICES,
  readLogs,
  setPrivacy,
  summarizeIps,
  type LogLevel,
} from "../diagnostics"
import {
  bootedDevice,
  currentDevice,
  define,
  ok,
  SHARE_SCHEMA,
  SIM_OPTIONS,
  UDID_SCHEMA,
  type SimulatorContext,
  type ToolEditor,
  type ToolRuntime,
} from "./context"

interface DeviceInput {
  readonly udid?: string
  readonly share?: boolean
}

interface LogsInput extends DeviceInput {
  readonly bundleId?: string
  readonly process?: string
  readonly since?: number
  readonly level?: LogLevel
  readonly grep?: string
  readonly max?: number
}

interface CrashInput extends DeviceInput {
  readonly bundleId?: string
  readonly process?: string
  readonly list?: boolean
  readonly index?: number
  readonly frames?: number
  readonly since?: number
}

interface OpenUrlInput extends DeviceInput {
  readonly url: string
}

interface PermissionsInput extends DeviceInput {
  readonly action: string
  readonly service: string
  readonly bundleId?: string
}

export function registerDebugTools(editor: ToolEditor, simulator: SimulatorContext): void {
  editor.add({
    name: "logs",
    description:
      "Read recent unified logs from the simulator (log show). Filter by bundleId (its process and subsystem) or an exact process name, by lookback seconds, level, and a case-insensitive grep. Returns the last max entries (a multi-line entry counts once). With no bundleId or process the output is unfiltered, so keep since small.",
    input: {
      type: "object",
      properties: {
        udid: UDID_SCHEMA,
        share: SHARE_SCHEMA,
        bundleId: {
          type: "string",
          description: "App bundle id. Matches its process or subsystem.",
        },
        process: { type: "string", description: "Exact process name, e.g. SpringBoard." },
        since: {
          type: "integer",
          minimum: 1,
          maximum: 3600,
          default: 60,
          description: "Lookback in seconds.",
        },
        level: {
          type: "string",
          enum: [...LOG_LEVELS],
          default: "default",
          description: "info and debug include more verbose messages.",
        },
        grep: { type: "string", description: "Case-insensitive substring filter." },
        max: {
          type: "integer",
          minimum: 1,
          maximum: 2000,
          default: 200,
          description: "Maximum log entries returned (the last ones).",
        },
      },
      additionalProperties: false,
    },
    options: SIM_OPTIONS,
    execute: define(async (input: LogsInput, context: ToolRuntime) => {
      const device = await bootedDevice(simulator, context, input.udid, input.share)
      const tail = await readLogs(device.udid, { ...input, signal: context.signal })
      return ok(formatLogs(tail), {
        udid: device.udid,
        entries: tail.shown,
        total: tail.total,
        truncated: tail.truncated,
      })
    }),
  })

  editor.add({
    name: "crash",
    description:
      "Read crash reports (.ips) for this simulator's apps from the Mac's DiagnosticReports. Default: summary of the newest crash (exception, termination reason, crashed thread frames). list: true lists recent crashes newest first; index picks one (1 = newest). Filter by bundleId or process.",
    input: {
      type: "object",
      properties: {
        udid: UDID_SCHEMA,
        share: SHARE_SCHEMA,
        bundleId: { type: "string", description: "Only crashes of this bundle id." },
        process: { type: "string", description: "Only crashes of this process name." },
        list: { type: "boolean", default: false, description: "List crashes instead of one." },
        index: { type: "integer", minimum: 1, default: 1, description: "1-based, 1 = newest." },
        frames: {
          type: "integer",
          minimum: 1,
          maximum: 60,
          default: CRASH_DEFAULT_FRAMES,
          description: "Stack frames to show.",
        },
        since: {
          type: "integer",
          minimum: 1,
          default: 1440,
          description: "Only crashes from the last N minutes.",
        },
      },
      additionalProperties: false,
    },
    options: SIM_OPTIONS,
    execute: define(async (input: CrashInput, context: ToolRuntime) => {
      const device = await currentDevice(simulator, context, input.udid, input.share)
      const crashes = await findCrashes(device.udid, {
        bundleId: input.bundleId?.trim() || undefined,
        process: input.process?.trim() || undefined,
        sinceMinutes: input.since,
      })
      if (crashes.length === 0) {
        return ok("No crash reports found for this simulator in that window.", {
          udid: device.udid,
          count: 0,
        })
      }
      if (input.list) {
        const shown = crashes.slice(0, CRASH_LIST_LIMIT)
        const more =
          crashes.length > shown.length
            ? `\n… ${crashes.length - shown.length} older not shown`
            : ""
        return ok(shown.map((entry, i) => listLine(entry, i + 1)).join("\n") + more, {
          udid: device.udid,
          count: crashes.length,
        })
      }
      const position = Math.max(1, Math.floor(input.index ?? 1))
      const entry = crashes[position - 1]
      if (!entry) {
        throw new Error(`No crash #${position}; found ${crashes.length}. Use list: true.`)
      }
      return ok(summarizeIps(entry.report, entry.path, input.frames), {
        udid: device.udid,
        count: crashes.length,
        path: entry.path,
      })
    }),
  })

  editor.add({
    name: "open_url",
    description:
      "Open a URL on the simulator: a custom scheme deep link (myapp://item/1) or an https universal link. The URL must include a scheme.",
    input: {
      type: "object",
      properties: {
        udid: UDID_SCHEMA,
        share: SHARE_SCHEMA,
        url: { type: "string", description: "URL with a scheme." },
      },
      required: ["url"],
      additionalProperties: false,
    },
    options: SIM_OPTIONS,
    execute: define(async (input: OpenUrlInput, context: ToolRuntime) => {
      const device = await bootedDevice(simulator, context, input.udid, input.share)
      const url = await openUrl(device.udid, input.url, context.signal)
      return ok(`Opened ${url} on ${device.name}.`, { udid: device.udid, url })
    }),
  })

  editor.add({
    name: "permissions",
    description:
      "Grant, revoke, or reset a privacy permission for an app without a prompt (simctl privacy). bundleId is required for grant and revoke, optional for reset. Notifications are not supported by simctl privacy. revoke and reset may terminate the running app, so relaunch it after.",
    input: {
      type: "object",
      properties: {
        udid: UDID_SCHEMA,
        share: SHARE_SCHEMA,
        action: { type: "string", enum: [...PRIVACY_ACTIONS] },
        service: { type: "string", enum: [...PRIVACY_SERVICES] },
        bundleId: { type: "string", description: "App bundle id." },
      },
      required: ["action", "service"],
      additionalProperties: false,
    },
    options: SIM_OPTIONS,
    execute: define(async (input: PermissionsInput, context: ToolRuntime) => {
      const device = await bootedDevice(simulator, context, input.udid, input.share)
      await setPrivacy(device.udid, input, context.signal)
      const target = input.bundleId?.trim() || "all apps"
      return ok(`${input.action} ${input.service} for ${target} on ${device.name}.`, {
        udid: device.udid,
        action: input.action,
        service: input.service,
      })
    }),
  })
}
