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

    const client = ctx.client.rpc(SIMULATOR_RPC)
    let stopped = false

    const handleOpen = (event: { data?: { udid?: unknown } }) => {
      const session = ctx.sessions.current() ?? ctx.sessions.list()[0]
      if (!session) return
      ctx.layout.open(`${ctx.id}:device`, session)
      const udid = typeof event.data?.udid === "string" ? event.data.udid : ""
      const location = session.location
      void client.opened({ udid }, location ? { location } : undefined).catch(() => {})
    }

    // The RPC event stream drops when the server/plugin restarts. Re-subscribe
    // so sim_start keeps working across reloads.
    void (async () => {
      while (!stopped && !ctx.signal.aborted) {
        try {
          for await (const event of client.events.subscribe("open", { signal: ctx.signal })) {
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
