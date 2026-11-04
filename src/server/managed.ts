/**
 * Simulators created and owned by the plugin.
 *
 * External devices are never auto-claimed, auto-refreshed, or auto-shut down.
 * They can be used as a model/runtime reference or an app source, and an
 * explicit `udid` can borrow one, but the pool only manages devices listed
 * here.
 */

import type { StorageLike } from "./session-devices"

export const MANAGED_KEY = "simulator-managed"
export const MAX_MANAGED = 200

export interface ManagedDevice {
  readonly udid: string
  readonly name: string
  readonly deviceType: string
  readonly runtimeId: string
  readonly createdAt: number
}

type Persist = (devices: Record<string, ManagedDevice>) => Promise<void>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value)

const readEntries = (value: unknown): Record<string, ManagedDevice> => {
  if (!isRecord(value)) return {}
  const entries: Record<string, ManagedDevice> = {}
  for (const entry of Object.values(value)) {
    if (!isRecord(entry)) continue
    const { udid, name, deviceType, runtimeId, createdAt } = entry
    if (
      typeof udid !== "string" ||
      !udid ||
      typeof name !== "string" ||
      !name ||
      typeof deviceType !== "string" ||
      !deviceType ||
      typeof runtimeId !== "string" ||
      !runtimeId ||
      typeof createdAt !== "number"
    ) {
      continue
    }
    entries[udid] = { udid, name, deviceType, runtimeId, createdAt }
  }
  return entries
}

export class ManagedDevices {
  readonly #devices: Map<string, ManagedDevice>
  readonly #persist: Persist | undefined

  constructor(entries: Record<string, ManagedDevice> = {}, persist?: Persist) {
    this.#devices = new Map(Object.entries(entries))
    this.#persist = persist
  }

  static async load(storage: StorageLike): Promise<ManagedDevices> {
    let stored: unknown
    try {
      stored = await storage.get(MANAGED_KEY)
    } catch {
      stored = undefined
    }
    return new ManagedDevices(readEntries(stored), async (devices) => {
      try {
        await storage.set(MANAGED_KEY, devices)
      } catch {}
    })
  }

  has(udid: string): boolean {
    return this.#devices.has(udid)
  }

  get(udid: string): ManagedDevice | undefined {
    return this.#devices.get(udid)
  }

  entries(): readonly ManagedDevice[] {
    return [...this.#devices.values()]
  }

  get size(): number {
    return this.#devices.size
  }

  async remember(device: ManagedDevice): Promise<void> {
    this.#devices.delete(device.udid)
    this.#devices.set(device.udid, device)
    while (this.#devices.size > MAX_MANAGED) {
      let oldest: string | undefined
      let timestamp = Number.POSITIVE_INFINITY
      for (const [udid, entry] of this.#devices) {
        if (entry.createdAt < timestamp) {
          timestamp = entry.createdAt
          oldest = udid
        }
      }
      if (oldest === undefined) break
      this.#devices.delete(oldest)
    }
    await this.#persist?.(this.#snapshot())
  }

  async forget(udid: string): Promise<void> {
    if (!this.#devices.delete(udid)) return
    await this.#persist?.(this.#snapshot())
  }

  #snapshot(): Record<string, ManagedDevice> {
    return Object.fromEntries(this.#devices)
  }
}
