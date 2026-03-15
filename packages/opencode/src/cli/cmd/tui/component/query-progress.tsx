import { createMemo, createSignal, onCleanup, Show } from "solid-js"
import { useTheme } from "../context/theme"
import { Spinner } from "./spinner"
import { useKV } from "../context/kv"
import { formatElapsed } from "../util/data-table-utils"
import { truncateQuery } from "../util/query-progress-utils"

export interface QueryProgressProps {
  /** Tool status: "pending" | "running" | "completed" | "error" */
  status: string
  /** SQL query being executed */
  query?: string
  /** Warehouse name */
  warehouse?: string
  /** Number of rows returned */
  rowCount?: number
  /** Whether result was truncated */
  truncated?: boolean
  /** Elapsed time in ms */
  elapsedMs?: number
}

export function QueryProgress(props: QueryProgressProps) {
  const { theme } = useTheme()
  const kv = useKV()

  // Live elapsed timer for running queries
  const [liveElapsed, setLiveElapsed] = createSignal(0)
  const startTime = Date.now()

  const animEnabled = () => kv.get("animations_enabled", true)

  // Update elapsed time while running
  let timer: ReturnType<typeof setInterval> | undefined
  const isRunning = createMemo(() => props.status === "running")

  if (isRunning()) {
    timer = setInterval(() => {
      setLiveElapsed(Date.now() - startTime)
    }, 100)
  }

  onCleanup(() => {
    if (timer) clearInterval(timer)
  })

  const elapsed = createMemo(() => {
    if (props.elapsedMs !== undefined) return formatElapsed(props.elapsedMs)
    if (isRunning()) return formatElapsed(liveElapsed())
    return ""
  })

  const warehouseLabel = createMemo(() => {
    if (!props.warehouse) return ""
    return props.warehouse
  })

  const completedSummary = createMemo(() => {
    const parts: string[] = []
    if (props.rowCount !== undefined) {
      parts.push(`${props.rowCount.toLocaleString()} row${props.rowCount !== 1 ? "s" : ""}`)
    }
    if (elapsed()) parts.push(elapsed())
    if (props.truncated) parts.push("truncated")
    if (warehouseLabel()) parts.push(warehouseLabel())
    return parts.join(" · ")
  })

  return (
    <box>
      <Show when={isRunning()}>
        <box flexDirection="row" gap={1}>
          <Show when={animEnabled()} fallback={<text fg={theme.text}>⋯</text>}>
            <Spinner color={theme.primary} />
          </Show>
          <text fg={theme.text}>
            Running on {warehouseLabel() || "warehouse"} · {elapsed()}
          </text>
        </box>
        <Show when={props.query}>
          <text fg={theme.textMuted}>{truncateQuery(props.query!, 80)}</text>
        </Show>
      </Show>
      <Show when={props.status === "completed"}>
        <text fg={theme.success}>
          ✓ {completedSummary()}
        </text>
      </Show>
      <Show when={props.status === "error"}>
        <text fg={theme.error}>
          ✗ Query failed{elapsed() ? ` · ${elapsed()}` : ""}
        </text>
      </Show>
    </box>
  )
}
