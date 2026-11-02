import { describe, expect, test } from "bun:test"
import {
  MAX_SESSION_DEVICES,
  SESSION_DEVICES_KEY,
  SessionDevices,
  type StorageLike,
} from "./session-devices"

const fakeStorage = (initial?: unknown) => {
  const data = new Map<string, unknown>()
  if (initial !== undefined) data.set(SESSION_DEVICES_KEY, initial)
  const storage: StorageLike = {
    get: async (key) => data.get(key),
    set: async (key, value) => {
      data.set(key, value)
    },
  }
  return { storage, data }
}

describe("SessionDevices", () => {
  test("ignores invalid stored entries", async () => {
    const { storage } = fakeStorage({ ses_ok: "udid-1", ses_bad: 42, ses_empty: "" })
    const sessions = await SessionDevices.load(storage)
    expect(sessions.size).toBe(1)
    expect(sessions.pick("ses_ok")).toBe("udid-1")
    expect(sessions.pick("ses_bad")).toBeUndefined()
  })

  test("an explicit request wins over the remembered device", async () => {
    const sessions = new SessionDevices({ ses_1: "remembered" })
    expect(sessions.pick("ses_1", "  explicit  ")).toBe("explicit")
    expect(sessions.pick("ses_1")).toBe("remembered")
  })

  test("caps stored sessions and keeps the newest", async () => {
    const { storage, data } = fakeStorage()
    const sessions = await SessionDevices.load(storage)
    for (let index = 0; index < MAX_SESSION_DEVICES + 2; index += 1) {
      await sessions.remember(`ses_${index}`, `udid_${index}`)
    }
    expect(sessions.size).toBe(MAX_SESSION_DEVICES)
    expect(sessions.pick("ses_0")).toBeUndefined()
    expect(sessions.pick("ses_1")).toBeUndefined()
    expect(sessions.pick(`ses_${MAX_SESSION_DEVICES + 1}`)).toBe(`udid_${MAX_SESSION_DEVICES + 1}`)
    expect(Object.keys(data.get(SESSION_DEVICES_KEY) as object)).toHaveLength(MAX_SESSION_DEVICES)
  })

  test("forgets every session that pointed at a deleted device", async () => {
    const { storage, data } = fakeStorage()
    const sessions = await SessionDevices.load(storage)
    await sessions.remember("ses_1", "shared")
    await sessions.remember("ses_2", "shared")
    await sessions.remember("ses_3", "other")
    await sessions.forget("shared")

    expect(sessions.pick("ses_1")).toBeUndefined()
    expect(sessions.pick("ses_2")).toBeUndefined()
    expect(sessions.pick("ses_3")).toBe("other")
    expect(Object.keys(data.get(SESSION_DEVICES_KEY) as object)).toEqual(["ses_3"])
  })

  test("reports other owners but not the caller", async () => {
    const sessions = new SessionDevices({
      ses_1: "shared",
      ses_2: "shared",
      ses_3: "other",
    })
    expect(sessions.owners("shared", "ses_1")).toEqual(["ses_2"])
    expect(sessions.owners("shared")).toEqual(["ses_1", "ses_2"])
    expect(sessions.owners("missing")).toEqual([])
  })

  test("claims an unowned device for a session", async () => {
    const sessions = new SessionDevices()
    expect(await sessions.claim("ses_1", "udid-1")).toBe(true)
    expect(sessions.pick("ses_1")).toBe("udid-1")
    expect(await sessions.claim("ses_1", "udid-1")).toBe(true)
  })

  test("refuses a device another session already owns", async () => {
    const sessions = new SessionDevices({ ses_1: "shared", ses_2: "shared" })
    expect(await sessions.claim("ses_2", "shared")).toBe(false)
    expect(await sessions.claim("ses_3", "shared")).toBe(false)
    expect(sessions.pick("ses_2")).toBe("shared")
    expect(sessions.pick("ses_3")).toBeUndefined()
  })

  test("only one of two simultaneous claims wins", async () => {
    const sessions = new SessionDevices()
    const first = sessions.claim("ses_1", "shared")
    const second = sessions.claim("ses_2", "shared")
    expect(await first).toBe(true)
    expect(await second).toBe(false)
    expect(sessions.owners("shared")).toEqual(["ses_1"])
  })

  test("survives a storage failure", async () => {
    const storage: StorageLike = {
      get: async () => {
        throw new Error("unavailable")
      },
      set: async () => {
        throw new Error("unavailable")
      },
    }
    const sessions = await SessionDevices.load(storage)
    await sessions.remember("ses_1", "udid")
    expect(sessions.pick("ses_1")).toBe("udid")
  })
})
