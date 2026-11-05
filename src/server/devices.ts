import { homedir } from "node:os"
import { join } from "node:path"
import { run, runWithInput } from "./exec"
import { baseName } from "./names"

export interface Device {
  readonly udid: string
  readonly name: string
  readonly state: string
  /** Human-readable runtime, for example "iOS 26.5". */
  readonly runtime: string
  /** Runtime identifier used by `simctl create`. */
  readonly runtimeId: string
  /** Device-type identifier used by `simctl create`. */
  readonly deviceType: string
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

export interface CommandOptions {
  readonly signal?: AbortSignal
}

/** "com.apple.CoreSimulator.SimRuntime.iOS-26-5" -> "iOS 26.5" */
const runtimeLabel = (identifier: string): string => {
  const short = identifier.split(".").pop() ?? identifier
  const match = /^([a-zA-Z]+)-(\d+)-(\d+)$/.exec(short)
  return match ? `${match[1]} ${match[2]}.${match[3]}` : short.replaceAll("-", " ")
}

export async function listDevices(options: CommandOptions = {}): Promise<Device[]> {
  const { stdout } = await run("xcrun", ["simctl", "list", "devices", "-j"], {
    signal: options.signal,
    timeout: 15_000,
  })
  const parsed = JSON.parse(stdout) as RawList
  const devices: Device[] = []
  for (const [runtimeId, entries] of Object.entries(parsed.devices ?? {})) {
    for (const entry of entries ?? []) {
      if (!entry.udid || !entry.name) continue
      devices.push({
        udid: entry.udid,
        name: entry.name,
        state: entry.state ?? "Unknown",
        runtime: runtimeLabel(runtimeId),
        runtimeId,
        deviceType: entry.deviceTypeIdentifier ?? "",
        available: entry.isAvailable !== false,
      })
    }
  }
  return devices
}

const describe = (device: Device) => `${device.name} (${device.udid}) [${device.state}]`

/** Approximate on-disk size of one simulator, in kilobytes. */
export async function deviceSize(
  udid: string,
  options: CommandOptions = {},
): Promise<number | undefined> {
  const path = join(homedir(), "Library", "Developer", "CoreSimulator", "Devices", udid)
  try {
    const { stdout } = await run("du", ["-sk", path], {
      signal: options.signal,
      timeout: 30_000,
    })
    const kb = Number(stdout.trim().split(/\s+/)[0])
    return Number.isFinite(kb) && kb >= 0 ? kb : undefined
  } catch {
    return undefined
  }
}

export const formatSize = (kb: number | undefined): string => {
  if (kb === undefined) return "-"
  if (kb < 1_024) return `${kb} KB`
  const mb = kb / 1_024
  if (mb < 1_024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`
  const gb = mb / 1_024
  return `${gb.toFixed(gb < 10 ? 2 : 1)} GB`
}

/**
 * Resolve a UDID, an exact name, or a unique name fragment. Ambiguous names fail
 * instead of guessing, so `iPhone 17 Pro` never silently selects one of several.
 */
export function matchDevice(devices: readonly Device[], wanted: string): Device {
  const exact = devices.find((device) => device.udid === wanted)
  if (exact) return exact

  const byName = devices.filter(
    (device) => device.name === wanted || baseName(device.name) === wanted,
  )
  if (byName.length === 1) return byName[0]!
  if (byName.length > 1) {
    throw new Error(
      `Multiple simulators are named "${wanted}": ${byName.map((device) => device.udid).join(", ")}. Pass a UDID.`,
    )
  }

  const partial = devices.filter((device) => device.name.includes(wanted))
  if (partial.length === 1) return partial[0]!
  if (partial.length > 1) {
    throw new Error(
      `"${wanted}" matches multiple simulators: ${partial.map(describe).join(", ")}. Pass a UDID.`,
    )
  }
  throw new Error(
    `No simulator matches "${wanted}". Booted: ${
      devices
        .filter((device) => device.state === "Booted")
        .map(describe)
        .join(", ") || "none"
    }.`,
  )
}

/** Resolve a device for an inspection or input tool. It must already be booted. */
export async function resolveDevice(
  requested?: string,
  options: CommandOptions = {},
): Promise<Device> {
  const devices = await listDevices(options)
  const wanted = requested?.trim()
  if (wanted) return matchDevice(devices, wanted)

  const booted = devices.filter((device) => device.state === "Booted")
  if (booted.length === 1) return booted[0]!
  if (booted.length === 0) {
    throw new Error("No simulator is booted. Boot one with sim_start or sim_boot.")
  }
  throw new Error(
    `Multiple simulators are booted: ${booted.map(describe).join(", ")}. Pass a udid to choose one.`,
  )
}

/**
 * Resolve a device for a start/boot request. Unlike `resolveDevice`, this may
 * return a shut-down device so the caller can boot it. Prefers an explicit
 * name/UDID, then the only booted device, then the only installed device.
 */
export async function resolveStartDevice(
  requested?: string,
  options: CommandOptions = {},
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

export async function bootDevice(device: Device, options: CommandOptions = {}): Promise<string> {
  if (device.state === "Booted") return `already booted ${device.name} (${device.udid})`

  try {
    await run("xcrun", ["simctl", "boot", device.udid], {
      signal: options.signal,
      timeout: 120_000,
    })
  } catch (cause) {
    // Another process may have booted it between listDevices and here.
    const fresh = await resolveDevice(device.udid, options).catch(() => undefined)
    if (!fresh || (fresh.state !== "Booted" && fresh.state !== "Booting")) throw cause
  }

  await run("xcrun", ["simctl", "bootstatus", device.udid, "-b"], {
    signal: options.signal,
    timeout: 420_000,
  })
  return `booted ${device.name} (${device.udid})`
}

export async function deleteDevice(device: Device, options: CommandOptions = {}): Promise<string> {
  if (device.state === "Booted" || device.state === "Booting") {
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

/**
 * Create a clean simulator with the same device type and runtime as `source`.
 * The source is left alone, so it can stay booted while the new device runs.
 */
export async function createDeviceFrom(
  source: Device,
  name: string,
  options: CommandOptions = {},
): Promise<Device> {
  if (!source.deviceType || !source.runtimeId) {
    throw new Error(`Could not read the device type or runtime for ${source.name}.`)
  }
  const { stdout } = await run(
    "xcrun",
    ["simctl", "create", name, source.deviceType, source.runtimeId],
    { signal: options.signal, timeout: 60_000 },
  )
  const udid = stdout.trim()
  if (!udid) throw new Error("xcrun simctl create returned no UDID.")
  return {
    udid,
    name,
    state: "Shutdown",
    runtime: source.runtime,
    runtimeId: source.runtimeId,
    deviceType: source.deviceType,
    available: true,
  }
}

/**
 * Rename a simulator. Metadata only: no disk image is copied, and it works
 * while the device is booted. The pool uses it to mark a managed device as in
 * use, so the name is cosmetic and never part of identity.
 */
export async function renameDevice(
  udid: string,
  name: string,
  options: CommandOptions = {},
): Promise<string> {
  await run("xcrun", ["simctl", "rename", udid, name], {
    signal: options.signal,
    timeout: 15_000,
  })
  return name
}

export async function shutdownDevice(
  device: Device,
  options: CommandOptions = {},
): Promise<string> {
  if (device.state !== "Booted") return `already shut down ${device.name} (${device.udid})`
  await run("xcrun", ["simctl", "shutdown", device.udid], {
    signal: options.signal,
    timeout: 60_000,
  })
  return `shut down ${device.name} (${device.udid})`
}

/**
 * Install an app that is already installed on `source` onto another simulator.
 * Only the bundle is copied; app data stays on the source. Installing over an
 * existing bundle on the target keeps that target's data container.
 */
export async function installAppBundle(
  udid: string,
  appPath: string,
  options: CommandOptions = {},
): Promise<string> {
  await run("xcrun", ["simctl", "install", udid, appPath], {
    signal: options.signal,
    timeout: 120_000,
  })
  return `installed ${appPath} on ${udid}`
}

export interface InstalledApp {
  readonly bundleId: string
  readonly name: string
}

/** Installed apps on a booted simulator, parsed from `simctl listapps`. */
export async function listApps(
  udid: string,
  options: CommandOptions = {},
): Promise<InstalledApp[]> {
  const listing = await run("xcrun", ["simctl", "listapps", udid], {
    signal: options.signal,
    timeout: 30_000,
  })
  const converted = await runWithInput(
    "plutil",
    ["-convert", "json", "-o", "-", "-"],
    listing.stdout,
    { signal: options.signal, timeout: 15_000 },
  )
  const parsed = JSON.parse(converted.stdout) as Record<
    string,
    { readonly CFBundleDisplayName?: string; readonly CFBundleName?: string }
  >
  return Object.entries(parsed).map(([bundleId, value]) => ({
    bundleId,
    name: value.CFBundleDisplayName ?? value.CFBundleName ?? bundleId,
  }))
}

export async function uninstallApp(
  udid: string,
  bundleId: string,
  options: CommandOptions = {},
): Promise<string> {
  await run("xcrun", ["simctl", "uninstall", udid, bundleId], {
    signal: options.signal,
    timeout: 60_000,
  })
  return `uninstalled ${bundleId} from ${udid}`
}

export async function eraseDevice(device: Device, options: CommandOptions = {}): Promise<string> {
  if (device.state === "Booted" || device.state === "Booting") {
    await run("xcrun", ["simctl", "shutdown", device.udid], {
      signal: options.signal,
      timeout: 60_000,
    })
  }
  await run("xcrun", ["simctl", "erase", device.udid], {
    signal: options.signal,
    timeout: 120_000,
  })
  return `erased ${device.name} (${device.udid})`
}

export async function installAppFrom(
  target: string,
  source: string,
  bundleId: string,
  options: CommandOptions = {},
): Promise<string> {
  const container = await run("xcrun", ["simctl", "get_app_container", source, bundleId, "app"], {
    signal: options.signal,
    timeout: 15_000,
  })
  const path = container.stdout.trim()
  if (!path) throw new Error(`No installed app ${bundleId} on the source simulator.`)
  // A reused pool device may still have the old build running.
  try {
    await run("xcrun", ["simctl", "terminate", target, bundleId], {
      signal: options.signal,
      timeout: 15_000,
    })
  } catch {}
  await run("xcrun", ["simctl", "install", target, path], {
    signal: options.signal,
    timeout: 120_000,
  })
  return path
}
