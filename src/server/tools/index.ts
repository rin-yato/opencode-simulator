import type { Plugin } from "@opencode/plugin"
import { cleanServeSimState, type HubOptions } from "../serve-sim"
import { SessionDevices } from "../session-devices"
import type { OpenPanel } from "./context"
import { registerInputTools } from "./input"
import { registerInspectionTools } from "./inspect"
import { registerLifecycleTools } from "./lifecycle"
import { registerSettingsTools } from "./settings"

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
  void cleanServeSimState().catch(() => {})

  await ctx.tool.transform((editor) => {
    editor.namespace({
      name: "sim",
      description:
        "Inspect and control the local iOS Simulator. Use these tools instead of xcrun simctl, axe, or Xcode for device and UI work.",
    })

    const simulator = { hub, sessions, openPanel }
    registerLifecycleTools(editor, simulator)
    registerInspectionTools(editor, simulator)
    registerInputTools(editor, simulator)
    registerSettingsTools(editor, simulator)
  })
}
