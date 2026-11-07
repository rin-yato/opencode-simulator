import { describe, expect, test } from "bun:test"
import { PANEL_THEMES, panelTheme, previewThemeCss, resolveMode } from "./theme"

describe("panel theme", () => {
  test("unknown schemes fall back to dark", () => {
    expect(resolveMode("light")).toBe("light")
    expect(resolveMode("dark")).toBe("dark")
    expect(resolveMode(undefined)).toBe("dark")
    expect(resolveMode("sepia")).toBe("dark")
  })

  test("each scheme has its own page color", () => {
    expect(panelTheme("dark").page).not.toBe(panelTheme("light").page)
  })

  test("the preview stylesheet sets only serve-sim's page variable", () => {
    expect(previewThemeCss("dark")).toBe(`:root{--color-page:${PANEL_THEMES.dark.page}}`)
    expect(previewThemeCss("light")).toBe(`:root{--color-page:${PANEL_THEMES.light.page}}`)
  })

  test("message text contrasts with the page", () => {
    const luminance = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [
        number,
        number,
        number,
      ]
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }
    for (const mode of ["light", "dark"] as const) {
      const theme = panelTheme(mode)
      expect(Math.abs(luminance(theme.page) - luminance(theme.text))).toBeGreaterThan(0.6)
    }
  })
})
