import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/**
 * The GUI app can be launched from Finder with a PATH that does not include
 * Homebrew or a version manager. Try the common install locations before
 * falling back to `node` on PATH.
 */
export const resolveNodeBinary = (): string => {
  const explicit = process.env.OPENCODE_SIMULATOR_NODE?.trim()
  if (explicit) return explicit

  const candidates = [
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    join(homedir(), ".local", "bin", "node"),
    join(homedir(), ".volta", "bin", "node"),
  ]
  return candidates.find((path) => existsSync(path)) ?? "node"
}
