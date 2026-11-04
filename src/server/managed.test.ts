import { describe, expect, test } from "bun:test"
import type { StorageLike } from "./session-devices"
import { MANAGED_KEY, ManagedDevices, type ManagedDevice } from "./managed"

const fakeStorage = (initial?: unknown) => {
  const data = new Map<string, unknown>()
  if (initial !== undefined) data.set(MANAGED_KEY, initial)
  const storage: StorageLike = {
    get: async (key) => data.get(key),
    set: async (key, value) => {
      data.set(key, value)
    },
  }
  return { storage, data }
}

const device = (index: number): ManagedDevice => ({
  udid: `udid-${index}`,
  name: `iPhone 17 Pro #${index}`,
  deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",
  runtimeId: "com.apple.CoreSimulator.SimRuntime.iOS-26-5",
  createdAt: index,
})

describe("ManagedDevices", () => {
  test("ignores invalid stored entries", async () => {
    const { storage } = fakeStorage({
      good: device(1),
      bad: { ...device(2), udid: 42 },
      empty: {},
    })
    const managed = await ManagedDevices.load(storage)
    expect(managed.size).toBe(1)
    expect(managed.get("udid-1")?.name).toBe("iPhone 17 Pro #1")
  })

  test("remembers and forgets a device", async () => {
    const { storage, data } = fakeStorage()
    const managed = await ManagedDevices.load(storage)
    await managed.remember(device(1))
    expect(managed.has("udid-1")).toBe(true)
    expect(Object.keys(data.get(MANAGED_KEY) as object)).toEqual(["udid-1"])
    await managed.forget("udid-1")
    expect(managed.has("udid-1")).toBe(false)
  })

  test("replaces an entry without growing", async () => {
    const managed = new ManagedDevices()
    await managed.remember(device(1))
    await managed.remember({ ...device(1), name: "Renamed" })
    expect(managed.size).toBe(1)
    expect(managed.get("udid-1")?.name).toBe("Renamed")
  })

  test("survives storage failures", async () => {
    const storage: StorageLike = {
      get: async () => {
        throw new Error("unavailable")
      },
      set: async () => {
        throw new Error("unavailable")
      },
    }
    const managed = await ManagedDevices.load(storage)
    await managed.remember(device(1))
    expect(managed.has("udid-1")).toBe(true)
  })
})
