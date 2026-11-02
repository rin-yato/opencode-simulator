import { Show, createSignal, onCleanup, onMount } from "solid-js"
import { usePlugin } from "@opencode/plugin/gui"
import { SimulatorIpc } from "./contract"

export function SimulatorPanel() {
  const ctx = usePlugin()
  const client = ctx.main(SimulatorIpc)
  const [embed, setEmbed] = createSignal<string>()
  const [url, setUrl] = createSignal<string>()
  const [error, setError] = createSignal<string>()
  const [loading, setLoading] = createSignal(true)
  let current: string | undefined

  const connect = async () => {
    setLoading(true)
    setError(undefined)
    try {
      const result = await client.register()
      current = result.embed
      setEmbed(result.embed)
      setUrl(result.url)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }

  onMount(() => {
    const stopFailed = client.on("failed", (event) => {
      if (event.embed !== current) return
      setEmbed(undefined)
      setError(event.detail)
    })
    const stopRestarted = client.on("restarted", (event) => {
      setUrl(event.url)
    })
    onCleanup(stopFailed)
    onCleanup(stopRestarted)
    void connect()
  })

  onCleanup(() => {
    const embedID = current
    current = undefined
    if (embedID) void client.close({ embed: embedID }).catch(() => {})
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
              onClick={() => void connect()}
            >
              {ctx.t("panel.retry")}
            </ctx.ui.Button>
          </Show>
        </div>
      </Show>
    </div>
  )
}
