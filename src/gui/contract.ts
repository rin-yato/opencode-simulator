import { Schema } from "effect"
import { Ipc } from "@opencode/plugin/gui"

export const SimulatorIpc = Ipc.define({
  id: "opencode-simulator.pane",
  methods: {
    register: {
      output: Schema.Struct({
        embed: Schema.String,
        url: Schema.String,
      }),
    },
    close: {
      input: Schema.Struct({ embed: Schema.String }),
    },
  },
  events: {
    failed: Schema.Struct({
      embed: Schema.String,
      detail: Schema.String,
    }),
    restarted: Schema.Struct({
      url: Schema.String,
    }),
  },
})
