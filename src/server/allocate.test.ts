import { describe, expect, test } from "bun:test"
import { allocate, createManaged, type AllocateDeps } from "./allocate"
import type { Device } from "./devices"
import { ManagedDevices } from "./managed"
import { MAX_POOL_SIZE } from "./pool"
import { SessionDevices } from "./session-devices"
import { SimulatorPool } from "./simulator-pool"

const TYPE = "com.apple.CoreSimulator.SimDeviceType."
const RUNTIME = "com.apple.CoreSimulator.SimRuntime.iOS-26-5"

const device = (name: string, overrides: Partial<Device> = {}): Device => ({
  udid: name,
  name,
  state: "Shutdown",
  runtime: "iOS 26.5",
  runtimeId: RUNTIME,
  deviceType: `${TYPE}iPhone-17-Pro`,
  available: true,
  ...overrides,
})

const air = (name: string, overrides: Partial<Device> = {}) =>
  device(name, { deviceType: `${TYPE}iPhone-Air`, ...overrides })

const setup = (initial: Device[]) => {
  const devices = [...initial]
  const created: Device[] = []
  const removed: string[] = []
  const deps: AllocateDeps & { failCreate?: boolean } = {
    list: async () => [...devices],
    create: async (source, name) => {
      await Promise.resolve()
      const next = device(name, {
        udid: `new-${created.length + 1}-${name}`,
        deviceType: source.deviceType,
        runtimeId: source.runtimeId,
      })
      devices.push(next)
      created.push(next)
      return next
    },
    remove: async (target) => {
      removed.push(target.udid)
      devices.splice(
        devices.findIndex((entry) => entry.udid === target.udid),
        1,
      )
    },
  }
  const pool = new SimulatorPool({
    sessions: new SessionDevices({}),
    managed: new ManagedDevices(),
    shutdownDelayMs: 0,
    rename: async () => {},
    list: async () => [...devices],
  })
  return { pool, deps, devices, created, removed }
}

