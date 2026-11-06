import { describe, expect, test } from "bun:test"
import { DEVICE_POLL_MS, resolvePanelDevice } from "./panel-device"

describe("panel device", () => {
  test("the window's device wins over the server's", () => {
    expect(resolvePanelDevice("A", "B")).toBe("A")
  })

  test("the server fills the gap when the window has nothing", () => {
    expect(resolvePanelDevice(undefined, "B")).toBe("B")
  })

  test("an empty answer never clears a known device", () => {
    expect(resolvePanelDevice("A", undefined)).toBe("A")
    expect(resolvePanelDevice(undefined, undefined)).toBeUndefined()
  })

  test("the panel keeps asking while it has no device", () => {
    expect(DEVICE_POLL_MS).toBeGreaterThan(0)
    expect(DEVICE_POLL_MS).toBeLessThanOrEqual(5_000)
  })
})
