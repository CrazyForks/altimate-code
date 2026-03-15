import { createMemo, Show } from "solid-js"
import { useTheme } from "../context/theme"
import { elapsedSeverity, formatInlineSummary } from "../util/cost-badge-utils"

export interface CostBadgeProps {
  /** Elapsed time in ms */
  elapsedMs?: number
  /** Row count from query */
  rowCount?: number
  /** Whether result was truncated */
  truncated?: boolean
  /** Warehouse name */
  warehouse?: string
  /** Tool completion status */
  status: string
}

export function CostBadge(props: CostBadgeProps) {
  const { theme } = useTheme()

  const severity = createMemo(() => {
    if (props.elapsedMs === undefined) return "fast"
    return elapsedSeverity(props.elapsedMs)
  })

  const badgeColor = createMemo(() => {
    switch (severity()) {
      case "fast":
        return theme.success
      case "normal":
        return theme.textMuted
      case "slow":
        return theme.warning
    }
  })

  const summaryText = createMemo(() =>
    formatInlineSummary({
      rowCount: props.rowCount,
      elapsedMs: props.elapsedMs,
      truncated: props.truncated,
      warehouse: props.warehouse,
    }),
  )

  return (
    <Show when={props.status === "completed" && summaryText()}>
      <text fg={badgeColor()}>({summaryText()})</text>
    </Show>
  )
}
