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
    for (const entry of entries ?? []) {
      if (!entry.udid || !entry.name) continue
      devices.push({
        udid: entry.udid,
        name: entry.name,
        state: entry.state ?? "Unknown",
        runtime: runtime.split(".").pop()?.replaceAll("-", " ") ?? runtime,
        available: entry.isAvailable !== false,
      })
    }
  }
  return devices
}

const describe = (device: Device) => `${device.name} (${device.udid}) [${device.state}]`

export async function resolveDevice(
  requested?: string,
  options: { signal?: AbortSignal } = {},
): Promise<Device> {
  const devices = await listDevices(options)
  const wanted = requested?.trim()

  if (wanted) {
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

  const booted = devices.filter((device) => device.state === "Booted")
  if (booted.length === 1) return booted[0]!
  if (booted.length === 0) {
    throw new Error("No simulator is booted. Boot one with Simulator.app or `xcrun simctl boot <udid>`.")
  }
  throw new Error(
    `Multiple simulators are booted: ${booted.map(describe).join(", ")}. Pass a udid to choose one.`,
  )
}
