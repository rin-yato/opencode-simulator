/**
 * Per-session simulator defaults.
 *
 * OpenCode tools receive a session id. Remembering the device a session started
 * lets every later tool omit `udid`, which keeps two sessions from fighting over
 * whichever simulator happens to be booted.
 *
 * The store is intentionally small and bounded: an entry is a session id and a
 * UDID. Persistence is best-effort; a storage failure must not break a tool.
 */

export const SESSION_DEVICES_KEY = "session-devices"
export const MAX_SESSION_DEVICES = 500

export interface StorageLike {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
}

type Persist = (devices: Record<string, string>) => Promise<void>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value)

const readEntries = (value: unknown): Record<string, string> => {
  if (!isRecord(value)) return {}
  const entries: Record<string, string> = {}
  for (const [sessionID, udid] of Object.entries(value)) {
    if (typeof udid === "string" && udid) entries[sessionID] = udid
  }
  return entries
}

export class SessionDevices {
  readonly #devices: Map<string, string>
  readonly #persist: Persist | undefined

  constructor(entries: Record<string, string> = {}, persist?: Persist) {
    this.#devices = new Map(Object.entries(entries))
    this.#persist = persist
  }

  /** Load the store from plugin storage. */
  static async load(storage: StorageLike): Promise<SessionDevices> {
    let stored: unknown
    try {
      stored = await storage.get(SESSION_DEVICES_KEY)
    } catch {
      stored = undefined
    }
    return new SessionDevices(readEntries(stored), async (devices) => {
      try {
        await storage.set(SESSION_DEVICES_KEY, devices)
      } catch {}
    })
  }

  /** An explicit request wins; otherwise return the device this session used. */
  pick(sessionID: string, requested?: string): string | undefined {
    return requested?.trim() || this.#devices.get(sessionID)
  }

  get size(): number {
    return this.#devices.size
  }

  /**
   * Make `udid` the session's default unless another session already owns it.
   *
   * The ownership scan and the map update run without awaiting, so two sessions
   * starting at the same time cannot both adopt one simulator: the first call
   * claims it, the second sees the owner and has to pick or create another.
   */
  async claim(sessionID: string, udid: string): Promise<boolean> {
    for (const [other, owned] of this.#devices) {
      if (owned === udid && other !== sessionID) return false
    }
    await this.remember(sessionID, udid)
    return true
  }

  /** Make `udid` the session's default and drop the least recently used entry. */
  async remember(sessionID: string, udid: string): Promise<void> {
    if (this.#devices.get(sessionID) === udid) return
    this.#devices.delete(sessionID)
    this.#devices.set(sessionID, udid)
    while (this.#devices.size > MAX_SESSION_DEVICES) {
      const oldest = this.#devices.keys().next().value
      if (oldest === undefined) break
      this.#devices.delete(oldest)
    }
    await this.#persist?.(this.#snapshot())
  }

  /** Forget one session; returns the UDID it pointed at. */
  async forgetSession(sessionID: string): Promise<string | undefined> {
    const udid = this.#devices.get(sessionID)
    if (!udid) return undefined
    this.#devices.delete(sessionID)
    await this.#persist?.(this.#snapshot())
    return udid
  }

  /** Forget every session that points at a deleted simulator. */
  async forget(udid: string): Promise<void> {
    let changed = false
    for (const [sessionID, owned] of this.#devices) {
      if (owned !== udid) continue
      this.#devices.delete(sessionID)
      changed = true
    }
    if (changed) await this.#persist?.(this.#snapshot())
  }

  /** Sessions other than `except` that currently use this simulator. */
  owners(udid: string, except?: string): string[] {
    const owners: string[] = []
    for (const [sessionID, owned] of this.#devices) {
      if (owned === udid && sessionID !== except) owners.push(sessionID)
    }
    return owners
  }

  #snapshot(): Record<string, string> {
    return Object.fromEntries(this.#devices)
  }
}
