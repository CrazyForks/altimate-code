import { describe, expect, test } from "bun:test"
import {
  isNumeric,
  isDateLike,
  detectColumnType,
  formatCell,
  calculateColumnWidths,
  fitToWidth,
  formatElapsed,
} from "../../../src/cli/cmd/tui/util/data-table-utils"

// ---------------------------------------------------------------------------
// isNumeric
// ---------------------------------------------------------------------------

describe("DataTable.isNumeric", () => {
  test("returns true for integers", () => {
    expect(isNumeric(42)).toBe(true)
    expect(isNumeric("42")).toBe(true)
    expect(isNumeric("0")).toBe(true)
    expect(isNumeric("-1")).toBe(true)
  })

  test("returns true for floats", () => {
    expect(isNumeric(3.14)).toBe(true)
    expect(isNumeric("3.14")).toBe(true)
    expect(isNumeric("-0.5")).toBe(true)
  })

  test("returns true for scientific notation", () => {
    expect(isNumeric("1e5")).toBe(true)
    expect(isNumeric("2.5E-3")).toBe(true)
  })

  test("returns false for non-numeric strings", () => {
    expect(isNumeric("hello")).toBe(false)
    expect(isNumeric("12abc")).toBe(false)
    expect(isNumeric("")).toBe(false)
  })

  test("returns false for null/undefined", () => {
    expect(isNumeric(null)).toBe(false)
    expect(isNumeric(undefined)).toBe(false)
  })

  test("returns false for Infinity", () => {
    expect(isNumeric("Infinity")).toBe(false)
    expect(isNumeric("-Infinity")).toBe(false)
  })

  test("returns false for NaN string", () => {
    expect(isNumeric("NaN")).toBe(false)
  })

  test("handles whitespace-padded numbers", () => {
    expect(isNumeric("  42  ")).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// isDateLike
// ---------------------------------------------------------------------------

describe("DataTable.isDateLike", () => {
  test("recognizes ISO date strings", () => {
    expect(isDateLike("2024-01-15")).toBe(true)
    expect(isDateLike("2024-12-31")).toBe(true)
  })

  test("recognizes timestamps", () => {
    expect(isDateLike("2024-01-15 10:30:00")).toBe(true)
    expect(isDateLike("2024-01-15T10:30:00Z")).toBe(true)
    expect(isDateLike("2024-01-15T10:30:00+05:30")).toBe(true)
  })

  test("rejects non-date strings", () => {
    expect(isDateLike("hello")).toBe(false)
    expect(isDateLike("42")).toBe(false)
    expect(isDateLike("01-15-2024")).toBe(false)
  })

  test("rejects null and undefined", () => {
    expect(isDateLike(null)).toBe(false)
    expect(isDateLike(undefined)).toBe(false)
  })

  test("rejects non-string types", () => {
    expect(isDateLike(42)).toBe(false)
    expect(isDateLike(true)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// detectColumnType
// ---------------------------------------------------------------------------

describe("DataTable.detectColumnType", () => {
  test("detects number columns", () => {
    const rows = [[42], [100], [0], [-5]]
    expect(detectColumnType(0, rows)).toBe("number")
  })

  test("detects date columns", () => {
    const rows = [["2024-01-15"], ["2024-02-20"], ["2024-03-25"]]
    expect(detectColumnType(0, rows)).toBe("date")
  })

  test("detects string columns", () => {
    const rows = [["hello"], ["world"], ["foo"]]
    expect(detectColumnType(0, rows)).toBe("string")
  })

  test("detects all-null columns", () => {
    const rows = [[null], [null], [null]]
    expect(detectColumnType(0, rows)).toBe("null")
  })

  test("handles mixed null and number columns as number", () => {
    const rows = [[null], [42], [null], [100]]
    expect(detectColumnType(0, rows)).toBe("number")
  })

  test("handles empty rows", () => {
    expect(detectColumnType(0, [])).toBe("null")
  })

  test("samples up to 20 rows", () => {
    const rows = Array.from({ length: 100 }, (_, i) => [i])
    expect(detectColumnType(0, rows)).toBe("number")
  })

  test("handles out-of-bounds column index", () => {
    const rows = [[1, 2]]
    expect(detectColumnType(5, rows)).toBe("null")
  })
})

// ---------------------------------------------------------------------------
// formatCell
// ---------------------------------------------------------------------------

describe("DataTable.formatCell", () => {
  test("formats null values", () => {
    expect(formatCell(null, "string")).toBe("NULL")
    expect(formatCell(undefined, "string")).toBe("NULL")
    expect(formatCell(null, "number")).toBe("NULL")
  })

  test("formats numbers with locale grouping", () => {
    const result = formatCell(1000000, "number")
    expect(result.length).toBeGreaterThan(6)
  })

  test("formats integers without decimals", () => {
    const result = formatCell(42, "number")
    expect(result).toBe("42")
  })

  test("formats floats with decimal precision", () => {
    const result = formatCell(3.14159, "number")
    expect(result).toContain("3.14")
  })

  test("formats strings as-is", () => {
    expect(formatCell("hello", "string")).toBe("hello")
    expect(formatCell("2024-01-15", "date")).toBe("2024-01-15")
  })
})

// ---------------------------------------------------------------------------
// calculateColumnWidths
// ---------------------------------------------------------------------------

describe("DataTable.calculateColumnWidths", () => {
  test("returns natural widths when enough space", () => {
    const columns = ["id", "name"]
    const rows = [
      [1, "Alice"],
      [2, "Bob"],
    ]
    const colTypes: Array<"number" | "date" | "null" | "string"> = ["number", "string"]
    const widths = calculateColumnWidths(columns, rows, 120, colTypes)
    expect(widths.length).toBe(2)
    expect(widths[0]).toBeGreaterThanOrEqual(4)
    expect(widths[1]).toBeGreaterThanOrEqual(5)
  })

  test("shrinks columns proportionally when too wide", () => {
    const columns = ["very_long_column_name_1", "very_long_column_name_2", "very_long_column_name_3"]
    const rows = [["a very long value indeed!", "another long value here!", "and yet another one!"]]
    const colTypes: Array<"number" | "date" | "null" | "string"> = ["string", "string", "string"]
    const widths = calculateColumnWidths(columns, rows, 60, colTypes)
    const total = widths.reduce((a, b) => a + b, 0)
    expect(total).toBeLessThanOrEqual(60)
    widths.forEach((w) => expect(w).toBeGreaterThanOrEqual(4))
  })

  test("returns empty array for empty columns", () => {
    expect(calculateColumnWidths([], [], 120, [])).toEqual([])
  })

  test("handles single column", () => {
    const widths = calculateColumnWidths(["id"], [[1], [2]], 120, ["number"])
    expect(widths.length).toBe(1)
    expect(widths[0]).toBeGreaterThanOrEqual(4)
  })

  test("respects minimum column width of 4", () => {
    const columns = ["a", "b"]
    const rows = [[1, 2]]
    const colTypes: Array<"number" | "date" | "null" | "string"> = ["number", "number"]
    const widths = calculateColumnWidths(columns, rows, 120, colTypes)
    widths.forEach((w) => expect(w).toBeGreaterThanOrEqual(4))
  })

  test("handles very narrow terminal width gracefully", () => {
    const columns = ["column_a", "column_b", "column_c"]
    const rows = [["val", "val", "val"]]
    const colTypes: Array<"number" | "date" | "null" | "string"> = ["string", "string", "string"]
    const widths = calculateColumnWidths(columns, rows, 20, colTypes)
    widths.forEach((w) => expect(w).toBeGreaterThanOrEqual(4))
  })

  test("handles many columns on narrow terminal", () => {
    const columns = Array.from({ length: 10 }, (_, i) => `col${i}`)
    const rows = [Array.from({ length: 10 }, (_, i) => `value_${i}`)]
    const colTypes: Array<"number" | "date" | "null" | "string"> = Array(10).fill("string")
    const widths = calculateColumnWidths(columns, rows, 80, colTypes)
    expect(widths.length).toBe(10)
    widths.forEach((w) => expect(w).toBeGreaterThanOrEqual(4))
  })

  test("samples up to 50 rows for width calculation", () => {
    const columns = ["value"]
    const rows = Array.from({ length: 100 }, (_, i) => [i < 5 ? "x".repeat(50) : "y"])
    const colTypes: Array<"number" | "date" | "null" | "string"> = ["string"]
    const widths = calculateColumnWidths(columns, rows, 200, colTypes)
    expect(widths[0]).toBeGreaterThanOrEqual(50)
  })
})

// ---------------------------------------------------------------------------
// fitToWidth
// ---------------------------------------------------------------------------

describe("DataTable.fitToWidth", () => {
  test("left-aligns strings shorter than width", () => {
    expect(fitToWidth("hi", 10, "left")).toBe("hi        ")
  })

  test("right-aligns strings shorter than width", () => {
    expect(fitToWidth("42", 10, "right")).toBe("        42")
  })

  test("truncates strings longer than width", () => {
    const result = fitToWidth("a very long string", 10, "left")
    expect(result.length).toBe(10)
    expect(result.endsWith("…")).toBe(true)
  })

  test("handles exact-width strings", () => {
    expect(fitToWidth("exact", 5, "left")).toBe("exact")
    expect(fitToWidth("exact", 5, "right")).toBe("exact")
  })

  test("handles single-character width truncation", () => {
    const result = fitToWidth("longtext", 1, "left")
    expect(result.length).toBe(1)
    expect(result).toBe("…")
  })

  test("handles empty string", () => {
    expect(fitToWidth("", 5, "left")).toBe("     ")
    expect(fitToWidth("", 5, "right")).toBe("     ")
  })
})

// ---------------------------------------------------------------------------
// formatElapsed
// ---------------------------------------------------------------------------

describe("DataTable.formatElapsed", () => {
  test("formats milliseconds", () => {
    expect(formatElapsed(0)).toBe("0ms")
    expect(formatElapsed(42)).toBe("42ms")
    expect(formatElapsed(999)).toBe("999ms")
  })

  test("formats seconds", () => {
    expect(formatElapsed(1000)).toBe("1.0s")
    expect(formatElapsed(1500)).toBe("1.5s")
    expect(formatElapsed(59999)).toBe("60.0s")
  })

  test("formats minutes and seconds", () => {
    expect(formatElapsed(60000)).toBe("1m0s")
    expect(formatElapsed(90000)).toBe("1m30s")
    expect(formatElapsed(125000)).toBe("2m5s")
  })

  test("handles large values", () => {
    const result = formatElapsed(3600000)
    expect(result).toBe("60m0s")
  })
})

// ---------------------------------------------------------------------------
// Integration: screen size resilience
// ---------------------------------------------------------------------------

describe("DataTable screen size resilience", () => {
  const columns = ["id", "name", "email", "created_at", "amount"]
  const rows = [
    [1, "Alice Johnson", "alice@example.com", "2024-01-15", 99.99],
    [2, "Bob Smith", "bob@example.com", "2024-02-20", 150.0],
    [null, null, null, null, null],
  ]
  const colTypes: Array<"number" | "date" | "null" | "string"> = ["number", "string", "string", "date", "number"]

  test("works at 40 char width (minimum)", () => {
    const widths = calculateColumnWidths(columns, rows, 40, colTypes)
    expect(widths.length).toBe(5)
    widths.forEach((w) => expect(w).toBeGreaterThanOrEqual(4))
  })

  test("works at 80 char width (standard)", () => {
    const widths = calculateColumnWidths(columns, rows, 80, colTypes)
    expect(widths.length).toBe(5)
    widths.forEach((w) => expect(w).toBeGreaterThanOrEqual(4))
  })

  test("works at 120 char width (wide)", () => {
    const widths = calculateColumnWidths(columns, rows, 120, colTypes)
    expect(widths.length).toBe(5)
    widths.forEach((w) => expect(w).toBeGreaterThanOrEqual(4))
  })

  test("works at 200 char width (ultra-wide)", () => {
    const widths = calculateColumnWidths(columns, rows, 200, colTypes)
    expect(widths.length).toBe(5)
    const totalNatural = widths.reduce((a, b) => a + b, 0)
    expect(totalNatural).toBeLessThanOrEqual(200)
  })

  test("handles 1 column at various widths", () => {
    for (const width of [20, 40, 80, 120, 200]) {
      const w = calculateColumnWidths(["id"], [[1]], width, ["number"])
      expect(w.length).toBe(1)
      expect(w[0]).toBeGreaterThanOrEqual(4)
    }
  })

  test("handles 20 columns at various widths", () => {
    const manyCols = Array.from({ length: 20 }, (_, i) => `column_${i}`)
    const manyRows = [Array.from({ length: 20 }, (_, i) => `value_${i}`)]
    const manyTypes: Array<"number" | "date" | "null" | "string"> = Array(20).fill("string")

    for (const width of [40, 80, 120, 200, 300]) {
      const widths = calculateColumnWidths(manyCols, manyRows, width, manyTypes)
      expect(widths.length).toBe(20)
      widths.forEach((w) => expect(w).toBeGreaterThanOrEqual(4))
    }
  })
})
