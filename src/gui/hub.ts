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
  waitForHttp,
  waitForReady,
} from "./serve-sim"
import { resolveStreamOptions, type StreamTransport } from "./stream-options"

const RESTART_BASE_MS = 1_000
const RESTART_MAX_MS = 30_000
const RESTART_RESET_MS = 60_000

/**
 * serve-sim's preview client falls back to Google's public STUN servers when
 * the server sends no ICE servers. The hub only streams over loopback, so give
 * it a loopback STUN address instead: the client gets a non-empty list, never
 * contacts a public server, and host candidates still connect directly.
 */
const LOOPBACK_STUN = "stun:127.0.0.1:3478"

const HubState = Schema.Struct({
  pid: Schema.Int,
  port: Schema.Int,
  cli: Schema.String,
  script: Schema.optional(Schema.String),
  device: Schema.optional(Schema.String),
})

type HubState = typeof HubState.Type

export interface HubStarted {
  /** The simulator the hub serves. */
  readonly device: string
  readonly url: string
}

export interface HubManager {
  /**
   * Start or reuse a hub for one simulator. A device gets its own serve-sim
   * process locked with `--single-device`, so the preview can never stream a
   * different booted simulator.
   */
  readonly ensure: (device: string, cli?: string) => Promise<{ readonly url: string }>
  readonly onStarted: (listener: (started: HubStarted) => void) => () => void
  /** Stop the hub for one device. No-op when it never started. */
  readonly release: (device: string) => Promise<void>
  readonly dispose: () => Promise<void>
}

interface Slot {
  readonly device: string
  /** Cancels a start that is still waiting for the device to boot. */
  readonly abort: AbortController
  child: ChildProcess | null
  port: number | null
  url: string | null
  starting: Promise<{ readonly url: string }> | null
  /** Waits for the device to boot after the preview page is already up. */
  ready: Promise<void> | null
  releasing: Promise<void> | null
  restartTimer: ReturnType<typeof setTimeout> | null
  restartDelay: number
  startedAt: number
  /** No panel wants this device any more; a start in flight must stop itself. */
  released: boolean
  /** WebRTC failed once, so the next start uses HTTP instead of retrying. */
  fellBack: boolean
  readonly intentionalStops: Set<ChildProcess>
}

