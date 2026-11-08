import { describe, expect, test } from "bun:test"
import { createParking } from "./parking"

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe("createParking", () => {
  test("expires a parked pane after the ttl", async () => {
    const expired: string[] = []
    const parking = createParking({ ttlMs: 10, max: 4, expire: (id) => expired.push(id) })
    parking.park("a")
    expect(parking.has("a")).toBe(true)
    await wait(30)
    expect(expired).toEqual(["a"])
    expect(parking.has("a")).toBe(false)
  })

  test("unparking cancels the expiry", async () => {
    const expired: string[] = []
    const parking = createParking({ ttlMs: 10, max: 4, expire: (id) => expired.push(id) })
    parking.park("a")
    expect(parking.unpark("a")).toBe(true)
    expect(parking.unpark("a")).toBe(false)
    await wait(30)
    expect(expired).toEqual([])
  })

  test("parking again restarts the timer", async () => {
    const expired: string[] = []
    const parking = createParking({ ttlMs: 40, max: 4, expire: (id) => expired.push(id) })
    parking.park("a")
    await wait(25)
    parking.park("a")
    await wait(25)
    expect(expired).toEqual([])
    await wait(40)
    expect(expired).toEqual(["a"])
  })

  test("drops the oldest pane past the cap", () => {
    const expired: string[] = []
    const parking = createParking({ ttlMs: 10_000, max: 2, expire: (id) => expired.push(id) })
    parking.park("a")
    parking.park("b")
    parking.park("c")
    expect(expired).toEqual(["a"])
    expect(parking.size).toBe(2)
    // Re-parking makes a pane the newest.
    parking.park("b")
    parking.park("d")
    expect(expired).toEqual(["a", "c"])
    parking.dispose()
    expect(parking.size).toBe(0)
  })
})
