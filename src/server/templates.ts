/**
 * Warm simulator templates.
 *
 * A template is one shut-down device that has booted successfully and has a
 * prepared data volume. Cloning it is cheap on APFS (shared blocks) and boots
 * in seconds, unlike a freshly created device whose first boot has to build a
 * data volume (minutes on current runtimes).
 *
 * Templates are keyed by device type and runtime and are never deleted by the
 * copy sweeper. One template per model/runtime is enough.
 */

import type { StorageLike } from "./session-devices"

export const TEMPLATES_KEY = "simulator-templates"
export const MAX_TEMPLATES = 8

export interface Template {
  readonly udid: string
  readonly name: string
  readonly deviceType: string
  readonly runtimeId: string
  readonly createdAt: number
}

type Persist = (templates: Record<string, Template>) => Promise<void>

export const templateKey = (deviceType: string, runtimeId: string): string =>
  `${deviceType}|${runtimeId}`

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value)

const readEntries = (value: unknown): Record<string, Template> => {
  if (!isRecord(value)) return {}
  const entries: Record<string, Template> = {}
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
    entries[templateKey(deviceType, runtimeId)] = { udid, name, deviceType, runtimeId, createdAt }
  }
  return entries
}

export class Templates {
  readonly #templates: Map<string, Template>
  readonly #persist: Persist | undefined

  constructor(entries: Record<string, Template> = {}, persist?: Persist) {
    this.#templates = new Map(Object.entries(entries))
    this.#persist = persist
  }

  static async load(storage: StorageLike): Promise<Templates> {
    let stored: unknown
    try {
      stored = await storage.get(TEMPLATES_KEY)
    } catch {
      stored = undefined
    }
    return new Templates(readEntries(stored), async (templates) => {
      try {
        await storage.set(TEMPLATES_KEY, templates)
      } catch {}
    })
  }

  /** The template for this model and runtime, if one was prepared. */
  get(device: { readonly deviceType: string; readonly runtimeId: string }): Template | undefined {
    if (!device.deviceType || !device.runtimeId) return undefined
    return this.#templates.get(templateKey(device.deviceType, device.runtimeId))
  }

  has(udid: string): boolean {
    for (const template of this.#templates.values()) {
      if (template.udid === udid) return true
    }
    return false
  }

  entries(): readonly Template[] {
    return [...this.#templates.values()]
  }

  get size(): number {
    return this.#templates.size
  }

  async remember(template: Template): Promise<void> {
    const key = templateKey(template.deviceType, template.runtimeId)
    this.#templates.delete(key)
    this.#templates.set(key, template)
    while (this.#templates.size > MAX_TEMPLATES) {
      const oldest = this.#templates.keys().next().value
      if (oldest === undefined) break
      this.#templates.delete(oldest)
    }
    await this.#persist?.(this.#snapshot())
  }

  async forget(udid: string): Promise<void> {
    let changed = false
    for (const [key, template] of this.#templates) {
      if (template.udid !== udid) continue
      this.#templates.delete(key)
      changed = true
    }
    if (changed) await this.#persist?.(this.#snapshot())
  }

  #snapshot(): Record<string, Template> {
    return Object.fromEntries(this.#templates)
  }
}
