import { Command, MenuItem, Panel, Plugin, type PanelTab } from "@opencode/plugin/gui"
import main from "./gui/main"
import { SimulatorPanel } from "./gui/panel"
import en from "./gui/i18n/en"
import { SIMULATOR_RPC } from "./rpc"

const definition = Plugin.define({
  os: ["macos"],
  i18n: { en },
})

export default Plugin.define({
  ...definition,
  setup(ctx) {
    const tab: PanelTab = {
      id: "device",
      get title() {
        return ctx.t("panel.title")
      },
      closable: "compact",
    }

    ctx.add(Panel, {
      id: "device",
      region: "side",
      mobile: {
        get title() {
          return ctx.t("panel.title")
        },
        order: 42,
        kind: "menu",
        icon: "monitor",
      },
      list: (input) => (input.open.includes("device") ? [tab] : []),
      render: () => <SimulatorPanel />,
    })

    ctx.add(
      MenuItem,
      (): MenuItem => {
        const session = ctx.sessions.current()
        return {
          menu: "session.panel",
          id: "device",
          title: ctx.t("panel.title"),
          icon: "monitor",
          opened: !!session && ctx.layout.state(`${ctx.id}:device`, session) !== "closed",
          run: () => {
            const current = ctx.sessions.current()
            if (current) ctx.layout.open(`${ctx.id}:device`, current)
          },
        }
      },
    )

    ctx.add(Command, () => ({
      id: "open",
      title: ctx.t("command.open"),
      keywords: "ios simulator device xcode",
      section: "navigation" as const,
      run: () => {
        const session = ctx.sessions.current()
        if (session) ctx.layout.open(`${ctx.id}:device`, session)
      },
    }))

    // Read the client where it is used: the plugin server replaces it on reload,
    // and a client captured at setup then rejects every call.
    const client = () => ctx.client.rpc(SIMULATOR_RPC)
    let stopped = false

    const handleOpen = (event: { data?: { request?: unknown; sessionID?: unknown; udid?: unknown } }) => {
      const request = typeof event.data?.request === "string" ? event.data.request : ""
      if (!request) return
      const sessionID = typeof event.data?.sessionID === "string" ? event.data.sessionID : ""
      // Only the window that owns the calling session's tab may open the panel.
      // Never fall back to whichever session happens to be focused: the user may
      // have moved to another session while the tool was running.
      const session = ctx.sessions.list().find((candidate) => candidate.id === sessionID)
      if (!session) {
        void client().opened({ request, opened: false }).catch(() => {})
        return
      }
      ctx.layout.open(`${ctx.id}:device`, session, { background: true })
      const location = session.location
      void client()
        .opened({ request, opened: true }, location ? { location } : undefined)
        .catch(() => {})
    }

    // The RPC event stream drops when the server/plugin restarts. Re-subscribe
    // so sim_start keeps working across reloads.
    void (async () => {
      while (!stopped && !ctx.signal.aborted) {
        try {
          for await (const event of client().events.subscribe("open", { signal: ctx.signal })) {
            handleOpen(event)
          }
        } catch {}
        if (stopped || ctx.signal.aborted) return
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
    })()

    return () => {
      stopped = true
    }
  },
  main,
})
