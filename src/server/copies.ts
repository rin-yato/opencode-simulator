/**
 * Leases for simulators the plugin created automatically.
 *
 * Only devices in this store are eligible for automatic cleanup. Explicit
 * `sim_create` devices, user devices, and templates are not touched.
 */

import type { StorageLike } from "./session-devices"

export const COPIES_KEY = "simulator-copies"
export const MAX_COPIES = 200
export const DEFAULT_COPY_TTL_DAYS = 14

export interface CopyLease {
  readonly udid: string
  readonly sessionID: string
  readonly name: string
  readonly createdAt: number
  readonly lastUsedAt: number
}

type Persist = (copies: Record<string, CopyLease>) => Promise<void>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value)

const readEntries = (value: unknown): Record<string, CopyLease> => {
  if (!isRecord(value)) return {}
  const entries: Record<string, CopyLease> = {}
  for (const entry of Object.values(value)) {
    if (!isRecord(entry)) continue
    const { udid, sessionID, name, createdAt, lastUsedAt } = entry
    if (
      typeof udid !== "string" ||
      !udid ||
      typeof sessionID !== "string" ||
      !sessionID ||
      typeof name !== "string" ||
      !name ||
      typeof createdAt !== "number" ||
      typeof lastUsedAt !== "number"
    ) {
      continue
    }
    entries[udid] = { udid, sessionID, name, createdAt, lastUsedAt }
  }
  return entries
}

export class Copies {
  readonly #copies: Map<string, CopyLease>
  readonly #persist: Persist | undefined

  constructor(entries: Record<string, CopyLease> = {}, persist?: Persist) {
    this.#copies = new Map(Object.entries(entries))
    this.#persist = persist
  }

  static async load(storage: StorageLike): Promise<Copies> {
    let stored: unknown
    try {
      stored = await storage.get(COPIES_KEY)
    } catch {
      stored = undefined
    }
    return new Copies(readEntries(stored), async (copies) => {
      try {
        await storage.set(COPIES_KEY, copies)
      } catch {}
    })
  }

  get(udid: string): CopyLease | undefined {
    return this.#copies.get(udid)
  }

  has(udid: string): boolean {
    return this.#copies.has(udid)
  }

  entries(): readonly CopyLease[] {
    return [...this.#copies.values()]
  }

  get size(): number {
    return this.#copies.size
  }

  async remember(lease: CopyLease): Promise<void> {
    this.#copies.delete(lease.udid)
    this.#copies.set(lease.udid, lease)
    while (this.#copies.size > MAX_COPIES) {
      let oldest: string | undefined
      let timestamp = Number.POSITIVE_INFINITY
      for (const [udid, copy] of this.#copies) {
        if (copy.lastUsedAt < timestamp) {
          timestamp = copy.lastUsedAt
          oldest = udid
        }
      }
      if (oldest === undefined) break
      this.#copies.delete(oldest)
    }
    await this.#persist?.(this.#snapshot())
  }

  /** Mark a managed copy as used now, so the TTL starts from its last use. */
  async touch(udid: string): Promise<void> {
    const copy = this.#copies.get(udid)
    if (!copy) return
    const now = Date.now()
    if (now - copy.lastUsedAt < 60_000) return
    this.#copies.set(udid, { ...copy, lastUsedAt: now })
    await this.#persist?.(this.#snapshot())
  }

  async forget(udid: string): Promise<void> {
    if (!this.#copies.delete(udid)) return
    await this.#persist?.(this.#snapshot())
  }

  #snapshot(): Record<string, CopyLease> {
    return Object.fromEntries(this.#copies)
  }
}

/** Copies whose last use is at least `ttlDays` old. `0` disables expiry. */
export const expiredCopies = (
  copies: readonly CopyLease[],
  now: number,
  ttlDays: number,
): CopyLease[] => {
  if (ttlDays <= 0) return []
  const ttl = ttlDays * 24 * 60 * 60 * 1_000
  return copies.filter((copy) => now - copy.lastUsedAt >= ttl)
}
