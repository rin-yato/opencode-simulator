import { existsSync, statSync } from "node:fs"
import { resolve } from "node:path"
import {
  bootDevice,
  createDeviceFrom,
  deleteDevice,
  deviceSize,
  eraseDevice,
  formatSize,
  installAppBundle,
  installAppFrom,
  listApps,
  listDevices,
  resolveDevice,
  resolveStartDevice,
  uninstallApp,
  type Device,
} from "../devices"
import { launchApp } from "../actions"
import { baseName } from "../names"
import { MAX_POOL_SIZE, deviceModel, poolDeviceName, poolDevices } from "../pool"
import { serveSimPort } from "../serve-sim"
import {
  currentDevice,
  define,
  errorText,
  ok,
  partial,
  SHARE_SCHEMA,
  startDevice,
  SIM_OPTIONS,
  UDID_SCHEMA,
  type SimulatorContext,
  type ToolEditor,
  type ToolRuntime,
} from "./context"

interface DevicesInput {
  readonly all?: boolean
  readonly disk?: boolean
}

interface BootInput {
  readonly udid?: string
  readonly share?: boolean
  readonly hold?: boolean
  readonly holdMinutes?: number
}

interface CreateInput {
  readonly from?: string
  readonly name?: string
  readonly app?: string
  readonly force?: boolean
}

interface DeleteInput {
  readonly udid: string
  readonly force?: boolean
}

interface StartInput {
  readonly udid?: string
  readonly app?: string
  readonly share?: boolean
  readonly hold?: boolean
  readonly holdMinutes?: number
}

interface ReleaseInput {
  readonly udid?: string
}

interface InstallInput {
  readonly udid?: string
  readonly path: string
  readonly share?: boolean
}

interface AppsInput {
  readonly udid?: string
  readonly share?: boolean
}

interface UninstallInput {
  readonly udid?: string
  readonly bundleId: string
  readonly share?: boolean
}

interface EraseInput {
  readonly udid?: string
  readonly share?: boolean
  readonly force?: boolean
}

