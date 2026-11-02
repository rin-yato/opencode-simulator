import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { Plugin, Skill } from "@opencode/plugin"
import { SIMULATOR_RPC } from "./rpc"
import { registerTools } from "./server/tools/index"

const OPEN_TIMEOUT_MS = 8_000

const SKILL_FILE = fileURLToPath(new URL("./skills/simulator.md", import.meta.url))
const SKILL_DESCRIPTION =
  "Drive and test the local iOS Simulator: boot devices, read the accessibility tree, tap, scroll, type, take screenshots, and change simulator settings. Use whenever the user asks to test, debug, or inspect an iOS app UI, or mentions the simulator or an iPhone app. Use the sim_* tools, not xcrun simctl, Xcode, axe, or ad-hoc scripts."

export default Plugin.define({
  id: "opencode-simulator",
  async setup(ctx) {
    if (process.platform === "darwin") {
      try {
        const content = readFileSync(SKILL_FILE, "utf8")
        await ctx.skill.transform((editor) => {
          editor.add({
            id: Skill.ID.make("simulator"),
            name: Skill.Name.make("Simulator"),
            description: SKILL_DESCRIPTION,
            autoinvoke: true,
            path: Skill.Info.fields.path.make(SKILL_FILE),
            content,
          })
        })
      } catch (cause) {
        console.warn("opencode-simulator: could not register the simulator skill", cause)
      }
    }

    const waiters = new Map<string, (opened: boolean) => void>()

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

    await registerTools(ctx, { hubCli: ctx.options.hubCli }, openPanel)

    return async () => {
      for (const finish of waiters.values()) finish(false)
      waiters.clear()
      await rpc.dispose()
    }
  },
})
