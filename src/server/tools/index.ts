import type { Plugin } from "@opencode/plugin"
import { Activity, type PanelUpdate } from "../activity"
import { cleanServeSimState, type HubOptions } from "../serve-sim"
import { SessionDevices } from "../session-devices"
import type { OpenPanel } from "./context"
import { registerInputTools } from "./input"
import { registerInspectionTools } from "./inspect"
import { registerLifecycleTools } from "./lifecycle"
import { registerSettingsTools } from "./settings"

export interface SimulatorHandle {
  /** Panel state pushed by the desktop window. */
  readonly panel: (update: PanelUpdate) => Promise<void>
  dispose(): void
}

const ACTIVITY_EVENTS = [
  "session.execution.started",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.idle",
  "session.deleted",
  "session.archived",
] as const

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Track agent turns so a simulator is not released while its session is still
 * working. Panels cover the user's side; this covers the agent's.
 *
 * The stream can drop when the server reloads. Re-subscribe with a short delay;
 * a missed event only leaves a claim busy, which the pool cap bounds.
 */
const watchActivity = (ctx: Plugin.Context, activity: Activity, signal: AbortSignal): void => {
  void (async () => {
    while (!signal.aborted) {
      try {
        for await (const event of ctx.event.subscribe({ types: ACTIVITY_EVENTS, signal })) {
          const data = event.data as { readonly sessionID?: unknown } | undefined
          const sessionID = typeof data?.sessionID === "string" ? data.sessionID : undefined
          if (!sessionID) continue

          switch (event.type) {
            case "session.execution.started":
              activity.started(sessionID)
              break
            case "session.execution.failed":
            case "session.execution.interrupted":
            case "session.idle":
              await activity.idle(sessionID)
              break
            case "session.deleted":
            case "session.archived":
              await activity.close(sessionID)
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
 * - lifecycle: discover, boot, create, delete, show, and launch apps
 * - inspect:   status, accessibility reads, waits, screenshots
 * - input:     taps, scrolling, typing, hardware buttons, rotation
 * - settings:  UI settings, software keyboard, status bar
 */
export async function registerTools(
  ctx: Plugin.Context,
  hub: HubOptions,
  openPanel?: OpenPanel,
  onRelease?: (sessionID: string, udid: string) => void,
): Promise<SimulatorHandle> {
  const sessions = await SessionDevices.load(ctx.storage)
  const activity = new Activity({ sessions, onRelease })
  const simulator = { hub, sessions, activity, openPanel }
  const abort = new AbortController()

  void cleanServeSimState().catch(() => {})
  watchActivity(ctx, activity, abort.signal)

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
    panel: (update) => activity.panel(update),
    dispose: () => {
      abort.abort()
      activity.dispose()
    },
  }
}
