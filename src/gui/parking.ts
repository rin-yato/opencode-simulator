/**
 * Panes whose panel left the screen stay alive for a while.
 *
 * Switching to another tab or session unmounts the panel. Destroying the view
 * then makes the way back reload the page and renegotiate WebRTC, which takes
 * five to ten seconds. A parked pane keeps its view, so returning is instant.
 * Parked panes are bounded in time and number because each one keeps a stream
 * running.
 */
export interface ParkingOptions {
  /** How long a pane may stay parked. */
  readonly ttlMs: number
  /** How many panes may be parked at once; the oldest is dropped first. */
  readonly max: number
  /** Called when a parked pane expires or is pushed out. */
  readonly expire: (id: string) => void
}

export interface Parking {
  /** Park `id`. Parking again restarts its timer. */
  park(id: string): void
  /** The panel came back, or the pane is gone: stop counting it as parked. */
  unpark(id: string): boolean
  has(id: string): boolean
  readonly size: number
  dispose(): void
}

export const createParking = (options: ParkingOptions): Parking => {
  // Insertion order is parking order, so the first entry is the oldest.
  const timers = new Map<string, ReturnType<typeof setTimeout>>()

  const drop = (id: string): boolean => {
    const timer = timers.get(id)
    if (!timer) return false
    clearTimeout(timer)
    timers.delete(id)
    return true
  }

  const expire = (id: string) => {
    if (drop(id)) options.expire(id)
  }

  return {
    park(id) {
      drop(id)
      const timer = setTimeout(() => expire(id), options.ttlMs)
      ;(timer as { unref?: () => void }).unref?.()
      timers.set(id, timer)
      while (timers.size > options.max) {
        const oldest = timers.keys().next().value
        if (oldest === undefined) break
        expire(oldest)
      }
    },
    unpark: drop,
    has: (id) => timers.has(id),
    get size() {
      return timers.size
    },
    dispose() {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
    },
  }
}
