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
})

type HubState = typeof HubState.Type

interface Cli {
  readonly command: string
  readonly args: readonly string[]
  readonly env: NodeJS.ProcessEnv
}

export interface HubManager {
  readonly ensure: () => Promise<{ readonly url: string }>
  readonly onStarted: (listener: (url: string) => void) => () => void
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

export function createHubManager(ctx: MainContext): HubManager {
  const stored = ctx.storage.store("hub", {
    schema: Schema.NullOr(HubState),
    initial: null,
  })
  const explicitCli =
    process.env.OPENCODE_SIMULATOR_HUB ??
    (typeof ctx.options.hubCli === "string" ? ctx.options.hubCli : undefined)
  const keepSimulatorVisible =
    process.env.OPENCODE_SIMULATOR_SHOW_SIMULATOR === "1" || ctx.options.showSimulator === true

  let stopped = false
  let starting: Promise<{ readonly url: string }> | null = null
  let child: ChildProcess | null = null
  let currentUrl: string | null = null
  let restartTimer: ReturnType<typeof setTimeout> | null = null
  let restartDelay = RESTART_BASE_MS
  let startedAt = 0
  const intentionalStops = new Set<ChildProcess>()
  const startedListeners = new Set<(url: string) => void>()

  const reapStale = () => {
    const previous = stored.value
    if (!previous) return
    if (isAlive(previous.pid) && commandLine(previous.pid).includes(HUB_PACKAGE)) {
      ctx.log.write("warn", "Stopping a simulator hub left behind by a previous run", {
        pid: previous.pid,
        port: previous.port,
      })
      try {
        process.kill(previous.pid, "SIGTERM")
      } catch {}
    }
    stored.set(null)
  }

  const start = async (): Promise<{ readonly url: string }> => {
    const port = await reservePort()
    const cli = resolveCli(explicitCli)
    const args = [
      ...cli.args,
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
    ]

    const processHandle = spawn(cli.command, args, {
      cwd: homedir(),
      env: cli.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    })

    child = processHandle
    startedAt = Date.now()
    stored.set({ pid: processHandle.pid ?? 0, port, cli: cli.command })

    processHandle.stdout?.on("data", (chunk: Buffer) => {
      const output = chunk.toString().trim()
      if (output) ctx.log.write("debug", "simulator hub output", { output })
    })
    processHandle.stderr?.on("data", (chunk: Buffer) => {
      const output = chunk.toString().trim()
      if (output) ctx.log.write("warn", "simulator hub stderr", { output })
    })

    processHandle.once("error", (cause) => {
      ctx.log.write("error", "simulator hub failed to start", { error: String(cause) })
    })

    processHandle.once("exit", (code, signal) => {
      if (child === processHandle) {
        child = null
        currentUrl = null
      }
      if (stopped || intentionalStops.delete(processHandle)) return
      ctx.log.write("warn", "simulator hub exited", { code, signal })
      stored.set(null)
      const uptime = Date.now() - startedAt
      if (uptime >= 60_000) restartDelay = RESTART_BASE_MS
      const delay = restartDelay
      restartDelay = Math.min(restartDelay * 2, RESTART_MAX_MS)
      if (restartTimer) clearTimeout(restartTimer)
      restartTimer = setTimeout(() => {
        restartTimer = null
        if (stopped) return
        void ensure().catch((cause) => {
          ctx.log.write("error", "simulator hub restart failed", { error: String(cause) })
        })
      }, delay)
    })

    const url = `http://127.0.0.1:${port}`
    try {
      await waitForReady(url, ctx.signal)
    } catch (cause) {
      intentionalStops.add(processHandle)
      await stopChild(processHandle)
      if (child === processHandle) {
        child = null
        currentUrl = null
      }
      stored.set(null)
      throw cause
    }
    currentUrl = url
    if (!keepSimulatorVisible) hideSimulatorWindow(ctx)
    for (const listener of startedListeners) listener(url)
    return { url }
  }

  const ensure = () => {
    if (stopped) return Promise.reject(new Error("The simulator hub is stopped."))
    if (currentUrl) return Promise.resolve({ url: currentUrl })
    starting ??= start().finally(() => {
      starting = null
    })
    return starting
  }

  const dispose = async () => {
    stopped = true
    if (restartTimer) {
      clearTimeout(restartTimer)
      restartTimer = null
    }
    const current = child
    child = null
    currentUrl = null
    if (current) {
      intentionalStops.add(current)
      await stopChild(current)
    }
    stored.set(null)
  }

  reapStale()
  ctx.onCleanup(dispose)

  return {
    ensure,
    onStarted(listener) {
      startedListeners.add(listener)
      return () => startedListeners.delete(listener)
    },
    dispose,
  }
}
