import { describe, expect, test } from "bun:test"
import { cleanCopyLabel, copyDeviceName } from "./copy-name"
import type { Device } from "./devices"

const device = (
  name: string,
  deviceType = "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",
): Device => ({
  udid: name,
  name,
  state: "Booted",
  runtime: "iOS 26.5",
  runtimeId: "com.apple.CoreSimulator.SimRuntime.iOS-26-5",
  deviceType,
  available: true,
})

describe("copyDeviceName", () => {
  test("keeps the Copy convention without a label", () => {
    expect(copyDeviceName(device("iPhone 17 Pro"), undefined, [])).toBe("iPhone 17 Pro Copy")
  })

  test("does not stack Copy on Copy", () => {
    const source = device("iPhone 17 Pro Copy")
    expect(copyDeviceName(source, undefined, [source, device("iPhone 17 Pro")])).toBe(
      "iPhone 17 Pro Copy 2",
    )
  })

  test("uses the model and label for a semantic name", () => {
    expect(copyDeviceName(device("iPhone 17 Pro"), "create order flow", [])).toBe(
      "iPhone 17 Pro — create order flow",
    )
  })

  test("uses the real model even when the source has a custom name", () => {
    expect(copyDeviceName(device("Melis Order Flow"), "store profile", [])).toBe(
      "iPhone 17 Pro — store profile",
    )
  })

  test("does not repeat a label that already starts with the model", () => {
    expect(copyDeviceName(device("iPhone 17 Pro"), "iPhone 17 Pro — create order", [])).toBe(
      "iPhone 17 Pro — create order",
    )
  })

  test("adds a numeric suffix when the semantic name is taken", () => {
    expect(
      copyDeviceName(device("iPhone 17 Pro"), "create order flow", [
        device("iPhone 17 Pro — create order flow"),
      ]),
    ).toBe("iPhone 17 Pro — create order flow 2")
  })

  test("falls back to Copy for a blank label", () => {
    expect(copyDeviceName(device("iPhone 17 Pro"), "   ", [])).toBe("iPhone 17 Pro Copy")
  })

  test("sanitizes and collapses the label", () => {
    expect(cleanCopyLabel("  store / profile:\n flow  ")).toBe("store profile flow")
    expect(copyDeviceName(device("iPhone 17 Pro"), "store / profile", [])).toBe(
      "iPhone 17 Pro — store profile",
    )
  })

  test("caps the label length", () => {
    const label = "x".repeat(100)
    expect(cleanCopyLabel(label)).toHaveLength(60)
  })
})
