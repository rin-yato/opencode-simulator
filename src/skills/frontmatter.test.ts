import { describe, expect, test } from "bun:test"
import { booleanValue, parseSkillFile } from "./frontmatter"

describe("skill frontmatter", () => {
  test("reads the name, description, and autoinvoke switch", () => {
    const parsed = parseSkillFile(
      [
        "---",
        "name: Simulator",
        "description: Drive the iOS Simulator.",
        "metadata:",
        "  opencode/autoinvoke: true",
        "---",
        "",
        "Body text.",
      ].join("\n"),
    )
    expect(parsed.frontmatter).toEqual({
      name: "Simulator",
      description: "Drive the iOS Simulator.",
      autoinvoke: true,
    })
    expect(parsed.content.trim()).toBe("Body text.")
  })

  test("the body never keeps the frontmatter", () => {
    const parsed = parseSkillFile("---\nname: Simulator\n---\n\nBody only.\n")
    expect(parsed.content).not.toContain("---")
    expect(parsed.content).not.toContain("name: Simulator")
    expect(parsed.content.trim()).toBe("Body only.")
  })

  test("a file without frontmatter is a valid skill", () => {
    const parsed = parseSkillFile("Just a body.\n")
    expect(parsed.frontmatter.name).toBeUndefined()
    expect(parsed.frontmatter.description).toBeUndefined()
    expect(parsed.frontmatter.autoinvoke).toBeUndefined()
    expect(parsed.content).toBe("Just a body.\n")
  })

  test("a folded description becomes one line", () => {
    const parsed = parseSkillFile(
      ["---", "description: >-", "  First line", "  second line", "---", "", "Body."].join("\n"),
    )
    expect(parsed.frontmatter.description).toBe("First line second line")
  })

  test("an unquoted colon in a value still parses", () => {
    const parsed = parseSkillFile("---\ndescription: Use it when: something happens\n---\n\nBody.")
    expect(parsed.frontmatter.description).toBe("Use it when: something happens")
  })

  test("the legacy switch turns autoinvoke off", () => {
    const parsed = parseSkillFile("---\ndisable-model-invocation: true\n---\n\nBody.")
    expect(parsed.frontmatter.autoinvoke).toBe(false)
  })

  test("the OpenCode switch wins over the legacy one", () => {
    const parsed = parseSkillFile(
      [
        "---",
        "disable-model-invocation: true",
        "metadata:",
        "  opencode/autoinvoke: true",
        "---",
        "",
        "Body.",
      ].join("\n"),
    )
    expect(parsed.frontmatter.autoinvoke).toBe(true)
  })

  test("an empty description is treated as missing", () => {
    const parsed = parseSkillFile("---\nname: Simulator\ndescription:   \n---\n\nBody.")
    expect(parsed.frontmatter.description).toBeUndefined()
  })

  test("broken frontmatter loses its metadata but keeps the body", () => {
    const parsed = parseSkillFile("---\nname: [unclosed\n---\n\nBody still here.\n")
    expect(parsed.frontmatter.description).toBeUndefined()
    expect(parsed.content.trim()).toBe("Body still here.")
  })

  test("booleans accept the usual spellings", () => {
    expect(booleanValue(true)).toBe(true)
    expect(booleanValue("yes")).toBe(true)
    expect(booleanValue("ON")).toBe(true)
    expect(booleanValue(1)).toBe(true)
    expect(booleanValue("false")).toBe(false)
    expect(booleanValue("off")).toBe(false)
    expect(booleanValue(0)).toBe(false)
    expect(booleanValue("maybe")).toBeUndefined()
    expect(booleanValue(undefined)).toBeUndefined()
  })
})
