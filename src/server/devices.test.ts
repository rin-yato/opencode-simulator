import { describe, expect, test } from "bun:test"
import { matchDevice, type Device } from "./devices"

const device = (name: string, udid: string): Device => ({
  udid,
  name,
  state: "Booted",
  runtime: "iOS 26.5",
  runtimeId: "com.apple.CoreSimulator.SimRuntime.iOS-26-5",
  deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",
  available: true,
})

const devices = [
  device("iPhone 17 Pro", "udid-17-pro"),
  device("iPhone 17 Pro Copy", "udid-copy"),
  device("iPhone 17e", "udid-17e"),
]

describe("matchDevice", () => {
  test("matches a UDID exactly", () => {
    expect(matchDevice(devices, "udid-copy").name).toBe("iPhone 17 Pro Copy")
  })

  test("matches an exact name before trying fragments", () => {
    expect(matchDevice(devices, "iPhone 17 Pro").udid).toBe("udid-17-pro")
  })

  test("matches a unique name fragment", () => {
    expect(matchDevice(devices, "17e").udid).toBe("udid-17e")
  })

  test("refuses an ambiguous fragment instead of guessing", () => {
    expect(() => matchDevice(devices, "iPhone 17")).toThrow(/matches multiple simulators/)
  })

  test("reports a missing device", () => {
    expect(() => matchDevice(devices, "Pixel")).toThrow(/No simulator matches/)
  })
})
