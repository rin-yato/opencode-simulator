import { expect, test } from "bun:test"
import { resolveCli } from "./serve-sim"

// The desktop app runs the GUI main bundle with a `require` that has no
// `resolve`, so an explicit path from the server is the only way a plain
// install finds the CLI.
test("resolves the CLI from an explicit path when require.resolve is unavailable", () => {
  const cli = resolveCli(import.meta.path)
  expect(cli?.args).toEqual([import.meta.path])
})

test("ignores an explicit path that does not exist", () => {
  const cli = resolveCli("/nonexistent/serve-sim.js")
  expect(cli?.args[0]).not.toBe("/nonexistent/serve-sim.js")
})
