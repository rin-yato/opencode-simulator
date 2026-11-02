import { createSignal } from "solid-js"

/**
 * The simulator each session asked to see. `sim.start` fills this in before it
 * opens the tab, so the panel mounts straight onto the booted device instead of
 * letting serve-sim pick whichever simulator booted first.
 *
 * Keyed by `MountedSession.key`, which survives routing and tab close. Kept in
 * localStorage too, so a window or plugin reload does not fall back to the
 * first booted device.
 */
const STORAGE_KEY = "opencode-simulator.devices"

const read = (): Readonly<Record<string, string>> => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const parsed = raw ? (JSON.parse(raw) as unknown) : undefined
    if (!parsed || typeof parsed !== "object") return {}
    const devices: Record<string, string> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string" && value) devices[key] = value
    }
    return devices
  } catch {
    return {}
  }
}

const [devices, setDevices] = createSignal<Readonly<Record<string, string>>>(read())

export const requestDevice = (sessionKey: string, udid: string) => {
  setDevices((current) => {
    if (current[sessionKey] === udid) return current
    const next = { ...current, [sessionKey]: udid }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    } catch {}
    return next
  })
}

export const requestedDevice = (sessionKey: string): string | undefined => devices()[sessionKey]
