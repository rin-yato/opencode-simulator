import { WebContentsView, type BrowserWindow } from "electron"
import type { Embed, Plugin } from "@opencode/plugin/gui/main"
import { SimulatorIpc } from "./contract"
import { createHubManager } from "./hub"

interface Pane {
  readonly windowId: number
  url: string
  readonly view: WebContentsView
  readonly embed: Embed
}

const setup: Plugin.MainSetup = (ctx) => {
  ctx.log.write("info", "opencode-simulator main loaded")
  const hub = createHubManager(ctx)
  const panes = new Map<number, Pane>()
  const byEmbed = new Map<string, Pane>()

  const disposePane = (pane: Pane) => {
    panes.delete(pane.windowId)
    byEmbed.delete(pane.embed.id)
    pane.embed.dispose()
    try {
      pane.view.webContents.close()
    } catch {}
  }

  const disposeAll = () => {
    for (const pane of panes.values()) disposePane(pane)
  }

  const provider = ctx.provide(SimulatorIpc, {
    register: async (_input, caller) => {
      const existing = panes.get(caller.window)
      if (existing) return { embed: existing.embed.id, url: existing.url }

      const window = ctx.windows.get(caller.window)
      if (!window) throw new Error("The window that asked for the simulator is gone.")

      const { url } = await hub.ensure()
      const view = new WebContentsView({
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      })
      view.setBackgroundColor("#000000")
      view.webContents.setWindowOpenHandler(() => ({ action: "deny" }))

      const embed = ctx.embeds.create(view, window)
      const pane: Pane = { windowId: caller.window, url, view, embed }
      panes.set(caller.window, pane)
      byEmbed.set(embed.id, pane)

      view.webContents.on("did-fail-load", (_event, code, description, _url, isMainFrame) => {
        if (!isMainFrame || code === -3) return
        provider.emit("failed", { embed: embed.id, detail: `${description} (${code})` })
      })
      view.webContents.on("render-process-gone", (_event, details) => {
        provider.emit("failed", { embed: embed.id, detail: `The viewer process stopped: ${details.reason}` })
      })

      try {
        await view.webContents.loadURL(url)
      } catch (cause) {
        disposePane(pane)
        throw cause
      }
      embed.show(true)
      return { embed: embed.id, url }
    },
    close: (input, caller) => {
      const pane = byEmbed.get(input.embed)
      if (!pane || pane.windowId !== caller.window) return
      disposePane(pane)
    },
  })

  const stopStarted = hub.onStarted((url) => {
    for (const pane of panes.values()) {
      pane.url = url
      void pane.view.webContents.loadURL(url).catch((cause) => {
        provider.emit("failed", { embed: pane.embed.id, detail: String(cause) })
      })
    }
    provider.emit("restarted", { url })
  })

  const onWindowClose = (window: BrowserWindow) => {
    const pane = panes.get(window.id)
    if (pane) disposePane(pane)
  }
  ctx.windows.list().forEach(onWindowClose)
  ctx.windows.on("close", onWindowClose)

  ctx.onCleanup(() => {
    stopStarted()
    disposeAll()
    void hub.dispose()
    provider.dispose()
  })
}

export default setup
