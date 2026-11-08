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
        /** The simulator to stream. Required: never stream whichever device is booted. */
        device: Schema.String,
        /** The serve-sim CLI the server found; main cannot resolve it itself. */
        cli: Schema.optional(Schema.String),
        /** OpenCode's color scheme, so the preview loads in it. */
        mode: Schema.optional(Schema.Literals(["light", "dark"])),
      }),
      output: Schema.Struct({
        embed: Schema.String,
        url: Schema.String,
      }),
    },
    theme: {
      input: Schema.Struct({
        embed: Schema.String,
        mode: Schema.Literals(["light", "dark"]),
      }),
    },
    close: {
      input: Schema.Struct({ embed: Schema.String }),
    },
    /**
     * The panel left the screen (another tab or session). Keep the view alive
     * and hidden so coming back does not reload the stream.
     */
    detach: {
      input: Schema.Struct({ embed: Schema.String }),
    },
    release: {
      input: Schema.Struct({
        device: Schema.String,
        /** Stop the hub even when a pane still shows the device (deleted). */
        force: Schema.optional(Schema.Boolean),
      }),
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
