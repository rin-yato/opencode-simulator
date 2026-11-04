import type { Device } from "./devices"
import { listDevices, shutdownDevice } from "./devices"
import type { SessionDevices } from "./session-devices"

/**
 * Who is using a simulator.
 *
 * A device is busy when its panel is open (the user can see or reopen it) or
 * when the session that owns it is running (the agent is still working). When
 * both are gone, the claim is released and the device returns to the pool.
 */
export type PanelState = "closed" | "open" | "active" | "visible"

export const PANEL_STATES = ["closed", "open", "active", "visible"] as const

export const isPanelState = (value: unknown): value is PanelState =>
  typeof value === "string" && (PANEL_STATES as readonly string[]).includes(value)

export interface PanelUpdate {
  readonly sessionID: string
  readonly state: PanelState
  readonly udid?: string
}

export interface ActivityOptions {
  readonly sessions: SessionDevices
  /** Delay before shutting down a released device. `0` disables shutdown. */
  readonly shutdownDelayMs?: number
  /** Test seam. Defaults to `simctl shutdown`. */
  readonly shutdown?: (device: Device) => Promise<unknown>
  /** Called after a claim is released, so the window can forget its device. */
  readonly onRelease?: (sessionID: string, udid: string) => void
}

const DEFAULT_SHUTDOWN_DELAY_MS = 60_000

export class Activity {
  readonly #sessions: SessionDevices
  readonly #shutdownDelayMs: number
  readonly #shutdownDevice: (device: Device) => Promise<unknown>
  readonly #onRelease: ((sessionID: string, udid: string) => void) | undefined
  readonly #panels = new Map<string, { readonly udid: string; readonly state: PanelState }>()
  readonly #running = new Set<string>()
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>()
  #stopped = false

  constructor(options: ActivityOptions) {
    this.#sessions = options.sessions
    this.#shutdownDelayMs = options.shutdownDelayMs ?? DEFAULT_SHUTDOWN_DELAY_MS
    this.#shutdownDevice = options.shutdown ?? ((device) => shutdownDevice(device))
    this.#onRelease = options.onRelease
  }

  /**
   * Update the panel of a session. A panel with no existing claim claims a free
   * device, so a restored panel survives a server restart without stealing from
   * another session. An existing claim always wins: `sim_create` and `sim_boot`
   * may deliberately point the session at another device while the old panel is
   * still open. Closing the panel releases the claim once the session is idle.
   */
  async panel(update: PanelUpdate): Promise<void> {
    if (this.#stopped) return
    if (update.state === "closed") {
      this.#panels.delete(update.sessionID)
      await this.#releaseIfIdle(update.sessionID)
      return
    }

    // An empty panel (no recorded device) is not using anything. Do not map it
    // to the session's claim: that would hold a device the user cannot see.
    const udid = update.udid?.trim()
    if (!udid) return

    this.#panels.set(update.sessionID, { udid, state: update.state })
    this.#cancelShutdown(udid)
    if (!this.#sessions.pick(update.sessionID)) {
      await this.#sessions.claim(update.sessionID, udid)
    }
  }

  /** The agent started a turn; its device must not be released mid-work. */
  started(sessionID: string): void {
    this.#running.add(sessionID)
    const udid = this.#sessions.pick(sessionID)
    if (udid) this.#cancelShutdown(udid)
  }

  /** The agent finished a turn. Release the device if its panel is closed. */
  async idle(sessionID: string): Promise<void> {
    this.#running.delete(sessionID)
    await this.#releaseIfIdle(sessionID)
  }

  /** The session was deleted or archived: forget both kinds of activity. */
  async close(sessionID: string): Promise<void> {
    this.#panels.delete(sessionID)
    this.#running.delete(sessionID)
    await this.#releaseIfIdle(sessionID)
  }

  /** Forget a deleted device's panels and pending shutdown. */
  forget(udid: string): void {
    for (const [sessionID, panel] of this.#panels) {
      if (panel.udid === udid) this.#panels.delete(sessionID)
    }
    this.#cancelShutdown(udid)
  }

  /** Cancel a pending shutdown when a session claims this device again. */
  use(udid: string): void {
    this.#cancelShutdown(udid)
  }

  panelState(sessionID: string): PanelState {
    return this.#panels.get(sessionID)?.state ?? "closed"
  }

  isRunning(sessionID: string): boolean {
    return this.#running.has(sessionID)
  }

  /**
   * Is someone other than `except` using this device? Claims are checked by the
   * caller; this covers open panels and running sessions that no longer have a
   * mapping (for example after a restart).
   */
  isBusy(udid: string, except?: string): boolean {
    for (const [sessionID, panel] of this.#panels) {
      if (sessionID !== except && panel.udid === udid) return true
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
    if (this.#panels.has(sessionID) || this.#running.has(sessionID)) return
    const udid = await this.#sessions.forgetSession(sessionID)
    if (!udid) return
    this.#onRelease?.(sessionID, udid)
    await this.#maybeShutdown(udid)
  }

  async #maybeShutdown(udid: string): Promise<void> {
    if (this.#stopped || this.#shutdownDelayMs <= 0) return
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
    if (this.#stopped) return
    if (this.#sessions.owners(udid).length > 0 || this.isBusy(udid)) return
    try {
      const devices = await listDevices()
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
}
