import { describe, expect, test } from "bun:test"
import { MAX_TEMPLATES, TEMPLATES_KEY, Templates, type Template } from "./templates"
import type { StorageLike } from "./session-devices"

const fakeStorage = (initial?: unknown) => {
  const data = new Map<string, unknown>()
  if (initial !== undefined) data.set(TEMPLATES_KEY, initial)
  const storage: StorageLike = {
    get: async (key) => data.get(key),
    set: async (key, value) => {
      data.set(key, value)
    },
  }
  return { storage, data }
}

const template = (index: number): Template => ({
  udid: `udid-${index}`,
  name: `Template ${index}`,
  deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",
  runtimeId: `com.apple.CoreSimulator.SimRuntime.iOS-26-${index}`,
  createdAt: index,
})

describe("Templates", () => {
  test("ignores invalid stored entries", async () => {
    const { storage } = fakeStorage({
      good: template(1),
      bad: { ...template(2), udid: 42 },
      empty: {},
    })
    const templates = await Templates.load(storage)
    expect(templates.size).toBe(1)
    expect(templates.get(template(1))?.udid).toBe("udid-1")
  })

  test("finds a template by device type and runtime", async () => {
    const templates = new Templates()
    await templates.remember(template(1))
    expect(templates.get(template(1))?.udid).toBe("udid-1")
    expect(templates.get({ ...template(1), runtimeId: "other" })).toBeUndefined()
  })

  test("keeps one template per model and runtime", async () => {
    const templates = new Templates()
    await templates.remember(template(1))
    await templates.remember({ ...template(2), runtimeId: template(1).runtimeId })
    expect(templates.size).toBe(1)
    expect(templates.get(template(1))?.udid).toBe("udid-2")
  })

  test("caps the store and keeps the newest", async () => {
    const { storage, data } = fakeStorage()
    const templates = await Templates.load(storage)
    for (let index = 0; index < MAX_TEMPLATES + 2; index += 1) {
      await templates.remember(template(index))
    }
    expect(templates.size).toBe(MAX_TEMPLATES)
    expect(templates.get(template(0))).toBeUndefined()
    expect(Object.keys(data.get(TEMPLATES_KEY) as object)).toHaveLength(MAX_TEMPLATES)
  })

  test("forgets a template by udid", async () => {
    const templates = new Templates()
    await templates.remember(template(1))
    await templates.forget("udid-1")
    expect(templates.size).toBe(0)
    expect(templates.has("udid-1")).toBe(false)
  })
})
