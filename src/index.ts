import { randomUUID } from "node:crypto"
import { Plugin } from "@opencode/plugin"
import { SIMULATOR_RPC } from "./rpc"
import { registerTools } from "./server/tools"

const OPEN_TIMEOUT_MS = 8_000

export default Plugin.define({
  id: "opencode-simulator",
  async setup(ctx) {
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
        void rpc.events
          .emit("open", { request, sessionID, udid })
          .catch(() => finish(false))
      })

    await registerTools(ctx, { hubCli: ctx.options.hubCli }, openPanel)

    return async () => {
      for (const finish of waiters.values()) finish(false)
      waiters.clear()
      await rpc.dispose()
    }
  },
})
