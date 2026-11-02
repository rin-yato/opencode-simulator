import {
  bootDevice,
  cloneDevice,
  createDeviceFrom,
  deleteDevice,
  deviceSize,
  formatSize,
  installAppFrom,
  listDevices,
  resolveDevice,
  shutdownDevice,
  type Device,
} from "../devices"
import { launchApp } from "../actions"
import { formatPrune, pruneCopies } from "../cleanup"
import { copyDeviceName } from "../copy-name"
import { serveSimPort } from "../serve-sim"
import type { Template } from "../templates"
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

interface PruneInput {
  readonly olderThanDays?: number
  readonly dryRun?: boolean
}

interface StartInput {
  readonly udid?: string
  readonly app?: string
  readonly label?: string
}

interface LaunchInput {
  readonly udid?: string
  readonly bundleId: string
  readonly terminate?: boolean
  readonly args?: readonly string[]
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

let copyLock: Promise<unknown> = Promise.resolve()

/**
 * Serialize automatic copies. Two sessions starting at the same moment would
 * otherwise list the same devices and both choose the same copy name.
 */
const withCopyLock = <T>(task: () => Promise<T>): Promise<T> => {
  const next = copyLock.then(task, task)
  copyLock = next.catch(() => {})
  return next
}

interface StartTarget {
  readonly device: Device
  readonly copiedFrom?: Device
  /** The copy came from a warm template. */
  readonly fromTemplate?: boolean
  /** A cold copy was made; prepare a template for the next session. */
  readonly prepareTemplate?: boolean
}

const templateJobs = new Map<string, Promise<Template | undefined>>()

const templateKeyOf = (device: Device): string => `${device.deviceType}|${device.runtimeId}`

/**
 * Prepare a shutdown device that has completed one boot. Cloning it is cheap on
 * APFS and boots in seconds, so later sessions skip the multi-minute first boot
 * of a freshly created simulator. Runs in the background; a failure only means
 * the next copy is slow again.
 */
const prepareTemplate = (
  simulator: SimulatorContext,
  source: Device,
): Promise<Template | undefined> => {
  const key = templateKeyOf(source)
  const running = templateJobs.get(key)
  if (running) return running

  const job = (async () => {
    const devices = await listDevices()
    const stored = simulator.templates.get(source)
    if (stored) {
      const found = devices.find((device) => device.udid === stored.udid)
      if (found) {
        if (found.state === "Booted") await shutdownDevice(found)
        return stored
      }
      await simulator.templates.forget(stored.udid)
    }

    const template = await createDeviceFrom(source, copyDeviceName(source, "template", devices))
    try {
      await bootDevice(template)
      await shutdownDevice(template)
    } catch (cause) {
      await deleteDevice(template).catch(() => {})
      throw cause
    }
    const saved: Template = {
      udid: template.udid,
      name: template.name,
      deviceType: template.deviceType,
      runtimeId: template.runtimeId,
      createdAt: Date.now(),
    }
    await simulator.templates.remember(saved)
    return saved
  })()
    .catch((cause) => {
      console.warn("opencode-simulator: could not prepare a warm template", cause)
      return undefined
    })
    .finally(() => {
      templateJobs.delete(key)
    })

  templateJobs.set(key, job)
  return job
}

/**
 * Resolve the device for `sim_start`, relaxing the "choose one" error when
 * several simulators are already booted. A new session should not be blocked
 * just because previous sessions left their devices running: it takes an
 * unowned one, or the first one as the source for its own copy.
 */
const pickStartDevice = async (
  simulator: SimulatorContext,
  context: ToolRuntime,
  requested?: string,
): Promise<Device> => {
  try {
    return await startDevice(simulator, context, requested)
  } catch (cause) {
    if (requested?.trim() || simulator.sessions.pick(context.sessionID)) throw cause
    const booted = (await listDevices({ signal: context.signal })).filter(
      (device) => device.state === "Booted" && !simulator.templates.has(device.udid),
    )
    if (booted.length === 0) throw cause
    if (booted.length === 1) return booted[0]!
    return (
      booted.find(
        (device) => simulator.sessions.owners(device.udid, context.sessionID).length === 0,
      ) ?? booted[0]!
    )
  }
}

/**
 * Choose the device for `sim_start`.
 *
 * An explicit UDID is honored even when another session uses it: sharing is an
 * explicit choice. Without one, the device is claimed for the calling session.
 * If another session already owns it, a copy is made so both sessions test in
 * parallel instead of sharing one screen and one set of taps. Copies prefer a
 * warm template, which turns a multi-minute first boot into seconds.
 */
const startTarget = async (
  simulator: SimulatorContext,
  context: ToolRuntime,
  requested?: string,
  label?: string,
): Promise<StartTarget> => {
  const device = await pickStartDevice(simulator, context, requested)
  if (simulator.templates.has(device.udid)) {
    throw new Error(
      `${device.name} is a warm template. Omit udid to clone it, or start another simulator.`,
    )
  }
  if (requested?.trim()) {
    await simulator.copies.touch(device.udid)
    return { device }
  }
  if (await simulator.sessions.claim(context.sessionID, device.udid)) {
    await simulator.copies.touch(device.udid)
    return { device }
  }

  const purpose = label?.trim() || (await simulator.sessionTitle?.(context.sessionID))
  const copy = await withCopyLock(async () => {
    const devices = await listDevices({ signal: context.signal })
    const stored = simulator.templates.get(device)
    if (stored) {
      const template = devices.find((candidate) => candidate.udid === stored.udid)
      if (template) {
        try {
          if (template.state === "Booted") {
            await shutdownDevice(template, { signal: context.signal })
          }
          const cloned = await cloneDevice(
            { ...template, state: "Shutdown" },
            copyDeviceName(device, purpose, devices),
            { signal: context.signal },
          )
          return { device: cloned, fromTemplate: true }
        } catch (cause) {
          // A broken template must not block starting; fall back to a cold copy.
          console.warn("opencode-simulator: template clone failed; creating a fresh copy", cause)
        }
      } else {
        await simulator.templates.forget(stored.udid)
      }
    }

    const created = await createDeviceFrom(device, copyDeviceName(device, purpose, devices), {
      signal: context.signal,
    })
    return { device: created, fromTemplate: false }
  })

  await simulator.sessions.claim(context.sessionID, copy.device.udid)
  const now = Date.now()
  await simulator.copies.remember({
    udid: copy.device.udid,
    sessionID: context.sessionID,
    name: copy.device.name,
    createdAt: now,
    lastUsedAt: now,
  })
  return {
    device: copy.device,
    copiedFrom: device,
    fromTemplate: copy.fromTemplate,
    prepareTemplate: !copy.fromTemplate,
  }
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
      "List simulators with state, runtime, and UDID. Use this before sim_boot or sim_start when you need to pick a device. Booted devices are listed first. Pass disk to add on-disk size and copy/template tags.",
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
          description: "Add on-disk size and copy/template tags (slower).",
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
        const tag = simulator.templates.has(device.udid)
          ? "template"
          : simulator.copies.has(device.udid)
            ? "copy"
            : "-"
        lines.push(`${row}\t${formatSize(sizes[index])}\t${tag}`)
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
      if (simulator.templates.has(device.udid)) {
        throw new Error(`${device.name} is a warm template; omit the udid to clone it instead.`)
      }
      const output = await bootDevice(device, { signal: context.signal })
      await simulator.sessions.remember(context.sessionID, device.udid)
      await simulator.copies.touch(device.udid)
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
      const name = input.name?.trim() || copyDeviceName(source, undefined, devices)
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
      await simulator.copies.forget(device.udid)
      await simulator.templates.forget(device.udid)
      return ok(output, { udid: device.udid, name: device.name })
    }),
  })

  editor.add({
    name: "prune",
    description:
      "Delete old automatic simulator copies. Only copies created by sim_start are eligible, they must be shut down, and templates are never touched. Defaults to a dry run.",
    input: {
      type: "object",
      properties: {
        olderThanDays: {
          type: "integer",
          minimum: 1,
          maximum: 365,
          description:
            "Delete copies idle for at least this many days. Defaults to the configured copy TTL.",
        },
        dryRun: {
          type: "boolean",
          default: true,
          description: "List what would be deleted without deleting it.",
        },
      },
      additionalProperties: false,
    },
    options: SIM_OPTIONS,
    execute: define(async (input: PruneInput, context: ToolRuntime) => {
      const ttlDays =
        input.olderThanDays ?? (simulator.copyTtlDays > 0 ? simulator.copyTtlDays : 14)
      const result = await pruneCopies({
        copies: simulator.copies,
        templates: simulator.templates,
        sessions: simulator.sessions,
        ttlDays,
        dryRun: input.dryRun !== false,
        signal: context.signal,
      })
      return ok(formatPrune(result), {
        deleted: result.deleted.length,
        wouldDelete: result.wouldDelete.length,
        skipped: result.skipped.length,
        missing: result.missing,
      })
    }),
  })

  editor.add({
    name: "start",
    description:
      "Start the simulator end to end: boot the device if needed, optionally launch an app, and open the Simulator panel in the session that called this tool. Omitting udid gives the session its own device; if another session already owns the only candidate, a copy is created so the two sessions do not share one simulator. Pass label to name that copy after the flow under test.",
    input: {
      type: "object",
      properties: {
        udid: UDID_SCHEMA,
        app: {
          type: "string",
          description:
            "Optional bundle id to launch after boot, e.g. com.example.app. When sim_start has to copy a device, it installs this app from the source first.",
        },
        label: {
          type: "string",
          description:
            "Optional short purpose for this session's simulator, e.g. 'create order flow' or 'store profile settings'. Used only when sim_start has to copy another session's device; the copy is named '<model> — <label>'. Defaults to the session title when omitted.",
        },
      },
      additionalProperties: false,
    },
    options: SIM_OPTIONS,
    execute: define(async (input: StartInput, context: ToolRuntime) => {
      const target = await startTarget(simulator, context, input.udid, input.label)
      const { device, copiedFrom, fromTemplate, prepareTemplate: needsTemplate } = target
      const shared =
        !copiedFrom && simulator.sessions.owners(device.udid, context.sessionID).length > 0
      if (!simulator.openPanel) throw new Error("The Simulator window entry is not available.")

      // Open the tab before boot. The panel starts its hub immediately and
      // serve-sim waits for the device, so the user sees the simulator (or a
      // loader) while a fresh device's multi-minute first boot runs.
      const panel = simulator.openPanel(device.udid, context.sessionID).catch(() => false)
      const boot = await bootDevice(device, { signal: context.signal })

      let installed = ""
      let installError = ""
      if (copiedFrom && input.app) {
        try {
          const path = await installAppFrom(device.udid, copiedFrom.udid, input.app, {
            signal: context.signal,
          })
          installed = `app=${input.app} (installed from ${copiedFrom.name}: ${path})`
        } catch (cause) {
          installError = `app=install failed: ${
            cause instanceof Error ? cause.message : String(cause)
          }`
        }
      }

      await simulator.sessions.remember(context.sessionID, device.udid)

      // A copy starts with a fresh install, so launch only after installing the
      // requested app. When the install failed, launching would only add a
      // second, less useful error.
      let launched = ""
      if (input.app && !installError) {
        launched = await launchApp(device.udid, input.app, {
          signal: context.signal,
          terminate: false,
        })
      }

      const opened = await panel
      const port = opened ? await waitForHub(device.udid, 3_000) : undefined

      // A cold copy paid the multi-minute first boot. Prepare a template after
      // this call so future sessions can clone it in seconds.
      if (needsTemplate && copiedFrom) {
        const source = copiedFrom
        setTimeout(() => void prepareTemplate(simulator, source), 2_000)
      }

      const lines = [
        boot,
        ...(copiedFrom
          ? [
              `copied=${device.name} (${device.udid}) from ${copiedFrom.name} (${copiedFrom.udid}); the source stays with its session`,
            ]
          : []),
        ...(fromTemplate ? ["template=used"] : []),
        ...(needsTemplate
          ? ["template=preparing in the background; the next session copies in seconds"]
          : []),
        ...(installed ? [installed] : []),
        ...(installError ? [installError] : []),
        ...(launched ? [`app=${input.app}`, launched] : []),
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
        ...(copiedFrom ? { copiedFrom: copiedFrom.udid } : {}),
        ...(fromTemplate ? { template: true } : {}),
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
