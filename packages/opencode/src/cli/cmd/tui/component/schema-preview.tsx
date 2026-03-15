import { createMemo, createSignal, For, Show } from "solid-js"
import { useTheme } from "../context/theme"
import { useTerminalDimensions } from "@opentui/solid"
import type { SchemaColumn } from "@/altimate/bridge/protocol"
import { shortType, detectFK, formatRowCount } from "../util/schema-preview-utils"

export interface SchemaPreviewProps {
  tableName: string
  schemaName?: string
  columns: SchemaColumn[]
  rowCount?: number
  maxColumns?: number
}

/** Detect if a column is likely a primary key from its properties */
function keyIndicator(col: SchemaColumn): string {
  if (col.primary_key) return "PK"
  return ""
}

export function SchemaPreview(props: SchemaPreviewProps) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const [expanded, setExpanded] = createSignal(false)

  const maxCols = () => props.maxColumns ?? 8

  const qualifiedName = createMemo(() => {
    if (props.schemaName) return `${props.schemaName}.${props.tableName}`
    return props.tableName
  })

  const displayColumns = createMemo(() => {
    if (expanded()) return props.columns
    return props.columns.slice(0, maxCols())
  })

  const hasMore = createMemo(() => props.columns.length > maxCols())

  const headerInfo = createMemo(() => {
    const parts: string[] = [qualifiedName()]
    if (props.rowCount !== undefined && props.rowCount !== null) {
      parts.push(`${formatRowCount(props.rowCount)} rows`)
    }
    parts.push(`${props.columns.length} columns`)
    return parts.join(" · ")
  })

  // Calculate column name and type widths for alignment
  const nameWidth = createMemo(() => {
    const maxName = Math.max(...props.columns.map((c) => c.name.length), 4)
    const available = Math.max(dimensions().width - 52, 40)
    return Math.min(maxName, Math.floor(available * 0.4))
  })

  const typeWidth = createMemo(() => {
    const maxType = Math.max(...props.columns.map((c) => shortType(c.data_type).length), 4)
    return Math.min(maxType, 16)
  })

  return (
    <box>
      {/* Header line */}
      <text fg={theme.text}>
        <b>{headerInfo()}</b>
      </text>
      {/* Column tree */}
      <For each={displayColumns()}>
        {(col, i) => {
          const isLast = () => i() === displayColumns().length - 1 && (!hasMore() || expanded())
          const prefix = () => (isLast() ? "└─" : "├─")
          const pk = () => keyIndicator(col)
          const fk = () => (detectFK(col.name) ? "FK" : "")
          const nullable = () => (col.nullable ? "?" : "")

          const colName = () => {
            const name = col.name
            return name.length > nameWidth() ? name.slice(0, nameWidth() - 1) + "…" : name.padEnd(nameWidth())
          }

          const colType = () => {
            const t = shortType(col.data_type)
            return t.padEnd(typeWidth())
          }

          const badges = createMemo(() => {
            const parts: string[] = []
            if (pk()) parts.push(pk())
            if (fk()) parts.push(fk())
            if (nullable()) parts.push("NULL")
            if (col.description) parts.push(col.description.slice(0, 30))
            return parts.join(" ")
          })

          return (
            <text fg={theme.text}>
              <span style={{ fg: theme.textMuted }}>{prefix()} </span>
              <Show when={pk() !== ""} fallback={<span>{colName()}</span>}>
                <b>{colName()}</b>
              </Show>
              {"  "}
              <span style={{ fg: theme.primary }}>{colType()}</span>
              <Show when={badges()}>
                {"  "}
                <span style={{ fg: theme.textMuted }}>{badges()}</span>
              </Show>
            </text>
          )
        }}
      </For>
      {/* Expand/collapse */}
      <Show when={hasMore() && !expanded()}>
        <text fg={theme.textMuted} onMouseDown={() => setExpanded(true)}>
          └─ … {props.columns.length - maxCols()} more columns (click to expand)
        </text>
      </Show>
      <Show when={expanded() && hasMore()}>
        <text fg={theme.textMuted} onMouseDown={() => setExpanded(false)}>
          (click to collapse)
        </text>
      </Show>
    </box>
  )
}
