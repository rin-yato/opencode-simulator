import { Show, createEffect, createSignal, onCleanup, onMount } from "solid-js"
import { usePlugin } from "@opencode/plugin/gui"
import type { MountedSession } from "@opencode/plugin/gui"
import { SimulatorIpc } from "./contract"
import { requestedDevice } from "./requests"

interface Attached {
  readonly embed: string
  readonly key: string
  readonly device: string | undefined
}

export function SimulatorPanel(props: { session: MountedSession }) {
  const ctx = usePlugin()
  const client = ctx.main(SimulatorIpc)
  const [embed, setEmbed] = createSignal<string>()
  const [url, setUrl] = createSignal<string>()
  const [error, setError] = createSignal<string>()
  const [loading, setLoading] = createSignal(true)
  let attached: Attached | undefined
  let generation = 0

  const connect = async (key: string, device: string | undefined) => {
    if (attached && attached.key === key && attached.device === device) return
    const ticket = ++generation
    if (attached) {
      // Moving to another session or simulator: drop the old view before the
      // new one lands, so a hidden preview cannot keep a capture running.
      const previous = attached
      attached = undefined
      setEmbed(undefined)
      void client.close({ embed: previous.embed }).catch(() => {})
    }
    setLoading(true)
    setError(undefined)
    try {
      const result = await client.register({ key, device })
      if (ticket !== generation) {
        void client.close({ embed: result.embed }).catch(() => {})
        return
      }
      attached = { embed: result.embed, key, device }
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
    const device = requestedDevice(key)
    void connect(key, device)
  })

  onMount(() => {
    const stopFailed = client.on("failed", (event) => {
      if (event.embed !== attached?.embed) return
      attached = undefined
      setEmbed(undefined)
      setError(event.detail)
    })
    const stopRestarted = client.on("restarted", (event) => {
      if (event.embed !== attached?.embed) return
      setUrl(event.url)
    })
    onCleanup(stopFailed)
    onCleanup(stopRestarted)
  })

  onCleanup(() => {
    const previous = attached
    attached = undefined
    if (previous) void client.close({ embed: previous.embed }).catch(() => {})
  })

  return (
    <div
      style={{
        position: "relative",
        display: "flex",
        width: "100%",
        height: "100%",
        "min-height": "0",
        background: "#000",
      }}
    >
      <Show when={embed()}>
        {(id) => (
          <ctx.embeds.View
            id={id()}
            visible={true}
            page={url()}
            radius={8}
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
            color: "var(--text-base, #e5e5e5)",
            background: "var(--background-base, #111)",
          }}
        >
          <Show when={loading()}>
            <ctx.ui.Loader size="large" />
          </Show>
          <Show when={!loading()}>
            <div style={{ "font-size": "13px", "line-height": "1.5", opacity: 0.8 }}>
              {error() ?? ctx.t("panel.empty")}
            </div>
            <ctx.ui.Button
              variant="neutral"
              size="small"
              icon="refresh"
              onClick={() => void connect(props.session.key, requestedDevice(props.session.key))}
            >
              {ctx.t("panel.retry")}
            </ctx.ui.Button>
          </Show>
        </div>
      </Show>
    </div>
  )
}
