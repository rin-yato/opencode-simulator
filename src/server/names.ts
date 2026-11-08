/**
 * Managed simulators carry a cosmetic marker so the device list in Xcode and
 * Simulator.app shows at a glance which copies the agent is using
 * (` · in use`) and which a session only keeps for later (` · idle`). The marker
 * is never part of a device's identity: the pool keeps the plain name in
 * `simulator-managed` and strips the marker before comparing.
 */
export const IN_USE_SUFFIX = " · in use"
export const IDLE_SUFFIX = " · idle"

/** The stable pool name, without any marker. */
export const baseName = (name: string): string =>
  name.replace(/\s*·\s*(?:in use|idle)\s*$/i, "").trim()

/** `<model> N` -> `<model> N · in use`. Idempotent. */
export const inUseName = (name: string): string => `${baseName(name)}${IN_USE_SUFFIX}`

/** `<model> N` -> `<model> N · idle`. Idempotent. */
export const idleName = (name: string): string => `${baseName(name)}${IDLE_SUFFIX}`
