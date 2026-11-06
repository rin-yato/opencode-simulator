import { existsSync, statSync } from "node:fs"
import { resolve } from "node:path"
import {
  bootDevice,
  deleteDevice,
  deviceSize,
  eraseDevice,
  formatSize,
  installAppBundle,
  installAppFrom,
  listApps,
  listDevices,
  matchDevice,
  resolveDevice,
  uninstallApp,
  type Device,
} from "../devices"
import { launchApp } from "../actions"
import { allocate, createManaged, refreshApp } from "../allocate"
import { baseName } from "../names"
import { MAX_POOL_SIZE, chooseReference, deviceModel, poolDeviceName, poolDevices } from "../pool"
import { serveSimPort } from "../serve-sim"
import {
  bootedDevice,
  currentDevice,
  define,
  errorText,
  ok,
  partial,
  SHARE_SCHEMA,
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
  readonly from?: string
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
  readonly from?: string
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

const FROM_SCHEMA = {
  type: "string",
  description:
    "Simulator name or UDID whose model and runtime to use. You get a managed device of that model; `from` itself is not claimed.",
} as const

const HOLD_SCHEMA = {
  type: "boolean",
  default: false,
  description: "Keep the device after this turn until sim_release or session close.",
} as const

const HOLD_MINUTES_SCHEMA = {
  type: "integer",
  minimum: 1,
  maximum: 1440,
  description: "Bound the hold to this many minutes; implies hold.",
} as const

const holdOptions = (input: { readonly hold?: boolean; readonly holdMinutes?: number }) => {
  const holdMs = input.holdMinutes ? input.holdMinutes * 60_000 : undefined
  return { hold: input.hold === true || holdMs !== undefined, holdMs }
}

/** Move the session's open panel to the device it just claimed. */
const followPanel = (simulator: SimulatorContext, sessionID: string, udid: string): void => {
  const current = simulator.pool.panelDevice(sessionID)
  if (current && current !== udid) void simulator.openPanel?.(udid, sessionID).catch(() => {})
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
      "Boot a simulator without opening a panel. Allocates like sim_start: with no udid it keeps this session's device, else the last one it used, else a free managed device, else creates one. The claim is released at turn end unless hold is true.",
    input: {
      type: "object",
      properties: {
        udid: UDID_SCHEMA,
        from: FROM_SCHEMA,
        share: SHARE_SCHEMA,
        hold: HOLD_SCHEMA,
        holdMinutes: HOLD_MINUTES_SCHEMA,
      },
      additionalProperties: false,
    },
    options: SIM_OPTIONS,
    execute: define(async (input: BootInput, context: ToolRuntime) => {
      const pool = simulator.pool
      const { device, created } = await allocate(pool, {
        sessionID: context.sessionID,
        udid: input.udid,
        from: input.from,
        share: input.share,
        ...holdOptions(input),
        signal: context.signal,
      })
      followPanel(simulator, context.sessionID, device.udid)
      let output: string
      try {
        output = await bootDevice(device, { signal: context.signal })
      } catch (cause) {
        await pool.failed(context.sessionID, device.udid)
        throw cause
      }
      const release = pool.releaseState(context.sessionID)
      return ok(
        [
          output,
          `release=${release}`,
          "panel=closed",
          ...(created ? [`pool=created ${device.name}; kept for later sessions`] : []),
        ].join("\n"),
        {
          udid: device.udid,
          name: device.name,
          release,
          ...(created ? { created: true } : {}),
        },
      )
    }),
  })

  editor.add({
    name: "create",
    description:
      "Create a managed simulator with the same model and runtime as `from`, and claim it for this session. Optionally boot it and install an app from `from`. The pool holds five per model and runtime; force exceeds that limit.",
    input: {
      type: "object",
      properties: {
        from: {
          type: "string",
          description:
            "Simulator name or UDID to copy the model and runtime from. Defaults to this session's device, else the model sim_start would choose.",
        },
        name: {
          type: "string",
          description: "Name for the new simulator. Defaults to '<model> N', made unique.",
        },
        app: {
          type: "string",
          description: "Optional bundle id to install from `from`, e.g. com.example.app.",
        },
        force: {
          type: "boolean",
          default: false,
          description: "Create beyond the five managed devices for this model and runtime.",
        },
      },
      additionalProperties: false,
    },
    options: SIM_OPTIONS,
    execute: define(async (input: CreateInput, context: ToolRuntime) => {
      const pool = simulator.pool
      const { created, source } = await pool.withLock(async () => {
        const devices = await listDevices({ signal: context.signal })
        const own = pool.pick(context.sessionID)
        const source = input.from?.trim()
          ? matchDevice(devices, input.from.trim())
          : (devices.find((device) => device.udid === own && device.available) ??
            chooseReference(
              devices,
              (udid) => pool.owners(udid, context.sessionID).length === 0,
              (udid) => pool.isManaged(udid),
            ))
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
        const created = await createManaged(
          pool,
          context.sessionID,
          source,
          name,
          undefined,
          context.signal,
        )
        return { created, source }
      })
      followPanel(simulator, context.sessionID, created.udid)

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
        await deleteDevice(created, { signal: context.signal }).catch(() => {})
        await pool.forgetDevice(created.udid).catch(() => {})
        throw cause
      }
    }),
  })

  editor.add({
    name: "delete",
    description:
      "Delete a simulator by exact UDID or exact name, shutting it down first. Destructive: the device and all its data are removed. An external device, or one in use by another session or a panel, needs force: true. Never pass a name fragment.",
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
      const others = pool.owners(device.udid, context.sessionID).length > 0
      // Your own running session is not a reason to refuse.
      const busy =
        pool.isBusy(device.udid, context.sessionID) ||
        pool.panelDevice(context.sessionID) === device.udid
      const managed = pool.isManaged(device.udid)
      if ((others || busy || !managed) && input.force !== true) {
        const reasons = [
          ...(others ? ["another session owns it"] : []),
          ...(busy ? ["it is in use"] : []),
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
      "Start the simulator end to end: allocate a device, boot it, optionally launch an app, and open the panel in this session. With no arguments it keeps this session's device, else the last device it used, else a free managed device, else creates one (up to five per model and runtime). When nothing is booted it uses the newest iPhone Pro; `from` overrides the model. External simulators are never claimed unless passed as udid.",
    input: {
      type: "object",
      properties: {
        udid: UDID_SCHEMA,
        from: FROM_SCHEMA,
        app: {
          type: "string",
          description:
            "Bundle id to launch after boot. A newly assigned managed device first gets the app copied from the source simulator; app data is kept. A device you already had, or passed as udid, just launches.",
        },
        share: SHARE_SCHEMA,
        hold: HOLD_SCHEMA,
        holdMinutes: HOLD_MINUTES_SCHEMA,
      },
      additionalProperties: false,
    },
    options: SIM_OPTIONS,
    execute: define(async (input: StartInput, context: ToolRuntime) => {
      const openPanel = simulator.openPanel
      if (!openPanel) throw new Error("The Simulator window entry is not available.")
      const { device, source, created, refresh } = await allocate(simulator.pool, {
        sessionID: context.sessionID,
        udid: input.udid,
        from: input.from,
        share: input.share,
        ...holdOptions(input),
        signal: context.signal,
      })

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
      let boot: string
      try {
        boot = await bootDevice(device, { signal: context.signal })
      } catch (cause) {
        await simulator.pool.failed(context.sessionID, device.udid)
        throw cause
      }

      let installed = ""
      let installError = ""
      let launched = ""
      let launchError = ""
      if (input.app) {
        if (refresh && simulator.pool.isManaged(device.udid)) {
          const result = await refreshApp(
            device,
            source,
            input.app,
            (udid) => simulator.pool.isManaged(udid),
            context.signal,
          ).catch((cause): { note?: string; error?: string } => ({
            error: `app=install failed: ${errorText(cause)}`,
          }))
          installed = result.note ?? ""
          installError = result.error ?? ""
        }
        // Launch even after an install failure: the launch error is useful
        // when the device has no working copy.
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
        share: SHARE_SCHEMA,
      },
      required: ["path"],
      additionalProperties: false,
    },
    options: SIM_OPTIONS,
    execute: define(async (input: InstallInput, context: ToolRuntime) => {
      const device = await currentDevice(simulator, context, input.udid, input.share)
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
        share: SHARE_SCHEMA,
      },
      required: ["bundleId"],
      additionalProperties: false,
    },
    options: SIM_OPTIONS,
    execute: define(async (input: UninstallInput, context: ToolRuntime) => {
      const device = await currentDevice(simulator, context, input.udid, input.share)
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
      const device = await bootedDevice(simulator, context, input.udid, input.share)
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
