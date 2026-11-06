import type { Plugin } from "@opencode/plugin"
import { resolveDevice, type Device } from "../devices"
import type { HubOptions } from "../serve-sim"
import type { SimulatorPool } from "../simulator-pool"

/** The part of the tool context this plugin uses. */
export interface ToolRuntime {
  readonly sessionID: string
  readonly signal: AbortSignal
}

export type ToolEditor = Parameters<Parameters<Plugin.Context["tool"]["transform"]>[0]>[0]

export interface TextContent {
  readonly type: "text"
  readonly text: string
}

export interface FileContent {
  readonly type: "file"
  readonly uri: string
  readonly mime: string
  readonly name?: string
}

export interface ToolResult {
  readonly content: string | readonly (TextContent | FileContent)[]
  readonly metadata: Record<string, unknown>
}

export type OpenPanel = (udid: string, sessionID: string) => Promise<boolean>

/** Dependencies shared by every tool group. */
export interface SimulatorContext {
  readonly hub: HubOptions
  readonly pool: SimulatorPool
  readonly openPanel?: OpenPanel
  /** Best-effort window notification after a device is deleted. */
  readonly onDeviceDeleted?: (udid: string) => void
}

export const SIM_OPTIONS = { namespace: "sim", codemode: true } as const

export const UDID_SCHEMA = {
  type: "string",
  description:
    "Simulator UDID, exact name, or unique name fragment. Defaults to the device this session started; run sim_start first or pass udid.",
} as const

export const SHARE_SCHEMA = {
  type: "boolean",
  default: false,
  description: "Allow an explicit udid that another session owns.",
} as const

export const errorText = (cause: unknown): string => {
  const message = cause instanceof Error ? cause.message : String(cause)
  return message.length > 2_000 ? `${message.slice(0, 2_000)}…` : message
}

export const ok = (content: string, metadata: Record<string, unknown> = {}): ToolResult => ({
  content,
  metadata: { ok: true, status: "ok", ...metadata },
})

export const partial = (content: string, metadata: Record<string, unknown> = {}): ToolResult => ({
  content,
  metadata: { ok: false, status: "partial", ...metadata },
})

export const fail = (cause: unknown): ToolResult => ({
  content: `ERROR: ${errorText(cause)}`,
  metadata: { ok: false, status: "error" },
})

/**
 * Wrap a tool handler so every failure becomes a readable `ERROR:` result
 * instead of an exception. Individual tools only describe their happy path.
 */
export const define = <Input>(
  handler: (input: Input, context: ToolRuntime) => Promise<ToolResult>,
) => {
  return async (raw: unknown, context: ToolRuntime): Promise<ToolResult> => {
    try {
      return await handler(raw as Input, context)
    } catch (cause) {
      return fail(cause)
    }
  }
}

/**
 * Resolve the device a session asked for, or its remembered default.
 *
 * A session without a device must not fall back to whichever simulator happens
 * to be booted: after a release that may belong to another session.
 */
export const currentDevice = async (
  simulator: SimulatorContext,
  context: ToolRuntime,
  requested?: string,
  share?: boolean,
): Promise<Device> => {
  const wanted = simulator.pool.pick(context.sessionID, requested)
  if (!wanted) {
    throw new Error("No simulator is assigned to this session. Run sim_start or pass udid.")
  }
  const device = await resolveDevice(wanted, { signal: context.signal })
  if (requested?.trim() && share !== true) {
    const others = simulator.pool.owners(device.udid, context.sessionID)
    if (others.length > 0 || simulator.pool.isBusy(device.udid, context.sessionID)) {
      throw new Error(
        `${device.name} is used by another session. Pass share: true to drive the same screen.`,
      )
    }
  }
  return device
}

/** Like `currentDevice`, for tools that need a running screen. */
export const bootedDevice = async (
  simulator: SimulatorContext,
  context: ToolRuntime,
  requested?: string,
  share?: boolean,
): Promise<Device> => {
  const device = await currentDevice(simulator, context, requested, share)
  if (device.state !== "Booted") {
    throw new Error(`${device.name} is ${device.state.toLowerCase()}. Run sim_start.`)
  }
  return device
}

/**
 * Keep an open panel on the session's device across a claim that does not open
 * one itself. Call before claiming: the claim drops the panel's entry, and a
 * window left on the old device would keep it busy through its heartbeat.
 */
export const panelFollower = (simulator: SimulatorContext, sessionID: string) => {
  const before = simulator.pool.panelDevice(sessionID)
  return (udid: string): boolean => {
    if (!before || before === udid) return false
    void simulator.openPanel?.(udid, sessionID).catch(() => {})
    return true
  }
}
