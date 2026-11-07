import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { Plugin, Skill } from "@opencode/plugin"
import { SIMULATOR_RPC } from "./rpc"
import { isPanelState } from "./server/activity"
import { resolveServeSim } from "./server/serve-sim"
import { registerTools, type SimulatorHandle } from "./server/tools/index"
import { parseSkillFile } from "./skills/frontmatter"

const OPEN_TIMEOUT_MS = 8_000

const SKILL_FILE = fileURLToPath(new URL("./skills/simulator.md", import.meta.url))
const SKILL_ID = Skill.ID.make("simulator")
const SKILL_NAME = Skill.Name.make("Simulator")
/**
 * The skill's own description is what makes the model load it, so it lives in
 * the skill file's frontmatter. This is the fallback for a file that lost its
 * frontmatter: without a description the skill is never advertised.
 */
const SKILL_DESCRIPTION_FALLBACK =
  "Drive and test the local iOS Simulator: boot devices, read the accessibility tree, tap, scroll, type, take screenshots, and change simulator settings. Use whenever the user asks to test, debug, or inspect an iOS app UI, or mentions the simulator or an iPhone app. Use the sim_* tools, not xcrun simctl, Xcode, axe, or ad-hoc scripts."

export default Plugin.define({
  id: "opencode-simulator",
  async setup(ctx) {
    if (process.platform === "darwin") {
      try {
        const raw = readFileSync(SKILL_FILE, "utf8")
        const { frontmatter, content } = parseSkillFile(raw)
        await ctx.skill.transform((editor) => {
          editor.add({
            id: SKILL_ID,
            name: Skill.Name.make(frontmatter.name ?? SKILL_NAME),
            // The description is what the model reads to decide whether the
            // skill is relevant. Without one the skill is never advertised.
            description: frontmatter.description ?? SKILL_DESCRIPTION_FALLBACK,
            autoinvoke: frontmatter.autoinvoke ?? true,
            path: Skill.Info.fields.path.make(SKILL_FILE),
            content,
          })
        })
      } catch (cause) {
        console.warn("opencode-simulator: could not register the simulator skill", cause)
      }
    }

    const waiters = new Map<string, (opened: boolean) => void>()
    let simulator: SimulatorHandle | undefined
    let markSimulatorReady: ((handle: SimulatorHandle) => void) | undefined
    const simulatorReady = new Promise<SimulatorHandle>((resolve) => {
      markSimulatorReady = resolve
    })

    const rpc = await ctx.rpc.register(SIMULATOR_RPC, {
      opened: async (input) => {
        const data = input as { request?: unknown; opened?: unknown } | undefined
        if (typeof data?.request === "string") {
          const finish = waiters.get(data.request)
          // A window without the calling session's tab answers `opened: false`;
          // another window may still have it, so only a true ack settles.
          if (finish && data.opened === true) finish(true)
        }
        return {}
      },
      device: async (input) => {
        const data = input as { sessionID?: unknown } | undefined
        if (typeof data?.sessionID === "string") {
          const handle = simulator ?? (await simulatorReady)
          const udid = handle.device(data.sessionID)
          return udid ? { udid } : {}
        }
        return {}
      },
      hub: async () => {
        const cli = resolveServeSim({ hubCli: ctx.options.hubCli })
        return cli ? { cli } : {}
      },
      panel: async (input) => {
        const data = input as
          { sessionID?: unknown; state?: unknown; udid?: unknown; window?: unknown } | undefined
        if (typeof data?.sessionID === "string" && isPanelState(data.state)) {
          // A window can restore its panel before tool registration finishes.
          // Wait for the handle instead of dropping the state.
          const handle = simulator ?? (await simulatorReady)
          await handle.panel({
            sessionID: data.sessionID,
            state: data.state,
            ...(typeof data.udid === "string" && data.udid ? { udid: data.udid } : {}),
            ...(typeof data.window === "string" && data.window ? { window: data.window } : {}),
          })
        }
        return {}
      },
    })

    const openPanel = (udid: string, sessionID: string) =>
      new Promise<boolean>((resolve) => {
        const request = randomUUID()
        let settled = false
        let timer: ReturnType<typeof setTimeout> | undefined

        const finish = (opened: boolean) => {
          if (settled) return
          settled = true
          if (timer) clearTimeout(timer)
          waiters.delete(request)
          resolve(opened)
        }

        waiters.set(request, finish)
        timer = setTimeout(() => finish(false), OPEN_TIMEOUT_MS)
        void rpc.events.emit("open", { request, sessionID, udid }).catch(() => finish(false))
      })

    simulator = await registerTools(ctx, { hubCli: ctx.options.hubCli }, openPanel, {
      onRelease: (sessionID, udid, force) => {
        void rpc.events.emit("released", { sessionID, udid, force }).catch(() => {})
      },
      onDeviceDeleted: (udid) => {
        void rpc.events.emit("deleted", { udid }).catch(() => {})
      },
    })
    markSimulatorReady?.(simulator)

    return async () => {
      for (const finish of waiters.values()) finish(false)
      waiters.clear()
      simulator?.dispose()
      await rpc.dispose()
    }
  },
})
