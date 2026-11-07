export type PanelMode = "light" | "dark"

export interface PanelTheme {
  /** The area around the device, and everything the panel draws itself. */
  readonly page: string
  /** Message text on the page, for the starting and error states. */
  readonly text: string
}

/**
 * The panel follows OpenCode's color scheme.
 *
 * serve-sim's controls are light-on-dark chips, so only the page behind the
 * device changes. Recoloring the chips too leaves white icons on white
 * buttons, so the floating toolbars stay dark in both schemes, like a macOS
 * HUD.
 */
export const PANEL_THEMES = {
  dark: { page: "#0a0a0a", text: "#e5e5e5" },
  light: { page: "#ececee", text: "#2b2b2e" },
} as const satisfies Record<PanelMode, PanelTheme>

export const resolveMode = (value: unknown): PanelMode => (value === "light" ? "light" : "dark")

export const panelTheme = (mode: PanelMode): PanelTheme => PANEL_THEMES[mode]

/**
 * CSS for the preview page. serve-sim paints the page from `--color-page`, so
 * one variable and the native scrollbar scheme are all it takes.
 */
export const previewThemeCss = (mode: PanelMode): string =>
  `:root{--color-page:${PANEL_THEMES[mode].page}}`
