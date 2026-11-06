import type { Device } from "./devices"
import { listDevices, shutdownDevice } from "./devices"
import type { SessionDevices } from "./session-devices"

/**
 * Who is using a simulator.
 *
 * A device is busy while a panel is open (the user can see or reopen it) or
 * while the session that owns it is running (the agent is still working). A
 * hold keeps a claim past the turn end until an explicit release or TTL.
 * Panels are leased: a dead window stops refreshing and is released.
 */
export type PanelState = "closed" | "open" | "active" | "visible"

export const PANEL_STATES = ["closed", "open", "active", "visible"] as const

export const isPanelState = (value: unknown): value is PanelState =>
  typeof value === "string" && (PANEL_STATES as readonly string[]).includes(value)

export type ReleaseState = "held" | "panel" | "turn" | "idle"

export interface PanelUpdate {
  readonly sessionID: string
  readonly state: PanelState
  readonly udid?: string
  /** Window or pane identity. Omit for the server's short-lived start lease. */
  readonly window?: string
  /** Override the panel lease. */
  readonly ttlMs?: number
}

export interface ActivityOptions {
  readonly sessions: SessionDevices
  /** Delay before shutting down a released device. `0` disables shutdown. */
  readonly shutdownDelayMs?: number
  /** Test seam. Defaults to `simctl shutdown`. */
  readonly shutdown?: (device: Device) => Promise<unknown>
  /** Test seam. Defaults to `simctl list`. */
  readonly list?: () => Promise<readonly Device[]>
  /** Called after a claim is taken or released; `force` asks the window to clear it. */
  readonly onRelease?: (sessionID: string, udid: string, force: boolean) => void
  /** Called after a claim changes hands, so a managed device's name can follow it. */
  readonly onChange?: (udid: string) => void | Promise<void>
  /** Only managed devices are sold back to the pool's shutdown policy. */
  readonly shouldShutdown?: (udid: string) => boolean
}

const DEFAULT_SHUTDOWN_DELAY_MS = 60_000
const DEFAULT_PANEL_TTL_MS = 30_000

const STATE_RANK: Record<PanelState, number> = {
  closed: 0,
  open: 1,
  active: 2,
  visible: 3,
}

interface PanelEntry {
  readonly sessionID: string
  readonly window: string
  readonly udid: string
  readonly state: Exclude<PanelState, "closed">
  readonly expiresAt: number
}

export class Activity {
  readonly #sessions: SessionDevices
  readonly #shutdownDelayMs: number
  readonly #shutdownDevice: (device: Device) => Promise<unknown>
  readonly #list: () => Promise<readonly Device[]>
  readonly #onRelease: ((sessionID: string, udid: string, force: boolean) => void) | undefined
  readonly #onChange: ((udid: string) => void | Promise<void>) | undefined
  readonly #shouldShutdown: (udid: string) => boolean
  readonly #panels = new Map<string, PanelEntry>()
  readonly #running = new Set<string>()
  /** sessionID -> expiry; undefined means held until an explicit release. */
  readonly #holds = new Map<string, number | undefined>()
  readonly #deleted = new Set<string>()
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>()
  #stopped = false

  constructor(options: ActivityOptions) {
    this.#sessions = options.sessions
    this.#shutdownDelayMs = options.shutdownDelayMs ?? DEFAULT_SHUTDOWN_DELAY_MS
    this.#shutdownDevice = options.shutdown ?? ((device) => shutdownDevice(device))
    this.#list = options.list ?? (() => listDevices())
    this.#onRelease = options.onRelease
    this.#onChange = options.onChange
    this.#shouldShutdown = options.shouldShutdown ?? (() => true)
  }

