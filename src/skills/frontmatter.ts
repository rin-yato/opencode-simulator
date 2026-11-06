import { parse as parseYaml } from "yaml"

/**
 * The metadata OpenCode reads from a skill file.
 *
 * The plugin registers its bundled skill by hand instead of letting OpenCode
 * discover it, so it parses the file the same way OpenCode's own skill loader
 * does:
 *
 * - `name` is the display name.
 * - `description` is the summary the model sees when it decides whether to
 *   load the skill. It is what makes the skill trigger.
 * - `metadata.opencode/autoinvoke` decides whether the skill is listed to the
 *   model at all.
 * - `disable-model-invocation` is the older spelling of the same switch.
 */
export interface SkillFrontmatter {
  readonly name?: string
  readonly description?: string
  /** Undefined means the default: the skill is listed to the model. */
  readonly autoinvoke?: boolean
}

export interface ParsedSkill {
  readonly frontmatter: SkillFrontmatter
  /** The Markdown body, without the frontmatter block. */
  readonly content: string
}

const FRONTMATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value)

/**
 * OpenCode accepts the usual spellings of a boolean, and so does this: a
 * frontmatter written by hand says `true` or `false`, but a catalog or a
 * generated file says `yes` or `1`.
 */
export const booleanValue = (value: unknown): boolean | undefined => {
  if (typeof value === "boolean") return value
  if (typeof value === "number") return value === 1 ? true : value === 0 ? false : undefined
  if (typeof value !== "string") return undefined
  const normalized = value.trim().toLowerCase()
  if (["true", "yes", "on", "1"].includes(normalized)) return true
  if (["false", "no", "off", "0"].includes(normalized)) return false
  return undefined
}

const metadataBoolean = (metadata: unknown, key: string) => {
  if (!isRecord(metadata)) return undefined
  return booleanValue(metadata[key])
}

/**
 * Other coding agents accept unquoted colons in frontmatter values. Retry
 * those values as YAML block scalars, the way OpenCode does, so a hand-written
 * description like `description: Use it when: something` still parses.
 */
const sanitize = (yaml: string) =>
  yaml
    .split(/\r?\n/)
    .flatMap((line) => {
      if (line.trim().startsWith("#") || line.trim() === "" || /^\s+/.test(line)) return [line]
      const entry = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/)
      if (!entry) return [line]
      const key = entry[1]
      const value = (entry[2] ?? "").trim()
      if (!key) return [line]
      if (
        value === "" ||
        value === ">" ||
        value === "|" ||
        value.startsWith('"') ||
        value.startsWith("'")
      ) {
        return [line]
      }
      if (!value.includes(":")) return [line]
      return [`${key}: |-`, `  ${value}`]
    })
    .join("\n")

/**
 * Parse the frontmatter block. Returns undefined when the YAML is broken
 * beyond the sanitized retry: the skill still registers, with no metadata.
 */
const parseFrontmatter = (yaml: string): Record<string, unknown> | undefined => {
  let parsed: unknown
  try {
    parsed = parseYaml(yaml)
  } catch {
    try {
      parsed = parseYaml(sanitize(yaml))
    } catch {
      return undefined
    }
  }
  if (!isRecord(parsed)) return {}
  return parsed
}

/**
 * Split a skill file into its metadata and its body.
 *
 * A file without frontmatter is a valid skill: it has no metadata, and its
 * whole text is the body. A file whose frontmatter does not parse keeps its
 * body and loses its metadata, so the skill still loads.
 */
export const parseSkillFile = (raw: string): ParsedSkill => {
  const match = FRONTMATTER.exec(raw)
  if (!match) return { frontmatter: {}, content: raw }
  const data = parseFrontmatter(match[1] ?? "") ?? {}
  const content = raw.slice(match[0].length)

  const name = typeof data.name === "string" && data.name.trim() ? data.name.trim() : undefined
  const description =
    typeof data.description === "string" && data.description.trim()
      ? data.description.trim()
      : undefined
  const opencodeAutoinvoke = metadataBoolean(data.metadata, "opencode/autoinvoke")
  const disableModelInvocation = booleanValue(data["disable-model-invocation"])

  return {
    frontmatter: {
      ...(name === undefined ? {} : { name }),
      ...(description === undefined ? {} : { description }),
      // The OpenCode-specific switch wins over the legacy one.
      autoinvoke: opencodeAutoinvoke ?? (disableModelInvocation ? false : undefined),
    },
    content,
  }
}
