import { describe, expect, test } from "bun:test"
import { formatPrune } from "./cleanup"

describe("formatPrune", () => {
  test("reports deleted, skipped, and missing entries", () => {
    const output = formatPrune({
      deleted: [{ udid: "u1", name: "Copy 1", ageDays: 20 }],
      wouldDelete: [{ udid: "u2", name: "Copy 2", ageDays: 15 }],
      skipped: [{ udid: "u3", name: "Copy 3", ageDays: 2, reason: "recent" }],
      missing: 1,
    })
    expect(output).toContain("deleted Copy 1 (u1)")
    expect(output).toContain("would delete Copy 2 (u2)")
    expect(output).toContain("skipped Copy 3 (u3) reason=recent")
    expect(output).toContain("forgot 1 missing device")
  })

  test("says when there is nothing managed", () => {
    expect(formatPrune({ deleted: [], wouldDelete: [], skipped: [], missing: 0 })).toBe(
      "no managed copies",
    )
  })
})
