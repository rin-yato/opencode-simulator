import type { Plugin } from "@opencode/plugin"
import { pruneCopies } from "../cleanup"
import { Copies, DEFAULT_COPY_TTL_DAYS } from "../copies"
import { cleanServeSimState, type HubOptions } from "../serve-sim"
import { SessionDevices } from "../session-devices"
import { Templates } from "../templates"
import type { OpenPanel } from "./context"
import { registerInputTools } from "./input"
import { registerInspectionTools } from "./inspect"
import { registerLifecycleTools } from "./lifecycle"
import { registerSettingsTools } from "./settings"

type SessionID = Parameters<Plugin.Context["session"]["get"]>[0]["sessionID"]

/**
 * A copy is named after the flow under test. Use the session title when the
 * agent did not pass a label; a failed lookup must never block starting.
 */
const sessionTitle = (ctx: Plugin.Context) => async (sessionID: string) => {
  try {
    const session = await ctx.session.get({ sessionID: sessionID as SessionID })
    return session.title
  } catch {
    return undefined
  }
}

const copyTtlDays = (ctx: Plugin.Context): number => {
  const configured =
    process.env.OPENCODE_SIMULATOR_COPY_TTL_DAYS ??
    (typeof ctx.options.copyTtlDays === "number" ? String(ctx.options.copyTtlDays) : undefined)
  if (configured === undefined) return DEFAULT_COPY_TTL_DAYS
  const value = Number(configured)
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_COPY_TTL_DAYS
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
): Promise<void> {
  const sessions = await SessionDevices.load(ctx.storage)
  const templates = await Templates.load(ctx.storage)
  const copies = await Copies.load(ctx.storage)
  const ttlDays = copyTtlDays(ctx)
  void cleanServeSimState().catch(() => {})

  const simulator = {
    hub,
    sessions,
    templates,
    copies,
    copyTtlDays: ttlDays,
    openPanel,
    sessionTitle: sessionTitle(ctx),
  }

  // Old copies should not survive a restart forever. This is best-effort and
  // only touches devices the plugin leased, never user devices or templates.
  if (ttlDays > 0) {
    void pruneCopies({
      copies,
      templates,
      sessions,
      ttlDays,
      dryRun: false,
    }).catch((cause) => {
      console.warn("opencode-simulator: could not prune old copies", cause)
    })
  }

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
}
