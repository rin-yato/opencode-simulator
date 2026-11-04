import type { Rpc } from "@opencode/plugin"

/**
 * Shared between the server side (which emits) and the window entry (which
 * opens the panel). The event travels over the OpenCode event stream, so no
 * extra local server is needed.
 *
 * `sessionID` is the session that called the tool: the window entry must open
 * the tab in that session's strip, never in whichever session is focused when
 * the event arrives. `request` ties the ack to the exact call.
 */
export const SIMULATOR_RPC = {
  id: "opencode-simulator",
  methods: {
    opened: {
      input: {
        type: "object",
        properties: {
          request: { type: "string" },
          opened: { type: "boolean" },
        },
        required: ["request", "opened"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    device: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { udid: { type: "string" } },
        additionalProperties: false,
      },
    },
    panel: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          udid: { type: "string" },
          window: { type: "string" },
          state: {
            type: "string",
            enum: ["closed", "open", "active", "visible"],
          },
        },
        required: ["sessionID", "state"],
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
          request: { type: "string" },
          sessionID: { type: "string" },
          udid: { type: "string" },
        },
        required: ["request", "sessionID", "udid"],
        additionalProperties: false,
      },
    },
    released: {
      schema: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          udid: { type: "string" },
          force: { type: "boolean" },
        },
        required: ["sessionID", "udid", "force"],
        additionalProperties: false,
      },
    },
    deleted: {
      schema: {
        type: "object",
        properties: { udid: { type: "string" } },
        required: ["udid"],
        additionalProperties: false,
      },
    },
  },
} as const satisfies Rpc.PortableDefinition
