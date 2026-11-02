import { spawn, execFile, execFileSync, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import { createServer } from "node:net"
import { homedir } from "node:os"
import { Schema } from "effect"
import type { MainContext } from "@opencode/plugin/gui/main"

declare const require: NodeRequire

const HUB_PACKAGE = "serve-sim"
const HUB_VERSION = "latest"
const READY_TIMEOUT_MS = 30_000
const READY_POLL_MS = 250
const RESTART_BASE_MS = 1_000
const RESTART_MAX_MS = 30_000

const HubState = Schema.Struct({
  pid: Schema.Int,
  port: Schema.Int,
  cli: Schema.String,
  device: Schema.optional(Schema.String),
})

type HubState = typeof HubState.Type

interface Cli {
  readonly command: string
  readonly args: readonly string[]
  readonly env: NodeJS.ProcessEnv
}

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

const resolveCli = (explicit?: string): Cli => {
  // serve-sim loads a native addon signed by Expo. Electron's hardened runtime refuses
  // to map it (different Team IDs), so the hub must run under the user's Node.
  const node = process.env.OPENCODE_SIMULATOR_NODE?.trim() || "node"
  const local = (entry: string): Cli => ({
    command: node,
    args: [entry],
    env: process.env,
  })

  if (explicit && existsSync(explicit)) return local(explicit)
  try {
    return local(require.resolve("expo-device-hub/vendor/serve-sim/dist/serve-sim.js"))
  } catch {}
  try {
    return local(require.resolve("serve-sim/dist/serve-sim.js"))
  } catch {}
  return {
    command: "npx",
    args: ["--yes", `${HUB_PACKAGE}@${HUB_VERSION}`],
    env: process.env,
  }
}

const reservePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      const port = typeof address === "object" && address ? address.port : 0
      server.close((error) => {
        if (error) reject(error)
        else if (port > 0) resolve(port)
        else reject(new Error("Could not reserve a loopback port."))
      })
    })
  })

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const commandLine = (pid: number) => {
  try {
    return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" })
  } catch {
    return ""
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const HIDE_SIMULATOR_SCRIPT =
  'tell application "System Events" to set visible of process "Simulator" to false'

/**
 * serve-sim opens Simulator.app after booting a device. Hide it once the stream
 * is ready so the panel is the only visible copy; the device, capture, and HID
 * input keep working while the app is hidden.
 */
const hideSimulatorWindow = (ctx: MainContext, attempt = 0): void => {
  if (process.platform !== "darwin") return
  execFile(
    "osascript",
    ["-e", HIDE_SIMULATOR_SCRIPT],
    { timeout: 5_000, encoding: "utf8" },
    (error, _stdout, stderr) => {
      if (!error) return
      if (attempt < 2) {
        setTimeout(() => hideSimulatorWindow(ctx, attempt + 1), 1_500)
        return
      }
      ctx.log.write("warn", "Could not hide the Simulator window", {
        error: stderr.trim() || String(error),
      })
    },
  )
}

async function waitForReady(url: string, signal: AbortSignal) {
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (signal.aborted) throw new Error("The simulator hub start was cancelled.")
    try {
      const response = await fetch(`${url}/readyz`, { signal: AbortSignal.timeout(1_000) })
      if (response.ok) return
    } catch {
      // The process is still starting.
    }
    await sleep(READY_POLL_MS)
  }
  throw new Error("The simulator hub did not become ready in time.")
}

const stopChild = async (child: ChildProcess) => {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill("SIGTERM")
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    sleep(2_000),
  ])
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
}

interface Slot {
  /** Undefined for the default hub, which follows whichever device booted first. */
  readonly device: string | undefined
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
      if (!slot.child || !slot.child.pid || !slot.port) continue
      entries.push({
        pid: slot.child.pid,
        port: slot.port,
        cli: resolveCli(explicitCli).command,
        ...(slot.device ? { device: slot.device } : {}),
      })
    }
    stored.set(entries.length > 0 ? entries : null)
  }

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

  const startSlot = async (slot: Slot): Promise<{ readonly url: string }> => {
    if (slot.released) throw new Error("The simulator hub was released.")
    const port = await reservePort()
    const cli = resolveCli(explicitCli)
    const args = [
      ...cli.args,
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      // Locked to the requested device: without this serve-sim streams whichever
      // simulator booted first, which is the wrong one when the tool just booted
      // another device.
      ...(slot.device ? ["--single-device", slot.device] : []),
    ]

    const processHandle = spawn(cli.command, args, {
      cwd: homedir(),
      env: cli.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    })

    slot.child = processHandle
    slot.port = port
    slot.startedAt = Date.now()
    persist()

    processHandle.stdout?.on("data", (chunk: Buffer) => {
      const output = chunk.toString().trim()
      if (output) ctx.log.write("debug", "simulator hub output", { device: slot.device, output })
    })
    processHandle.stderr?.on("data", (chunk: Buffer) => {
      const output = chunk.toString().trim()
      if (output) ctx.log.write("warn", "simulator hub stderr", { device: slot.device, output })
    })

    processHandle.once("error", (cause) => {
      ctx.log.write("error", "simulator hub failed to start", {
        device: slot.device,
        error: String(cause),
      })
    })

    processHandle.once("exit", (code, signal) => {
      if (slot.child === processHandle) {
        slot.child = null
        slot.port = null
        slot.url = null
      }
      persist()
      if (stopped || slot.intentionalStops.delete(processHandle)) return
      ctx.log.write("warn", "simulator hub exited", { device: slot.device, code, signal })
      const uptime = Date.now() - slot.startedAt
      if (uptime >= 60_000) slot.restartDelay = RESTART_BASE_MS
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
    })

    const url = `http://127.0.0.1:${port}`
    try {
      await waitForReady(url, ctx.signal)
    } catch (cause) {
      slot.intentionalStops.add(processHandle)
      await stopChild(processHandle)
      if (slot.child === processHandle) {
        slot.child = null
        slot.port = null
        slot.url = null
      }
      persist()
      throw cause
    }
    slot.url = url
    if (slot.released) {
      slot.intentionalStops.add(processHandle)
      await stopChild(processHandle)
      if (slot.child === processHandle) {
        slot.child = null
        slot.port = null
        slot.url = null
      }
      persist()
      throw new Error("The simulator hub was released.")
    }
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
      slot = {
        device,
        child: null,
        port: null,
        url: null,
        starting: null,
        restartTimer: null,
        restartDelay: RESTART_BASE_MS,
        startedAt: 0,
        released: false,
        intentionalStops: new Set(),
      }
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
    if (slot.restartTimer) {
      clearTimeout(slot.restartTimer)
      slot.restartTimer = null
    }
    if (slot.starting) await slot.starting.catch(() => {})
    const current = slot.child
    slot.child = null
    slot.port = null
    slot.url = null
    if (current) {
      slot.intentionalStops.add(current)
      await stopChild(current)
    }
    persist()
  }

  const dispose = async () => {
    stopped = true
    const children: ChildProcess[] = []
    for (const slot of slots.values()) {
      if (slot.restartTimer) {
        clearTimeout(slot.restartTimer)
        slot.restartTimer = null
      }
      const current = slot.child
      slot.child = null
      slot.port = null
      slot.url = null
      if (current) {
        slot.intentionalStops.add(current)
        children.push(current)
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
