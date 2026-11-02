import { run } from "./exec"

export interface Device {
  readonly udid: string
  readonly name: string
  readonly state: string
  readonly runtime: string
  readonly available: boolean
}

interface RawDevice {
  udid?: string
  name?: string
  state?: string
  isAvailable?: boolean
  deviceTypeIdentifier?: string
}

interface RawList {
  devices?: Record<string, RawDevice[]>
}

export async function listDevices(options: { signal?: AbortSignal } = {}): Promise<Device[]> {
  const { stdout } = await run("xcrun", ["simctl", "list", "devices", "-j"], {
    signal: options.signal,
    timeout: 15_000,
  })
  const parsed = JSON.parse(stdout) as RawList
  const devices: Device[] = []
  for (const [runtime, entries] of Object.entries(parsed.devices ?? {})) {
    const short = runtime.split(".").pop() ?? runtime
    const match = /^([a-zA-Z]+)-(\d+)-(\d+)$/.exec(short)
    const version = match ? `${match[1]} ${match[2]}.${match[3]}` : short.replaceAll("-", " ")
    for (const entry of entries ?? []) {
      if (!entry.udid || !entry.name) continue
      devices.push({
        udid: entry.udid,
        name: entry.name,
        state: entry.state ?? "Unknown",
        runtime: version,
        available: entry.isAvailable !== false,
      })
    }
  }
  return devices
}

const describe = (device: Device) => `${device.name} (${device.udid}) [${device.state}]`

function matchDevice(devices: readonly Device[], wanted: string): Device {
  const exact = devices.find((device) => device.udid === wanted)
  if (exact) return exact
  const byName = devices.filter((device) => device.name === wanted)
  if (byName.length === 1) return byName[0]!
  if (byName.length > 1) {
    throw new Error(
      `Multiple simulators are named "${wanted}": ${byName.map((device) => device.udid).join(", ")}. Pass a UDID.`,
    )
  }
  const partial = devices.filter((device) => device.name.includes(wanted))
  if (partial.length === 1) return partial[0]!
  throw new Error(
    `No simulator matches "${wanted}". Booted: ${
      devices.filter((device) => device.state === "Booted").map(describe).join(", ") || "none"
    }.`,
  )
}

export async function resolveDevice(
  requested?: string,
  options: { signal?: AbortSignal } = {},
): Promise<Device> {
  const devices = await listDevices(options)
  const wanted = requested?.trim()
  if (wanted) return matchDevice(devices, wanted)

  const booted = devices.filter((device) => device.state === "Booted")
  if (booted.length === 1) return booted[0]!
  if (booted.length === 0) {
    throw new Error("No simulator is booted. Boot one with Simulator.app or `xcrun simctl boot <udid>`.")
  }
  throw new Error(
    `Multiple simulators are booted: ${booted.map(describe).join(", ")}. Pass a udid to choose one.`,
  )
}

/**
 * The device a start/boot request should use. Prefers an explicit name/UDID,
 * then the only booted device, then the only installed device.
 */
export async function resolveStartDevice(
  requested?: string,
  options: { signal?: AbortSignal } = {},
): Promise<Device> {
  const devices = await listDevices(options)
  const wanted = requested?.trim()
  if (wanted) return matchDevice(devices, wanted)

  const booted = devices.filter((device) => device.state === "Booted")
  if (booted.length === 1) return booted[0]!
  if (booted.length > 1) {
    throw new Error(
      `Multiple simulators are booted: ${booted.map(describe).join(", ")}. Pass a udid to choose one.`,
    )
  }

  const available = devices.filter((device) => device.available)
  if (available.length === 1) return available[0]!
  throw new Error(
    `No simulator is booted. Pass a udid or name. Available: ${
      available.map(describe).join(", ") || "none"
    }.`,
  )
}

export async function deleteDevice(
  device: Device,
  options: { signal?: AbortSignal } = {},
): Promise<string> {
  if (device.state === "Booted") {
    await run("xcrun", ["simctl", "shutdown", device.udid], {
      signal: options.signal,
      timeout: 60_000,
    })
  }
  await run("xcrun", ["simctl", "delete", device.udid], {
    signal: options.signal,
    timeout: 60_000,
  })
  return `deleted ${device.name} (${device.udid})`
}

export async function bootDevice(
  device: Device,
  options: { signal?: AbortSignal } = {},
): Promise<string> {
  if (device.state === "Booted") return `already booted ${device.name} (${device.udid})`

  try {
    await run("xcrun", ["simctl", "boot", device.udid], {
      signal: options.signal,
      timeout: 120_000,
    })
  } catch (cause) {
    // Another process may have booted it between listDevices and here.
    const fresh = await resolveDevice(device.udid, options).catch(() => undefined)
    if (!fresh || fresh.state !== "Booted") throw cause
  }

  await run("xcrun", ["simctl", "bootstatus", device.udid, "-b"], {
    signal: options.signal,
    timeout: 180_000,
  })
  return `booted ${device.name} (${device.udid})`
}

/**
 * Create a clean simulator with the same device type and runtime as `source`.
 * The source is left alone, so it can stay booted while the copy runs.
 */
export async function createDeviceFrom(
  source: Device,
  name: string,
  options: { signal?: AbortSignal } = {},
): Promise<{ readonly udid: string; readonly name: string }> {
  const { stdout } = await run("xcrun", ["simctl", "list", "devices", "-j"], {
    signal: options.signal,
    timeout: 15_000,
  })
  const parsed = JSON.parse(stdout) as RawList
  let deviceType: string | undefined
  let runtime: string | undefined
  for (const [key, entries] of Object.entries(parsed.devices ?? {})) {
    const entry = (entries ?? []).find((candidate) => candidate.udid === source.udid)
    if (!entry) continue
    deviceType = entry.deviceTypeIdentifier
    runtime = key
    break
  }
  if (!deviceType || !runtime) {
    throw new Error(`Could not read the device type or runtime for ${source.name}.`)
  }

  const created = await run("xcrun", ["simctl", "create", name, deviceType, runtime], {
    signal: options.signal,
    timeout: 60_000,
  })
  return { udid: created.stdout.trim(), name }
}

/**
 * Install an app that is already installed on `source` onto another simulator.
 * Only the bundle is copied; app data stays on the source.
 */
export async function installAppFrom(
  target: string,
  source: string,
  bundleId: string,
  options: { signal?: AbortSignal } = {},
): Promise<string> {
  const container = await run("xcrun", ["simctl", "get_app_container", source, bundleId, "app"], {
    signal: options.signal,
    timeout: 15_000,
  })
  const path = container.stdout.trim()
  if (!path) throw new Error(`No installed app ${bundleId} on the source simulator.`)
  await run("xcrun", ["simctl", "install", target, path], {
    signal: options.signal,
    timeout: 120_000,
  })
  return path
}
