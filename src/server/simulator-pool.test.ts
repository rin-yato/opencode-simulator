import { describe, expect, test } from "bun:test"
import type { Device } from "./devices"
import { ManagedDevices } from "./managed"
import { SessionDevices } from "./session-devices"
import { SimulatorPool } from "./simulator-pool"

const device = (udid: string): Device => ({
  udid,
  name: udid,
  state: "Booted",
  runtime: "iOS 26.5",
  runtimeId: "com.apple.CoreSimulator.SimRuntime.iOS-26-5",
  deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",
  available: true,
})

const setup = (entries: Record<string, string> = {}) => {
  const sessions = new SessionDevices(entries)
  const managed = new ManagedDevices()
  const released: Array<{ sessionID: string; udid: string; force: boolean }> = []
  const pool = new SimulatorPool({
    sessions,
    managed,
    shutdownDelayMs: 0,
    onRelease: (sessionID, udid, force) => released.push({ sessionID, udid, force }),
  })
  return { sessions, managed, pool, released }
}

describe("SimulatorPool", () => {
  test("claims and releases a managed device", async () => {
    const { sessions, managed, pool } = setup()
    await pool.manage(device("udid-1"))
    expect(pool.isManaged("udid-1")).toBe(true)
    expect(await pool.claim("ses_1", "udid-1")).toBe(true)
    expect(sessions.pick("ses_1")).toBe("udid-1")
    pool.started("ses_1")
    expect(pool.releaseState("ses_1")).toBe("turn")

    await pool.hold("ses_1")
    await pool.idle("ses_1")
    expect(pool.releaseState("ses_1")).toBe("held")
    expect(await pool.releaseManual("ses_1")).toBe("udid-1")
    expect(sessions.pick("ses_1")).toBeUndefined()
    expect(managed.has("udid-1")).toBe(true)
  })

  test("forgetDevice clears owners, managed state, and late panels", async () => {
    const { sessions, managed, pool } = setup({ ses_1: "udid-1" })
    await pool.manage(device("udid-1"))
    await pool.panel({
      sessionID: "ses_1",
      udid: "udid-1",
      state: "visible",
      window: "win-a",
    })

    expect(await pool.forgetDevice("udid-1")).toEqual(["ses_1"])
    expect(sessions.pick("ses_1")).toBeUndefined()
    expect(managed.has("udid-1")).toBe(false)
    expect(pool.panelState("ses_1")).toBe("closed")

    await pool.panel({
      sessionID: "ses_1",
      udid: "udid-1",
      state: "visible",
      window: "win-a",
    })
    expect(sessions.pick("ses_1")).toBeUndefined()
  })

  test("an explicit release only releases the expected device", async () => {
    const { sessions, pool } = setup({ ses_1: "udid-1" })
    expect(await pool.releaseManual("ses_1", "udid-2")).toBeUndefined()
    expect(sessions.pick("ses_1")).toBe("udid-1")
  })
})
