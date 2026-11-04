import { run } from "./exec"
import { serveSimAx } from "./serve-sim"

export interface Frame {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

interface AxNode {
  readonly type?: string
  readonly AXLabel?: string | null
  readonly AXValue?: string | null
  readonly AXUniqueId?: string | null
  readonly AXFrame?: string | null
  readonly frame?: Partial<Frame> | null
  readonly traits?: readonly string[] | null
  readonly children?: readonly AxNode[] | null
}

export interface UiRow {
  readonly kind: string
  readonly label: string
  readonly uid: string
  readonly value: string
  readonly frame: Frame
  readonly interactive: boolean
  readonly visible: boolean
  readonly direction: "visible" | "below" | "above"
  readonly tap: string
}

export interface UiSnapshot {
  readonly app: string
  readonly screen: { readonly width: number; readonly height: number } | null
  readonly rows: readonly UiRow[]
}

const INTERACTIVE_TYPES = new Set([
  "Button",
  "Cell",
  "CheckBox",
  "Link",
  "MenuItem",
  "PopUpButton",
  "RadioButton",
  "SegmentedControl",
  "Slider",
  "Switch",
  "Tab",
  "TextField",
  "Toggle",
])

const TEXT_TYPES = new Set(["Heading", "StaticText", "Text"])
const NOISE_TYPES = new Set(["Image", "ScrollBar"])
const PUNCTUATION = new Set(["·", "•", "-", "–", "—", "|"])

const FRAME_RE = /\{\{(-?[\d.]+), (-?[\d.]+)\}, \{(-?[\d.]+), (-?[\d.]+)\}\}/

const number = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined

function frameOf(node: AxNode): Frame | null {
  const frame = node.frame
  if (frame) {
    const x = number(frame.x)
    const y = number(frame.y)
    const width = number(frame.width)
    const height = number(frame.height)
    if (x !== undefined && y !== undefined && width !== undefined && height !== undefined) {
      if (width > 0 && height > 0) return { x, y, width, height }
    }
  }
  if (typeof node.AXFrame === "string") {
    const match = node.AXFrame.match(FRAME_RE)
    if (match) {
      const values = match.slice(1).map(Number)
      const x = values[0]
      const y = values[1]
      const width = values[2]
      const height = values[3]
      if (x === undefined || y === undefined || width === undefined || height === undefined)
        return null
      if (width > 0 && height > 0) return { x, y, width, height }
    }
  }
  return null
}

const traitsOf = (node: AxNode): readonly string[] =>
  Array.isArray(node.traits) ? node.traits : []

const isInteractive = (node: AxNode): boolean => {
  const kind = node.type ?? ""
  if (INTERACTIVE_TYPES.has(kind)) return true
  const traits = new Set(traitsOf(node))
  return ["Button", "Link", "Switch", "Toggle", "TextField"].some((trait) => traits.has(trait))
}

const isScrollBar = (node: AxNode): boolean => {
  const label = node.AXLabel ?? ""
  return (
    node.type === "Slider" &&
    (label.startsWith("Vertical scroll bar") || label.startsWith("Horizontal scroll bar"))
  )
}

const isPunctuation = (label: string): boolean =>
  label.length > 0 && [...label].every((char) => PUNCTUATION.has(char) || char.trim() === "")

function* walk(
  nodes: readonly AxNode[],
  ancestors: readonly AxNode[] = [],
): Generator<{ node: AxNode; ancestors: readonly AxNode[] }> {
  for (const node of nodes) {
    yield { node, ancestors }
    if (Array.isArray(node.children)) {
      yield* walk(node.children, [...ancestors, node])
    }
  }
}

function screenOf(nodes: readonly AxNode[]): { width: number; height: number } | null {
  for (const node of nodes) {
    if (node.type !== "Application") continue
    const frame = frameOf(node)
    if (frame) return { width: frame.width, height: frame.height }
  }
  return null
}

function appOf(nodes: readonly AxNode[]): string {
  return nodes.find((node) => node.type === "Application")?.AXLabel?.trim() ?? ""
}

function intersection(
  frame: Frame,
  screen: { width: number; height: number } | null,
): Frame | null {
  if (!screen) return frame
  const left = Math.max(0, frame.x)
  const top = Math.max(0, frame.y)
  const right = Math.min(screen.width, frame.x + frame.width)
  const bottom = Math.min(screen.height, frame.y + frame.height)
  if (right <= left || bottom <= top) return null
  return { x: left, y: top, width: right - left, height: bottom - top }
}

function directionOf(
  frame: Frame,
  screen: { width: number; height: number } | null,
): UiRow["direction"] {
  if (!screen) return "visible"
  if (frame.y >= screen.height) return "below"
  if (frame.y + frame.height <= 0) return "above"
  return "visible"
}

const overlapRatio = (first: Frame, second: Frame): number => {
  const left = Math.max(first.x, second.x)
  const top = Math.max(first.y, second.y)
  const right = Math.min(first.x + first.width, second.x + second.width)
  const bottom = Math.min(first.y + first.height, second.y + second.height)
  if (right <= left || bottom <= top) return 0
  const overlap = (right - left) * (bottom - top)
  const smaller = Math.min(first.width * first.height, second.width * second.height)
  return smaller ? overlap / smaller : 0
}

function collect(nodes: readonly AxNode[], includeAll: boolean): UiRow[] {
  const screen = screenOf(nodes)
  const rows: UiRow[] = []
  const seen = new Set<string>()

  for (const { node, ancestors } of walk(nodes)) {
    const kind = node.type ?? "?"
    if (kind === "Application") continue
    if (!includeAll && NOISE_TYPES.has(kind)) continue
    if (isScrollBar(node)) continue

    const label = (node.AXLabel ?? "").trim()
    const uid = (node.AXUniqueId ?? "").trim()
    const value = node.AXValue == null ? "" : String(node.AXValue).trim()
    const interactive = isInteractive(node)

    if (!includeAll) {
      if ((kind === "Group" || kind === "Other") && !(label || uid || value)) continue
      if (ancestors.some(isInteractive) && TEXT_TYPES.has(kind)) continue
      if (TEXT_TYPES.has(kind) && (!label || isPunctuation(label))) continue
      if (!(label || uid || value || interactive)) continue
    }

    const frame = frameOf(node)
    if (!frame) continue

    const key = `${kind}\u0000${label}\u0000${uid}\u0000${value}\u0000${frame.x},${frame.y},${frame.width},${frame.height}`
    if (seen.has(key)) continue
    seen.add(key)

    const visibleFrame = intersection(frame, screen)
    const tap =
      interactive && visibleFrame
        ? `${Math.round(visibleFrame.x + visibleFrame.width / 2)},${Math.round(
            visibleFrame.y + visibleFrame.height / 2,
          )}`
        : ""

    rows.push({
      kind,
      label,
      uid,
      value,
      frame,
      interactive,
      visible: visibleFrame !== null,
      direction: directionOf(frame, screen),
      tap,
    })
  }

  if (includeAll) {
    return rows.sort((a, b) => a.frame.y - b.frame.y || a.frame.x - b.frame.x)
  }

  const controls = rows.filter((row) => row.interactive)
  let kept = rows.filter(
    (row) =>
      !(
        TEXT_TYPES.has(row.kind) &&
        controls.some(
          (control) =>
            control.label &&
            control.label.toLowerCase() === row.label.toLowerCase() &&
            overlapRatio(control.frame, row.frame) > 0.5,
        )
      ),
  )

  const textRows = kept
    .filter((row) => TEXT_TYPES.has(row.kind))
    .sort((a, b) => b.frame.width * b.frame.height - a.frame.width * a.frame.height)
  const keptText: UiRow[] = []
  const dropped = new Set<UiRow>()
  for (const row of textRows) {
    if (keptText.some((parent) => overlapRatio(row.frame, parent.frame) > 0.8)) {
      dropped.add(row)
    } else {
      keptText.push(row)
    }
  }
  kept = kept.filter((row) => !dropped.has(row))

  return kept.sort((a, b) => a.frame.y - b.frame.y || a.frame.x - b.frame.x)
}

async function viaAxe(udid: string, signal?: AbortSignal): Promise<readonly AxNode[]> {
  const { stdout } = await run("axe", ["describe-ui", "--udid", udid], {
    signal,
    timeout: 20_000,
  })
  const parsed = JSON.parse(stdout) as AxNode | AxNode[]
  return Array.isArray(parsed) ? parsed : [parsed]
}

export async function readSnapshot(
  udid: string,
  options: { includeAll?: boolean; signal?: AbortSignal } = {},
): Promise<UiSnapshot> {
  let nodes: readonly AxNode[]
  try {
    nodes = await viaAxe(udid, options.signal)
  } catch (cause) {
    if (!/ENOENT|not found|command failed/i.test(String(cause))) throw cause
    nodes = (await serveSimAx(udid, options.signal)) as AxNode[]
  }
  return {
    app: appOf(nodes),
    screen: screenOf(nodes),
    rows: collect(nodes, options.includeAll === true),
  }
}

const truncate = (text: string, limit: number): string =>
  text.length <= limit ? text : `${text.slice(0, limit - 1)}…`

const rowLine = (row: UiRow, index: number, full = false): string => {
  const label = full ? row.label : truncate(row.label, 48)
  const uid = full ? row.uid : truncate(row.uid, 18)
  const value = full ? row.value : truncate(row.value, 20)
  const tap = row.visible ? row.tap : row.direction === "below" ? "↓" : "↑"
  return `${index}\t${row.kind}\t${label}\t${uid}\t${value}\t${tap}`
}

export function formatSnapshot(
  snapshot: UiSnapshot,
  mode: "visible" | "interactive" | "all",
  max: number,
): string {
  const visible = snapshot.rows.filter((row) => row.visible)
  const below = snapshot.rows.filter((row) => row.direction === "below")
  const above = snapshot.rows.filter((row) => row.direction === "above")
  const size = snapshot.screen
    ? `${Math.round(snapshot.screen.width)}x${Math.round(snapshot.screen.height)}`
    : "unknown"

  let rows = snapshot.rows
  if (mode === "visible") rows = visible
  if (mode === "interactive") rows = rows.filter((row) => row.interactive)

  const lines = [
    `# app=${snapshot.app || "-"} screen=${size} visible=${visible.length} below=${below.length} above=${above.length}`,
    "# tap points are logical points (axe)",
    "# idx\ttype\tlabel\tid\tvalue\ttap",
  ]
  for (const [index, row] of rows.slice(0, max).entries()) {
    lines.push(rowLine(row, index + 1))
  }
  if (rows.length > max) {
    lines.push(`# ${rows.length - max} more rows hidden; narrow with find or raise max`)
  }
  if (below.length && mode !== "all") {
    lines.push("# rows below the fold; scroll down first")
  }
  return lines.join("\n")
}

function matchRank(row: UiRow, query: string): number {
  const label = row.label.toLowerCase()
  const exact = label === query
  const prefix = label.startsWith(query)
  // A tap should hit the control, not the heading that repeats its label.
  if (row.interactive) return exact ? 0 : prefix ? 1 : 2
  return exact ? 3 : prefix ? 4 : 5
}

export function matches(row: UiRow, query: string): boolean {
  const wanted = query.toLowerCase()
  return (
    row.label.toLowerCase().includes(wanted) ||
    row.uid.toLowerCase().includes(wanted) ||
    row.value.toLowerCase().includes(wanted)
  )
}

export function findRows(rows: readonly UiRow[], query: string): UiRow[] {
  return rows
    .filter((row) => matches(row, query))
    .sort(
      (a, b) =>
        matchRank(a, query.toLowerCase()) - matchRank(b, query.toLowerCase()) ||
        Number(b.visible) - Number(a.visible) ||
        a.frame.y - b.frame.y ||
        a.frame.x - b.frame.x,
    )
}

export function formatMatches(rows: readonly UiRow[], query: string): string {
  const found = findRows(rows, query)
  if (!found.length) return `# no match for ${JSON.stringify(query)} in ${rows.length} rows`
  const lines = [`# ${found.length} match(es) for ${JSON.stringify(query)}`]
  for (const [index, row] of found.slice(0, 20).entries()) {
    lines.push(rowLine(row, index + 1, true))
    if (!row.visible) {
      lines.push(
        row.direction === "below"
          ? "#   below the fold; scroll down first"
          : "#   above the fold; scroll up first",
      )
    }
  }
  return lines.join("\n")
}

export function resolveRow(rows: readonly UiRow[], query: string): UiRow | undefined {
  return findRows(rows, query)[0]
}
