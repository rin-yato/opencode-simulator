import type { Plugin } from "@opencode/plugin"
import type { PanelUpdate } from "../activity"
import { ManagedDevices } from "../managed"
import { cleanServeSimState, type HubOptions } from "../serve-sim"
import { SessionDevices } from "../session-devices"
import { SimulatorPool } from "../simulator-pool"
import type { OpenPanel } from "./context"
import { registerInputTools } from "./input"
import { registerInspectionTools } from "./inspect"
import { registerLifecycleTools } from "./lifecycle"
import { registerSettingsTools } from "./settings"

export interface SimulatorHandle {
  /** Panel state pushed by the desktop window. */
  readonly panel: (update: PanelUpdate) => Promise<void>
  /** The authoritative device a session currently owns. */
  readonly device: (sessionID: string) => string | undefined
  dispose(): void
}

export interface SimulatorHandlers {
  readonly onRelease?: (sessionID: string, udid: string, force: boolean) => void
  readonly onDeviceDeleted?: (udid: string) => void
}

type SessionID = Parameters<Plugin.Context["session"]["get"]>[0]["sessionID"]

const ACTIVITY_EVENTS = [
  "session.execution.started",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.idle",
  "session.deleted",
  "session.archived",
] as const

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Read a decoded Effect DateTime or a raw millisecond number. */
const epochMillis = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (value && typeof value === "object" && "epochMillis" in value) {
    const millis = (value as { readonly epochMillis?: unknown }).epochMillis
    if (typeof millis === "number" && Number.isFinite(millis)) return millis
  }
  return undefined
}

/**
 * Claims are persisted, but the running set is process memory. After a plugin
 * reload a turn can still be running; seed it from Session.Info.time so the
 * window's first `panel closed` update cannot release a device mid-work.
 */
const syncRunning = async (
  ctx: Plugin.Context,
  pool: SimulatorPool,
  releaseIdle: boolean,
): Promise<void> => {
  let live: Set<string> | undefined
  if (releaseIdle) {
    try {
      const listed = await ctx.session.list({ limit: 1_000 })
      live = new Set(listed.data.map((info) => info.id))
    } catch {}
  }

  for (const [sessionID] of pool.entries()) {
    try {
      const info = await ctx.session.get({ sessionID: sessionID as SessionID })
      const busy = epochMillis(info.time.busy)
      const idle = epochMillis(info.time.idle)
      if (busy !== undefined && (idle === undefined || busy > idle)) {
        pool.started(sessionID)
      } else if (releaseIdle) {
        // A dropped idle event must not keep a claim forever.
        await pool.idle(sessionID)
      }
    } catch {
      // A missing session that is also absent from the list was deleted while
      // the plugin was away. A transient get failure is left for the next sweep.
      if (live && !live.has(sessionID)) await pool.close(sessionID)
    }
  }
}

/**
 * Track agent turns so a simulator is not released while its session is still
 * working. Panels cover the user's side; this covers the agent's.
 */
const watchActivity = (ctx: Plugin.Context, pool: SimulatorPool, signal: AbortSignal): void => {
  void (async () => {
    while (!signal.aborted) {
      await syncRunning(ctx, pool, false)
      try {
        for await (const event of ctx.event.subscribe({ types: ACTIVITY_EVENTS, signal })) {
          const data = event.data as { readonly sessionID?: unknown } | undefined
          const sessionID = typeof data?.sessionID === "string" ? data.sessionID : undefined
          if (!sessionID) continue

          switch (event.type) {
            case "session.execution.started":
              pool.started(sessionID)
              break
            case "session.execution.failed":
            case "session.execution.interrupted":
            case "session.idle":
              await pool.idle(sessionID)
              break
            case "session.deleted":
            case "session.archived":
              await pool.close(sessionID)
              break
          }
        }
      } catch (cause) {
        if (signal.aborted) return
        console.warn("opencode-simulator: session activity stream stopped", cause)
      }
      if (signal.aborted) return
      await sleep(1_000)
    }
  })()
}

/**
 * Register the `sim` namespace. Tools are grouped by what they do:
 *
 * - lifecycle: discover, boot, create, delete, install, release, and launch apps
 * - inspect:   status, accessibility reads, waits, screenshots
 * - input:     taps, scrolling, typing, hardware buttons, rotation
 * - settings:  UI settings, software keyboard, status bar
 */
export async function registerTools(
  ctx: Plugin.Context,
  hub: HubOptions,
  openPanel?: OpenPanel,
  handlers: SimulatorHandlers = {},
): Promise<SimulatorHandle> {
  const sessions = await SessionDevices.load(ctx.storage)
  const managed = await ManagedDevices.load(ctx.storage)
  const pool = new SimulatorPool({
    sessions,
    managed,
    onRelease: handlers.onRelease,
  })
  const simulator = { hub, pool, openPanel, onDeviceDeleted: handlers.onDeviceDeleted }
  const abort = new AbortController()
  let sweepCount = 0
  const sweep = setInterval(() => {
    void pool.expirePanels().catch((cause) => {
      console.warn("opencode-simulator: could not expire panel leases", cause)
    })
    // Reconcile running claims against Session.Info every 30 seconds. A
    // dropped idle event must not pin a device forever.
    sweepCount += 1
    if (sweepCount % 3 === 0) void syncRunning(ctx, pool, true)
  }, 10_000)
  ;(sweep as { unref?: () => void }).unref?.()

  void cleanServeSimState().catch(() => {})
  await syncRunning(ctx, pool, false)
  watchActivity(ctx, pool, abort.signal)

  await ctx.tool.transform((editor) => {
    editor.namespace({
      name: "sim",
      description:
        "Inspect and control the local iOS Simulator. Use these tools instead of xcrun simctl, axe, or Xcode for device and UI work.",
    })

    registerLifecycleTools(editor, simulator)
    registerInspectionTools(editor, simulator)
    registerInputTools(editor, simulator)
    registerSettingsTools(editor, simulator)
  })

  return {
    panel: (update) => pool.panel(update),
    device: (sessionID) => pool.pick(sessionID),
    dispose: () => {
      abort.abort()
      clearInterval(sweep)
      pool.dispose()
    },
  }
}
