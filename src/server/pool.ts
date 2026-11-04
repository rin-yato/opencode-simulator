import type { Device } from "./devices"

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
  return model || device.name.replace(/ #\d+$/, "").trim() || "Simulator"
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
 * The smallest free `<model> #N`, starting at 2 because the pool source is
 * implicitly #1. Names are globally unique in `simctl`, so a taken number is
 * skipped even when it belongs to another runtime.
 */
export const poolDeviceName = (source: Device, devices: readonly Device[]): string => {
  const model = deviceModel(source)
  const taken = new Set(devices.map((device) => device.name))
  let index = 2
  while (taken.has(`${model} #${index}`)) index += 1
  return `${model} #${index}`
}
