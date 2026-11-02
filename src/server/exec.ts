import { execFile, spawn } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

const MAX_BUFFER = 64 * 1024 * 1024

export interface RunOptions {
  readonly signal?: AbortSignal
  readonly timeout?: number
  readonly cwd?: string
}

export interface RunResult {
  readonly stdout: string
  readonly stderr: string
}

const failure = (command: string, args: readonly string[], cause: unknown): Error => {
  const detail =
    cause && typeof cause === "object" && "stderr" in cause
      ? String((cause as { stderr?: unknown }).stderr ?? "").trim()
      : ""
  const message = cause instanceof Error ? cause.message : String(cause)
  return new Error(`${command} ${args.join(" ")} failed: ${detail || message}`)
}

export async function run(
  command: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<RunResult> {
  try {
    const result = await execFileAsync(command, [...args], {
      maxBuffer: MAX_BUFFER,
      timeout: options.timeout ?? 30_000,
      signal: options.signal,
      cwd: options.cwd,
      encoding: "utf8",
    })
    return { stdout: result.stdout, stderr: result.stderr }
  } catch (cause) {
    throw failure(command, args, cause)
  }
}

export function runWithInput(
  command: string,
  args: readonly string[],
  input: string,
  options: RunOptions = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    let settled = false

    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener("abort", onAbort)
      if (error) reject(error)
      else resolve({ stdout, stderr })
    }

    const onAbort = () => {
      child.kill("SIGTERM")
      finish(new Error(`${command} was cancelled.`))
    }

    const timer = setTimeout(() => {
      child.kill("SIGTERM")
      finish(new Error(`${command} timed out after ${options.timeout ?? 30_000}ms.`))
    }, options.timeout ?? 30_000)

    options.signal?.addEventListener("abort", onAbort, { once: true })

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8")
    })
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8")
    })
    child.on("error", (cause) => {
      finish(failure(command, args, cause))
    })
    child.on("close", (code) => {
      if (code === 0) {
        finish()
      } else {
        finish(
          new Error(
            `${command} ${args.join(" ")} failed (${code}): ${stderr.trim() || stdout.trim()}`,
          ),
        )
      }
    })

    child.stdin.end(input)
  })
}
