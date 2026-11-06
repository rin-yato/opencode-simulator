import type { Device } from "./devices"
import { baseName } from "./names"

/**
 * The pool keeps at most this many simulators per model and runtime. A new
 * session reuses a free device first; only when all of them are in use does it
 * create another. At the cap, `sim_start` asks the user to free one instead of
 * growing the pool forever.
 */
export const MAX_POOL_SIZE = 5

/** `com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro` -> `iPhone 17 Pro`. */
export const deviceModel = (device: Device): string => {
  const short = device.deviceType.split(".").pop() ?? ""
  const model = short.replaceAll("-", " ").trim()
  return (
    model ||
    baseName(device.name)
      .replace(/(?: #)?\d+$/, "")
      .trim() ||
    "Simulator"
  )
}

/** Two devices belong to the same pool when model and runtime match. */
export const sameModel = (a: Device, b: Device): boolean =>
  Boolean(a.deviceType && a.runtimeId) &&
  a.deviceType === b.deviceType &&
  a.runtimeId === b.runtimeId

/** Available devices in a source's pool, in a stable, human order. */
export const poolDevices = (source: Device, devices: readonly Device[]): Device[] =>
  devices
    .filter((device) => device.available && sameModel(device, source))
    .sort(
      (a, b) =>
        Number(b.state === "Booted") - Number(a.state === "Booted") ||
        a.name.localeCompare(b.name, undefined, { numeric: true }) ||
        a.udid.localeCompare(b.udid),
    )

/**
 * The smallest free `<model> N`, starting at 1. Names are globally unique in
 * `simctl`, so a taken number is skipped even when it belongs to another
 * runtime. The pool source keeps its plain model name.
 */
export const poolDeviceName = (source: Device, devices: readonly Device[]): string => {
  const model = deviceModel(source)
  const taken = new Set(devices.map((device) => baseName(device.name)))
  let index = 1
  while (taken.has(`${model} ${index}`)) index += 1
  return `${model} ${index}`
}

const iosVersion = (device: Device): number[] =>
  (/\.iOS-([\d-]+)$/.exec(device.runtimeId)?.[1] ?? "").split("-").map(Number)

const newerRuntime = (a: Device, b: Device): number => {
  const x = iosVersion(a)
  const y = iosVersion(b)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const diff = (y[i] ?? 0) - (x[i] ?? 0)
    if (diff) return diff
  }
  return 0
}

/**
 * Which model and runtime a new session gets when it names none: a booted
 * device, then an existing pool, then the newest iPhone Pro. The result only
 * defines the pool; the caller never claims it unless it is a free managed one.
 */
export const chooseReference = (
  devices: readonly Device[],
  isFree: (udid: string) => boolean,
  isManaged: (udid: string) => boolean,
): Device => {
  const ios = devices.filter(
    (device) =>
      device.available &&
      device.deviceType &&
      device.runtimeId &&
      device.runtimeId.includes(".iOS-"),
  )
  const booted = ios.filter((device) => device.state === "Booted")
  const free = booted.find((device) => isFree(device.udid)) ?? booted[0]
  if (free) return free

  const managed = ios
    .filter((device) => isManaged(device.udid))
    .sort(
      (a, b) =>
        a.name.localeCompare(b.name, undefined, { numeric: true }) || a.udid.localeCompare(b.udid),
    )[0]
  if (managed) return managed

  const newest = [...ios].sort(newerRuntime)[0]
  if (!newest) throw new Error("No iOS simulators are installed. Add an iOS runtime in Xcode.")
  const onNewest = ios.filter((device) => newerRuntime(device, newest) === 0)
  const pro = onNewest
    .map((device) => ({ device, n: /^iPhone (\d+) Pro$/.exec(baseName(device.name))?.[1] }))
    .filter((entry) => entry.n !== undefined)
    .sort((a, b) => Number(b.n) - Number(a.n))[0]
  return (
    pro?.device ??
    onNewest.find((device) => baseName(device.name).startsWith("iPhone")) ??
    onNewest[0]!
  )
}