  /**
   * Update one window's panel. A panel with no existing claim claims a free
   * device. Closing it releases the claim once no other window, running turn,
   * or hold needs it.
   */
  async panel(update: PanelUpdate): Promise<void> {
    if (this.#stopped) return
    const window = update.window?.trim() || "server"
    const key = this.#panelKey(window, update.sessionID)

    if (update.state === "closed") {
      this.#panels.delete(key)
      await this.#releaseIfIdle(update.sessionID)
      return
    }

    // A window that does not know the device yet reports the panel without
    // one. The session's own claim is the device that panel shows, and using
    // it keeps the claim alive: a released claim would leave the panel
    // pointing at a simulator nobody owns.
    const udid = update.udid?.trim() || this.#sessions.pick(update.sessionID)
    if (!udid || this.#deleted.has(udid)) return

    const ttl = update.ttlMs && update.ttlMs > 0 ? update.ttlMs : DEFAULT_PANEL_TTL_MS
    const previous = this.#panels.get(key)
    this.#panels.set(key, {
      sessionID: update.sessionID,
      window,
      udid,
      state: update.state,
      expiresAt: Date.now() + ttl,
    })
    this.#cancelShutdown(udid)
    if (!this.#sessions.pick(update.sessionID)) {
      if (await this.#sessions.claim(update.sessionID, udid)) await this.#onChange?.(udid)
    }
    // The panel moved away; nothing else will look at the device it left.
    if (previous && previous.udid !== udid) {
      await this.#onChange?.(previous.udid)
      await this.#maybeShutdown(previous.udid)
    }
  }

  /**
   * The session's claim moved off `from`. Drop this session's panels there so
   * they cannot keep it busy, then apply the shutdown policy to it.
   */
  async moved(sessionID: string, from: string): Promise<void> {
    for (const [key, panel] of this.#panels) {
      if (panel.sessionID === sessionID && panel.udid === from) this.#panels.delete(key)
    }
    await this.#maybeShutdown(from)
  }

  /** The agent started a turn; its device must not be released mid-work. */
  started(sessionID: string): void {
    this.#running.add(sessionID)
    const udid = this.#sessions.pick(sessionID)
    if (udid) this.#cancelShutdown(udid)
  }

  /** The agent finished a turn. Release the device if nothing else needs it. */
  async idle(sessionID: string): Promise<void> {
    this.#running.delete(sessionID)
    await this.#releaseIfIdle(sessionID)
  }

  /** The session was deleted or archived: forget panels, holds, and running. */
  async close(sessionID: string): Promise<void> {
    this.#deletePanelsForSession(sessionID)
    this.#running.delete(sessionID)
    this.#holds.delete(sessionID)
    await this.#releaseIfIdle(sessionID)
  }

  /** Keep the session's device past the end of this turn. */
  hold(sessionID: string, ttlMs?: number): void {
    this.#holds.set(sessionID, ttlMs && ttlMs > 0 ? Date.now() + ttlMs : undefined)
    const udid = this.#sessions.pick(sessionID)
    if (udid) this.#cancelShutdown(udid)
  }

  /**
   * Explicit release: clear panels/holds and forget the claim now. Emits a
   * forced release so the window empties its panel even when it is open.
   */
  async releaseManual(sessionID: string, expectedUdid?: string): Promise<string | undefined> {
    if (this.#stopped) return undefined
    const owned = this.#sessions.pick(sessionID)
    const panelDevice = this.panelDevice(sessionID)
    const udid = owned ?? panelDevice
    if (expectedUdid && udid && udid !== expectedUdid) return undefined

    this.#deletePanelsForSession(sessionID)
    this.#holds.delete(sessionID)
    if (owned) await this.#sessions.forgetSession(sessionID)
    if (!udid) return undefined

    // The window keys its panel by the device it shows, which can differ from
    // the session's claim after sim_create/sim_boot. Force-clear both.
    const targets = new Set<string>([udid])
    if (panelDevice) targets.add(panelDevice)
    for (const target of targets) {
      await this.#onChange?.(target)
      this.#onRelease?.(sessionID, target, true)
      await this.#maybeShutdown(target)
    }
    return udid
  }

  /** Forget a deleted device and stop its window from re-claiming it. */
  forget(udid: string): void {
    for (const [key, panel] of this.#panels) {
      if (panel.udid === udid) this.#panels.delete(key)
    }
    this.#cancelShutdown(udid)
    this.#deleted.add(udid)
    while (this.#deleted.size > 200) {
      const oldest = this.#deleted.values().next().value
      if (oldest === undefined) break
      this.#deleted.delete(oldest)
    }
  }

  /** Cancel a pending shutdown when a session claims this device again. */
  use(udid: string): void {
    this.#cancelShutdown(udid)
  }

  /** Expire panels that a window stopped refreshing and holds past their TTL. */
  async expirePanels(now = Date.now()): Promise<number> {
    const affected = new Set<string>()
    let changed = 0
    for (const [key, panel] of this.#panels) {
      if (panel.expiresAt > now) continue
      this.#panels.delete(key)
      affected.add(panel.sessionID)
      changed += 1
    }
    for (const [sessionID, expiresAt] of this.#holds) {
      if (expiresAt === undefined || expiresAt > now) continue
      this.#holds.delete(sessionID)
      affected.add(sessionID)
      changed += 1
    }
    for (const sessionID of affected) await this.#releaseIfIdle(sessionID)
    return changed
  }

  panelState(sessionID: string): PanelState {
    let best: PanelState = "closed"
    for (const panel of this.#panels.values()) {
      if (panel.sessionID !== sessionID) continue
      if (STATE_RANK[panel.state] > STATE_RANK[best]) best = panel.state
    }
    return best
  }

  panelDevice(sessionID: string): string | undefined {
    let best: PanelEntry | undefined
    for (const panel of this.#panels.values()) {
      if (panel.sessionID !== sessionID) continue
      if (!best || STATE_RANK[panel.state] > STATE_RANK[best.state]) best = panel
    }
    return best?.udid
  }

  releaseState(sessionID: string): ReleaseState {
    if (this.isHeld(sessionID)) return "held"
    if (this.panelState(sessionID) !== "closed") return "panel"
    if (this.#sessions.pick(sessionID) && this.#running.has(sessionID)) return "turn"
    return "idle"
  }

  isRunning(sessionID: string): boolean {
    return this.#running.has(sessionID)
  }

  isHeld(sessionID: string, now = Date.now()): boolean {
    const expiresAt = this.#holds.get(sessionID)
    if (expiresAt === undefined) return this.#holds.has(sessionID)
    if (expiresAt <= now) return false
    return true
  }

  /**
   * Is someone other than `except` using this device? Claims are checked by the
   * caller; this covers open panels and running sessions.
   */
  isBusy(udid: string, except?: string): boolean {
    for (const panel of this.#panels.values()) {
      if (panel.sessionID !== except && panel.udid === udid) return true
    }
    for (const sessionID of this.#running) {
      if (sessionID !== except && this.#sessions.pick(sessionID) === udid) return true
    }
    return false
  }

  dispose(): void {
    this.#stopped = true
    for (const timer of this.#timers.values()) clearTimeout(timer)
    this.#timers.clear()
  }

  async #releaseIfIdle(sessionID: string): Promise<void> {
    if (this.#stopped) return
    if (this.#hasPanel(sessionID) || this.#running.has(sessionID) || this.isHeld(sessionID)) {
      return
    }
    const udid = await this.#sessions.forgetSession(sessionID)
    if (!udid) return
    await this.#onChange?.(udid)
    this.#onRelease?.(sessionID, udid, false)
    await this.#maybeShutdown(udid)
  }

  async #maybeShutdown(udid: string): Promise<void> {
    if (this.#stopped || this.#shutdownDelayMs <= 0) return
    if (!this.#shouldShutdown(udid)) return
    if (this.#sessions.owners(udid).length > 0 || this.isBusy(udid)) return

    this.#cancelShutdown(udid)
    const timer = setTimeout(() => {
      this.#timers.delete(udid)
      void this.#shutdown(udid)
    }, this.#shutdownDelayMs)
    ;(timer as { unref?: () => void }).unref?.()
    this.#timers.set(udid, timer)
  }

  async #shutdown(udid: string): Promise<void> {
    if (this.#stopped || !this.#shouldShutdown(udid)) return
    if (this.#sessions.owners(udid).length > 0 || this.isBusy(udid)) return
    try {
      const devices = await this.#list()
      const device = devices.find((candidate) => candidate.udid === udid)
      if (!device || device.state !== "Booted") return
      // A claim can land while `simctl list` runs.
      if (this.#sessions.owners(udid).length > 0 || this.isBusy(udid)) return
      await this.#shutdownDevice(device)
    } catch (cause) {
      console.warn("opencode-simulator: could not shut down a released simulator", cause)
    }
  }

  #cancelShutdown(udid: string): void {
    const timer = this.#timers.get(udid)
    if (!timer) return
    clearTimeout(timer)
    this.#timers.delete(udid)
  }

  #panelKey(window: string, sessionID: string): string {
    return `${window}\u0000${sessionID}`
  }

  #hasPanel(sessionID: string): boolean {
    for (const panel of this.#panels.values()) {
      if (panel.sessionID === sessionID) return true
    }
    return false
  }

  #deletePanelsForSession(sessionID: string): void {
    for (const [key, panel] of this.#panels) {
      if (panel.sessionID === sessionID) this.#panels.delete(key)
    }
  }
}
