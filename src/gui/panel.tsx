import { Show, createEffect, createSignal, onCleanup, onMount } from "solid-js"
import { usePlugin } from "@opencode/plugin/gui"
import type { MountedSession } from "@opencode/plugin/gui"
import { SIMULATOR_RPC } from "../rpc"
import { SimulatorIpc } from "./contract"
import { DEVICE_POLL_MS, resolvePanelDevice } from "./panel-device"
import { requestDevice, requestedDevice } from "./requests"
import { panelTheme, resolveMode } from "./theme"

interface Attached {
  readonly embed: string
  readonly key: string
  readonly device: string | undefined
}

export function SimulatorPanel(props: { session: MountedSession }) {
  const ctx = usePlugin()
  const client = ctx.main(SimulatorIpc)
  const rpc = ctx.client.rpc(SIMULATOR_RPC)
  const [embed, setEmbed] = createSignal<string>()
  const [url, setUrl] = createSignal<string>()
  const [error, setError] = createSignal<string>()
  const [loading, setLoading] = createSignal(true)
  /** The device the server named for this session, when the window had none. */
  const [remote, setRemote] = createSignal<{ key: string; udid: string }>()
  let attached: Attached | undefined
  let generation = 0

  /** The panel follows OpenCode's color scheme, so it never sits in a mismatched box. */
  const mode = () => resolveMode(ctx.appearance.mode())
  const theme = () => panelTheme(mode())

  /** The simulator this panel shows: the window's copy, else the server's. */
  const device = () => {
    const key = props.session.key
    const found = remote()
    return resolvePanelDevice(requestedDevice(key), found?.key === key ? found.udid : undefined)
  }

  const connect = async (key: string, target: string) => {
    if (attached && attached.key === key && attached.device === target) return
    const ticket = ++generation
    if (attached) {
      // Moving to another simulator: drop the old view before the new one
      // lands. Moving to another session only parks it, so coming back is instant.
      const previous = attached
      attached = undefined
      setEmbed(undefined)
      const gone = { embed: previous.embed }
      void (previous.key === key ? client.close(gone) : client.detach(gone)).catch(() => {})
    }
    setLoading(true)
    setError(undefined)
    try {
      // Main cannot resolve packages itself, so pass along where the server
      // found the CLI. A server without the answer leaves main to its own lookup.
      const cli = await rpc
        .hub({})
        .then((found) => (found as { readonly cli?: string } | null | undefined)?.cli)
        .catch(() => undefined)
      const registered = mode()
      const result = await client.register({
        key,
        device: target,
        mode: registered,
        ...(cli ? { cli } : {}),
      })
      if (ticket !== generation) {
        void client.close({ embed: result.embed }).catch(() => {})
        return
      }
      attached = { embed: result.embed, key, device: target }
      // The scheme changed while the hub was starting.
      if (mode() !== registered)
        void client.theme({ embed: result.embed, mode: mode() }).catch(() => {})
      setEmbed(result.embed)
      setUrl(result.url)
    } catch (cause) {
      if (ticket !== generation) return
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (ticket === generation) setLoading(false)
    }
  }

  createEffect(() => {
    const key = props.session.key
    const target = device()
    if (!target) {
      // The device was released when this panel closed. Do not fall back to
      // whichever simulator happens to be booted: it may belong to another
      // session now. The next sim_start records a new device here.
      generation += 1
      const previous = attached
      attached = undefined
      setEmbed(undefined)
      setError(undefined)
      if (previous) void client.close({ embed: previous.embed }).catch(() => {})
      return
    }
    void connect(key, target)
  })

  // The window usually knows the device already, so the panel can show the
  // simulator without asking the server. When it does not, keep asking: the
  // claim can land a moment after the panel opened, and the panel should pick
  // it up on its own instead of waiting for the tab to be closed and reopened.
  createEffect(() => {
    const key = props.session.key
    if (requestedDevice(key)) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const ask = async () => {
      if (cancelled) return
      try {
        const result = (await rpc.device({ sessionID: props.session.id })) as
          { readonly udid?: string } | null | undefined
        if (cancelled) return
        if (result?.udid) {
          setRemote({ key, udid: result.udid })
          // Tell the window about it too, so the panel report carries the
          // device and the server can take the claim back.
          requestDevice(key, result.udid)
          return
        }
      } catch {}
      if (cancelled) return
      setLoading(false)
      timer = setTimeout(ask, DEVICE_POLL_MS)
    }
    void ask()
    onCleanup(() => {
      cancelled = true
      if (timer) clearTimeout(timer)
    })
  })

  // The scheme can change while the panel is open. The preview page is
  // restyled in place rather than reloaded, so the stream keeps running.
  createEffect(() => {
    const next = mode()
    const current = attached
    if (current) void client.theme({ embed: current.embed, mode: next }).catch(() => {})
  })

  onMount(() => {
    const stopFailed = client.on("failed", (event) => {
      if (event.embed !== attached?.embed) return
      const embed = attached.embed
      generation += 1
      attached = undefined
      setEmbed(undefined)
      setError(event.detail)
      void client.close({ embed }).catch(() => {})
    })
    const stopRestarted = client.on("restarted", (event) => {
      if (event.embed !== attached?.embed) return
      setUrl(event.url)
    })
    onCleanup(stopFailed)
    onCleanup(stopRestarted)
  })

  // The panel leaves the screen when the user opens another tab or session.
  // Park the view instead of destroying it: it keeps streaming, hidden, and the
  // way back is instant. The main process ends it after a while.
  onCleanup(() => {
    generation += 1
    const previous = attached
    attached = undefined
    if (previous) void client.detach({ embed: previous.embed }).catch(() => {})
  })

  return (
    <div
      style={{
        display: "flex",
        "flex-direction": "column",
        width: "100%",
        height: "100%",
        "min-height": "0",
        background: theme().page,
      }}
    >
      <div
        style={{
          position: "relative",
          display: "flex",
          "flex-grow": 1,
          width: "100%",
          "min-height": "0",
          "align-items": "stretch",
          "justify-content": "center",
          background: theme().page,
        }}
      >
        <Show when={embed()}>
          {(id) => (
            <ctx.embeds.View
              id={id()}
              visible={true}
              page={url()}
              radius={8}
              background={theme().page}
              class="size-full"
            />
          )}
        </Show>
        <Show when={!embed()}>
          <div
            style={{
              display: "flex",
              width: "100%",
              height: "100%",
              "flex-direction": "column",
              "align-items": "center",
              "justify-content": "center",
              gap: "12px",
              padding: "24px",
              "text-align": "center",
              color: theme().text,
              background: theme().page,
            }}
          >
            <Show when={loading()}>
              <ctx.ui.Loader size="large" />
              <div style={{ "font-size": "13px", "line-height": "1.5", opacity: 0.8 }}>
                {ctx.t("panel.starting")}
              </div>
            </Show>
            <Show when={!loading()}>
              <div style={{ "font-size": "13px", "line-height": "1.5", opacity: 0.8 }}>
                {error() ?? ctx.t("panel.empty")}
              </div>
              <Show when={device()}>
                {(target) => (
                  <ctx.ui.Button
                    variant="neutral"
                    size="small"
                    icon="refresh"
                    onClick={() => void connect(props.session.key, target())}
                  >
                    {ctx.t("panel.retry")}
                  </ctx.ui.Button>
                )}
              </Show>
            </Show>
          </div>
        </Show>
      </div>
    </div>
  )
}
