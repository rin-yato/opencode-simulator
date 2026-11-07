import { execFile, execFileSync, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import { createServer } from "node:net"
import { homedir } from "node:os"
import { join } from "node:path"
import type { MainContext } from "@opencode/plugin/gui/main"
import { resolveNodeBinary } from "../node-path"

declare const require: NodeRequire

export const HUB_PACKAGE = "serve-sim"
/** A device's first boot can take minutes; serve-sim listens only after it. */
export const HUB_START_TIMEOUT_MS = 180_000
const READY_TIMEOUT_MS = 420_000
const READY_POLL_MS = 250

export interface Cli {
  readonly command: string
  readonly args: readonly string[]
  readonly env: NodeJS.ProcessEnv
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * serve-sim loads a native addon signed by Expo. Electron's hardened runtime
 * refuses to map it (different Team IDs), so the hub must run under the user's
 * Node.
 *
 * There is deliberately no `npx` fallback: a missing CLI is a configuration
 * error, not a reason to download and execute a package at runtime.
 */
export const resolveCli = (explicit?: string): Cli | undefined => {
  const node = resolveNodeBinary()
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
  const configured = join(
    homedir(),
    ".config",
    "opencode",
    "node_modules",
    "expo-device-hub",
    "vendor",
    "serve-sim",
    "dist",
    "serve-sim.js",
  )
  if (existsSync(configured)) return local(configured)
  return undefined
}

export const reservePort = () =>
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

export const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export const commandLine = (pid: number) => {
  try {
    return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" })
  } catch {
    return ""
  }
}

/**
 * Wait until the hub's HTTP server answers.
 *
 * serve-sim boots the device first and binds its port afterwards, so this
 * waits through a first boot. Any response means the server is up; `/readyz`
 * is what confirms which device it serves.
 */
export async function waitForHttp(
  url: string,
  signal: AbortSignal,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (signal.aborted) throw new Error("The simulator hub start was cancelled.")
    try {
      await fetch(url, { signal: AbortSignal.timeout(1_000) })
      return
    } catch {
      // The server is still starting.
    }
    await sleep(100)
  }
  throw new Error("The simulator hub did not answer in time.")
}

export async function waitForReady(
  url: string,
  device: string,
  signal: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (signal.aborted) throw new Error("The simulator hub start was cancelled.")
    try {
      const response = await fetch(`${url}/readyz`, { signal: AbortSignal.timeout(1_000) })
      if (response.ok) {
        const body = (await response.json().catch(() => undefined)) as
          { readonly status?: unknown; readonly device?: unknown } | undefined
        // serve-sim reports the device it selected. A different device means
        // another process answered this port, not our child.
        if (typeof body?.device === "string" && body.device !== device) {
          throw new Error(`serve-sim reported device ${body.device}, expected ${device}.`)
        }
        return
      }
    } catch (cause) {
      if (cause instanceof Error && cause.message.includes("reported device")) throw cause
      // The process is still starting.
    }
    await sleep(READY_POLL_MS)
  }
  throw new Error("The simulator hub did not become ready in time.")
}

export const stopChild = async (child: ChildProcess) => {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill("SIGTERM")
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    sleep(2_000),
  ])
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
}

const HIDE_SIMULATOR_SCRIPT =
  'tell application "System Events" to set visible of process "Simulator" to false'

/**
 * serve-sim opens Simulator.app after booting a device. Hide it once the stream
 * is ready so the panel is the only visible copy; the device, capture, and HID
 * input keep working while the app is hidden.
 */
export const hideSimulatorWindow = (ctx: MainContext, attempt = 0): void => {
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
