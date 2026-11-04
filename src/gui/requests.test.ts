import { describe, expect, test } from "bun:test"
import { MAX_ENTRIES, removeDevice, upsertDevice } from "./requests"

describe("upsertDevice", () => {
  test("adds a session entry", () => {
    expect(upsertDevice({}, "ses_1", "udid-1")).toEqual({ ses_1: "udid-1" })
  })

  test("moves an existing session to the newest position", () => {
    const next = upsertDevice({ ses_1: "old", ses_2: "other" }, "ses_1", "new")
    expect(Object.keys(next)).toEqual(["ses_2", "ses_1"])
    expect(next.ses_1).toBe("new")
  })

  test("drops the oldest entries beyond the cap", () => {
    const entries: Record<string, string> = {}
    for (let index = 0; index < MAX_ENTRIES + 2; index += 1)
      entries[`ses_${index}`] = `udid_${index}`
    const next = upsertDevice(entries, "newest", "udid")
    expect(Object.keys(next)).toHaveLength(MAX_ENTRIES)
    expect(next.ses_0).toBeUndefined()
    expect(next.ses_1).toBeUndefined()
    expect(next.newest).toBe("udid")
  })
})

describe("removeDevice", () => {
  test("removes one session and keeps the rest", () => {
    expect(removeDevice({ ses_1: "udid-1", ses_2: "udid-2" }, "ses_1")).toEqual({
      ses_2: "udid-2",
    })
  })

  test("returns the same object for an unknown session", () => {
    const devices = { ses_1: "udid-1" }
    expect(removeDevice(devices, "ses_2")).toBe(devices)
  })
})
