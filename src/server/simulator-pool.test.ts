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

const setup = (
  entries: Record<string, string> = {},
  extra: Partial<ConstructorParameters<typeof SimulatorPool>[0]> = {},
) => {
  const sessions = new SessionDevices(entries)
  const managed = new ManagedDevices()
  const released: Array<{ sessionID: string; udid: string; force: boolean }> = []
  const renames: Array<{ udid: string; name: string }> = []
  const pool = new SimulatorPool({
    sessions,
    managed,
    shutdownDelayMs: 0,
    onRelease: (sessionID, udid, force) => released.push({ sessionID, udid, force }),
    rename: async (udid, name) => {
      renames.push({ udid, name })
    },
    ...extra,
  })
  return { sessions, managed, pool, released, renames }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

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

  test("marks a managed device in use and clears the mark on release", async () => {
    const { pool, renames } = setup()
    await pool.manage(device("udid-1"))
    pool.started("ses_1")
    await pool.claim("ses_1", "udid-1")
    expect(renames.at(-1)).toEqual({ udid: "udid-1", name: "udid-1 · in use" })
    await pool.releaseManual("ses_1")
    expect(renames.at(-1)).toEqual({ udid: "udid-1", name: "udid-1" })
  })

  test("keeps the mark while another session still shares the device", async () => {
    const { pool, renames } = setup()
    await pool.manage(device("udid-1"))
    pool.started("ses_1")
    pool.started("ses_2")
    await pool.claim("ses_1", "udid-1")
    await pool.remember("ses_2", "udid-1")
    await pool.releaseManual("ses_1")
    expect(renames.at(-1)).toEqual({ udid: "udid-1", name: "udid-1 · in use" })
  })

  test("switching devices unmarks and schedules shutdown of the old one", async () => {
    const shut: string[] = []
    const { sessions, pool, renames, released } = setup(
      {},
      {
        shutdownDelayMs: 5,
        list: async () => [device("udid-1"), device("udid-2")],
        shutdown: async (d) => {
          shut.push(d.udid)
        },
      },
    )
    await pool.manage(device("udid-1"))
    await pool.manage(device("udid-2"))
    await pool.claim("ses_1", "udid-1")
    await pool.panel({ sessionID: "ses_1", udid: "udid-1", state: "open", window: "w" })
    await pool.claim("ses_1", "udid-2")
    expect(sessions.pick("ses_1")).toBe("udid-2")
    expect(renames.filter((r) => r.udid === "udid-1").at(-1)?.name).toBe("udid-1")
    expect(pool.panelDevice("ses_1")).toBeUndefined()
    expect(released).toEqual([])
    await wait(30)
    expect(shut).toEqual(["udid-1"])
  })

  test("switching leaves a device another session still owns alone", async () => {
    const shut: string[] = []
    const { pool, renames } = setup(
      {},
      {
        shutdownDelayMs: 5,
        list: async () => [device("udid-1"), device("udid-2")],
        shutdown: async (d) => {
          shut.push(d.udid)
        },
      },
    )
    await pool.manage(device("udid-1"))
    pool.started("ses_2")
    await pool.claim("ses_1", "udid-1")
    await pool.remember("ses_2", "udid-1")
    await pool.remember("ses_1", "udid-2")
    expect(renames.filter((r) => r.udid === "udid-1").at(-1)?.name).toBe("udid-1 · in use")
    await wait(30)
    expect(shut).toEqual([])
  })

  test("a panel that moves to another device schedules the old one for shutdown", async () => {
    const shut: string[] = []
    const { pool } = setup(
      {},
      {
        shutdownDelayMs: 5,
        list: async () => [device("udid-1"), device("udid-2")],
        shutdown: async (d) => {
          shut.push(d.udid)
        },
      },
    )
    await pool.manage(device("udid-1"))
    await pool.panel({ sessionID: "ses_1", udid: "udid-1", state: "open", window: "w" })
    await pool.claim("ses_1", "udid-2")
    await pool.panel({ sessionID: "ses_1", udid: "udid-2", state: "open", window: "w" })
    await wait(30)
    expect(shut).toEqual(["udid-1"])
  })

  test("remembers the last device per session and forgets it with the device", async () => {
    const { pool } = setup()
    expect(pool.last("ses_1")).toBeUndefined()
    await pool.claim("ses_1", "udid-1")
    await pool.releaseManual("ses_1")
    expect(pool.last("ses_1")).toBe("udid-1")
    await pool.remember("ses_1", "udid-2")
    expect(pool.last("ses_1")).toBe("udid-2")
    await pool.forgetDevice("udid-2")
    expect(pool.last("ses_1")).toBeUndefined()
  })

  test("caps the last-device map", async () => {
    const { pool } = setup()
    for (let i = 0; i < 501; i += 1) await pool.remember(`ses_${i}`, `udid-${i}`)
    expect(pool.last("ses_0")).toBeUndefined()
    expect(pool.last("ses_500")).toBe("udid-500")
  })

  test("failed gives the device up and drops the affinity", async () => {
    const { sessions, pool } = setup()
    await pool.claim("ses_1", "udid-1")
    await pool.failed("ses_1", "udid-1")
    expect(sessions.pick("ses_1")).toBeUndefined()
    expect(pool.last("ses_1")).toBeUndefined()
  })

  test("markIdle ends a hold and keeps the claim and the panel", async () => {
    const { sessions, pool, released } = setup()
    await pool.manage(device("udid-1"))
    await pool.claim("ses_1", "udid-1")
    pool.hold("ses_1")
    await pool.panel({ sessionID: "ses_1", udid: "udid-1", state: "visible", window: "w" })
    expect(await pool.markIdle("ses_1")).toBe("udid-1")
    expect(pool.releaseState("ses_1")).toBe("panel")
    expect(sessions.pick("ses_1")).toBe("udid-1")
    expect(released).toEqual([])
    expect(await pool.markIdle("ses_9")).toBeUndefined()
    expect(await pool.markIdle("ses_1", "udid-2")).toBeUndefined()
  })

  test("the name shows in use while an agent works, idle once it is done, plain when unbound", async () => {
    const { pool, renames } = setup()
    const last = () => renames.at(-1)?.name
    await pool.manage(device("udid-1"))
    pool.started("ses_1")
    await pool.claim("ses_1", "udid-1")
    expect(last()).toBe("udid-1 · in use")

    // The turn is still running, but the agent said it is done.
    expect(await pool.markIdle("ses_1")).toBe("udid-1")
    await wait(5)
    expect(last()).toBe("udid-1 · idle")
    expect(pool.isBusy("udid-1")).toBe(false)
    expect(pool.releaseState("ses_1")).toBe("idle")

    // Using the simulator again makes it active.
    pool.engage("ses_1")
    await wait(5)
    expect(last()).toBe("udid-1 · in use")
    expect(pool.isBusy("udid-1")).toBe(true)

    await pool.idle("ses_1")
    expect(last()).toBe("udid-1 · idle")
    await pool.releaseManual("ses_1")
    expect(last()).toBe("udid-1")
  })

  test("an open panel keeps a device idle, not in use, and still protects it", async () => {
    const { pool, renames } = setup()
    await pool.manage(device("udid-1"))
    await pool.claim("ses_1", "udid-1")
    await pool.panel({ sessionID: "ses_1", udid: "udid-1", state: "visible", window: "w" })
    expect(renames.at(-1)?.name).toBe("udid-1 · idle")
    expect(pool.isBusy("udid-1", "ses_2")).toBe(true)
  })

  test("a hold marks the device in use until it is marked idle", async () => {
    const { pool, renames } = setup()
    await pool.manage(device("udid-1"))
    await pool.claim("ses_1", "udid-1")
    pool.hold("ses_1")
    await wait(5)
    expect(renames.at(-1)?.name).toBe("udid-1 · in use")
    await pool.markIdle("ses_1")
    await wait(5)
    expect(renames.at(-1)?.name).toBe("udid-1 · idle")
  })

  test("an idle device winds down after the shutdown delay but stays claimed", async () => {
    const shut: string[] = []
    const { sessions, pool } = setup(
      {},
      {
        shutdownDelayMs: 5,
        list: async () => [{ ...device("udid-1"), state: "Booted" }],
        shutdown: async (d) => {
          shut.push(d.udid)
        },
      },
    )
    await pool.manage(device("udid-1"))
    await pool.claim("ses_1", "udid-1")
    pool.started("ses_1")
    await pool.idle("ses_1")
    await wait(30)
    expect(shut).toEqual(["udid-1"])
    expect(sessions.pick("ses_1")).toBe("udid-1")
  })

  test("takeOver notifies the window of the session that lost its device", async () => {
    const { sessions, pool, released } = setup()
    await pool.manage(device("udid-1"))
    await pool.claim("ses_1", "udid-1")
    expect(await pool.takeOver("ses_2", "udid-1")).toBe(true)
    expect(sessions.pick("ses_1")).toBeUndefined()
    expect(sessions.pick("ses_2")).toBe("udid-1")
    expect(released).toEqual([{ sessionID: "ses_1", udid: "udid-1", force: false }])
    expect(pool.last("ses_1")).toBeUndefined()

    pool.started("ses_2")
    expect(await pool.takeOver("ses_3", "udid-1")).toBe(false)
    expect(sessions.pick("ses_2")).toBe("udid-1")
  })

  describe("resume", () => {
    const resumable = async (
      extra: Partial<ConstructorParameters<typeof SimulatorPool>[0]> = {},
    ) => {
      const booted: string[] = []
      const ctx = setup(
        {},
        {
          list: async () => [{ ...device("udid-1"), state: "Shutdown" }, device("udid-2")],
          boot: async (d) => {
            booted.push(d.udid)
          },
          ...extra,
        },
      )
      await ctx.pool.manage(device("udid-1"))
      await ctx.pool.claim("ses_1", "udid-1")
      // The claim is lost (another session took it, or the store was cleared);
      // the affinity stays.
      await ctx.sessions.forgetSession("ses_1")
      expect(ctx.sessions.pick("ses_1")).toBeUndefined()
      return { ...ctx, booted }
    }

    test("takes the last device back when a panel reopens, and wakes it", async () => {
      const { pool, sessions, booted } = await resumable()
      expect(await pool.resume("ses_1")).toBe("udid-1")
      expect(sessions.pick("ses_1")).toBe("udid-1")
      await wait(5)
      expect(booted).toEqual(["udid-1"])
      // A second poll sees the claim and does not boot again.
      expect(await pool.resume("ses_1")).toBe("udid-1")
      expect(booted).toEqual(["udid-1"])
    })

    test("does not boot a device that is already running", async () => {
      const { pool, booted } = await resumable({ list: async () => [device("udid-1")] })
      expect(await pool.resume("ses_1")).toBe("udid-1")
      await wait(5)
      expect(booted).toEqual([])
    })

    test("leaves a device another session took", async () => {
      const { pool, sessions } = await resumable()
      await pool.claim("ses_2", "udid-1")
      expect(await pool.resume("ses_1")).toBeUndefined()
      expect(sessions.pick("ses_1")).toBeUndefined()
    })

    test("does not resume after an explicit release", async () => {
      const { pool, sessions } = await resumable()
      await pool.claim("ses_1", "udid-1")
      await pool.releaseManual("ses_1")
      expect(await pool.resume("ses_1")).toBeUndefined()
      expect(sessions.pick("ses_1")).toBeUndefined()
      // A later start takes it again, and resume works from then on.
      await pool.claim("ses_1", "udid-1")
      await pool.idle("ses_1")
      expect(await pool.resume("ses_1")).toBe("udid-1")
    })

    test("an idle session keeps its claim without any resume", async () => {
      const { pool, sessions } = await resumable()
      await pool.claim("ses_1", "udid-1")
      await pool.idle("ses_1")
      expect(sessions.pick("ses_1")).toBe("udid-1")
    })

    test("ignores external and deleted devices", async () => {
      const { pool } = setup({}, { list: async () => [device("udid-ext")] })
      await pool.claim("ses_1", "udid-ext")
      await pool.sessions.forgetSession("ses_1")
      expect(await pool.resume("ses_1")).toBeUndefined()

      const second = await resumable()
      await second.pool.forgetDevice("udid-1")
      expect(await second.pool.resume("ses_1")).toBeUndefined()
    })

    test("gives up when the device is gone or the listing fails", async () => {
      const gone = await resumable({ list: async () => [device("udid-2")] })
      expect(await gone.pool.resume("ses_1")).toBeUndefined()
      const broken = await resumable({
        list: async () => {
          throw new Error("no simctl")
        },
      })
      expect(await broken.pool.resume("ses_1")).toBeUndefined()
    })

    test("a session with no history gets nothing", async () => {
      const { pool } = setup()
      expect(await pool.resume("ses_1")).toBeUndefined()
    })
  })

  test("reconcile prunes and renames from the listing", async () => {
    const { sessions, managed, pool, renames } = setup(
      { ses_1: "udid-gone", ses_2: "udid-ext", ses_3: "udid-live" },
      {
        list: async () => [
          { ...device("udid-live"), name: "udid-live" },
          { ...device("udid-ext"), name: "External" },
        ],
      },
    )
    await pool.manage(device("udid-gone"))
    await pool.manage(device("udid-live"))
    pool.started("ses_3")
    await pool.reconcile()
    expect(managed.has("udid-gone")).toBe(false)
    expect(managed.has("udid-live")).toBe(true)
    expect(sessions.pick("ses_1")).toBeUndefined()
    expect(sessions.pick("ses_2")).toBe("udid-ext")
    expect(renames.at(-1)).toEqual({ udid: "udid-live", name: "udid-live · in use" })
  })

  test("reconcile changes nothing when listing fails", async () => {
    const { sessions, managed, pool } = setup(
      { ses_1: "udid-1" },
      {
        list: async () => {
          throw new Error("no simctl")
        },
      },
    )
    await pool.manage(device("udid-1"))
    const warn = console.warn
    console.warn = () => {}
    try {
      await pool.reconcile()
    } finally {
      console.warn = warn
    }
    expect(managed.has("udid-1")).toBe(true)
    expect(sessions.pick("ses_1")).toBe("udid-1")
  })

  test("withLock serializes tasks and survives a rejection", async () => {
    const { pool } = setup()
    const order: string[] = []
    const first = pool.withLock(async () => {
      await wait(10)
      order.push("first")
      throw new Error("boom")
    })
    const second = pool.withLock(async () => {
      order.push("second")
      return 2
    })
    await expect(first).rejects.toThrow("boom")
    expect(await second).toBe(2)
    expect(order).toEqual(["first", "second"])
  })

  test("never renames an external device", async () => {
    const { pool, renames } = setup()
    expect(await pool.claim("ses_1", "udid-external")).toBe(true)
    expect(renames).toEqual([])
  })

  test("reconcile keeps every record when the list comes back empty", async () => {
    const { managed, pool } = setup({}, { list: async () => [] })
    await pool.manage(device("udid-1"))
    await pool.reconcile()
    expect(managed.has("udid-1")).toBe(true)
  })

  test("reconcile waits for a locked allocation", async () => {
    let listed = false
    const { pool } = setup(
      {},
      {
        list: async () => {
          listed = true
          return [device("udid-1")]
        },
      },
    )
    let finish = () => {}
    const allocation = pool.withLock(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    const reconciled = pool.reconcile()
    await wait(5)
    expect(listed).toBe(false)
    finish()
    await allocation
    await reconciled
    expect(listed).toBe(true)
  })
})
