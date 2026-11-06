import { ManagedDevices } from "./managed"
import { SessionDevices, type StorageLike } from "./session-devices"
import { SimulatorPool } from "./simulator-pool"

type OnRelease = (sessionID: string, udid: string, force: boolean) => void

/** Key under which the process-wide pool lives; `Symbol.for` survives a double import. */
const KEY = Symbol.for("opencode-simulator.shared-pool")

interface Shared {
  readonly ready: Promise<SimulatorPool>
  readonly listeners: Set<OnRelease>
  refs: number
}

export interface PoolHandle {
  readonly pool: SimulatorPool
  release(): void
}

/**
 * OpenCode runs one plugin instance per project inside one server process, but
 * storage is global. Separate pools would each rewrite the whole claim map and
 * hand one simulator to two projects, so every instance shares one pool.
 *
 * A release is emitted through a single live listener: RPC events reach every
 * client whichever instance sends them.
 */
export async function acquirePool(
  storage: StorageLike,
  onRelease?: OnRelease,
  registry: object = globalThis,
): Promise<PoolHandle> {
  const slots = registry as Record<symbol, Shared | undefined>
  let shared = slots[KEY]
  if (!shared) {
    const listeners = new Set<OnRelease>()
    const created: Shared = {
      listeners,
      refs: 0,
      ready: (async () => {
        const sessions = await SessionDevices.load(storage)
        const managed = await ManagedDevices.load(storage)
        return new SimulatorPool({
          sessions,
          managed,
          onRelease: (sessionID, udid, force) => {
            const first = listeners.values().next().value
            first?.(sessionID, udid, force)
          },
        })
      })(),
    }
    shared = created
    slots[KEY] = created
    // A failed load must not wedge later setups.
    created.ready.catch(() => {
      if (slots[KEY] === created) delete slots[KEY]
    })
  }

  const current = shared
  current.refs += 1
  const listener = onRelease
  if (listener) current.listeners.add(listener)

  let pool: SimulatorPool
  try {
    pool = await current.ready
  } catch (cause) {
    current.refs -= 1
    if (listener) current.listeners.delete(listener)
    throw cause
  }

  let released = false
  return {
    pool,
    release: () => {
      if (released) return
      released = true
      if (listener) current.listeners.delete(listener)
      current.refs -= 1
      if (current.refs > 0) return
      pool.dispose()
      if (slots[KEY] === current) delete slots[KEY]
    },
  }
}
