import { describe, expect, test } from "bun:test"
import { ManagedDevices } from "../managed"
import { SessionDevices } from "../session-devices"
import { SimulatorPool } from "../simulator-pool"
import { panelFollower, type SimulatorContext } from "./context"

const setup = () => {
  const opened: string[] = []
  const pool = new SimulatorPool({
    sessions: new SessionDevices(),
    managed: new ManagedDevices(),
    shutdownDelayMs: 0,
    rename: async () => {},
  })
  const simulator: SimulatorContext = {
    hub: {},
    pool,
    openPanel: async (udid) => {
      opened.push(udid)
      return true
    },
  }
  return { opened, pool, simulator }
}

describe("panelFollower", () => {
  test("moves an open panel to the device the claim moved to", async () => {
    const { opened, pool, simulator } = setup()
    await pool.claim("ses_1", "udid-1")
    await pool.panel({ sessionID: "ses_1", udid: "udid-1", state: "visible", window: "win" })

    const follow = panelFollower(simulator, "ses_1")
    await pool.claim("ses_1", "udid-2")

    expect(follow("udid-2")).toBe(true)
    expect(opened).toEqual(["udid-2"])
  })

  test("leaves the panel alone when the device did not change", async () => {
    const { opened, pool, simulator } = setup()
    await pool.claim("ses_1", "udid-1")
    await pool.panel({ sessionID: "ses_1", udid: "udid-1", state: "visible", window: "win" })

    expect(panelFollower(simulator, "ses_1")("udid-1")).toBe(false)
    expect(opened).toEqual([])
  })

  test("does not open a panel the session never had", async () => {
    const { opened, pool, simulator } = setup()
    await pool.claim("ses_1", "udid-1")

    expect(panelFollower(simulator, "ses_1")("udid-2")).toBe(false)
    expect(opened).toEqual([])
  })
})
