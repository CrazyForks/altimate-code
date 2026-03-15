import { createMemo, createSignal, For, Show } from "solid-js"
import { useTheme } from "../context/theme"
import { useTerminalDimensions } from "@opentui/solid"
import {
  detectColumnType,
  formatCell,
  calculateColumnWidths,
  fitToWidth,
  formatElapsed,
  type ColumnType,
} from "../util/data-table-utils"

export { formatElapsed } from "../util/data-table-utils"

export interface DataTableProps {
  columns: string[]
  rows: any[][]
  maxRows?: number
  rowCount?: number
  truncated?: boolean
  elapsedMs?: number
  warehouse?: string
}

export function DataTable(props: DataTableProps) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const [expanded, setExpanded] = createSignal(false)

  const maxDisplayRows = () => props.maxRows ?? 20
  const displayRows = createMemo(() => {
    if (expanded()) return props.rows
    return props.rows.slice(0, maxDisplayRows())
  })
  const hasMore = createMemo(() => props.rows.length > maxDisplayRows())

  const colTypes = createMemo(() => props.columns.map((_, i) => detectColumnType(i, props.rows)))

  const colWidths = createMemo(() => {
    const available = Math.max(dimensions().width - 52, 40) // account for sidebar + padding
    return calculateColumnWidths(props.columns, displayRows(), available, colTypes())
  })

  const headerRow = createMemo(() => {
    return props.columns
      .map((col, i) => {
        const align = colTypes()[i] === "number" ? "right" : "left"
        return fitToWidth(col, colWidths()[i], align)
      })
      .join(" │ ")
  })

  const separatorRow = createMemo(() => {
    return colWidths()
      .map((w, i) => {
        const type = colTypes()[i]
        if (type === "number") return "─".repeat(w - 1) + "┤"
        return "─".repeat(w)
      })
      .join("─┼─")
  })

  const footerText = createMemo(() => {
    const parts: string[] = []
    const rc = props.rowCount ?? props.rows.length
    parts.push(`${rc.toLocaleString()} row${rc !== 1 ? "s" : ""}`)
    if (props.elapsedMs !== undefined) parts.push(formatElapsed(props.elapsedMs))
    if (props.truncated) parts.push("truncated")
    if (props.warehouse) parts.push(props.warehouse)
    return parts.join(" · ")
  })

  return (
    <box>
      {/* Header */}
      <text fg={theme.text}>
        <b>{headerRow()}</b>
      </text>
      {/* Separator */}
      <text fg={theme.textMuted}>{separatorRow()}</text>
      {/* Data rows */}
      <For each={displayRows()}>
        {(row) => {
          const formatted = createMemo(() =>
            row
              .map((val, i) => {
                const type = colTypes()[i]
                const cellText = formatCell(val, type)
                const align = type === "number" ? "right" : "left"
                return fitToWidth(cellText, colWidths()[i], align)
              })
              .join(" │ "),
          )

          return <text fg={theme.text}>{formatted()}</text>
        }}
      </For>
      {/* Expand/collapse for large results */}
      <Show when={hasMore() && !expanded()}>
        <text fg={theme.textMuted} onMouseDown={() => setExpanded(true)}>
          … {props.rows.length - maxDisplayRows()} more rows (click to expand)
        </text>
      </Show>
      <Show when={expanded() && hasMore()}>
        <text fg={theme.textMuted} onMouseDown={() => setExpanded(false)}>
          (click to collapse)
        </text>
      </Show>
      {/* Footer */}
      <text fg={theme.textMuted}>{footerText()}</text>
    </box>
  )
}

