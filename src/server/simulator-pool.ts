import { Activity, type PanelState, type PanelUpdate, type ReleaseState } from "./activity"
import { listDevices, renameDevice, type Device } from "./devices"
import type { ManagedDevice, ManagedDevices } from "./managed"
import { inUseName } from "./names"
import type { SessionDevices } from "./session-devices"

export interface SimulatorPoolOptions {
  readonly sessions: SessionDevices
  readonly managed: ManagedDevices
  readonly onRelease?: (sessionID: string, udid: string, force: boolean) => void
  readonly shutdownDelayMs?: number
  /** Test seam. Defaults to `simctl rename`. */
  readonly rename?: (udid: string, name: string) => Promise<unknown>
  /** Test seam. Defaults to `simctl list`. */
  readonly list?: () => Promise<readonly Device[]>
  /** Test seam. Defaults to `simctl shutdown`. */
  readonly shutdown?: (device: Device) => Promise<unknown>
}

const MAX_LAST_DEVICES = 500

/**
 * The single server-side owner of session/device claims.
 *
 * Tools ask this object to claim, release, hold, or observe a device. They no
 * longer mutate the claim map or the activity maps directly, so reassign,
 * release, panel leases, and shutdown timers stay consistent.
 */
export class SimulatorPool {
  readonly sessions: SessionDevices
  readonly managed: ManagedDevices
  readonly activity: Activity
  readonly #renameDevice: (udid: string, name: string) => Promise<unknown>
  /** Name this process last applied, so a redundant rename is skipped. */
  readonly #applied = new Map<string, string>()
  /** One rename at a time per device; claim and release can race. */
  readonly #renames = new Map<string, Promise<void>>()
  readonly #list: () => Promise<readonly Device[]>
  /** session -> last device it held, so the next start gets the same build back. */
  readonly #last = new Map<string, string>()
  #lock: Promise<unknown> = Promise.resolve()

  constructor(options: SimulatorPoolOptions) {
    this.sessions = options.sessions
    this.managed = options.managed
    this.#renameDevice = options.rename ?? ((udid, name) => renameDevice(udid, name))
    this.#list = options.list ?? (() => listDevices())
    this.activity = new Activity({
      sessions: options.sessions,
      onRelease: options.onRelease,
      shutdownDelayMs: options.shutdownDelayMs,
      shutdown: options.shutdown,
      list: this.#list,
      shouldShutdown: (udid) => options.managed.has(udid),
      onChange: (udid) => this.syncName(udid),
    })
  }

  pick(sessionID: string, requested?: string): string | undefined {
    return this.sessions.pick(sessionID, requested)
  }

  entries(): readonly (readonly [string, string])[] {
    return this.sessions.entries()
  }

  owners(udid: string, except?: string): string[] {
    return this.sessions.owners(udid, except)
  }

  forgetSession(sessionID: string): Promise<string | undefined> {
    return this.sessions.forgetSession(sessionID)
  }

  isManaged(udid: string): boolean {
    return this.managed.has(udid)
  }

  managedEntries(): readonly ManagedDevice[] {
    return this.managed.entries()
  }

  /**
   * Reflect ownership in the device's name: `<model> N · in use` while a
   * session holds it, the plain name otherwise. Only managed devices are
   * renamed, and the name stays cosmetic — the pool still keys on the UDID.
   */
  async syncName(udid: string): Promise<void> {
    const base = this.managed.get(udid)?.name
    if (!base) return
    const busy = this.owners(udid).length > 0 || this.isBusy(udid)
    await this.#rename(udid, busy ? inUseName(base) : base)
  }

  /**
   * Repair state after a restart: forget devices deleted outside the plugin,
   * and strip a name mark that outlived its claim.
   */
  reconcile(): Promise<void> {
    // Under the lock: a device created while the list runs would look deleted.
    return this.withLock(() => this.#reconcile())
  }

  async #reconcile(): Promise<void> {
    let devices: readonly Device[]
    try {
      devices = await this.#list()
    } catch (cause) {
      console.warn("opencode-simulator: could not reconcile simulator names", cause)
      return
    }
    // CoreSimulator can answer with nothing while it restarts.
    if (devices.length === 0) return
    const existing = new Set(devices.map((device) => device.udid))
    const stale = new Set<string>()
    for (const entry of this.managed.entries()) {
      if (!existing.has(entry.udid)) stale.add(entry.udid)
    }
    for (const [, udid] of this.sessions.entries()) {
      if (!existing.has(udid)) stale.add(udid)
    }
    for (const udid of stale) await this.forgetDevice(udid)
    for (const device of devices) {
      const base = this.managed.get(device.udid)?.name
      if (!base) continue
      const busy = this.owners(device.udid).length > 0 || this.isBusy(device.udid)
      const wanted = busy ? inUseName(base) : base
      if (device.name === wanted) {
        this.#applied.set(device.udid, wanted)
        continue
      }
      await this.#rename(device.udid, wanted)
    }
  }

