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

// serve-sim binds its port only after the device has booted, and a device's
// first boot takes longer than the old 20 second wait.
test("waits for a server that starts late", async () => {
  const { createServer } = await import("node:http")
  const { reservePort, waitForHttp } = await import("./serve-sim")
  const port = await reservePort()
  const server = createServer((_request, response) => response.end("ok"))
  const timer = setTimeout(() => server.listen(port, "127.0.0.1"), 600)
  try {
    await waitForHttp(`http://127.0.0.1:${port}`, new AbortController().signal, 5_000)
  } finally {
    clearTimeout(timer)
    server.close()
  }
})

test("stops waiting when the start is cancelled", async () => {
  const { reservePort, waitForHttp } = await import("./serve-sim")
  const port = await reservePort()
  const abort = new AbortController()
  setTimeout(() => abort.abort(), 200)
  await expect(waitForHttp(`http://127.0.0.1:${port}`, abort.signal, 5_000)).rejects.toThrow(
    /cancelled/,
  )
})
