import type { Rpc } from "@opencode/plugin"

/**
 * Shared between the server side (which emits) and the window entry (which
 * opens the panel). The event travels over the OpenCode event stream, so no
 * extra local server is needed.
 */
export const SIMULATOR_RPC = {
  id: "opencode-simulator",
  methods: {
    opened: {
      input: {
        type: "object",
        properties: {
          udid: { type: "string" },
        },
        required: ["udid"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  events: {
    open: {
      schema: {
        type: "object",
        properties: {
          udid: { type: "string" },
        },
        required: ["udid"],
        additionalProperties: false,
      },
    },
  },
} as const satisfies Rpc.PortableDefinition
