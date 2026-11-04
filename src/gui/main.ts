import { WebContentsView, session as electronSession, type BrowserWindow } from "electron"
import type { Embed, Plugin } from "@opencode/plugin/gui/main"
import { SimulatorIpc } from "./contract"
import { createHubManager } from "./hub"

interface Pane {
  readonly windowId: number
  /** The session that owns the panel; one pane per window and session. */
  readonly sessionKey: string
  /** The device this pane streams. */
  readonly device: string
  url: string
  readonly view: WebContentsView
  readonly embed: Embed
}

const paneId = (windowId: number, sessionKey: string) => `${windowId}\u0000${sessionKey}`

/** How long a hub lives after its last panel closes, so reopening is instant. */
const RELEASE_IDLE_MS = 30_000

const setup: Plugin.MainSetup = (ctx) => {
  ctx.log.write("info", "opencode-simulator main loaded")
  const hub = createHubManager(ctx)
  const simulatorSession = electronSession.fromPartition("persist:opencode-simulator")
  simulatorSession.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  )
  const panes = new Map<string, Pane>()
  const byEmbed = new Map<string, Pane>()
  const idleTimers = new Map<string, ReturnType<typeof setTimeout>>()

  const hasPaneFor = (device: string) => [...panes.values()].some((pane) => pane.device === device)

  const cancelRelease = (device: string) => {
    const timer = idleTimers.get(device)
    if (!timer) return
    clearTimeout(timer)
    idleTimers.delete(device)
  }

  const scheduleRelease = (device: string) => {
    if (hasPaneFor(device)) return
    cancelRelease(device)
    const key = device
    idleTimers.set(
      key,
      setTimeout(() => {
        idleTimers.delete(key)
        if (hasPaneFor(device)) return
        void hub.release(device).catch((cause) => {
          ctx.log.write("warn", "Could not release the simulator hub", {
            device,
            error: String(cause),
          })
        })
      }, RELEASE_IDLE_MS),
    )
  }

  const disposePane = (pane: Pane) => {
    panes.delete(paneId(pane.windowId, pane.sessionKey))
    byEmbed.delete(pane.embed.id)
    pane.embed.dispose()
    try {
      pane.view.webContents.close()
    } catch {}
    scheduleRelease(pane.device)
  }

  const provider = ctx.provide(SimulatorIpc, {
    register: async (input, caller) => {
      const id = paneId(caller.window, input.key)
      const existing = panes.get(id)
      if (existing && existing.device === input.device) {
        return { embed: existing.embed.id, url: existing.url }
      }
      // The session asked for another simulator: drop the old view and attach a
      // new one to the hub that serves the requested device.
      if (existing) disposePane(existing)

      const window = ctx.windows.get(caller.window)
      if (!window) throw new Error("The window that asked for the simulator is gone.")

      // The panel wants this device again: cancel any pending idle release before
      // the hub starts, so a timer cannot abort a start that is already underway.
      cancelRelease(input.device)
      const { url } = await hub.ensure(input.device)

      const view = new WebContentsView({
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          session: simulatorSession,
        },
      })
      view.setBackgroundColor("#000000")
      view.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
      const allowedOrigin = new URL(url).origin
      const allowNavigation = (target: string): boolean => {
        try {
          return new URL(target).origin === allowedOrigin
        } catch {
          return false
        }
      }
      view.webContents.on("will-navigate", (event, target) => {
        if (!allowNavigation(target)) event.preventDefault()
      })
      view.webContents.on("will-redirect", (event, target) => {
        if (!allowNavigation(target)) event.preventDefault()
      })

      const embed = ctx.embeds.create(view, window)
      const pane: Pane = {
        windowId: caller.window,
        sessionKey: input.key,
        device: input.device,
        url,
        view,
        embed,
      }
      panes.set(id, pane)
      byEmbed.set(embed.id, pane)

      view.webContents.on("did-fail-load", (_event, code, description, _url, isMainFrame) => {
        if (!isMainFrame || code === -3) return
        provider.emit("failed", { embed: embed.id, detail: `${description} (${code})` })
      })
      view.webContents.on("render-process-gone", (_event, details) => {
        provider.emit("failed", {
          embed: embed.id,
          detail: `The viewer process stopped: ${details.reason}`,
        })
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

    release: async (input) => {
      // Another pane may still show this device (explicit sharing or another
      // window's session). Pane disposal schedules the real release.
      if (!input.force && hasPaneFor(input.device)) return
      await hub.release(input.device)
    },
  })

  const stopStarted = hub.onStarted(({ device, url }) => {
    for (const pane of panes.values()) {
      // A restarted hub only replaces its own device's preview; other devices
      // keep their panes and embeds.
      if (pane.device !== device) continue
      pane.url = url
      void pane.view.webContents.loadURL(url).catch((cause) => {
        provider.emit("failed", { embed: pane.embed.id, detail: String(cause) })
      })
      provider.emit("restarted", { embed: pane.embed.id, url })
    }
  })

  const onWindowClose = (window: BrowserWindow) => {
    for (const pane of [...panes.values()]) {
      if (pane.windowId === window.id) disposePane(pane)
    }
  }
  ctx.windows.list().forEach(onWindowClose)
  ctx.windows.on("close", onWindowClose)

  ctx.onCleanup(() => {
    stopStarted()
    for (const pane of [...panes.values()]) disposePane(pane)
    for (const timer of idleTimers.values()) clearTimeout(timer)
    idleTimers.clear()
    void hub.dispose()
    provider.dispose()
  })
}

export default setup
