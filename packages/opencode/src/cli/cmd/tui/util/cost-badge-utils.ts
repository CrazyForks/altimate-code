/**
 * Pure utility functions for cost badge display.
 * Separated from TSX for testability.
 */

import { formatElapsed } from "./data-table-utils"

/** Determine cost severity color thresholds based on elapsed time */
export function elapsedSeverity(ms: number): "fast" | "normal" | "slow" {
  if (ms < 1000) return "fast"
  if (ms < 10000) return "normal"
  return "slow"
}

/** Format a compact summary string for inline display */
export function formatInlineSummary(props: {
  rowCount?: number
  elapsedMs?: number
  truncated?: boolean
  warehouse?: string
}): string {
  const parts: string[] = []
  if (props.rowCount !== undefined) {
    parts.push(`${props.rowCount.toLocaleString()} row${props.rowCount !== 1 ? "s" : ""}`)
  }
  if (props.elapsedMs !== undefined) {
    parts.push(formatElapsed(props.elapsedMs))
  }
  if (props.truncated) {
    parts.push("truncated")
  }
  if (props.warehouse) {
    parts.push(props.warehouse)
  }
  return parts.join(" · ")
}
