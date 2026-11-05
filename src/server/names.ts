/**
 * Managed simulators carry a cosmetic marker while a session holds them, so the
 * device list in Xcode and Simulator.app shows at a glance which copies are
 * busy. The marker is never part of a device's identity: the pool keeps the
 * plain name in `simulator-managed` and strips the marker before comparing.
 */
export const IN_USE_SUFFIX = " · in use"

/** The stable pool name, without the ownership marker. */
export const baseName = (name: string): string => name.replace(/\s*·\s*in use\s*$/i, "").trim()

/** `<model> N` -> `<model> N · in use`. Idempotent. */
export const inUseName = (name: string): string => `${baseName(name)}${IN_USE_SUFFIX}`
