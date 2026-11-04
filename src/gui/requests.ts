import { createSignal } from "solid-js"

/**
 * The simulator each session asked to see. `sim_start` fills this in before it
 * opens the tab, so the panel mounts onto the booted device instead of letting
 * serve-sim pick whichever simulator booted first.
 *
 * Keyed by `MountedSession.key`, which survives routing and tab close. Kept in
 * localStorage too, so a window or plugin reload restores the same device.
 */

export const STORAGE_KEY = "opencode-simulator.devices"
export const MAX_ENTRIES = 500

const read = (): Readonly<Record<string, string>> => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const parsed = raw ? (JSON.parse(raw) as unknown) : undefined
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    const devices: Record<string, string> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string" && value) devices[key] = value
    }
    return devices
  } catch {
    return {}
  }
}

/** Add or move a session entry, dropping the oldest when the cap is exceeded. */
export const upsertDevice = (
  devices: Readonly<Record<string, string>>,
  sessionKey: string,
  udid: string,
  max = MAX_ENTRIES,
): Record<string, string> => {
  const next: Record<string, string> = {}
  for (const [key, value] of Object.entries(devices)) {
    if (key !== sessionKey) next[key] = value
  }
  next[sessionKey] = udid
  const keys = Object.keys(next)
  for (const key of keys.slice(0, Math.max(0, keys.length - max))) delete next[key]
  return next
}

const [devices, setDevices] = createSignal<Readonly<Record<string, string>>>(read())

export const requestDevice = (sessionKey: string, udid: string) => {
  setDevices((current) => {
    if (current[sessionKey] === udid) return current
    const next = upsertDevice(current, sessionKey, udid)
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    } catch {}
    return next
  })
}

/** Drop one session entry; returns the same object when nothing changes. */
export const removeDevice = <T>(
  devices: Readonly<Record<string, T>>,
  sessionKey: string,
): Readonly<Record<string, T>> => {
  if (!(sessionKey in devices)) return devices
  const next = { ...devices }
  delete next[sessionKey]
  return next
}

export const clearDevice = (sessionKey: string) => {
  setDevices((current) => {
    const next = removeDevice(current, sessionKey)
    if (next === current) return current
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    } catch {}
    return next
  })
}

export const requestedDevice = (sessionKey: string): string | undefined => devices()[sessionKey]
