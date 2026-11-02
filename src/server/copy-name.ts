import type { Device } from "./devices"

/**
 * Naming for automatic simulator copies.
 *
 * A session can name its copy after the flow it is testing instead of building
 * up "Copy 2", "Copy 3" chains. The model comes from the device type, so a copy
 * of a renamed device still starts from the real model name.
 */

const MAX_LABEL = 60

/** Keep a purpose short and safe for `simctl` and the device list. */
export const cleanCopyLabel = (value?: string): string =>
  (value ?? "")
    .replace(/[\u0000-\u001f\u007f/\\:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_LABEL)
    .trim()

const modelName = (device: Device): string => {
  const short = device.deviceType.split(".").pop() ?? ""
  const model = short.replaceAll("-", " ").trim()
  return model || device.name.replace(/ Copy(?: \d+)?$/, "")
}

/**
 * Name a copy of `source`. With a label the name is `<model> — <label>`;
 * without one it keeps the old `<source> Copy` convention. Duplicate names get
 * a numeric suffix.
 */
export const copyDeviceName = (
  source: Device,
  label: string | undefined,
  devices: readonly Device[],
): string => {
  const purpose = cleanCopyLabel(label)
  const model = modelName(source) || "Simulator"
  const base = purpose
    ? purpose.toLowerCase().startsWith(model.toLowerCase())
      ? purpose
      : `${model} — ${purpose}`
    : `${source.name.replace(/ Copy(?: \d+)?$/, "")} Copy`

  const taken = new Set(devices.map((device) => device.name))
  let name = base
  let index = 2
  while (taken.has(name)) name = `${base} ${index++}`
  return name
}
