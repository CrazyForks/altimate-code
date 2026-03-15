/**
 * Pure utility functions for data table formatting.
 * Separated from the TSX component so they can be tested independently.
 */

/** Detect if a value looks numeric */
export function isNumeric(val: unknown): boolean {
  if (val === null || val === undefined) return false
  const s = String(val).trim()
  return s !== "" && !isNaN(Number(s)) && isFinite(Number(s))
}

/** Detect if a value looks like a date/timestamp */
export function isDateLike(val: unknown): boolean {
  if (val === null || val === undefined || typeof val !== "string") return false
  return /^\d{4}-\d{2}-\d{2}/.test(val.trim())
}

/** Detect column type from sample data */
export function detectColumnType(
  columnIndex: number,
  rows: any[][],
): "number" | "date" | "null" | "string" {
  let numericCount = 0
  let dateCount = 0
  let otherCount = 0
  let nonNullCount = 0

  const sampleSize = Math.min(rows.length, 20)
  for (let i = 0; i < sampleSize; i++) {
    const val = rows[i]?.[columnIndex]
    if (val === null || val === undefined) continue
    nonNullCount++
    if (isNumeric(val)) numericCount++
    else if (isDateLike(val)) dateCount++
    else otherCount++
  }

  if (nonNullCount === 0) return "null"
  // Only classify as number/date if ALL non-null values match that type
  if (numericCount === nonNullCount) return "number"
  if (dateCount === nonNullCount) return "date"
  return "string"
}

export type ColumnType = ReturnType<typeof detectColumnType>

/** Format a cell value for display */
export function formatCell(val: unknown, colType: ColumnType): string {
  if (val === null || val === undefined) return "NULL"
  const s = String(val)
  if (colType === "number") {
    const n = Number(s)
    // Fall back to string display if value isn't actually a valid number
    if (!Number.isFinite(n)) return s
    if (Number.isInteger(n)) return n.toLocaleString()
    return n.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 4 })
  }
  return s
}

/** Calculate column widths respecting available terminal width */
export function calculateColumnWidths(
  columns: string[],
  rows: any[][],
  availableWidth: number,
  colTypes: ColumnType[],
): number[] {
  if (columns.length === 0) return []

  const minColWidth = 4
  const separatorWidth = 3 * (columns.length - 1) // " | " between columns
  const maxAvailable = Math.max(availableWidth - separatorWidth - 4, columns.length * minColWidth)

  // Compute natural widths (header width vs max data width)
  const naturalWidths = columns.map((col, i) => {
    let maxWidth = col.length
    const sampleSize = Math.min(rows.length, 50)
    for (let r = 0; r < sampleSize; r++) {
      const cell = formatCell(rows[r]?.[i], colTypes[i])
      maxWidth = Math.max(maxWidth, cell.length)
    }
    return Math.max(maxWidth, minColWidth)
  })

  const totalNatural = naturalWidths.reduce((a, b) => a + b, 0)

  if (totalNatural <= maxAvailable) {
    return naturalWidths
  }

  // Proportionally shrink columns to fit
  const ratio = maxAvailable / totalNatural
  return naturalWidths.map((w) => Math.max(Math.floor(w * ratio), minColWidth))
}

/** Pad/truncate a string to fit a given width */
export function fitToWidth(text: string, width: number, align: "left" | "right"): string {
  if (width <= 0) return ""
  if (width === 1) return text.length > 1 ? "…" : text.length === 1 ? text : " "
  if (text.length > width) {
    return text.slice(0, width - 1) + "…"
  }
  if (align === "right") {
    return text.padStart(width)
  }
  return text.padEnd(width)
}

/** Format elapsed time in human-readable form */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—"
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60000)
  const seconds = ((ms % 60000) / 1000).toFixed(0)
  return `${minutes}m${seconds}s`
}
