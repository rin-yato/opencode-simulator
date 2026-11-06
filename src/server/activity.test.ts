import { describe, expect, test } from "bun:test"
import { Activity } from "./activity"
import { SessionDevices } from "./session-devices"

const setup = (entries: Record<string, string> = {}) => {
  const sessions = new SessionDevices(entries)
  const activity = new Activity({ sessions, shutdownDelayMs: 0 })
  return { sessions, activity }
}

describe("Activity", () => {
  test("opening a panel claims a free device", async () => {
    const { sessions, activity } = setup()
    await activity.panel({ sessionID: "ses_1", udid: "udid-1", state: "visible" })
    expect(sessions.pick("ses_1")).toBe("udid-1")
    expect(activity.panelState("ses_1")).toBe("visible")
  })

  test("a running session keeps its device after the panel closes", async () => {
    const { sessions, activity } = setup({ ses_1: "udid-1" })
    activity.started("ses_1")
    await activity.panel({ sessionID: "ses_1", state: "closed" })
    expect(sessions.pick("ses_1")).toBe("udid-1")
    expect(activity.isRunning("ses_1")).toBe(true)
  })

  test("an idle session releases a closed panel's device", async () => {
    const { sessions, activity } = setup({ ses_1: "udid-1" })
    await activity.panel({ sessionID: "ses_1", state: "visible" })
    await activity.panel({ sessionID: "ses_1", state: "closed" })
    expect(sessions.pick("ses_1")).toBeUndefined()
    expect(activity.panelState("ses_1")).toBe("closed")
  })

  test("an open panel keeps the device when the session goes idle", async () => {
    const { sessions, activity } = setup({ ses_1: "udid-1" })
    await activity.panel({ sessionID: "ses_1", udid: "udid-1", state: "active" })
    activity.started("ses_1")
    await activity.idle("ses_1")
    expect(sessions.pick("ses_1")).toBe("udid-1")
  })

  test("closing a session releases both kinds of activity", async () => {
    const { sessions, activity } = setup({ ses_1: "udid-1" })
    await activity.panel({ sessionID: "ses_1", state: "visible" })
    activity.started("ses_1")
    await activity.close("ses_1")
    expect(sessions.pick("ses_1")).toBeUndefined()
    expect(activity.panelState("ses_1")).toBe("closed")
    expect(activity.isRunning("ses_1")).toBe(false)
  })

  test("a panel never steals a device owned by another session", async () => {
    const { sessions, activity } = setup({ ses_2: "udid-1" })
    await activity.panel({ sessionID: "ses_1", udid: "udid-1", state: "visible" })
    expect(sessions.pick("ses_1")).toBeUndefined()
    expect(sessions.pick("ses_2")).toBe("udid-1")
    expect(activity.isBusy("udid-1", "ses_2")).toBe(true)
    expect(activity.isBusy("udid-1", "ses_1")).toBe(false)
  })

  test("an open panel does not replace the session's existing claim", async () => {
    const { sessions, activity } = setup({ ses_1: "udid-old" })
    await activity.panel({ sessionID: "ses_1", udid: "udid-panel", state: "visible" })
    expect(sessions.pick("ses_1")).toBe("udid-old")
    expect(activity.isBusy("udid-panel", "ses_2")).toBe(true)
  })

  test("an open panel without a device holds the session's claim", async () => {
    const { sessions, activity } = setup({ ses_1: "udid-1" })
    await activity.panel({ sessionID: "ses_1", state: "visible" })
    expect(activity.panelState("ses_1")).toBe("visible")
    expect(activity.panelDevice("ses_1")).toBe("udid-1")
    expect(sessions.pick("ses_1")).toBe("udid-1")
  })

  test("an open panel without a device claims nothing when the session has none", async () => {
    const { sessions, activity } = setup()
    await activity.panel({ sessionID: "ses_1", state: "visible" })
    expect(activity.panelState("ses_1")).toBe("closed")
    expect(sessions.pick("ses_1")).toBeUndefined()
  })

  test("a running session marks its device busy for other sessions", () => {
    const { activity } = setup({ ses_1: "udid-1" })
    activity.started("ses_1")
    expect(activity.isBusy("udid-1", "ses_2")).toBe(true)
    expect(activity.isBusy("udid-1", "ses_1")).toBe(false)
  })

  test("forget clears a deleted device's panel", async () => {
    const { activity } = setup()
    await activity.panel({ sessionID: "ses_1", udid: "udid-1", state: "visible" })
    activity.forget("udid-1")
    expect(activity.panelState("ses_1")).toBe("closed")
  })

  test("notifies the window when a claim is released", async () => {
    const sessions = new SessionDevices({ ses_1: "udid-1" })
    const released: string[] = []
    const activity = new Activity({
      sessions,
      shutdownDelayMs: 0,
      onRelease: (sessionID, udid) => released.push(`${sessionID}:${udid}`),
    })
    await activity.panel({ sessionID: "ses_1", state: "closed" })
    expect(released).toEqual(["ses_1:udid-1"])
  })

  test("does not notify for a session without a claim", async () => {
    const sessions = new SessionDevices()
    const released: string[] = []
    const activity = new Activity({
      sessions,
      shutdownDelayMs: 0,
      onRelease: (sessionID, udid) => released.push(`${sessionID}:${udid}`),
    })
    await activity.close("ses_1")
    expect(released).toEqual([])
  })

  test("expires a panel a dead window stopped refreshing", async () => {
    const { sessions, activity } = setup({ ses_1: "udid-1" })
    await activity.panel({
      sessionID: "ses_1",
      udid: "udid-1",
      state: "visible",
      window: "win-a",
      ttlMs: 1_000,
    })
    await activity.expirePanels(Date.now() + 5_000)
    expect(sessions.pick("ses_1")).toBeUndefined()
    expect(activity.panelState("ses_1")).toBe("closed")
  })

  test("keeps the claim while another window still shows the panel", async () => {
    const { sessions, activity } = setup({ ses_1: "udid-1" })
    await activity.panel({
      sessionID: "ses_1",
      udid: "udid-1",
      state: "visible",
      window: "win-a",
    })
    await activity.panel({
      sessionID: "ses_1",
      udid: "udid-1",
      state: "open",
      window: "win-b",
    })
    await activity.panel({ sessionID: "ses_1", state: "closed", window: "win-a" })
    expect(sessions.pick("ses_1")).toBe("udid-1")
    await activity.panel({ sessionID: "ses_1", state: "closed", window: "win-b" })
    expect(sessions.pick("ses_1")).toBeUndefined()
  })

  test("a hold keeps the device after the panel closes and the session idles", async () => {
    const { sessions, activity } = setup({ ses_1: "udid-1" })
    activity.hold("ses_1")
    await activity.panel({
      sessionID: "ses_1",
      udid: "udid-1",
      state: "visible",
      window: "win-a",
    })
    await activity.panel({ sessionID: "ses_1", state: "closed", window: "win-a" })
    await activity.idle("ses_1")
    expect(sessions.pick("ses_1")).toBe("udid-1")
    expect(activity.releaseState("ses_1")).toBe("held")
  })

  test("manual release clears panels and emits a forced release", async () => {
    const { sessions } = setup()
    const released: boolean[] = []
    const activity = new Activity({
      sessions,
      shutdownDelayMs: 0,
      onRelease: (_sessionID, _udid, force) => released.push(force),
    })
    await activity.panel({ sessionID: "ses_1", udid: "udid-1", state: "visible" })
    expect(await activity.releaseManual("ses_1", "udid-1")).toBe("udid-1")
    expect(sessions.pick("ses_1")).toBeUndefined()
    expect(activity.panelState("ses_1")).toBe("closed")
    expect(released).toEqual([true])
  })

  test("a deleted UDID cannot be claimed by a late panel update", async () => {
    const { sessions, activity } = setup()
    activity.forget("udid-1")
    await activity.panel({ sessionID: "ses_1", udid: "udid-1", state: "visible" })
    expect(sessions.pick("ses_1")).toBeUndefined()
    expect(activity.panelState("ses_1")).toBe("closed")
  })

  test("expires a bounded hold", async () => {
    const { sessions, activity } = setup({ ses_1: "udid-1" })
    activity.hold("ses_1", 1_000)
    expect(activity.releaseState("ses_1")).toBe("held")
    await activity.expirePanels(Date.now() + 5_000)
    expect(sessions.pick("ses_1")).toBeUndefined()
    expect(activity.releaseState("ses_1")).toBe("idle")
  })

  test("manual release clears a panel that shows a different device", async () => {
    const sessions = new SessionDevices({ ses_1: "udid-1" })
    const released: string[] = []
    const activity = new Activity({
      sessions,
      shutdownDelayMs: 0,
      onRelease: (_sessionID, udid) => released.push(udid),
    })
    await activity.panel({
      sessionID: "ses_1",
      udid: "udid-panel",
      state: "visible",
      window: "win-a",
    })
    expect(await activity.releaseManual("ses_1")).toBe("udid-1")
    expect(sessions.pick("ses_1")).toBeUndefined()
    expect(activity.panelState("ses_1")).toBe("closed")
    expect(released).toEqual(["udid-1", "udid-panel"])
  })
})
