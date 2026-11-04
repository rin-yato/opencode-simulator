import { Activity, type PanelState, type PanelUpdate, type ReleaseState } from "./activity"
import type { Device } from "./devices"
import type { ManagedDevice, ManagedDevices } from "./managed"
import type { SessionDevices } from "./session-devices"

export interface SimulatorPoolOptions {
  readonly sessions: SessionDevices
  readonly managed: ManagedDevices
  readonly onRelease?: (sessionID: string, udid: string, force: boolean) => void
  readonly shutdownDelayMs?: number
}

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

  constructor(options: SimulatorPoolOptions) {
    this.sessions = options.sessions
    this.managed = options.managed
    this.activity = new Activity({
      sessions: options.sessions,
      onRelease: options.onRelease,
      shutdownDelayMs: options.shutdownDelayMs,
      shouldShutdown: (udid) => options.managed.has(udid),
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

  /** Claim a device exclusively and mark it recently used. */
  async claim(sessionID: string, udid: string): Promise<boolean> {
    const claimed = await this.sessions.claim(sessionID, udid)
    if (claimed) this.activity.use(udid)
    return claimed
  }

  /** Point a session at a device, allowing deliberate sharing. */
  async remember(sessionID: string, udid: string): Promise<void> {
    await this.sessions.remember(sessionID, udid)
    this.activity.use(udid)
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
