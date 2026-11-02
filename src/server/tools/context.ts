import type { Plugin } from "@opencode/plugin"
import type { Copies } from "../copies"
import { resolveDevice, resolveStartDevice, type Device } from "../devices"
import type { HubOptions } from "../serve-sim"
import type { SessionDevices } from "../session-devices"
import type { Templates } from "../templates"

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
  readonly sessions: SessionDevices
  readonly templates: Templates
  readonly copies: Copies
  readonly copyTtlDays: number
  readonly openPanel?: OpenPanel
  /** Best-effort session title, used to name an automatic copy when no label is given. */
  readonly sessionTitle?: (sessionID: string) => Promise<string | undefined>
}

export const SIM_OPTIONS = { namespace: "sim", codemode: true } as const

export const UDID_SCHEMA = {
  type: "string",
  description:
    "Simulator UDID, exact name, or unique name fragment. Defaults to the device this session started, else the only booted simulator.",
} as const

export const errorText = (cause: unknown): string => {
  const message = cause instanceof Error ? cause.message : String(cause)
  return message.length > 2_000 ? `${message.slice(0, 2_000)}…` : message
}

export const ok = (content: string, metadata: Record<string, unknown> = {}): ToolResult => ({
  content,
  metadata: { ok: true, ...metadata },
})

export const fail = (cause: unknown): ToolResult => ({
  content: `ERROR: ${errorText(cause)}`,
  metadata: { ok: false },
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

/** Resolve the device a session asked for, or its remembered default. */
export const currentDevice = (
  simulator: SimulatorContext,
  context: ToolRuntime,
  requested?: string,
): Promise<Device> =>
  resolveDevice(simulator.sessions.pick(context.sessionID, requested), {
    signal: context.signal,
  })

/** Resolve a device for boot/start; it may still be shut down. */
export const startDevice = (
  simulator: SimulatorContext,
  context: ToolRuntime,
  requested?: string,
): Promise<Device> =>
  resolveStartDevice(simulator.sessions.pick(context.sessionID, requested), {
    signal: context.signal,
  })
