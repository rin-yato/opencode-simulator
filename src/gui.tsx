import { Command, MenuItem, Panel, Plugin, type PanelTab } from "@opencode/plugin/gui"
import main from "./gui/main"
import { SimulatorPanel } from "./gui/panel"
import en from "./gui/i18n/en"

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
  },
  main,
})
