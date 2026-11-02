import { Plugin } from "@opencode/plugin"
import { registerTools } from "./server/tools"

export default Plugin.define({
  id: "opencode-simulator",
  async setup(ctx) {
    await registerTools(ctx, { hubCli: ctx.options.hubCli })
  },
})
