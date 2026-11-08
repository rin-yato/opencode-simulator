import { describe, expect, test } from "bun:test"
import { baseName, idleName, inUseName } from "./names"

describe("device names", () => {
  test("adds and strips the in-use mark", () => {
    expect(inUseName("iPhone 17 Pro 2")).toBe("iPhone 17 Pro 2 · in use")
    expect(baseName("iPhone 17 Pro 2 · in use")).toBe("iPhone 17 Pro 2")
  })

  test("adds and strips the idle mark, and swaps marks", () => {
    expect(idleName("iPhone 17 Pro 2")).toBe("iPhone 17 Pro 2 · idle")
    expect(baseName("iPhone 17 Pro 2 · idle")).toBe("iPhone 17 Pro 2")
    expect(idleName("iPhone 17 Pro 2 · in use")).toBe("iPhone 17 Pro 2 · idle")
    expect(inUseName("iPhone 17 Pro 2 · idle")).toBe("iPhone 17 Pro 2 · in use")
  })

  test("is idempotent", () => {
    expect(inUseName("iPhone 17 Pro 2 · in use")).toBe("iPhone 17 Pro 2 · in use")
  })

  test("leaves other names alone", () => {
    expect(baseName("iPhone 17 Pro — storybook")).toBe("iPhone 17 Pro — storybook")
  })
})
