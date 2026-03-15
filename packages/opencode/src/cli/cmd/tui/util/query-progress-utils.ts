/**
 * Pure utility functions for query progress display.
 * Separated from TSX for testability.
 */

/** Determine cost severity color thresholds */
export function formatCostColor(cost: number): "green" | "yellow" | "red" {
  if (cost < 0.01) return "green"
  if (cost < 1.0) return "yellow"
  return "red"
}

/** Truncate a SQL query for display, removing extra whitespace */
export function truncateQuery(query: string, maxLen: number = 60): string {
  const cleaned = query.replace(/\s+/g, " ").trim()
  if (cleaned.length <= maxLen) return cleaned
  return cleaned.slice(0, maxLen - 3) + "..."
}