  #rename(udid: string, name: string): Promise<void> {
    const previous = this.#renames.get(udid) ?? Promise.resolve()
    const next = previous
      .catch(() => {})
      .then(async () => {
        if (this.#applied.get(udid) === name) return
        await this.#renameDevice(udid, name)
        this.#applied.set(udid, name)
      })
      .catch((cause) => {
        console.warn("opencode-simulator: could not rename a simulator", cause)
      })
    this.#renames.set(udid, next)
    void next.then(() => {
      if (this.#renames.get(udid) === next) this.#renames.delete(udid)
    })
    return next
  }

  /** Claim a device exclusively and mark it recently used. */
  async claim(sessionID: string, udid: string): Promise<boolean> {
    const previous = this.sessions.pick(sessionID)
    const claimed = await this.sessions.claim(sessionID, udid)
    if (claimed) await this.#took(sessionID, udid, previous)
    return claimed
  }

  /** Point a session at a device, allowing deliberate sharing. */
  async remember(sessionID: string, udid: string): Promise<void> {
    const previous = this.sessions.pick(sessionID)
    await this.sessions.remember(sessionID, udid)
    await this.#took(sessionID, udid, previous)
  }

  /** The device this session held last, if it still exists. Not persisted. */
  last(sessionID: string): string | undefined {
    return this.#last.get(sessionID)
  }

  /** A boot failed: give the device up so the next start does not retry it. */
  async failed(sessionID: string, udid: string): Promise<void> {
    await this.releaseManual(sessionID, udid)
    if (this.#last.get(sessionID) === udid) this.#last.delete(sessionID)
  }

  /** Run `task` after every earlier locked task; a failure does not block the next. */
  withLock<T>(task: () => Promise<T>): Promise<T> {
    const result = this.#lock.then(task, task)
    this.#lock = result.catch(() => {})
    return result
  }

  async #took(sessionID: string, udid: string, previous: string | undefined): Promise<void> {
    this.#last.delete(sessionID)
    this.#last.set(sessionID, udid)
    while (this.#last.size > MAX_LAST_DEVICES) {
      const oldest = this.#last.keys().next().value
      if (oldest === undefined) break
      this.#last.delete(oldest)
    }
    this.activity.use(udid)
    if (previous && previous !== udid) {
      await this.activity.moved(sessionID, previous)
      await this.syncName(previous)
    }
    await this.syncName(udid)
  }

  async manage(device: Device): Promise<void> {
    await this.managed.remember({
      udid: device.udid,
      name: device.name,
      deviceType: device.deviceType,
      runtimeId: device.runtimeId,
      createdAt: Date.now(),
    })
  }

  async unmanage(udid: string): Promise<void> {
    await this.managed.forget(udid)
  }

  /**
   * Delete bookkeeping for a device. Returns the sessions that owned it so the
   * caller can notify them. The tombstone stops a late panel update from
   * re-claiming a UDID that no longer exists.
   */
  async forgetDevice(udid: string): Promise<string[]> {
    const owners = this.sessions.owners(udid)
    await this.sessions.forget(udid)
    for (const sessionID of owners) await this.activity.close(sessionID)
    this.activity.forget(udid)
    await this.managed.forget(udid)
    this.#applied.delete(udid)
    for (const [sessionID, last] of this.#last) {
      if (last === udid) this.#last.delete(sessionID)
    }
    return owners
  }

  releaseManual(sessionID: string, expectedUdid?: string): Promise<string | undefined> {
    return this.activity.releaseManual(sessionID, expectedUdid)
  }

  panel(update: PanelUpdate): Promise<void> {
    return this.activity.panel(update)
  }

  started(sessionID: string): void {
    this.activity.started(sessionID)
  }

  idle(sessionID: string): Promise<void> {
    return this.activity.idle(sessionID)
  }

  close(sessionID: string): Promise<void> {
    return this.activity.close(sessionID)
  }

  hold(sessionID: string, ttlMs?: number): void {
    this.activity.hold(sessionID, ttlMs)
  }

  use(udid: string): void {
    this.activity.use(udid)
  }

  isBusy(udid: string, except?: string): boolean {
    return this.activity.isBusy(udid, except)
  }

  isRunning(sessionID: string): boolean {
    return this.activity.isRunning(sessionID)
  }

  panelState(sessionID: string): PanelState {
    return this.activity.panelState(sessionID)
  }

  panelDevice(sessionID: string): string | undefined {
    return this.activity.panelDevice(sessionID)
  }

  releaseState(sessionID: string): ReleaseState {
    return this.activity.releaseState(sessionID)
  }

  expirePanels(now?: number): Promise<number> {
    return this.activity.expirePanels(now)
  }

  dispose(): void {
    this.activity.dispose()
  }
}
