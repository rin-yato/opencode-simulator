import {
  createDeviceFrom,
  deleteDevice,
  hasApp,
  installAppFrom,
  listDevices,
  matchDevice,
  type Device,
} from "./devices"
import {
  MAX_POOL_SIZE,
  chooseReference,
  deviceModel,
  poolDeviceName,
  poolDevices,
  sameModel,
} from "./pool"
import type { SimulatorPool } from "./simulator-pool"

export interface AllocateRequest {
  readonly sessionID: string
  /** Explicit device: the caller chose it, it is only launched. */
  readonly udid?: string
  /** Model and runtime to use, and where the app comes from. Never claimed. */
  readonly from?: string
  readonly share?: boolean
  readonly hold?: boolean
  readonly holdMs?: number
  readonly signal?: AbortSignal
}

export interface Allocation {
  readonly device: Device
  /** Where an app comes from. */
  readonly source: Device
  /** Copy the app from `source` before launching. */
  readonly refresh: boolean
  readonly created?: boolean
}

export interface AllocateDeps {
  list(signal?: AbortSignal): Promise<Device[]>
  create(source: Device, name: string, signal?: AbortSignal): Promise<Device>
  remove(device: Device, signal?: AbortSignal): Promise<unknown>
}

const defaults: AllocateDeps = {
  list: (signal) => listDevices({ signal }),
  create: (source, name, signal) => createDeviceFrom(source, name, { signal }),
  remove: (device, signal) => deleteDevice(device, { signal }),
}

/** Create a pool device and claim it; undo everything if either step fails. */
export async function createManaged(
  pool: SimulatorPool,
  sessionID: string,
  source: Device,
  name: string,
  deps: AllocateDeps = defaults,
  signal?: AbortSignal,
): Promise<Device> {
  const created = await deps.create(source, name, signal)
  try {
    await pool.manage(created)
    if (!(await pool.claim(sessionID, created.udid))) {
      throw new Error(`Could not claim the new simulator ${created.name}.`)
    }
  } catch (cause) {
    await pool.unmanage(created.udid).catch(() => {})
    await deps.remove(created, signal).catch(() => {})
    throw cause
  }
  return created
}

/**
 * The one place that decides which simulator a session gets. Never falls back
 * to the focused session, and never claims an external device unless asked by
 * udid.
 */
export async function allocate(
  pool: SimulatorPool,
  request: AllocateRequest,
  deps: AllocateDeps = defaults,
): Promise<Allocation> {
  const result = await choose(pool, request, deps)
  if (request.hold) pool.hold(request.sessionID, request.holdMs)
  return result
}

const heldByOthers = (pool: SimulatorPool, udid: string, sessionID: string): boolean =>
  pool.owners(udid, sessionID).length > 0 || pool.isBusy(udid, sessionID)

async function choose(
  pool: SimulatorPool,
  request: AllocateRequest,
  deps: AllocateDeps,
): Promise<Allocation> {
  const { sessionID, signal } = request
  const explicit = request.udid?.trim()
  const wanted = request.from?.trim()

  if (explicit) {
    const device = matchDevice(await deps.list(signal), explicit)
    if (heldByOthers(pool, device.udid, sessionID)) {
      if (request.share !== true) {
        throw new Error(
          `${device.name} is used by another session. Pass share: true to drive the same screen, or omit udid for your own pool device.`,
        )
      }
      await pool.remember(sessionID, device.udid)
    } else {
      await pool.claim(sessionID, device.udid)
    }
    return { device, source: device, refresh: false }
  }

  const held = pool.pick(sessionID)
  if (held) {
    const devices = await deps.list(signal)
    const device = devices.find((candidate) => candidate.udid === held)
    if (!device?.available) {
      await pool.forgetSession(sessionID)
    } else {
      const from = wanted ? matchDevice(devices, wanted) : undefined
      if (!from || sameModel(device, from)) {
        await pool.claim(sessionID, device.udid)
        return { device, source: device, refresh: false }
      }
    }
  }

  return pool.withLock(async () => {
    const devices = await deps.list(signal)
    const from = wanted ? matchDevice(devices, wanted) : undefined
    const free = (udid: string) => !heldByOthers(pool, udid, sessionID)

    let last = pool.last(sessionID)
    const lastDevice = devices.find((device) => device.udid === last)
    if (
      !lastDevice ||
      !lastDevice.available ||
      !pool.isManaged(lastDevice.udid) ||
      !free(lastDevice.udid) ||
      (from && !sameModel(lastDevice, from))
    ) {
      last = undefined
    }

    const source =
      from ??
      (last ? devices.find((device) => device.udid === last) : undefined) ??
      chooseReference(devices, free, (udid) => pool.isManaged(udid))
    const candidates = poolDevices(source, devices)
      .filter((device) => pool.isManaged(device.udid))
      .sort((a, b) => Number(b.udid === last) - Number(a.udid === last))

    for (const device of candidates) {
      if (!free(device.udid)) continue
      if (await pool.claim(sessionID, device.udid)) {
        return { device, source, refresh: device.udid !== last }
      }
    }

    if (candidates.length >= MAX_POOL_SIZE) {
      throw new Error(
        `All ${MAX_POOL_SIZE} managed ${deviceModel(source)} simulators are in use. Release one with sim_release, or delete one with sim_delete.`,
      )
    }
    const device = await createManaged(
      pool,
      sessionID,
      source,
      poolDeviceName(source, devices),
      deps,
      signal,
    )
    return { device, source, refresh: true, created: true }
  })
}

/**
 * Copy the app from the source, or another booted managed device. External
 * devices are only ever read. A failed copy is not an error when the target
 * already has the app.
 */
export async function refreshApp(
  target: Device,
  source: Device,
  bundleId: string,
  isManaged: (udid: string) => boolean,
  signal?: AbortSignal,
): Promise<{ note?: string; error?: string }> {
  const booted = (await listDevices({ signal })).filter(
    (device) => device.state === "Booted" && device.udid !== target.udid && isManaged(device.udid),
  )
  const candidates = [source, ...booted.filter((device) => device.udid !== source.udid)].filter(
    (device) => device.udid !== target.udid,
  )
  let failure: unknown
  for (const candidate of candidates) {
    try {
      const path = await installAppFrom(target.udid, candidate.udid, bundleId, { signal })
      return { note: `app=${bundleId} (installed from ${candidate.name}: ${path})` }
    } catch (cause) {
      failure ??= cause
    }
  }
  if (!failure) return {}
  const message = (failure instanceof Error ? failure.message : String(failure)).split("\n")[0]
  if (await hasApp(target.udid, bundleId, { signal })) {
    return {
      note: `app=${bundleId} (kept the installed copy; could not refresh: ${message})`,
    }
  }
  return { error: `app=install failed: ${message}` }
}
