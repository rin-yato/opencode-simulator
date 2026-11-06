import { describe, expect, test } from "bun:test"
import { acquirePool } from "./shared-pool"
import type { StorageLike } from "./session-devices"

const storage = (): StorageLike => {
  const data = new Map<string, unknown>()
  return {
    get: async (key) => data.get(key),
    set: async (key, value) => {
      data.set(key, value)
    },
  }
}

describe("acquirePool", () => {
  test("two acquires, even concurrent, share one pool", async () => {
    const registry = {}
    const [a, b] = await Promise.all([
      acquirePool(storage(), undefined, registry),
      acquirePool(storage(), undefined, registry),
    ])
    expect(a.pool).toBe(b.pool)
    const c = await acquirePool(storage(), undefined, registry)
    expect(c.pool).toBe(a.pool)
  })

  test("a release goes through one listener and moves on when it leaves", async () => {
    const registry = {}
    const first: string[] = []
    const second: string[] = []
    const a = await acquirePool(storage(), (id) => first.push(id), registry)
    const b = await acquirePool(storage(), (id) => second.push(id), registry)
    await a.pool.remember("ses_1", "udid-1")
    await a.pool.releaseManual("ses_1")
    expect(first).toEqual(["ses_1"])
    expect(second).toEqual([])

    a.release()
    await b.pool.remember("ses_2", "udid-2")
    await b.pool.releaseManual("ses_2")
    expect(first).toEqual(["ses_1"])
    expect(second).toEqual(["ses_2"])
    b.release()
  })

  test("disposes at zero refs and builds a new pool afterwards", async () => {
    const registry = {}
    const a = await acquirePool(storage(), undefined, registry)
    const b = await acquirePool(storage(), undefined, registry)
    a.release()
    a.release()
    // A double release must not drop b's reference.
    const again = await acquirePool(storage(), undefined, registry)
    expect(again.pool).toBe(b.pool)
    again.release()
    b.release()

    await b.pool.panel({ sessionID: "ses_1", udid: "udid-1", state: "open" })
    expect(b.pool.panelState("ses_1")).toBe("closed")

    const fresh = await acquirePool(storage(), undefined, registry)
    expect(fresh.pool).not.toBe(b.pool)
    fresh.release()
  })
})
