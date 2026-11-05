import { describe, expect, test } from "bun:test"
import { formatSize, matchDevice, type Device } from "./devices"

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
  device("iPhone 17 Pro 2", "udid-17-pro-2"),
  device("iPhone 17e", "udid-17e"),
]

describe("matchDevice", () => {
  test("matches a UDID exactly", () => {
    expect(matchDevice(devices, "udid-17-pro-2").name).toBe("iPhone 17 Pro 2")
  })

  test("matches an exact name before trying fragments", () => {
    expect(matchDevice(devices, "iPhone 17 Pro").udid).toBe("udid-17-pro")
  })

  test("matches a unique name fragment", () => {
    expect(matchDevice(devices, "17e").udid).toBe("udid-17e")
  })

  test("matches a marked device by its plain name", () => {
    const marked = [device("iPhone 17 Pro 2 · in use", "udid-17-pro-2")]
    expect(matchDevice(marked, "iPhone 17 Pro 2").udid).toBe("udid-17-pro-2")
  })

  test("refuses an ambiguous fragment instead of guessing", () => {
    expect(() => matchDevice(devices, "iPhone 17")).toThrow(/matches multiple simulators/)
  })

  test("reports a missing device", () => {
    expect(() => matchDevice(devices, "Pixel")).toThrow(/No simulator matches/)
  })
})

describe("formatSize", () => {
  test("formats kilobytes, megabytes, and gigabytes", () => {
    expect(formatSize(undefined)).toBe("-")
    expect(formatSize(512)).toBe("512 KB")
    expect(formatSize(2_048)).toBe("2.0 MB")
    expect(formatSize(2 * 1_024 * 1_024)).toBe("2.00 GB")
  })
})
