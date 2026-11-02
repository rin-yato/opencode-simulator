import { describe, expect, test } from "bun:test"
import { COPIES_KEY, Copies, MAX_COPIES, expiredCopies, type CopyLease } from "./copies"
import type { StorageLike } from "./session-devices"

const DAY = 24 * 60 * 60 * 1_000

const fakeStorage = (initial?: unknown) => {
  const data = new Map<string, unknown>()
  if (initial !== undefined) data.set(COPIES_KEY, initial)
  const storage: StorageLike = {
    get: async (key) => data.get(key),
    set: async (key, value) => {
      data.set(key, value)
    },
  }
  return { storage, data }
}

const lease = (index: number, lastUsedAt = index): CopyLease => ({
  udid: `udid-${index}`,
  sessionID: `ses_${index}`,
  name: `Copy ${index}`,
  createdAt: index,
  lastUsedAt,
})

describe("Copies", () => {
  test("ignores invalid stored entries", async () => {
    const { storage } = fakeStorage({
      good: lease(1),
      bad: { ...lease(2), udid: 42 },
      empty: {},
    })
    const copies = await Copies.load(storage)
    expect(copies.size).toBe(1)
    expect(copies.get("udid-1")?.sessionID).toBe("ses_1")
  })

  test("remembers a lease by udid", async () => {
    const copies = new Copies()
    await copies.remember(lease(1))
    expect(copies.has("udid-1")).toBe(true)
    expect(copies.get("udid-1")?.name).toBe("Copy 1")
  })

  test("caps the store by least recently used", async () => {
    const { storage, data } = fakeStorage()
    const copies = await Copies.load(storage)
    for (let index = 0; index < MAX_COPIES + 2; index += 1) {
      await copies.remember(lease(index))
    }
    expect(copies.size).toBe(MAX_COPIES)
    expect(copies.has("udid-0")).toBe(false)
    expect(copies.has("udid-1")).toBe(false)
    expect(Object.keys(data.get(COPIES_KEY) as object)).toHaveLength(MAX_COPIES)
  })

  test("touch moves the expiry window forward", async () => {
    const copies = new Copies()
    const old = lease(1, Date.now() - 2 * DAY)
    await copies.remember(old)
    await copies.touch("udid-1")
    expect(copies.get("udid-1")!.lastUsedAt).toBeGreaterThan(old.lastUsedAt)
  })

  test("touch ignores an unmanaged device", async () => {
    const copies = new Copies()
    await copies.touch("missing")
    expect(copies.size).toBe(0)
  })

  test("forgets a lease", async () => {
    const copies = new Copies()
    await copies.remember(lease(1))
    await copies.forget("udid-1")
    expect(copies.has("udid-1")).toBe(false)
  })
})

describe("expiredCopies", () => {
  test("returns copies older than the TTL", () => {
    const now = 10 * DAY
    const copies = [lease(1, now - 20 * DAY), lease(2, now - 2 * DAY)]
    expect(expiredCopies(copies, now, 14).map((copy) => copy.udid)).toEqual(["udid-1"])
  })

  test("never expires when the TTL is zero", () => {
    const now = 10 * DAY
    expect(expiredCopies([lease(1, 0)], now, 0)).toEqual([])
  })
})
