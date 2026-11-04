import { createEffect } from "solid-js"
import { Command, MenuItem, Panel, Plugin, type PanelTab } from "@opencode/plugin/gui"
import main from "./gui/main"
import { SimulatorPanel } from "./gui/panel"
import en from "./gui/i18n/en"
import { clearDevice, requestDevice, requestedDevice } from "./gui/requests"
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
      render: (props) => <SimulatorPanel session={props.session} />,
    })

    ctx.add(MenuItem, (): MenuItem => {
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
    })

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

    const handleOpen = (event: {
      data?: { request?: unknown; sessionID?: unknown; udid?: unknown }
    }) => {
      const request = typeof event.data?.request === "string" ? event.data.request : ""
      if (!request) return
      const sessionID = typeof event.data?.sessionID === "string" ? event.data.sessionID : ""
      // Only the window that owns the calling session's tab may open the panel.
      // Never fall back to whichever session happens to be focused: the user may
      // have moved to another session while the tool was running.
      const session = ctx.sessions.list().find((candidate) => candidate.id === sessionID)
      if (!session) {
        void client()
          .opened({ request, opened: false })
          .catch(() => {})
        return
      }
      const udid = typeof event.data?.udid === "string" ? event.data.udid : ""
      // Record the device before mounting the tab: the panel reads it on mount
      // and asks the main process for a hub locked to that simulator.
      if (udid) requestDevice(session.key, udid)
      ctx.layout.open(`${ctx.id}:device`, session, { background: true })
      const location = session.location
      void client()
        .opened({ request, opened: true }, location ? { location } : undefined)
        .catch(() => {})
    }

    // The panel is the usage signal. Tell the server when it opens or closes
    // so a device is released as soon as the user closes it and the session is
    // idle. Serialize calls so a close cannot overtake a newer open.
    type PanelState = "closed" | "open" | "active" | "visible"

    const panelKey = `${ctx.id}:device`
    const known = new Map<string, { key: string; state: PanelState; udid?: string }>()
    let panelQueue: Promise<unknown> = Promise.resolve()

    const withTimeout = <T,>(promise: Promise<T>, ms: number): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined
      return Promise.race([
        promise.finally(() => {
          if (timer) clearTimeout(timer)
        }),
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => reject(new Error("The simulator server did not answer.")), ms)
        }),
      ])
    }

    const sendPanel = (input: { sessionID: string; state: PanelState; udid?: string }) => {
      panelQueue = panelQueue.then(() => withTimeout(client().panel(input), 5_000)).catch(() => {})
    }

    const syncPanels = (force = false) => {
      if (!ctx.layout.ready()) return

      const sessions = ctx.sessions.list()
      const open = new Set<string>()
      for (const session of sessions) {
        open.add(session.id)
        // A moved or reconnecting session has no location yet, and the layout
        // reports every tab as closed. Keep the last known state until it loads.
        if (!session.location) continue
        const state = ctx.layout.state(panelKey, session)
        const udid = state === "closed" ? undefined : requestedDevice(session.key)
        const previous = known.get(session.id)
        if (
          force ||
          previous?.key !== session.key ||
          previous.state !== state ||
          previous.udid !== udid
        ) {
          known.set(session.id, { key: session.key, state, ...(udid ? { udid } : {}) })
          sendPanel({ sessionID: session.id, state, ...(udid ? { udid } : {}) })
        }
      }

      for (const [sessionID, entry] of [...known]) {
        if (open.has(sessionID)) continue
        known.delete(sessionID)
        clearDevice(entry.key)
        sendPanel({ sessionID, state: "closed" })
      }
    }

    createEffect(() => syncPanels())

    // A server or plugin restart can drop a panel update. Resending the full
    // state is cheap and makes the server converge without tracking reconnects.
    const heartbeat = setInterval(() => syncPanels(true), 10_000)

    // The RPC event stream drops when the server/plugin restarts. Re-subscribe
    // so sim_start keeps working across reloads, and resend panel state so a
    // restored panel re-claims its device.
    void (async () => {
      while (!stopped && !ctx.signal.aborted) {
        try {
          for await (const event of client().events.subscribe("open", { signal: ctx.signal })) {
            handleOpen(event)
          }
        } catch {}
        if (stopped || ctx.signal.aborted) return
        syncPanels(true)
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
    })()

    // The server releases a device after the panel closes and the session goes
    // idle. Clear the stored device so reopening the panel cannot stream a
    // simulator that another session may own by then.
    void (async () => {
      while (!stopped && !ctx.signal.aborted) {
        try {
          for await (const event of client().events.subscribe("released", {
            signal: ctx.signal,
          })) {
            const sessionID = typeof event.data?.sessionID === "string" ? event.data.sessionID : ""
            const udid = typeof event.data?.udid === "string" ? event.data.udid : ""
            if (!sessionID || !udid) continue
            const session = ctx.sessions.list().find((candidate) => candidate.id === sessionID)
            if (!session) continue
            if (ctx.layout.state(panelKey, session) !== "closed") continue
            if (requestedDevice(session.key) !== udid) continue
            clearDevice(session.key)
          }
        } catch {}
        if (stopped || ctx.signal.aborted) return
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
    })()

    return () => {
      stopped = true
      clearInterval(heartbeat)
      for (const [sessionID, entry] of known) {
        if (entry.state === "closed") continue
        try {
          void client()
            .panel({ sessionID, state: "closed" })
            .catch(() => {})
        } catch {}
      }
      known.clear()
    }
  },
  main,
})