interface LaunchInput {
  readonly udid?: string
  readonly share?: boolean
  readonly bundleId: string
  readonly terminate?: boolean
  readonly args?: readonly string[]
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

let poolLock: Promise<unknown> = Promise.resolve()

/**
 * Serialize pool selection. The claim itself is atomic, but two sessions that
 * list at the same time could both choose to create when one new device would
 * be enough.
 */
const withPoolLock = <T>(task: () => Promise<T>): Promise<T> => {
  const next = poolLock.then(task, task)
  poolLock = next.catch(() => {})
  return next
}

interface StartTarget {
  readonly device: Device
  /** The device whose model and runtime define the pool. */
  readonly reference: Device
  /** Refresh the app from the pool source. False when reusing this session's device. */
  readonly refresh: boolean
  /** The device did not exist before this call. */
  readonly created?: boolean
}

/**
 * Resolve the device for `sim_start` when the session has no usable default.
 * External devices are only a model/runtime reference; the pool never claims
 * one automatically.
 */
const pickStartDevice = async (
  simulator: SimulatorContext,
  context: ToolRuntime,
): Promise<Device> => {
  try {
    return await startDevice(simulator, context)
  } catch (cause) {
    const devices = await listDevices({ signal: context.signal })
    const booted = devices.filter((device) => device.state === "Booted")
    if (booted.length > 1) {
      return (
        booted.find(
          (device) => simulator.pool.owners(device.udid, context.sessionID).length === 0,
        ) ?? booted[0]!
      )
    }
    if (booted.length === 1) return booted[0]!

    // Everything is shut down: a fresh session still has to know which pool to
    // use. One model/runtime is unambiguous; several need an explicit udid.
    const pools = new Map<string, Device[]>()
    for (const device of devices) {
      if (!device.available || !device.deviceType || !device.runtimeId) continue
      const key = `${device.deviceType}|${device.runtimeId}`
      const group = pools.get(key)
      if (group) group.push(device)
      else pools.set(key, [device])
    }
    if (pools.size !== 1) throw cause
    return [...pools.values()][0]!.sort(
      (a, b) =>
        a.name.localeCompare(b.name, undefined, { numeric: true }) || a.udid.localeCompare(b.udid),
    )[0]!
  }
}

/**
 * Choose a simulator for a session.
 *
 * Auto allocation is managed-only: the user's own simulators are never claimed,
 * refreshed, or shut down by the pool. An external device can still supply the
 * model/runtime and app source. An explicit udid borrows any device; using one
 * another session owns requires `share: true`.
 */
const startTarget = async (
  simulator: SimulatorContext,
  context: ToolRuntime,
  requested?: string,
  share?: boolean,
  hold?: boolean,
  holdMs?: number,
): Promise<StartTarget> => {
  const pool = simulator.pool
  const explicit = requested?.trim()
  if (explicit) {
    const device = await startDevice(simulator, context, explicit)
    const others = pool.owners(device.udid, context.sessionID)
    const busyByOther = pool.isBusy(device.udid, context.sessionID)
    if (others.length > 0 || busyByOther) {
      if (share !== true) {
        throw new Error(
          `${device.name} is used by another session. Pass share: true to drive the same screen, or omit udid for your own pool device.`,
        )
      }
      await pool.remember(context.sessionID, device.udid)
    } else {
      await pool.claim(context.sessionID, device.udid)
    }
    if (hold) pool.hold(context.sessionID, holdMs)
    return {
      device,
      reference: device,
      refresh: pool.isManaged(device.udid),
    }
  }

  // Reuse the device this session already started, even when it is shut down.
  const remembered = pool.pick(context.sessionID)
  if (remembered) {
    const device = await resolveStartDevice(remembered, { signal: context.signal }).catch(
      () => undefined,
    )
    if (device) {
      await pool.claim(context.sessionID, device.udid)
      if (hold) pool.hold(context.sessionID, holdMs)
      return { device, reference: device, refresh: false }
    }
    await pool.forgetSession(context.sessionID)
  }

  const reference = await pickStartDevice(simulator, context)
  return withPoolLock(async () => {
    const devices = await listDevices({ signal: context.signal })
    const source = devices.find((device) => device.udid === reference.udid) ?? reference
    const candidates = poolDevices(source, devices).filter((device) => pool.isManaged(device.udid))

    for (const candidate of candidates) {
      if (pool.owners(candidate.udid, context.sessionID).length > 0) continue
      if (pool.isBusy(candidate.udid, context.sessionID)) continue
      if (await pool.claim(context.sessionID, candidate.udid)) {
        if (hold) pool.hold(context.sessionID, holdMs)
        return { device: candidate, reference: source, refresh: true }
      }
    }

    if (candidates.length >= MAX_POOL_SIZE) {
      throw new Error(
        `All ${MAX_POOL_SIZE} managed ${deviceModel(source)} simulators are in use. Release one with sim_release, or delete one with sim_delete.`,
      )
    }

    const created = await createDeviceFrom(source, poolDeviceName(source, devices), {
      signal: context.signal,
    })
    try {
      await pool.manage(created)
      if (!(await pool.claim(context.sessionID, created.udid))) {
        await pool.unmanage(created.udid)
        throw new Error(`Could not claim the new simulator ${created.name}.`)
      }
    } catch (cause) {
      await pool.unmanage(created.udid).catch(() => {})
      await deleteDevice(created, { signal: context.signal }).catch(() => {})
      throw cause
    }
    if (hold) pool.hold(context.sessionID, holdMs)
    return { device: created, reference: source, refresh: true, created: true }
  })
}

/**
 * Install or refresh the app from the reference device. Extra sources are
 * managed devices only; an external device is read-only and never overwritten.
 */
const installApp = async (
  target: Device,
  source: Device,
  bundleId: string,
  isManaged: (udid: string) => boolean,
  signal?: AbortSignal,
): Promise<string> => {
  const booted = (await listDevices({ signal })).filter(
    (device) => device.state === "Booted" && device.udid !== target.udid && isManaged(device.udid),
  )
  const candidates = [source, ...booted.filter((device) => device.udid !== source.udid)]
  let lastError: unknown
  for (const candidate of candidates) {
    if (candidate.udid === target.udid) continue
    try {
      const path = await installAppFrom(target.udid, candidate.udid, bundleId, { signal })
      return `app=${bundleId} (installed from ${candidate.name}: ${path})`
    } catch (cause) {
      lastError = cause
    }
  }
  if (lastError) throw lastError
  // The target is the only candidate. Its bundle is already whatever the user
  // installed there; launching is the only useful step.
  return ""
}

/** Exact UDID or exact name only: delete must never hit a fragment by mistake. */
const resolveExactDevice = async (wanted: string): Promise<Device> => {
  const text = wanted.trim()
  if (!text) {
    throw new Error("udid is required. Pass an exact UDID or exact simulator name.")
  }
  const devices = await listDevices()
  const needle = text.toLowerCase()
  const found = devices.filter(
    (device) =>
      device.udid.toLowerCase() === needle ||
      device.name === text ||
      baseName(device.name) === text,
  )
  if (found.length === 0) {
    throw new Error(
      `No simulator exactly matches ${JSON.stringify(text)}. Pass an exact UDID or name from sim_devices.`,
    )
  }
  if (found.length > 1) {
    throw new Error(
      `Multiple simulators match ${JSON.stringify(text)}: ${found.map((device) => device.udid).join(", ")}. Pass a UDID.`,
    )
  }
  return found[0]!
}

/** Validate a local .app bundle before handing it to simctl. */
const resolveAppBundle = (path: string): string => {
  const absolute = resolve(path.trim())
  if (!absolute.endsWith(".app")) throw new Error("path must point to a .app bundle.")
  if (!existsSync(absolute)) throw new Error(`No app bundle exists at ${absolute}.`)
  if (!statSync(absolute).isDirectory()) throw new Error(`${absolute} is not a directory.`)
  return absolute
}

const waitForHub = async (udid: string, timeout = 8_000): Promise<number | undefined> => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const port = serveSimPort(udid)
    if (port) return port
    await sleep(250)
  }
  return undefined
}

