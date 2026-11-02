import { spawn, type ChildProcess } from "node:child_process"
import { homedir } from "node:os"
import { Schema } from "effect"
import type { MainContext } from "@opencode/plugin/gui/main"
import {
  HUB_PACKAGE,
  commandLine,
  hideSimulatorWindow,
  isAlive,
  reservePort,
  resolveCli,
  stopChild,
  waitForReady,
} from "./serve-sim"

const RESTART_BASE_MS = 1_000
const RESTART_MAX_MS = 30_000
const RESTART_RESET_MS = 60_000

const HubState = Schema.Struct({
  pid: Schema.Int,
  port: Schema.Int,
  cli: Schema.String,
  device: Schema.optional(Schema.String),
})

type HubState = typeof HubState.Type

export interface HubStarted {
  /** The simulator the hub serves. Undefined for the default (first booted) hub. */
  readonly device: string | undefined
  readonly url: string
}

export interface HubManager {
  /**
   * Start or reuse a hub for one simulator. A device gets its own serve-sim
   * process locked with `--single-device`, so the preview can never stream a
   * different booted simulator. Omit `device` for the legacy default hub.
   */
  readonly ensure: (device?: string) => Promise<{ readonly url: string }>
  readonly onStarted: (listener: (started: HubStarted) => void) => () => void
  /** Stop the hub for one device. No-op when it never started. */
  readonly release: (device?: string) => Promise<void>
  readonly dispose: () => Promise<void>
}

interface Slot {
  /** Undefined for the default hub, which follows whichever device booted first. */
  readonly device: string | undefined
  /** Cancels a start that is still waiting for the device to boot. */
  readonly abort: AbortController
  child: ChildProcess | null
  port: number | null
  url: string | null
  starting: Promise<{ readonly url: string }> | null
  restartTimer: ReturnType<typeof setTimeout> | null
  restartDelay: number
  startedAt: number
  /** No panel wants this device any more; a start in flight must stop itself. */
  released: boolean
  readonly intentionalStops: Set<ChildProcess>
}

const emptySlot = (device: string | undefined): Slot => ({
  device,
  abort: new AbortController(),
  child: null,
  port: null,
  url: null,
  starting: null,
  restartTimer: null,
  restartDelay: RESTART_BASE_MS,
  startedAt: 0,
  released: false,
  intentionalStops: new Set(),
})

