import {
  bootDevice,
  createDeviceFrom,
  deleteDevice,
  deviceSize,
  formatSize,
  installAppFrom,
  listDevices,
  resolveDevice,
  resolveStartDevice,
  type Device,
} from "../devices"
import { launchApp } from "../actions"
import { MAX_POOL_SIZE, deviceModel, poolDeviceName, poolDevices } from "../pool"
import { serveSimPort } from "../serve-sim"
import {
  currentDevice,
  define,
  errorText,
  ok,
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
}

interface CreateInput {
  readonly from?: string
  readonly name?: string
  readonly app?: string
}

interface DeleteInput {
  readonly udid: string
  readonly force?: boolean
}

interface StartInput {
  readonly udid?: string
  readonly app?: string
}

interface LaunchInput {
  readonly udid?: string
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
 * A new session should not be blocked just because previous sessions left
 * devices running: it takes an unowned booted device as the reference, or the
 * first one when every booted device belongs to another session.
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
          (device) => simulator.sessions.owners(device.udid, context.sessionID).length === 0,
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
 * An explicit UDID is honored even when another session uses it: sharing is an
 * explicit choice. Without one, the session reuses its own device, then the
 * first free device of the same model and runtime, then creates `<Model> #N`.
 * The pool keeps up to `MAX_POOL_SIZE` devices; at the cap the session is asked
 * to free one instead of growing forever.
 */
const startTarget = async (
  simulator: SimulatorContext,
  context: ToolRuntime,
  requested?: string,
): Promise<StartTarget> => {
  const explicit = requested?.trim()
  if (explicit) {
    const device = await startDevice(simulator, context, explicit)
    await simulator.sessions.remember(context.sessionID, device.udid)
    simulator.activity.use(device.udid)
    return { device, reference: device, refresh: false }
  }

  // Reuse the device this session already started, even when it is shut down.
  const remembered = simulator.sessions.pick(context.sessionID)
  if (remembered) {
    const device = await resolveStartDevice(remembered, { signal: context.signal }).catch(
      () => undefined,
    )
    if (device) {
      await simulator.sessions.claim(context.sessionID, device.udid)
      simulator.activity.use(device.udid)
      return { device, reference: device, refresh: false }
    }
    // The remembered device was deleted. Forget it and allocate a new one.
    await simulator.sessions.forgetSession(context.sessionID)
  }

  const reference = await pickStartDevice(simulator, context)
  return withPoolLock(async () => {
    const devices = await listDevices({ signal: context.signal })
    const source = devices.find((device) => device.udid === reference.udid) ?? reference
    const candidates = poolDevices(source, devices)

    for (const candidate of candidates) {
      if (simulator.sessions.owners(candidate.udid, context.sessionID).length > 0) continue
      if (simulator.activity.isBusy(candidate.udid, context.sessionID)) continue
      if (await simulator.sessions.claim(context.sessionID, candidate.udid)) {
        simulator.activity.use(candidate.udid)
        return { device: candidate, reference: source, refresh: true }
      }
    }

    if (candidates.length >= MAX_POOL_SIZE) {
      throw new Error(
        `All ${MAX_POOL_SIZE} ${deviceModel(source)} simulators are in use. Close a Simulator panel, wait for the agent to finish, or delete one with sim_delete.`,
      )
    }

    const created = await createDeviceFrom(source, poolDeviceName(source, devices), {
      signal: context.signal,
    })
    await simulator.sessions.claim(context.sessionID, created.udid)
    simulator.activity.use(created.udid)
    return { device: created, reference: source, refresh: true, created: true }
  })
}

/**
 * Install or refresh the app from the reference device. Installing over an
 * existing bundle preserves its data container, so this is how a reused pool
 * device gets the current build. When the reference is shut down or lacks the
 * bundle, try any booted simulator.
 */
const installApp = async (
  target: Device,
  source: Device,
  bundleId: string,
  signal?: AbortSignal,
): Promise<string> => {
  const booted = (await listDevices({ signal })).filter(
    (device) => device.state === "Booted" && device.udid !== target.udid,
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
  // The target is the only candidate (it is the source). Its bundle is already
  // whatever the user installed there; launching is the only useful step.
  return ""
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
      "List simulators with state, runtime, and UDID. Use this before sim_boot or sim_start when you need to pick a device. Booted devices are listed first. Pass disk to add on-disk size and a free/in-use tag.",
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
          description: "Add on-disk size and a free/in-use tag (slower).",
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
      const sizes = input.disk
        ? await Promise.all(
            devices.map((device) => deviceSize(device.udid, { signal: context.signal })),
          )
        : []
      const lines = [
        `# ${devices.length} simulator(s)`,
        input.disk ? "# name\tstate\truntime\tudid\tsize\ttag" : "# name\tstate\truntime\tudid",
      ]
      for (const [index, device] of devices.entries()) {
        const row = `${device.name}\t${device.state}\t${device.runtime}\t${device.udid}`
        if (!input.disk) {
          lines.push(row)
          continue
        }
        const inUse =
          simulator.sessions.owners(device.udid).length > 0 ||
          simulator.activity.isBusy(device.udid)
        lines.push(`${row}\t${formatSize(sizes[index])}\t${inUse ? "in use" : "free"}`)
      }
      return ok(lines.join("\n"), { count: devices.length })
    }),
  })

  editor.add({
    name: "boot",
    description:
      "Boot a simulator by UDID or name, without opening Simulator.app. Without a udid it reuses this session's device, then takes a free device from the pool. Use sim_start to also open the Simulator panel.",
    input: {
      type: "object",
      properties: { udid: UDID_SCHEMA },
      additionalProperties: false,
    },
    options: SIM_OPTIONS,
    execute: define(async (input: BootInput, context: ToolRuntime) => {
      const target = await startTarget(simulator, context, input.udid)
      const output = await bootDevice(target.device, { signal: context.signal })
      return ok(output, { udid: target.device.udid, name: target.device.name })
    }),
  })

  editor.add({
    name: "create",
    description:
      "Create a new simulator with the same model and runtime as a source simulator, leaving the source running. Optionally install an app that is installed on the source. Use this for an explicitly named device, or when you need more control than the automatic pool.",
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
          description: "Name for the new simulator. Defaults to '<model> #N', made unique.",
        },
        app: {
          type: "string",
          description: "Optional bundle id to install from the source, e.g. com.example.app.",
        },
      },
      additionalProperties: false,
    },
    options: SIM_OPTIONS,
    execute: define(async (input: CreateInput, context: ToolRuntime) => {
      const source = await startDevice(simulator, context, input.from)
      const devices = await listDevices({ signal: context.signal })
      const name = input.name?.trim() || poolDeviceName(source, devices)
      if (devices.some((device) => device.name === name)) {
        throw new Error(`A simulator named "${name}" already exists. Pass another name.`)
      }

      const created = await createDeviceFrom(source, name, { signal: context.signal })
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
      await simulator.sessions.claim(context.sessionID, created.udid)
      simulator.activity.use(created.udid)

      const lines = [
        `created ${created.name} (${created.udid}) from ${source.name} (${source.udid})`,
        ...(booted ? [booted] : []),
        ...(installed ? [installed] : []),
        ...(installError ? [installError] : []),
        "Use sim_start to open its panel.",
      ]
      return ok(lines.join("\n"), {
        udid: created.udid,
        name: created.name,
        source: source.udid,
      })
    }),
  })

  editor.add({
    name: "delete",
    description:
      "Delete a simulator by UDID or name, shutting it down first. Destructive: the device and all its data are removed. Refuses when another session owns the device unless force is true.",
    input: {
      type: "object",
      properties: {
        udid: {
          type: "string",
          description: "Simulator UDID or name to delete. Required.",
        },
        force: {
          type: "boolean",
          description: "Delete even if another session is using this simulator.",
        },
      },
      required: ["udid"],
      additionalProperties: false,
    },
    options: SIM_OPTIONS,
    execute: define(async (input: DeleteInput, context: ToolRuntime) => {
      const device = await resolveDevice(input.udid, { signal: context.signal })
      const owners = simulator.sessions.owners(device.udid, context.sessionID)
      if (owners.length > 0 && input.force !== true) {
        throw new Error(
          `Another session is using ${device.name} (${device.udid}). Pass force: true to delete it anyway.`,
        )
      }

      const output = await deleteDevice(device, { signal: context.signal })
      await simulator.sessions.forget(device.udid)
      simulator.activity.forget(device.udid)
      return ok(output, { udid: device.udid, name: device.name })
    }),
  })

  editor.add({
    name: "start",
    description:
      "Start the simulator end to end: boot the device if needed, optionally launch an app, and open the Simulator panel in the session that called this tool. Omitting udid reuses this session's device, then the first free device of the same model and runtime; when none is free, it creates <model> #N (up to five per model and runtime).",
    input: {
      type: "object",
      properties: {
        udid: UDID_SCHEMA,
        app: {
          type: "string",
          description:
            "Optional bundle id to launch after boot, e.g. com.example.app. When this call assigns a pool device, the app is installed or refreshed from the reference device or another booted simulator; existing app data is kept. Reusing the session's device just launches.",
        },
      },
      additionalProperties: false,
    },
    options: SIM_OPTIONS,
    execute: define(async (input: StartInput, context: ToolRuntime) => {
      const openPanel = simulator.openPanel
      if (!openPanel) throw new Error("The Simulator window entry is not available.")
      const target = await startTarget(simulator, context, input.udid)
      const { device, reference, created, refresh } = target

      // Open the tab before boot. The panel starts its hub immediately and
      // serve-sim waits for the device, so the user sees the simulator (or a
      // loader) while a fresh device's first boot runs. Tell the server the
      // panel exists as soon as the window acknowledges; the window also
      // reports the precise layout state, but a fast turn can go idle before
      // that update arrives.
      const panel = openPanel(device.udid, context.sessionID)
        .then(async (opened) => {
          if (opened) {
            await simulator.activity.panel({
              sessionID: context.sessionID,
              udid: device.udid,
              state: "open",
            })
          }
          return opened
        })
        .catch(() => false)
      const boot = await bootDevice(device, { signal: context.signal })

      let installed = ""
      let installError = ""
      let launched = ""
      let launchError = ""
      if (input.app) {
        if (refresh) {
          try {
            installed = await installApp(device, reference, input.app, context.signal)
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

      const shared = simulator.sessions.owners(device.udid, context.sessionID).length > 0
      const opened = await panel
      const port = opened ? await waitForHub(device.udid, 3_000) : undefined

      const lines = [
        boot,
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
      return ok(lines.join("\n"), {
        udid: device.udid,
        name: device.name,
        port,
        panel: opened,
        ...(created ? { created: true } : {}),
      })
    }),
  })

  editor.add({
    name: "launch",
    description: "Terminate and relaunch an app by bundle id on the simulator.",
    input: {
      type: "object",
      properties: {
        udid: UDID_SCHEMA,
        bundleId: { type: "string", description: "Bundle identifier, e.g. com.example.app." },
        terminate: { type: "boolean", default: true },
        args: { type: "array", items: { type: "string" }, description: "Launch arguments." },
      },
      required: ["bundleId"],
      additionalProperties: false,
    },
    options: SIM_OPTIONS,
    execute: define(async (input: LaunchInput, context: ToolRuntime) => {
      const device = await currentDevice(simulator, context, input.udid)
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