describe("allocate", () => {
  test("first use with nothing booted creates a managed iPhone Pro", async () => {
    const { pool, deps, created } = setup([
      device("iPhone 16 Pro"),
      device("iPhone 17 Pro"),
      air("iPhone Air"),
    ])
    const result = await allocate(pool, { sessionID: "a" }, deps)
    expect(result.created).toBe(true)
    expect(result.refresh).toBe(true)
    expect(result.source.name).toBe("iPhone 17 Pro")
    expect(result.device.name).toBe("iPhone 17 Pro 1")
    expect(created).toHaveLength(1)
    expect(pool.isManaged(result.device.udid)).toBe(true)
    expect(pool.pick("a")).toBe(result.device.udid)
  })

  test("never claims an external device implicitly", async () => {
    const { pool, deps } = setup([device("iPhone 17 Pro", { state: "Booted" })])
    const result = await allocate(pool, { sessionID: "a" }, deps)
    expect(result.device.udid).not.toBe("iPhone 17 Pro")
    expect(pool.owners("iPhone 17 Pro")).toEqual([])
    expect(result.source.udid).toBe("iPhone 17 Pro")
  })

  test("two parallel allocations get two devices", async () => {
    const { pool, deps, created } = setup([device("iPhone 17 Pro")])
    pool.started("a")
    pool.started("b")
    const [a, b] = await Promise.all([
      allocate(pool, { sessionID: "a" }, deps),
      allocate(pool, { sessionID: "b" }, deps),
    ])
    expect(a.device.udid).not.toBe(b.device.udid)
    expect(created).toHaveLength(2)
  })

  test("reuses a free managed device without creating", async () => {
    const { pool, deps, devices, created } = setup([device("iPhone 17 Pro")])
    const free = device("iPhone 17 Pro 1")
    devices.push(free)
    await pool.manage(free)
    const result = await allocate(pool, { sessionID: "a" }, deps)
    expect(result.device.udid).toBe(free.udid)
    expect(result.refresh).toBe(true)
    expect(created).toHaveLength(0)
  })

  test("a held claim is re-claimed without refresh", async () => {
    const { pool, deps } = setup([device("iPhone 17 Pro")])
    const first = await allocate(pool, { sessionID: "a" }, deps)
    const again = await allocate(pool, { sessionID: "a" }, deps)
    expect(again.device.udid).toBe(first.device.udid)
    expect(again.refresh).toBe(false)
  })

  test("a finished session keeps its device and gets it back without refresh", async () => {
    const { pool, deps, created } = setup([device("iPhone 17 Pro")])
    pool.started("a")
    pool.started("b")
    const first = await allocate(pool, { sessionID: "a" }, deps)
    const other = await allocate(pool, { sessionID: "b" }, deps)
    await pool.idle("a")
    await pool.idle("b")
    expect(pool.pick("a")).toBe(first.device.udid)
    const again = await allocate(pool, { sessionID: "a" }, deps)
    expect(again.device.udid).toBe(first.device.udid)
    expect(again.refresh).toBe(false)
    expect(other.device.udid).not.toBe(first.device.udid)
    expect(created).toHaveLength(2)
  })

  test("a new session takes an idle session's running device instead of creating one", async () => {
    const { pool, deps, devices, created } = setup([device("iPhone 17 Pro")])
    pool.started("a")
    const first = await allocate(pool, { sessionID: "a" }, deps)
    const at = devices.findIndex((entry) => entry.udid === first.device.udid)
    devices[at] = { ...devices[at]!, state: "Booted" }
    await pool.idle("a")

    const second = await allocate(pool, { sessionID: "b" }, deps)
    expect(second.device.udid).toBe(first.device.udid)
    expect(second.created).toBeUndefined()
    expect(created).toHaveLength(1)
    expect(pool.pick("a")).toBeUndefined()
    expect(pool.pick("b")).toBe(first.device.udid)
  })

  test("takes an idle booted device before waking a shut down one", async () => {
    const { pool, deps, devices } = setup([device("iPhone 17 Pro")])
    const sleeping = device("iPhone 17 Pro 1")
    const booted = device("iPhone 17 Pro 2", { state: "Booted" })
    devices.push(sleeping, booted)
    await pool.manage(sleeping)
    await pool.manage(booted)
    await pool.claim("a", booted.udid)
    const result = await allocate(pool, { sessionID: "b" }, deps)
    expect(result.device.udid).toBe(booted.udid)
  })

  test("never takes a device from a running turn, an open panel, or a hold", async () => {
    const { pool, deps, devices, created } = setup([device("iPhone 17 Pro")])
    for (const [name, protect] of [
      ["running", () => pool.started("owner")],
      ["held", () => pool.hold("owner")],
    ] as const) {
      const managed = device(`iPhone 17 Pro ${name}`, { state: "Booted" })
      devices.push(managed)
      await pool.manage(managed)
      await pool.claim("owner", managed.udid)
      protect()
      const result = await allocate(pool, { sessionID: `taker-${name}` }, deps)
      expect(result.device.udid).not.toBe(managed.udid)
      expect(pool.pick("owner")).toBe(managed.udid)
      await pool.releaseManual("owner")
      await pool.releaseManual(`taker-${name}`)
    }
    const shown = device("iPhone 17 Pro shown", { state: "Booted" })
    devices.push(shown)
    await pool.manage(shown)
    await pool.panel({ sessionID: "viewer", udid: shown.udid, state: "visible", window: "w" })
    const result = await allocate(pool, { sessionID: "taker-panel" }, deps)
    expect(result.device.udid).not.toBe(shown.udid)
    expect(pool.pick("viewer")).toBe(shown.udid)
    expect(created.length).toBeGreaterThan(0)
  })

  test("never takes an external device from an idle session", async () => {
    const { pool, deps } = setup([device("iPhone 17 Pro", { state: "Booted" })])
    await allocate(pool, { sessionID: "a", udid: "iPhone 17 Pro" }, deps)
    const result = await allocate(pool, { sessionID: "b" }, deps)
    expect(result.device.udid).not.toBe("iPhone 17 Pro")
    expect(pool.pick("a")).toBe("iPhone 17 Pro")
  })

  test("a vanished claim is forgotten and replaced", async () => {
    const { pool, deps, devices } = setup([device("iPhone 17 Pro")])
    const first = await allocate(pool, { sessionID: "a" }, deps)
    devices.splice(
      devices.findIndex((entry) => entry.udid === first.device.udid),
      1,
    )
    const next = await allocate(pool, { sessionID: "a" }, deps)
    expect(next.device.udid).not.toBe(first.device.udid)
    expect(next.created).toBe(true)
  })

  test("throws at the cap", async () => {
    const { pool, deps, devices } = setup([device("iPhone 17 Pro")])
    for (let i = 1; i <= MAX_POOL_SIZE; i++) {
      const managed = device(`iPhone 17 Pro ${i}`)
      devices.push(managed)
      await pool.manage(managed)
      await pool.claim(`other-${i}`, managed.udid)
      pool.started(`other-${i}`)
    }
    await expect(allocate(pool, { sessionID: "a" }, deps)).rejects.toThrow(
      `All ${MAX_POOL_SIZE} managed iPhone 17 Pro simulators are in use`,
    )
  })

  test("from picks that model's pool and does not claim from", async () => {
    const { pool, deps } = setup([device("iPhone 17 Pro"), air("iPhone Air")])
    const result = await allocate(pool, { sessionID: "a", from: "iPhone Air" }, deps)
    expect(result.source.name).toBe("iPhone Air")
    expect(result.device.deviceType).toContain("iPhone-Air")
    expect(result.device.udid).not.toBe("iPhone Air")
    expect(pool.owners("iPhone Air")).toEqual([])
  })

  test("from claims a free managed device of that model", async () => {
    const { pool, deps, devices } = setup([air("iPhone Air")])
    const free = air("iPhone Air 1")
    devices.push(free)
    await pool.manage(free)
    const result = await allocate(pool, { sessionID: "a", from: "iPhone Air" }, deps)
    expect(result.device.udid).toBe("iPhone Air 1")
  })

  test("a claim moves when from names another model", async () => {
    const { pool, deps } = setup([device("iPhone 17 Pro"), air("iPhone Air")])
    const first = await allocate(pool, { sessionID: "a" }, deps)
    const moved = await allocate(pool, { sessionID: "a", from: "iPhone Air" }, deps)
    expect(moved.device.deviceType).toContain("iPhone-Air")
    expect(moved.refresh).toBe(true)
    expect(pool.pick("a")).toBe(moved.device.udid)
    expect(pool.owners(first.device.udid)).toEqual([])
  })

  test("from of the held model keeps the claim", async () => {
    const { pool, deps } = setup([device("iPhone 17 Pro")])
    const first = await allocate(pool, { sessionID: "a" }, deps)
    const again = await allocate(pool, { sessionID: "a", from: "iPhone 17 Pro" }, deps)
    expect(again.device.udid).toBe(first.device.udid)
    expect(again.refresh).toBe(false)
  })

  test("an explicit udid claims that device and does not refresh", async () => {
    const { pool, deps } = setup([device("iPhone 17 Pro")])
    const result = await allocate(pool, { sessionID: "a", udid: "iPhone 17 Pro" }, deps)
    expect(result.device.udid).toBe("iPhone 17 Pro")
    expect(result.refresh).toBe(false)
    expect(pool.pick("a")).toBe("iPhone 17 Pro")
  })

  test("refuses another session's device without share, allows it with share", async () => {
    const { pool, deps } = setup([device("iPhone 17 Pro")])
    await allocate(pool, { sessionID: "a", udid: "iPhone 17 Pro" }, deps)
    await expect(allocate(pool, { sessionID: "b", udid: "iPhone 17 Pro" }, deps)).rejects.toThrow(
      "is used by another session. Pass share: true",
    )
    const shared = await allocate(
      pool,
      { sessionID: "b", udid: "iPhone 17 Pro", share: true },
      deps,
    )
    expect(shared.device.udid).toBe("iPhone 17 Pro")
    expect(pool.owners("iPhone 17 Pro").sort()).toEqual(["a", "b"])
  })

  test("applies hold in every branch", async () => {
    const { pool, deps } = setup([device("iPhone 17 Pro")])
    await allocate(pool, { sessionID: "a", hold: true }, deps)
    expect(pool.releaseState("a")).toBe("held")
    await allocate(pool, { sessionID: "b", udid: "iPhone 17 Pro", hold: true }, deps)
    expect(pool.releaseState("b")).toBe("held")
    await allocate(pool, { sessionID: "a", hold: true }, deps)
    expect(pool.releaseState("a")).toBe("held")
  })
})

describe("createManaged", () => {
  test("removes the device when claiming fails", async () => {
    const { pool, deps, removed } = setup([device("iPhone 17 Pro")])
    pool.claim = async () => false
    await expect(
      createManaged(pool, "a", device("iPhone 17 Pro"), "iPhone 17 Pro 1", deps),
    ).rejects.toThrow("Could not claim")
    expect(removed).toEqual(["new-1-iPhone 17 Pro 1"])
    expect(pool.isManaged("new-1-iPhone 17 Pro 1")).toBe(false)
  })
})