export function createHubManager(ctx: MainContext): HubManager {
  const stored = ctx.storage.store("hubs", {
    schema: Schema.NullOr(Schema.Array(HubState)),
    initial: null,
  })
  const explicitCli =
    process.env.OPENCODE_SIMULATOR_HUB ??
    (typeof ctx.options.hubCli === "string" ? ctx.options.hubCli : undefined)
  const keepSimulatorVisible =
    process.env.OPENCODE_SIMULATOR_SHOW_SIMULATOR === "1" || ctx.options.showSimulator === true

  const slots = new Map<string, Slot>()
  const startedListeners = new Set<(started: HubStarted) => void>()
  let stopped = false

  const persist = () => {
    const entries: HubState[] = []
    for (const slot of slots.values()) {
      if (!slot.child?.pid || !slot.port) continue
      entries.push({
        pid: slot.child.pid,
        port: slot.port,
        cli: resolveCli(explicitCli)?.command ?? "node",
        ...(slot.device ? { device: slot.device } : {}),
      })
    }
    stored.set(entries.length > 0 ? entries : null)
  }

  /** Kill hubs left behind by a crash of the previous GUI process. */
  const reapStale = () => {
    const previous = stored.value
    if (!previous) return
    for (const entry of previous) {
      if (!isAlive(entry.pid) || !commandLine(entry.pid).includes(HUB_PACKAGE)) continue
      ctx.log.write("warn", "Stopping a simulator hub left behind by a previous run", {
        pid: entry.pid,
        port: entry.port,
        device: entry.device,
      })
      try {
        process.kill(entry.pid, "SIGTERM")
      } catch {}
    }
    stored.set(null)
  }

  const clearChild = (slot: Slot, child?: ChildProcess) => {
    if (child && slot.child !== child) return
    slot.child = null
    slot.port = null
    slot.url = null
  }

  const stopSlotChild = async (slot: Slot, child: ChildProcess) => {
    slot.intentionalStops.add(child)
    await stopChild(child)
    clearChild(slot, child)
    persist()
  }

  const scheduleRestart = (slot: Slot) => {
    if (stopped) return
    const uptime = Date.now() - slot.startedAt
    if (uptime >= RESTART_RESET_MS) slot.restartDelay = RESTART_BASE_MS
    const delay = slot.restartDelay
    slot.restartDelay = Math.min(slot.restartDelay * 2, RESTART_MAX_MS)
    if (slot.restartTimer) clearTimeout(slot.restartTimer)
    slot.restartTimer = setTimeout(() => {
      slot.restartTimer = null
      if (stopped) return
      void ensureSlot(slot).catch((cause) => {
        ctx.log.write("error", "simulator hub restart failed", {
          device: slot.device,
          error: String(cause),
        })
      })
    }, delay)
  }

  const startSlot = async (slot: Slot): Promise<{ readonly url: string }> => {
    if (slot.released) throw new Error("The simulator hub was released.")
    const cli = resolveCli(explicitCli)
    if (!cli) {
      throw new Error(
        "serve-sim CLI not found. Install dependencies, or set options.hubCli or OPENCODE_SIMULATOR_HUB.",
      )
    }

    const port = await reservePort()
    const args = [
      ...cli.args,
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      // Locked to the requested device: without this serve-sim streams
      // whichever simulator booted first, which is the wrong one when the tool
      // just booted another device.
      ...(slot.device ? ["--single-device", slot.device] : []),
    ]

    const child = spawn(cli.command, args, {
      cwd: homedir(),
      env: cli.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    })

    slot.child = child
    slot.port = port
    slot.startedAt = Date.now()
    persist()

    child.stdout?.on("data", (chunk: Buffer) => {
      const output = chunk.toString().trim()
      if (output) ctx.log.write("debug", "simulator hub output", { device: slot.device, output })
    })
    child.stderr?.on("data", (chunk: Buffer) => {
      const output = chunk.toString().trim()
      if (output) ctx.log.write("warn", "simulator hub stderr", { device: slot.device, output })
    })

    child.once("error", (cause) => {
      ctx.log.write("error", "simulator hub failed to start", {
        device: slot.device,
        error: String(cause),
      })
    })

    child.once("exit", (code, signal) => {
      clearChild(slot, child)
      persist()
      if (stopped || slot.intentionalStops.delete(child)) return
      ctx.log.write("warn", "simulator hub exited", { device: slot.device, code, signal })
      scheduleRestart(slot)
    })

    const url = `http://127.0.0.1:${port}`
    const exited = new Promise<never>((_, reject) => {
      child.once("exit", (code, signal) => {
        reject(new Error(`serve-sim exited before ready (${code ?? signal ?? "unknown"})`))
      })
    })
    try {
      await Promise.race([waitForReady(url, slot.abort.signal), exited])
    } catch (cause) {
      await stopSlotChild(slot, child)
      throw cause
    }

    if (slot.released) {
      await stopSlotChild(slot, child)
      throw new Error("The simulator hub was released.")
    }

    slot.url = url
    if (!keepSimulatorVisible) hideSimulatorWindow(ctx)
    for (const listener of startedListeners) listener({ device: slot.device, url })
    return { url }
  }

  const ensureSlot = (slot: Slot) => {
    if (stopped) return Promise.reject(new Error("The simulator hub is stopped."))
    if (slot.url) return Promise.resolve({ url: slot.url })
    slot.starting ??= startSlot(slot).finally(() => {
      slot.starting = null
    })
    return slot.starting
  }

  const ensure = (device?: string) => {
    const key = device ?? ""
    let slot = slots.get(key)
    if (!slot) {
      slot = emptySlot(device)
      slots.set(key, slot)
    }
    return ensureSlot(slot)
  }

  const release = async (device?: string) => {
    const key = device ?? ""
    const slot = slots.get(key)
    if (!slot) return
    slots.delete(key)
    slot.released = true
    slot.abort.abort()
    if (slot.restartTimer) {
      clearTimeout(slot.restartTimer)
      slot.restartTimer = null
    }
    if (slot.starting) await slot.starting.catch(() => {})
    const child = slot.child
    clearChild(slot)
    if (child) await stopSlotChild(slot, child)
    persist()
  }

  const dispose = async () => {
    stopped = true
    const children: ChildProcess[] = []
    for (const slot of slots.values()) {
      slot.abort.abort()
      if (slot.restartTimer) {
        clearTimeout(slot.restartTimer)
        slot.restartTimer = null
      }
      const child = slot.child
      clearChild(slot)
      if (child) {
        slot.intentionalStops.add(child)
        children.push(child)
      }
    }
    stored.set(null)
    await Promise.all(children.map((child) => stopChild(child)))
  }

  reapStale()
  ctx.onCleanup(dispose)

  return {
    ensure,
    onStarted(listener) {
      startedListeners.add(listener)
      return () => startedListeners.delete(listener)
    },
    release,
    dispose,
  }
}
