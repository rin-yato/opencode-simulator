import {
  bootDevice,
  createDeviceFrom,
  deleteDevice,
  installAppFrom,
  listDevices,
  resolveDevice,
  type Device,
} from "../devices"
import { launchApp } from "../actions"
import { serveSimPort } from "../serve-sim"
import {
  currentDevice,
  define,
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

const uniqueDeviceName = (base: string, devices: readonly Device[]): string => {
  const taken = new Set(devices.map((device) => device.name))
  let name = `${base} Copy`
  let index = 2
  while (taken.has(name)) name = `${base} Copy ${index++}`
  return name
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const waitForHub = async (udid: string): Promise<number | undefined> => {
  const deadline = Date.now() + 8_000
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
      "List simulators with state, runtime, and UDID. Use this before sim_boot or sim_start when you need to pick a device. Booted devices are listed first.",
    input: {
      type: "object",
      properties: {
        all: {
          type: "boolean",
          default: false,
          description: "Include unavailable devices that cannot boot.",
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
          a.name.localeCompare(b.name) ||
          a.udid.localeCompare(b.udid),
      )
      const lines = [`# ${devices.length} simulator(s)`, "# name\tstate\truntime\tudid"]
      for (const device of devices) {
        lines.push(`${device.name}\t${device.state}\t${device.runtime}\t${device.udid}`)
      }
      return ok(lines.join("\n"), { count: devices.length })
    }),
  })

  editor.add({
    name: "boot",
    description:
      "Boot a simulator by UDID or name, without opening Simulator.app. Defaults to this session's device, then the only booted device, then the only installed device. Use sim_start to also open the Simulator panel.",
    input: {
      type: "object",
      properties: { udid: UDID_SCHEMA },
      additionalProperties: false,
    },
    options: SIM_OPTIONS,
    execute: define(async (input: BootInput, context: ToolRuntime) => {
      const device = await startDevice(simulator, context, input.udid)
      const output = await bootDevice(device, { signal: context.signal })
      await simulator.sessions.remember(context.sessionID, device.udid)
      return ok(output, { udid: device.udid, name: device.name })
    }),
  })

  editor.add({
    name: "create",
    description:
      "Create a new simulator with the same model and runtime as a source simulator, leaving the source running. Optionally install an app that is installed on the source. Use this when two sessions need the same device without sharing one UDID.",
    input: {
      type: "object",
      properties: {
        from: {
          type: "string",
          description:
            "Source simulator name or UDID. Defaults to this session's device, then the only booted simulator.",
        },
        name: {
          type: "string",
          description: "Name for the new simulator. Defaults to '<source> Copy', made unique.",
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
      const name = input.name?.trim() || uniqueDeviceName(source.name, devices)
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
          installError = `app=install failed: ${cause instanceof Error ? cause.message : String(cause)}`
        }
      }
      await simulator.sessions.remember(context.sessionID, created.udid)

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
      "Delete a simulator by UDID or name, shutting it down first. Destructive: the device and all its data are removed. Use it to clean up sim_create copies. Refuses when another session owns the device unless force is true.",
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
      return ok(output, { udid: device.udid, name: device.name })
    }),
  })

  editor.add({
    name: "start",
    description:
      "Start the simulator end to end: boot the device if needed, optionally launch an app, and open the Simulator panel in the session that called this tool. Use this when the user wants to see or interact with the simulator.",
    input: {
      type: "object",
      properties: {
        udid: UDID_SCHEMA,
        app: {
          type: "string",
          description: "Optional bundle id to launch after boot, e.g. com.example.app.",
        },
      },
      additionalProperties: false,
    },
    options: SIM_OPTIONS,
    execute: define(async (input: StartInput, context: ToolRuntime) => {
      const device = await startDevice(simulator, context, input.udid)
      const shared = simulator.sessions.owners(device.udid, context.sessionID).length > 0
      const boot = await bootDevice(device, { signal: context.signal })
      await simulator.sessions.remember(context.sessionID, device.udid)

      let launched = ""
      if (input.app) {
        launched = await launchApp(device.udid, input.app, {
          signal: context.signal,
          terminate: false,
        })
      }

      if (!simulator.openPanel) throw new Error("The Simulator window entry is not available.")
      const opened = await simulator.openPanel(device.udid, context.sessionID)
      const port = opened ? await waitForHub(device.udid) : undefined

      const lines = [
        boot,
        ...(launched ? [`app=${input.app}`, launched] : []),
        ...(shared
          ? [
              "note=this simulator is also used by another session; run sim_create to get an independent copy of the same model.",
            ]
          : []),
        !opened
          ? "panel=requested; the tab opens in the calling session's strip. Open that session in a window to see it, or restart OpenCode once if the window code is stale."
          : port
            ? `panel=opened serve-sim=http://127.0.0.1:${port}`
            : "panel=opened; serve-sim starts when the Simulator tab is shown in the calling session.",
      ]
      return ok(lines.join("\n"), {
        udid: device.udid,
        name: device.name,
        port,
        panel: opened,
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
