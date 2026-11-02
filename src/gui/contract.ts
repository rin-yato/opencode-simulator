import { Schema } from "effect"
import { Ipc } from "@opencode/plugin/gui"

export const SimulatorIpc = Ipc.define({
  id: "opencode-simulator.pane",
  methods: {
    register: {
      input: Schema.Struct({
        /**
         * The session that owns the panel. Several sessions can show a panel at
         * once, each attached to a different simulator.
         */
        key: Schema.String,
        /** The simulator to stream. Omitted opens whichever device is booted. */
        device: Schema.optional(Schema.String),
      }),
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
      embed: Schema.String,
      url: Schema.String,
    }),
  },
})