const emptySlot = (device: string): Slot => ({
  device,
  abort: new AbortController(),
  child: null,
  port: null,
  url: null,
  starting: null,
  ready: null,
  releasing: null,
  restartTimer: null,
  restartDelay: RESTART_BASE_MS,
  startedAt: 0,
  released: false,
  fellBack: false,
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
  /**
   * The CLI path the server found. This bundle runs with a stub `require` that
   * resolves no packages, so without it a plain install finds nothing.
   */
  let discoveredCli: string | undefined
  const cliPath = () => explicitCli ?? discoveredCli
  const keepSimulatorVisible =
    process.env.OPENCODE_SIMULATOR_SHOW_SIMULATOR === "1" || ctx.options.showSimulator === true
  const stream = resolveStreamOptions(ctx.options)

  const slots = new Map<string, Slot>()
  const startedListeners = new Set<(started: HubStarted) => void>()
  let stopped = false

  const persist = () => {
    const entries: HubState[] = []
    for (const slot of slots.values()) {
      if (!slot.child?.pid || !slot.port) continue
      const cli = resolveCli(cliPath())
      entries.push({
        pid: slot.child.pid,
        port: slot.port,
        cli: cli?.command ?? "node",
        ...(cli?.args[0] ? { script: cli.args[0] } : {}),
        device: slot.device,
      })
    }
    stored.set(entries.length > 0 ? entries : null)
  }

  /** Kill hubs left behind by a crash of the previous GUI process. */
  const reapStale = () => {
    const previous = stored.value
    if (!previous) return
    for (const entry of previous) {
      const command = commandLine(entry.pid)
      const script = entry.script ?? `${HUB_PACKAGE}.js`
      if (!isAlive(entry.pid) || !command.includes(script)) continue
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
    if (stopped || slot.released) return
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

  const startSlot = async (
    slot: Slot,
    transport: StreamTransport,
  ): Promise<{ readonly url: string }> => {
    if (slot.released) throw new Error("The simulator hub was released.")
    const cli = resolveCli(cliPath())
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
      // whichever simulator booted first.
      "--single-device",
      slot.device,
      "--transport",
      transport,
      "--max-dimension",
      String(stream.maxDimension),
    ]
    if (transport === "webrtc") {
      // H.264 uses VideoToolbox on macOS. The bitrate is a ceiling: WebRTC
      // backs off when the simulator is idle. The loopback STUN keeps the
      // preview client from falling back to Google's public STUN servers.
      args.push(
        "--webrtc-codec",
        "h264",
        "--stun-url",
        LOOPBACK_STUN,
        "--video-bitrate",
        String(stream.bitrate),
        "--video-fps",
        String(stream.fps),
      )
    }

    ctx.log.write("info", "Starting simulator hub", {
      device: slot.device,
      transport,
      bitrate: stream.bitrate,
      fps: stream.fps,
      maxDimension: stream.maxDimension,
    })

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
      if (stopped || slot.released || slot.starting || slot.intentionalStops.delete(child)) {
        return
      }
      ctx.log.write("warn", "simulator hub exited", { device: slot.device, code, signal })
      scheduleRestart(slot)
    })

    const url = `http://127.0.0.1:${port}`
    const exited = new Promise<never>((_, reject) => {
      child.once("exit", (code, signal) => {
        reject(new Error(`serve-sim exited before ready (${code ?? signal ?? "unknown"})`))
      })
    })
    const failed = new Promise<never>((_, reject) => {
      child.once("error", (cause) => {
        reject(new Error(`Could not start serve-sim with ${cli.command}: ${cause.message}`))
      })
      child.once("close", (code) => {
        reject(new Error(`serve-sim closed before ready (${code ?? "unknown"})`))
      })
    })
    try {
      // The preview page answers before the device is booted. Waiting for the
      // port instead of for the device lets the panel show the simulator
      // booting rather than a spinner.
      await Promise.race([waitForHttp(url, slot.abort.signal), exited, failed])
    } catch (cause) {
      await stopSlotChild(slot, child).catch(() => {})
      throw cause
    }

    if (slot.released) {
      await stopSlotChild(slot, child)
      throw new Error("The simulator hub was released.")
    }

    slot.url = url
    if (!keepSimulatorVisible) hideSimulatorWindow(ctx)
    for (const listener of startedListeners) listener({ device: slot.device, url })
    // The device can still be booting. Watch it in the background: one that
    // never becomes ready falls back to HTTP, like a failed start.
    slot.ready = watchReady(slot, transport, url)
    return { url }
  }

  /**
   * Wait for the device to boot. A device that never becomes ready is the one
   * case where WebRTC is retried over HTTP, because the panel is already
   * showing the preview page.
   */
  const watchReady = async (
    slot: Slot,
    transport: StreamTransport,
    url: string,
  ): Promise<void> => {
    try {
      await waitForReady(url, slot.device, slot.abort.signal)
    } catch (cause) {
      if (stopped || slot.released) return
      const message = cause instanceof Error ? cause.message : String(cause)
      if (!/did not become ready in time/i.test(message)) return
      ctx.log.write("warn", "The simulator hub never became ready", {
        device: slot.device,
        error: message,
      })
      // WebRTC falls back to HTTP. On HTTP there is nothing left to fall back
      // to, so the preview stays as it is instead of restarting in a loop.
      if (transport === "webrtc") await fallbackToHttp(slot, message)
    }
  }

  /** Stop the current child and start the slot again on another transport. */
  const restart = async (slot: Slot, transport: StreamTransport): Promise<void> => {
    if (slot.released || stopped) return
    const child = slot.child
    clearChild(slot)
    if (child) await stopSlotChild(slot, child).catch(() => {})
    if (slot.released || stopped) return
    try {
      await startSlot(slot, transport)
    } catch (cause) {
      ctx.log.write("error", "simulator hub restart failed", {
        device: slot.device,
        error: String(cause),
      })
    }
  }

  /** A WebRTC failure falls back to HTTP for this device, once. */
  const fallbackToHttp = async (slot: Slot, message: string): Promise<void> => {
    if (slot.released || stopped || slot.fellBack) return
    slot.fellBack = true
    ctx.log.write("warn", "WebRTC stream failed; falling back to HTTP", {
      device: slot.device,
      error: message,
    })
    await restart(slot, "http")
  }

  const ensureSlot = (slot: Slot) => {
    if (stopped) return Promise.reject(new Error("The simulator hub is stopped."))
    if (slot.url) return Promise.resolve({ url: slot.url })
    const transport = slot.fellBack ? "http" : stream.transport
    slot.starting ??= startSlot(slot, transport)
      .catch((cause) => {
        const message = cause instanceof Error ? cause.message : String(cause)
        // A port can be taken between reserve and spawn; a nonexistent Node
        // fails immediately. Those are quick startup races and are worth one
        // more try.
        const startupRace =
          /exited before ready|closed before ready|EADDRINUSE|address already in use|did not answer in time/i.test(
            message,
          )
        if (slot.released || stopped || !startupRace) {
          throw cause
        }
        const retry = transport === "webrtc" ? fallbackToHttp(slot, message) : restart(slot, transport)
        return retry.then(() => {
          const url = slot.url
          if (!url) throw cause
          return { url }
        })
      })
      .finally(() => {
        slot.starting = null
      })
      .catch((cause) => {
        const key = slot.device
        if (!slot.released && !slot.child && slots.get(key) === slot) slots.delete(key)
        throw cause
      })
    return slot.starting
  }

  const ensure = async (device: string, cli?: string) => {
    if (cli) discoveredCli = cli
    const key = device
    const existing = slots.get(key)
    if (existing?.releasing) await existing.releasing.catch(() => {})
    let slot = slots.get(key)
    if (!slot || slot.released) {
      slot = emptySlot(device)
      slots.set(key, slot)
    }
    return ensureSlot(slot)
  }

  const release = async (device: string) => {
    const key = device
    const slot = slots.get(key)
    if (!slot) return
    if (slot.releasing) return slot.releasing

    slot.released = true
    slot.abort.abort()
    if (slot.restartTimer) {
      clearTimeout(slot.restartTimer)
      slot.restartTimer = null
    }

    const task = (async () => {
      if (slot.starting) await slot.starting.catch(() => {})
      const child = slot.child
      clearChild(slot)
      if (child) await stopSlotChild(slot, child)
      if (slots.get(key) === slot) slots.delete(key)
      persist()
    })()
    slot.releasing = task
    await task
  }

  const dispose = async () => {
    stopped = true
    const children: ChildProcess[] = []
    await Promise.all(
      [...slots.values()].map(async (slot) => {
        slot.released = true
        slot.abort.abort()
        if (slot.restartTimer) {
          clearTimeout(slot.restartTimer)
          slot.restartTimer = null
        }
        if (slot.releasing) await slot.releasing.catch(() => {})
        if (slot.starting) await slot.starting.catch(() => {})
        const child = slot.child
        clearChild(slot)
        if (child) {
          slot.intentionalStops.add(child)
          children.push(child)
        }
      }),
    )
    slots.clear()
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
