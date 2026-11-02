import { Plugin } from "@opencode/plugin"
import { SIMULATOR_RPC } from "./rpc"
import { registerTools } from "./server/tools"

export default Plugin.define({
  id: "opencode-simulator",
  async setup(ctx) {
    const waiters = new Map<string, Set<() => void>>()

    const rpc = await ctx.rpc.register(SIMULATOR_RPC, {
      opened: async (input) => {
        const udid = (input as { udid?: unknown } | undefined)?.udid
        if (typeof udid === "string") {
          const pending = waiters.get(udid)
          if (pending) for (const resolve of [...pending]) resolve()
        }
        return {}
      },
    })

    const openPanel = (udid: string) =>
      new Promise<boolean>((resolve) => {
        let settled = false
        let timer: ReturnType<typeof setTimeout>
        const pending = waiters.get(udid) ?? new Set<() => void>()
        waiters.set(udid, pending)

        const finish = (opened: boolean) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          pending.delete(done)
          if (pending.size === 0) waiters.delete(udid)
          resolve(opened)
        }
        const done = () => finish(true)

        pending.add(done)
        timer = setTimeout(() => finish(false), 3_000)
        void rpc.events.emit("open", { udid }).catch(() => finish(false))
      })

    await registerTools(ctx, { hubCli: ctx.options.hubCli }, openPanel)

    return async () => {
      await rpc.dispose()
    }
  },
})
