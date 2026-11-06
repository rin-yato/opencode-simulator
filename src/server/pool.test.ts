import { describe, expect, test } from "bun:test"
import type { Device } from "./devices"
import {
  MAX_POOL_SIZE,
  chooseReference,
  deviceModel,
  poolDeviceName,
  poolDevices,
  sameModel,
} from "./pool"

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
    expect(
      deviceModel(device("My Phone 2", { deviceType: "com.apple.CoreSimulator.SimDeviceType." })),
    ).toBe("My Phone")
    expect(
      deviceModel(
        device("My Phone 2 · in use", { deviceType: "com.apple.CoreSimulator.SimDeviceType." }),
      ),
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
      device("iPhone 17 Pro 10"),
      device("iPhone 17 Pro 2"),
      device("Other", { deviceType: "other" }),
      device("Unavailable", { available: false }),
      device("iPhone 17 Pro"),
    ]
    expect(poolDevices(source, devices).map((entry) => entry.name)).toEqual([
      "iPhone 17 Pro",
      "iPhone 17 Pro 2",
      "iPhone 17 Pro 10",
    ])
  })

  test("prefers a booted device over a shut-down one", () => {
    const source = device("iPhone 17 Pro")
    const devices = [device("iPhone 17 Pro"), device("iPhone 17 Pro 2", { state: "Booted" })]
    expect(poolDevices(source, devices)[0]!.name).toBe("iPhone 17 Pro 2")
  })

  test("caps the retained pool", () => {
    expect(MAX_POOL_SIZE).toBe(5)
  })
})

describe("poolDeviceName", () => {
  test("starts at 1", () => {
    expect(poolDeviceName(device("iPhone 17 Pro"), [])).toBe("iPhone 17 Pro 1")
  })

  test("skips taken numbers", () => {
    expect(
      poolDeviceName(device("iPhone 17 Pro"), [
        device("iPhone 17 Pro"),
        device("iPhone 17 Pro 1"),
        device("iPhone 17 Pro 2"),
      ]),
    ).toBe("iPhone 17 Pro 3")
  })

  test("counts an in-use device as taken", () => {
    expect(poolDeviceName(device("iPhone 17 Pro"), [device("iPhone 17 Pro 1 · in use")])).toBe(
      "iPhone 17 Pro 2",
    )
  })

  test("uses the model even when the source has a custom name", () => {
    expect(poolDeviceName(device("Melis Order Flow"), [])).toBe("iPhone 17 Pro 1")
  })
})

describe("chooseReference", () => {
  const rt = (v: string) => `com.apple.CoreSimulator.SimRuntime.iOS-${v}`
  const free = () => true
  const none = () => false

  test("prefers a booted device that no other session holds", () => {
    const a = device("A", { state: "Booted" })
    const b = device("B", { state: "Booted" })
    const all = [device("iPhone 17 Pro"), a, b]
    expect(chooseReference(all, (udid) => udid === "B", none)).toBe(b)
    expect(chooseReference(all, none, none)).toBe(a)
  })

  test("then a managed device in name order", () => {
    const all = [device("iPhone 17 Pro"), device("X 10"), device("X 9")]
    expect(chooseReference(all, free, (udid) => udid.startsWith("X")).name).toBe("X 9")
  })

  test("defaults to the highest iPhone Pro on the newest runtime, numerically", () => {
    const all = [
      device("iPhone 9 Pro", { runtimeId: rt("26-10"), udid: "a" }),
      device("iPhone 10 Pro", { runtimeId: rt("26-10"), udid: "b" }),
      device("iPhone 17 Pro", { runtimeId: rt("26-9"), udid: "c" }),
      device("iPhone 18 Pro", { runtimeId: rt("26-9"), udid: "d" }),
      device("iPhone 99 Pro", { runtimeId: rt("25-0"), udid: "e" }),
    ]
    expect(chooseReference(all, free, none).udid).toBe("b")
    expect(chooseReference(all.slice(0, 1), free, none).udid).toBe("a")
  })

  test("falls back to any iPhone, then any device", () => {
    const pad = device("iPad", { udid: "pad" })
    const phone = device("iPhone Air", { udid: "air" })
    expect(chooseReference([pad, phone], free, none).udid).toBe("air")
    expect(chooseReference([pad], free, none).udid).toBe("pad")
  })

  test("ignores watch, tv, unavailable and typeless devices", () => {
    const ignored = [
      device("Watch", { runtimeId: "com.apple.CoreSimulator.SimRuntime.watchOS-26-0" }),
      device("TV", { runtimeId: "com.apple.CoreSimulator.SimRuntime.tvOS-26-0", state: "Booted" }),
      device("Old", { available: false }),
      device("Bare", { deviceType: "" }),
    ]
    expect(() => chooseReference(ignored, free, none)).toThrow("No iOS simulators are installed")
    expect(chooseReference([...ignored, device("iPhone 17 Pro")], free, none).name).toBe(
      "iPhone 17 Pro",
    )
  })
})
