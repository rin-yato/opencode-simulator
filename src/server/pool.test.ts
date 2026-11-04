import { describe, expect, test } from "bun:test"
import type { Device } from "./devices"
import { MAX_POOL_SIZE, deviceModel, poolDeviceName, poolDevices, sameModel } from "./pool"

const device = (name: string, overrides: Partial<Device> = {}): Device => ({
  udid: name,
  name,
  state: "Shutdown",
  runtime: "iOS 26.5",
  runtimeId: "com.apple.CoreSimulator.SimRuntime.iOS-26-5",
  deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",
  available: true,
  ...overrides,
})

describe("deviceModel", () => {
  test("uses the device type, not a custom name", () => {
    expect(deviceModel(device("Melis Order Flow"))).toBe("iPhone 17 Pro")
  })

  test("falls back to a numbered device name", () => {
    expect(
      deviceModel(device("My Phone #2", { deviceType: "com.apple.CoreSimulator.SimDeviceType." })),
    ).toBe("My Phone")
  })
})

describe("sameModel", () => {
  test("requires both device type and runtime", () => {
    expect(sameModel(device("A"), device("B"))).toBe(true)
    expect(sameModel(device("A"), device("B", { runtimeId: "other" }))).toBe(false)
    expect(sameModel(device("A"), device("B", { deviceType: "other" }))).toBe(false)
  })
})

describe("poolDevices", () => {
  test("keeps matching available devices in numeric order", () => {
    const source = device("iPhone 17 Pro")
    const devices = [
      device("iPhone 17 Pro #10"),
      device("iPhone 17 Pro #2"),
      device("Other", { deviceType: "other" }),
      device("Unavailable", { available: false }),
      device("iPhone 17 Pro"),
    ]
    expect(poolDevices(source, devices).map((entry) => entry.name)).toEqual([
      "iPhone 17 Pro",
      "iPhone 17 Pro #2",
      "iPhone 17 Pro #10",
    ])
  })

  test("prefers a booted device over a shut-down one", () => {
    const source = device("iPhone 17 Pro")
    const devices = [device("iPhone 17 Pro"), device("iPhone 17 Pro #2", { state: "Booted" })]
    expect(poolDevices(source, devices)[0]!.name).toBe("iPhone 17 Pro #2")
  })

  test("caps the retained pool", () => {
    expect(MAX_POOL_SIZE).toBe(5)
  })
})

describe("poolDeviceName", () => {
  test("starts at 2 because the source is implicitly 1", () => {
    expect(poolDeviceName(device("iPhone 17 Pro"), [])).toBe("iPhone 17 Pro #2")
  })

  test("skips taken numbers", () => {
    expect(
      poolDeviceName(device("iPhone 17 Pro"), [
        device("iPhone 17 Pro"),
        device("iPhone 17 Pro #2"),
        device("iPhone 17 Pro #3"),
      ]),
    ).toBe("iPhone 17 Pro #4")
  })

  test("uses the model even when the source has a custom name", () => {
    expect(poolDeviceName(device("Melis Order Flow"), [])).toBe("iPhone 17 Pro #2")
  })
})