export function registerLifecycleTools(editor: ToolEditor, simulator: SimulatorContext): void {
  editor.add({
    name: "devices",
    description:
      "List simulators with state, runtime, UDID, and an owner label. `in use (self)` is this session's device, `in use (other)` is another session, `free` is a managed pool device nobody uses, and `external` is a simulator the plugin did not create. A managed device's name also ends with ` · in use` while it is claimed. Pass disk to add on-disk sizes (slower).",
    input: {
      type: "object",
      properties: {
        all: {
          type: "boolean",
          default: false,
          description: "Include unavailable devices that cannot boot.",
        },
        disk: {
          type: "boolean",
          default: false,
          description: "Add on-disk size (slower).",
        },
      },
      additionalProperties: false,
    },
    options: SIM_OPTIONS,
    execute: define(async (input: DevicesInput, context: ToolRuntime) => {
      const devices = (await listDevices({ signal: context.signal })).filter(
        (device) => input.all || device.available,
      )
      devices.sort(
        (a, b) =>
          Number(b.state === "Booted") - Number(a.state === "Booted") ||
          a.name.localeCompare(b.name, undefined, { numeric: true }) ||
          a.udid.localeCompare(b.udid),
      )
      const sizes: Array<number | undefined> = new Array(devices.length)
      if (input.disk) {
        let next = 0
        const worker = async () => {
          while (next < devices.length) {
            const index = next++
            sizes[index] = await deviceSize(devices[index]!.udid, { signal: context.signal })
          }
        }
        await Promise.all(Array.from({ length: Math.min(4, devices.length) }, () => worker()))
      }
      const lines = [
        `# ${devices.length} simulator(s)`,
        input.disk
          ? "# name\tstate\truntime\tudid\tsize\towner"
          : "# name\tstate\truntime\tudid\towner",
      ]
      const metadata: Array<Record<string, unknown>> = []
      for (const [index, device] of devices.entries()) {
        const owners = simulator.pool.owners(device.udid)
        const managed = simulator.pool.isManaged(device.udid)
        const inUse = owners.length > 0 || simulator.pool.isBusy(device.udid)
        const selfPanel = simulator.pool.panelDevice(context.sessionID) === device.udid
        const owner = !managed
          ? "external"
          : owners.includes(context.sessionID) || selfPanel
            ? "in use (self)"
            : inUse
              ? "in use (other)"
              : "free"
        const size = input.disk ? formatSize(sizes[index]) : undefined
        const row = `${device.name}\t${device.state}\t${device.runtime}\t${device.udid}`
        lines.push(input.disk ? `${row}\t${size}\t${owner}` : `${row}\t${owner}`)
        metadata.push({
          name: device.name,
          udid: device.udid,
          state: device.state,
          runtime: device.runtime,
          owner,
          managed,
          inUse,
          ...(size ? { size } : {}),
        })
      }
      return ok(lines.join("\n"), { count: devices.length, devices: metadata })
    }),
  })

  editor.add({
    name: "boot",
    description:
      "Boot a simulator by UDID or name, without opening Simulator.app. Without a udid it reuses this session's device, then takes a free managed pool device; it may create <model> N (cold boot). The claim is released at turn end unless hold is true. Use sim_start to also open the panel.",
    input: {
      type: "object",
      properties: {
        udid: UDID_SCHEMA,
        share: {
          type: "boolean",
          default: false,
          description: "Allow an explicit udid that another session owns.",
        },
        hold: {
          type: "boolean",
          default: false,
          description: "Keep the device after this turn until sim_release or session close.",
        },
        holdMinutes: {
          type: "integer",
          minimum: 1,
          maximum: 1440,
          description: "Bound the hold to this many minutes; implies hold.",
        },
      },
      additionalProperties: false,
    },
    options: SIM_OPTIONS,
    execute: define(async (input: BootInput, context: ToolRuntime) => {
      const holdMs = input.holdMinutes ? input.holdMinutes * 60_000 : undefined
      const hold = input.hold === true || holdMs !== undefined
      const target = await startTarget(simulator, context, input.udid, input.share, hold, holdMs)
      const output = await bootDevice(target.device, { signal: context.signal })
      const release = simulator.pool.releaseState(context.sessionID)
      return ok(
        [
          output,
          `release=${release}`,
          "panel=closed",
          ...(target.created
            ? [`pool=created ${target.device.name}; kept for later sessions`]
            : []),
        ].join("\n"),
        {
          udid: target.device.udid,
          name: target.device.name,
          release,
          ...(target.created ? { created: true } : {}),
        },
      )
    }),
  })

  editor.add({
    name: "create",
    description:
      "Create a new managed simulator with the same model and runtime as a source simulator, leaving the source running. Optionally install an app that is installed on the source. Explicit creation bypasses the automatic cap unless it would exceed five managed devices; pass force for that.",
    input: {
      type: "object",
      properties: {
        from: {
          type: "string",
          description:
            "Source simulator name or UDID. Defaults to this session's device, then the only booted simulator, then the only installed simulator.",
        },
        name: {
          type: "string",
          description: "Name for the new simulator. Defaults to '<model> N', made unique.",
        },
        app: {
          type: "string",
          description: "Optional bundle id to install from the source, e.g. com.example.app.",
        },
        force: {
          type: "boolean",
          default: false,
          description: "Create beyond the five managed devices for this model/runtime.",
        },
      },
      additionalProperties: false,
    },
    options: SIM_OPTIONS,
    execute: define(async (input: CreateInput, context: ToolRuntime) => {
      const pool = simulator.pool
      const source = await startDevice(simulator, context, input.from)
      const devices = await listDevices({ signal: context.signal })
      const managed = poolDevices(source, devices).filter((device) => pool.isManaged(device.udid))
      if (managed.length >= MAX_POOL_SIZE && input.force !== true) {
        throw new Error(
          `The ${deviceModel(source)} pool already has ${MAX_POOL_SIZE} managed devices. Pass force: true to create another.`,
        )
      }
      const name = baseName(input.name?.trim() || poolDeviceName(source, devices))
      if (devices.some((device) => baseName(device.name) === name)) {
        throw new Error(`A simulator named "${name}" already exists. Pass another name.`)
      }

      const created = await createDeviceFrom(source, name, { signal: context.signal })
      try {
        let booted = ""
        let installed = ""
        let installError = ""
        if (input.app) {
          // `simctl install` requires a booted device.
          booted = await bootDevice(created, { signal: context.signal })
          try {
            const path = await installAppFrom(created.udid, source.udid, input.app, {
              signal: context.signal,
            })
            installed = `app=${input.app} (installed from ${path})`
          } catch (cause) {
            installError = `app=install failed: ${errorText(cause)}`
          }
        }
        await pool.manage(created)
        if (!(await pool.claim(context.sessionID, created.udid))) {
          throw new Error(`Could not claim the new simulator ${created.name}.`)
        }

        const lines = [
          `created ${created.name} (${created.udid}) from ${source.name} (${source.udid})`,
          `state=${booted ? "Booted" : "Shutdown"}`,
          ...(booted ? [booted] : []),
          ...(installed ? [installed] : []),
          ...(installError ? [installError] : []),
          "Use sim_start to boot and open its panel.",
        ]
        const metadata = {
          udid: created.udid,
          name: created.name,
          source: source.udid,
        }
        return installError ? partial(lines.join("\n"), metadata) : ok(lines.join("\n"), metadata)
      } catch (cause) {
        await pool.unmanage(created.udid).catch(() => {})
        await deleteDevice(created, { signal: context.signal }).catch(() => {})
        throw cause
      }
    }),
  })

  editor.add({
    name: "delete",
    description:
      "Delete a simulator by exact UDID or exact name, shutting it down first. Destructive: the device and all its data are removed. An external, divided, or actively used device needs force: true. Never pass a name fragment.",
    input: {
      type: "object",
      properties: {
        udid: {
          type: "string",
          minLength: 1,
          description: "Exact simulator UDID or exact name. Fragments are refused.",
        },
        force: {
          type: "boolean",
          default: false,
          description:
            "Delete an external device, a device with an open panel, or one another session owns.",
        },
      },
      required: ["udid"],
      additionalProperties: false,
    },
    options: SIM_OPTIONS,
    execute: define(async (input: DeleteInput, context: ToolRuntime) => {
      const pool = simulator.pool
      const device = await resolveExactDevice(input.udid)
      const otherOwners = pool.owners(device.udid, context.sessionID)
      const busy = pool.isBusy(device.udid)
      const managed = pool.isManaged(device.udid)
      if ((otherOwners.length > 0 || busy || !managed) && input.force !== true) {
        const reasons = [
          ...(otherOwners.length > 0 ? ["another session owns it"] : []),
          ...(busy ? ["a panel is using it"] : []),
          ...(!managed ? ["it is an external simulator"] : []),
        ]
        throw new Error(
          `Refusing to delete ${device.name}: ${reasons.join(", ")}. Pass force: true to delete it anyway.`,
        )
      }

      const output = await deleteDevice(device, { signal: context.signal })
      await pool.forgetDevice(device.udid)
      simulator.onDeviceDeleted?.(device.udid)
      return ok(output, { udid: device.udid, name: device.name, managed })
    }),
  })

  editor.add({
    name: "start",
    description:
      "Start the simulator end to end: boot the device if needed, optionally launch an app, and open the Simulator panel in the session that called this tool. Omitting udid reuses this session's device, then the first free managed device of the same model and runtime; when none is free, it creates <model> N (up to five managed devices). External simulators are never claimed automatically.",
    input: {
      type: "object",
      properties: {
        udid: UDID_SCHEMA,
        app: {
          type: "string",
          description:
            "Optional bundle id to launch after boot. When this call assigns a managed pool device, the app is installed or refreshed from the reference or another managed simulator; existing app data is kept. Reusing an external or own device just launches.",
        },
        share: {
          type: "boolean",
          default: false,
          description: "Allow an explicit udid that another session owns.",
        },
        hold: {
          type: "boolean",
          default: false,
          description: "Keep the device after this turn until sim_release or session close.",
        },
        holdMinutes: {
          type: "integer",
          minimum: 1,
          maximum: 1440,
          description: "Bound the hold to this many minutes; implies hold.",
        },
      },
      additionalProperties: false,
    },
    options: SIM_OPTIONS,
    execute: define(async (input: StartInput, context: ToolRuntime) => {
      const openPanel = simulator.openPanel
      if (!openPanel) throw new Error("The Simulator window entry is not available.")
      const holdMs = input.holdMinutes ? input.holdMinutes * 60_000 : undefined
      const hold = input.hold === true || holdMs !== undefined
      const target = await startTarget(simulator, context, input.udid, input.share, hold, holdMs)
      const { device, reference, created, refresh } = target

      // Open the tab before boot. The panel starts its hub immediately and
      // serve-sim waits for the device, so the user sees the simulator booting
      // while a fresh device's first boot runs.
      //
      // The server lease is taken first. The window acks the open request only
      // after it mounted the tab, and the turn can end in between: without the
      // lease the claim would be released while the simulator is still booting,
      // and the panel would come up empty.
      const lease = simulator.pool.panel({
        sessionID: context.sessionID,
        udid: device.udid,
        state: "open",
        window: "tool",
        ttlMs: 30_000,
      })
      const panel = openPanel(device.udid, context.sessionID)
        .then(async (opened) => {
          if (opened) await lease
          return opened
        })
        .catch(() => false)
      const boot = await bootDevice(device, { signal: context.signal })

      let installed = ""
      let installError = ""
      let launched = ""
      let launchError = ""
      if (input.app) {
        if (refresh && simulator.pool.isManaged(device.udid)) {
          try {
            installed = await installApp(
              device,
              reference,
              input.app,
              (udid) => simulator.pool.isManaged(udid),
              context.signal,
            )
          } catch (cause) {
            installError = `app=install failed: ${errorText(cause)}`
          }
        }
        // Launch even after an install failure: the device may already have a
        // working copy, and the launch error is useful when it does not.
        try {
          launched = await launchApp(device.udid, input.app, {
            signal: context.signal,
            terminate: false,
          })
        } catch (cause) {
          launchError = `app=launch failed: ${errorText(cause)}`
        }
      }

      const shared = simulator.pool.owners(device.udid, context.sessionID).length > 0
      // Do not block a headless/TUI session on the full UI ack timeout. A late
      // ack still records the panel through the promise above.
      const opened = await Promise.race([panel, sleep(2_000).then(() => false)])
      const port = opened ? await waitForHub(device.udid, 3_000) : undefined
      const release = simulator.pool.releaseState(context.sessionID)

      const lines = [
        boot,
        `release=${release}`,
        ...(created
          ? [`pool=created ${device.name} (${device.udid}); kept for later sessions`]
          : []),
        ...(installed ? [installed] : []),
        ...(installError ? [installError] : []),
        ...(launched ? [`app=${input.app}`, launched] : []),
        ...(launchError ? [launchError] : []),
        ...(shared
          ? [
              "note=this simulator is also used by another session; pass that udid only when sharing is intended.",
            ]
          : []),
        !opened
          ? "panel=requested; the tab opens in the calling session's strip. Open that session in a window to see it, or restart OpenCode once if the window code is stale."
          : port
            ? `panel=opened serve-sim=http://127.0.0.1:${port}`
            : "panel=opened; serve-sim is still starting in the panel.",
      ]
      const metadata = {
        udid: device.udid,
        name: device.name,
        port,
        panel: opened,
        release,
        ...(created ? { created: true } : {}),
      }
      return installError || launchError
        ? partial(lines.join("\n"), metadata)
        : ok(lines.join("\n"), metadata)
    }),
  })

  editor.add({
    name: "release",
    description:
      "Release this session's simulator back to the pool now, closing its panel. Use it when a device was held or the agent is done before the panel is closed.",
    input: {
      type: "object",
      properties: {
        udid: {
          type: "string",
          description: "Optional exact device to release. Defaults to this session's device.",
        },
      },
      additionalProperties: false,
    },
    options: SIM_OPTIONS,
    execute: define(async (input: ReleaseInput, context: ToolRuntime) => {
      const expected = input.udid?.trim() ? (await resolveDevice(input.udid)).udid : undefined
      const released = await simulator.pool.releaseManual(context.sessionID, expected)
      if (!released) {
        throw new Error("This session has no simulator claim to release.")
      }
      return ok(`released ${released}`, {
        udid: released,
        release: simulator.pool.releaseState(context.sessionID),
      })
    }),
  })

  editor.add({
    name: "install",
    description:
      "Install a local .app bundle on this session's simulator. Boots the device if needed. Use this to test a fresh build; sim_start can also refresh a managed pool device from another simulator's installed app.",
    input: {
      type: "object",
      properties: {
        udid: UDID_SCHEMA,
        path: {
          type: "string",
          minLength: 1,
          description: "Absolute or workspace-relative path to a .app bundle.",
        },
        share: {
          type: "boolean",
          default: false,
          description: "Allow a udid that another session owns.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    options: SIM_OPTIONS,
    execute: define(async (input: InstallInput, context: ToolRuntime) => {
      const device = await currentDevice(simulator, context, input.udid, input.share)
      const others = simulator.pool.owners(device.udid, context.sessionID)
      if (others.length > 0 && input.share !== true) {
        throw new Error(
          `${device.name} is used by another session. Pass share: true to install on the same simulator.`,
        )
      }
      const appPath = resolveAppBundle(input.path)
      const booted = await bootDevice(device, { signal: context.signal })
      const output = await installAppBundle(device.udid, appPath, { signal: context.signal })
      return ok([booted, output].join("\n"), { udid: device.udid, path: appPath })
    }),
  })

  editor.add({
    name: "apps",
    description:
      "List the apps installed on this session's simulator as bundle id and name. Boots the device if needed.",
    input: {
      type: "object",
      properties: { udid: UDID_SCHEMA, share: SHARE_SCHEMA },
      additionalProperties: false,
    },
    options: SIM_OPTIONS,
    execute: define(async (input: AppsInput, context: ToolRuntime) => {
      const device = await currentDevice(simulator, context, input.udid, input.share)
      const booted = await bootDevice(device, { signal: context.signal })
      const apps = await listApps(device.udid, { signal: context.signal })
      const lines = [
        booted,
        `# ${apps.length} app(s)`,
        ...apps.map((app) => `${app.bundleId}\t${app.name}`),
      ]
      return ok(lines.join("\n"), { udid: device.udid, apps })
    }),
  })

  editor.add({
    name: "uninstall",
    description: "Uninstall an app bundle from this session's simulator.",
    input: {
      type: "object",
      properties: {
        udid: UDID_SCHEMA,
        bundleId: { type: "string", minLength: 1, description: "Bundle identifier to remove." },
        share: {
          type: "boolean",
          default: false,
          description: "Allow a udid that another session owns.",
        },
      },
      required: ["bundleId"],
      additionalProperties: false,
    },
    options: SIM_OPTIONS,
    execute: define(async (input: UninstallInput, context: ToolRuntime) => {
      const device = await currentDevice(simulator, context, input.udid, input.share)
      const others = simulator.pool.owners(device.udid, context.sessionID)
      if (others.length > 0 && input.share !== true) {
        throw new Error(
          `${device.name} is used by another session. Pass share: true to uninstall from the same simulator.`,
        )
      }
      const booted = await bootDevice(device, { signal: context.signal })
      const output = await uninstallApp(device.udid, input.bundleId, { signal: context.signal })
      return ok([booted, output].join("\n"), { udid: device.udid, bundleId: input.bundleId })
    }),
  })

  editor.add({
    name: "erase",
    description:
      "Erase a simulator's contents and settings, removing all app data. Destructive; requires force: true. The device is left shut down; boot it with sim_start or sim_boot.",
    input: {
      type: "object",
      properties: {
        udid: UDID_SCHEMA,
        share: SHARE_SCHEMA,
        force: {
          type: "boolean",
          default: false,
          description: "Required to confirm the data loss.",
        },
      },
      additionalProperties: false,
    },
    options: SIM_OPTIONS,
    execute: define(async (input: EraseInput, context: ToolRuntime) => {
      if (input.force !== true) {
        throw new Error("Erase removes all app data. Pass force: true to confirm.")
      }
      const device = await currentDevice(simulator, context, input.udid, input.share)
      const output = await eraseDevice(device, { signal: context.signal })
      return ok(`${output}\nstate=Shutdown`, { udid: device.udid, name: device.name })
    }),
  })

  editor.add({
    name: "launch",
    description: "Terminate and relaunch an app by bundle id on the simulator.",
    input: {
      type: "object",
      properties: {
        udid: UDID_SCHEMA,
        share: SHARE_SCHEMA,
        bundleId: { type: "string", description: "Bundle identifier, e.g. com.example.app." },
        terminate: { type: "boolean", default: true },
        args: { type: "array", items: { type: "string" }, description: "Launch arguments." },
      },
      required: ["bundleId"],
      additionalProperties: false,
    },
    options: SIM_OPTIONS,
    execute: define(async (input: LaunchInput, context: ToolRuntime) => {
      const device = await currentDevice(simulator, context, input.udid, input.share)
      const result = await launchApp(device.udid, input.bundleId, {
        ...simulator.hub,
        signal: context.signal,
        terminate: input.terminate,
        args: input.args,
      })
      return ok(result, { udid: device.udid, bundleId: input.bundleId })
    }),
  })
}
