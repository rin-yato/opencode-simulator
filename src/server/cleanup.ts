/**
 * Prune automatic simulator copies.
 *
 * A copy is eligible only when it is still in the lease store, not a template,
 * shut down, and older than the TTL. Booted devices are never touched. The
 * sweep is safe to run at plugin startup: a missing or failed check simply
 * leaves the simulator alone.
 */

import type { Copies } from "./copies"
import { expiredCopies } from "./copies"
import { deleteDevice, listDevices, type Device } from "./devices"
import type { SessionDevices } from "./session-devices"
import type { Templates } from "./templates"

export interface PruneOptions {
  readonly copies: Copies
  readonly templates: Templates
  readonly sessions: SessionDevices
  readonly ttlDays: number
  readonly dryRun: boolean
  readonly now?: number
  readonly signal?: AbortSignal
}

export interface PruneEntry {
  readonly udid: string
  readonly name: string
  readonly ageDays: number
}

export interface PruneResult {
  readonly deleted: readonly PruneEntry[]
  readonly wouldDelete: readonly PruneEntry[]
  readonly skipped: readonly (PruneEntry & { readonly reason: string })[]
  readonly missing: number
}

const ageDays = (lastUsedAt: number, now: number): number =>
  Math.floor((now - lastUsedAt) / (24 * 60 * 60 * 1_000))

export async function pruneCopies(options: PruneOptions): Promise<PruneResult> {
  const now = options.now ?? Date.now()
  const devices = await listDevices({ signal: options.signal })
  const byUdid = new Map<string, Device>(devices.map((device) => [device.udid, device]))
  const expired = new Map(
    expiredCopies(options.copies.entries(), now, options.ttlDays).map((copy) => [copy.udid, copy]),
  )

  const deleted: PruneEntry[] = []
  const wouldDelete: PruneEntry[] = []
  const skipped: (PruneEntry & { reason: string })[] = []
  let missing = 0

  for (const copy of options.copies.entries()) {
    if (options.templates.has(copy.udid)) {
      skipped.push({
        udid: copy.udid,
        name: copy.name,
        ageDays: ageDays(copy.lastUsedAt, now),
        reason: "template",
      })
      continue
    }

    const device = byUdid.get(copy.udid)
    if (!device) {
      if (!options.dryRun) await options.copies.forget(copy.udid)
      missing += 1
      continue
    }

    if (!expired.has(copy.udid)) {
      skipped.push({
        udid: copy.udid,
        name: copy.name,
        ageDays: ageDays(copy.lastUsedAt, now),
        reason: "recent",
      })
      continue
    }

    if (device.state !== "Shutdown") {
      skipped.push({
        udid: copy.udid,
        name: copy.name,
        ageDays: ageDays(copy.lastUsedAt, now),
        reason: "booted",
      })
      continue
    }

    const entry = { udid: device.udid, name: device.name, ageDays: ageDays(copy.lastUsedAt, now) }
    if (options.dryRun) {
      wouldDelete.push(entry)
      continue
    }

    await deleteDevice(device, { signal: options.signal })
    await options.copies.forget(device.udid)
    await options.sessions.forget(device.udid)
    deleted.push(entry)
  }

  return { deleted, wouldDelete, skipped, missing }
}

export const formatPrune = (result: PruneResult): string => {
  const lines: string[] = []
  for (const entry of result.deleted) {
    lines.push(`deleted ${entry.name} (${entry.udid}) idle=${entry.ageDays}d`)
  }
  for (const entry of result.wouldDelete) {
    lines.push(`would delete ${entry.name} (${entry.udid}) idle=${entry.ageDays}d`)
  }
  for (const entry of result.skipped) {
    lines.push(
      `skipped ${entry.name} (${entry.udid}) reason=${entry.reason} idle=${entry.ageDays}d`,
    )
  }
  if (result.missing > 0) lines.push(`forgot ${result.missing} missing device(s)`)
  if (lines.length === 0) lines.push("no managed copies")
  return lines.join("\n")
}
