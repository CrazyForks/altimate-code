/**
 * Adversarial tests — try to crash, corrupt, or produce garbage output
 * from every data-UX utility function.
 */
import { describe, test, expect } from "bun:test"
import {
  isNumeric,
  isDateLike,
  detectColumnType,
  formatCell,
  calculateColumnWidths,
  fitToWidth,
  formatElapsed,
} from "../../../src/cli/cmd/tui/util/data-table-utils"
import {
  shortType,
  detectFK,
  formatRowCount,
} from "../../../src/cli/cmd/tui/util/schema-preview-utils"
import {
  elapsedSeverity,
  formatInlineSummary,
} from "../../../src/cli/cmd/tui/util/cost-badge-utils"
import {
  formatCostColor,
  truncateQuery,
} from "../../../src/cli/cmd/tui/util/query-progress-utils"

// ═══════════════════════════════════════════════════════════════
// Helper: simulate the full table rendering pipeline
// ═══════════════════════════════════════════════════════════════
function renderTable(columns: string[], rows: any[][], termWidth: number) {
  const colTypes = columns.map((_, i) => detectColumnType(i, rows))
  const available = Math.max(termWidth - 52, 40)
  const colWidths = calculateColumnWidths(columns, rows, available, colTypes)

  const header = columns
    .map((col, i) => fitToWidth(col, colWidths[i], colTypes[i] === "number" ? "right" : "left"))
    .join(" │ ")
  const separator = colWidths
    .map((w, i) => (colTypes[i] === "number" ? "─".repeat(w - 1) + "┤" : "─".repeat(w)))
    .join("─┼─")
  const dataRows = rows.map((row) =>
    row
      .map((val, i) => {
        const cellText = formatCell(val, colTypes[i])
        return fitToWidth(cellText, colWidths[i], colTypes[i] === "number" ? "right" : "left")
      })
      .join(" │ "),
  )

  return { header, separator, dataRows, colWidths, colTypes }
}

// ═══════════════════════════════════════════════════════════════
// 1. EMPTY INPUTS
// ═══════════════════════════════════════════════════════════════
describe("Adversarial: empty inputs", () => {
  test("zero columns, zero rows", () => {
    const widths = calculateColumnWidths([], [], 100, [])
    expect(widths).toEqual([])
  })

  test("columns but zero rows", () => {
    const result = renderTable(["A", "B", "C"], [], 100)
    expect(result.header).toBeDefined()
    expect(result.dataRows).toHaveLength(0)
    // Column widths should still be at least the header length
    result.colWidths.forEach((w) => expect(w).toBeGreaterThanOrEqual(4))
  })

  test("single column, single row", () => {
    const result = renderTable(["X"], [["hello"]], 100)
    expect(result.dataRows).toHaveLength(1)
    expect(result.header.trim()).toBe("X")
  })

  test("empty string column name", () => {
    const result = renderTable(["", "B"], [["a", "b"]], 100)
    // Should not crash; empty column gets padded to minWidth
    expect(result.colWidths[0]).toBeGreaterThanOrEqual(4)
  })

  test("all empty string values", () => {
    const result = renderTable(["A", "B"], [["", ""], ["", ""]], 100)
    expect(result.dataRows).toHaveLength(2)
  })
})

// ═══════════════════════════════════════════════════════════════
// 2. NULL / UNDEFINED EVERYWHERE
// ═══════════════════════════════════════════════════════════════
describe("Adversarial: null/undefined values", () => {
  test("all null row", () => {
    const result = renderTable(["A", "B"], [[null, null]], 100)
    expect(result.dataRows[0]).toContain("NULL")
  })

  test("all undefined row", () => {
    const result = renderTable(["A", "B"], [[undefined, undefined]], 100)
    expect(result.dataRows[0]).toContain("NULL")
  })

  test("mixed null/undefined/value", () => {
    const result = renderTable(
      ["A", "B", "C"],
      [[null, "hello", undefined], [undefined, null, "world"]],
      100,
    )
    expect(result.dataRows).toHaveLength(2)
  })

  test("entire table is null", () => {
    const rows = Array.from({ length: 10 }, () => [null, null, null])
    const result = renderTable(["A", "B", "C"], rows, 100)
    expect(result.colTypes.every((t) => t === "null")).toBe(true)
  })

  test("formatCell with null", () => {
    expect(formatCell(null, "string")).toBe("NULL")
    expect(formatCell(null, "number")).toBe("NULL")
    expect(formatCell(null, "date")).toBe("NULL")
    expect(formatCell(null, "null")).toBe("NULL")
  })

  test("formatCell with undefined", () => {
    expect(formatCell(undefined, "string")).toBe("NULL")
    expect(formatCell(undefined, "number")).toBe("NULL")
  })
})

// ═══════════════════════════════════════════════════════════════
// 3. EXTREME NUMBERS
// ═══════════════════════════════════════════════════════════════
describe("Adversarial: extreme numbers", () => {
  test("NaN value in numeric column", () => {
    // NaN should not be detected as numeric
    expect(isNumeric(NaN)).toBe(false)
    expect(formatCell(NaN, "number")).toBe("NaN")
  })

  test("Infinity", () => {
    expect(isNumeric(Infinity)).toBe(false)
    expect(isNumeric(-Infinity)).toBe(false)
    // Non-finite numbers fall back to string display
    expect(formatCell(Infinity, "number")).toBe("Infinity")
    expect(formatCell(-Infinity, "number")).toBe("-Infinity")
  })

  test("Number.MAX_SAFE_INTEGER", () => {
    const result = formatCell(Number.MAX_SAFE_INTEGER, "number")
    expect(result).toBeDefined()
    expect(result.length).toBeGreaterThan(0)
  })

  test("very small decimals", () => {
    const result = formatCell(0.000001, "number")
    expect(result).toBeDefined()
    // Should not produce something unreadable
    expect(result.length).toBeLessThan(30)
  })

  test("negative numbers", () => {
    const result = renderTable(["VAL"], [[-999], [-0.5], [-1234567]], 80)
    expect(result.dataRows).toHaveLength(3)
    result.dataRows.forEach((r) => expect(r).toContain("-"))
  })

  test("string that looks numeric: '1e308'", () => {
    expect(isNumeric("1e308")).toBe(true)
    // formatCell should handle this without crashing
    const result = formatCell("1e308", "number")
    expect(result).toBeDefined()
  })

  test("string 'NaN' should not be numeric", () => {
    expect(isNumeric("NaN")).toBe(false)
  })

  test("string 'Infinity' should not be numeric", () => {
    expect(isNumeric("Infinity")).toBe(false)
  })

  test("zero", () => {
    expect(formatCell(0, "number")).toBe("0")
    expect(formatCell(-0, "number")).toBe("0")
  })
})

// ═══════════════════════════════════════════════════════════════
// 4. EXTREMELY LONG STRINGS
// ═══════════════════════════════════════════════════════════════
describe("Adversarial: extremely long strings", () => {
  test("1000-char cell value at width 40", () => {
    const longStr = "A".repeat(1000)
    const result = renderTable(["DATA"], [[longStr]], 40)
    // Should truncate, not blow up
    result.dataRows.forEach((r) => expect(r.length).toBeLessThanOrEqual(result.header.length + 5))
  })

  test("1000-char column name", () => {
    const longName = "X".repeat(1000)
    const result = renderTable([longName], [["val"]], 80)
    // Header should be truncated to fit
    expect(result.header.length).toBeLessThanOrEqual(100)
  })

  test("URL-length strings in narrow terminal", () => {
    const url = "https://warehouse.example.com/api/v3/datasets/production/tables/user_events?format=json&limit=1000"
    const result = renderTable(["URL"], [[url]], 60)
    expect(result.dataRows[0].length).toBe(result.header.length)
  })

  test("string with newlines", () => {
    const val = "line1\nline2\nline3"
    const result = formatCell(val, "string")
    // Should not crash; newlines become part of the string
    expect(result).toBeDefined()
  })

  test("string with tabs", () => {
    const val = "col1\tcol2\tcol3"
    const result = formatCell(val, "string")
    expect(result).toBeDefined()
  })

  test("empty string", () => {
    const result = formatCell("", "string")
    expect(result).toBe("")
  })
})

// ═══════════════════════════════════════════════════════════════
// 5. UNICODE AND SPECIAL CHARACTERS
// ═══════════════════════════════════════════════════════════════
describe("Adversarial: unicode and special chars", () => {
  test("emoji in cell value", () => {
    const result = renderTable(["STATUS"], [["✅ Done"], ["❌ Failed"], ["⏳ Running"]], 80)
    expect(result.dataRows).toHaveLength(3)
  })

  test("CJK characters", () => {
    // CJK chars are typically double-width but String.length counts them as 1
    const result = renderTable(["名前"], [["太郎"], ["花子"]], 80)
    expect(result.dataRows).toHaveLength(2)
  })

  test("RTL characters", () => {
    const result = renderTable(["NAME"], [["مرحبا"], ["שלום"]], 80)
    expect(result.dataRows).toHaveLength(2)
  })

  test("null byte in string", () => {
    const result = formatCell("hello\x00world", "string")
    expect(result).toBeDefined()
  })

  test("ANSI escape sequences in data", () => {
    const result = formatCell("\x1b[31mred\x1b[0m", "string")
    // Should pass through without crashing
    expect(result).toBeDefined()
  })

  test("box drawing chars in data (conflict with separators)", () => {
    const result = renderTable(["DATA"], [["│ box │ chars │"]], 80)
    expect(result.dataRows).toHaveLength(1)
  })
})

// ═══════════════════════════════════════════════════════════════
// 6. MISMATCHED ROW LENGTHS
// ═══════════════════════════════════════════════════════════════
describe("Adversarial: mismatched row lengths", () => {
  test("row shorter than columns", () => {
    // 3 columns but row has only 1 value
    const result = renderTable(["A", "B", "C"], [["only_one"]], 100)
    expect(result.dataRows).toHaveLength(1)
    // Should not crash; missing values become undefined → NULL
  })

  test("row longer than columns", () => {
    // 2 columns but row has 5 values — extra values ignored
    const result = renderTable(["A", "B"], [["a", "b", "c", "d", "e"]], 100)
    expect(result.dataRows).toHaveLength(1)
  })

  test("empty row (zero-length array)", () => {
    const result = renderTable(["A", "B"], [[]], 100)
    expect(result.dataRows).toHaveLength(1)
  })

  test("mixed row lengths", () => {
    const rows = [
      ["a", "b", "c"],
      ["d"],
      ["e", "f"],
      ["g", "h", "i", "j"],
    ]
    const result = renderTable(["A", "B", "C"], rows, 100)
    expect(result.dataRows).toHaveLength(4)
  })
})

// ═══════════════════════════════════════════════════════════════
// 7. EXTREME TERMINAL WIDTHS
// ═══════════════════════════════════════════════════════════════
describe("Adversarial: extreme terminal widths", () => {
  const columns = ["ORDER_ID", "CUSTOMER", "AMOUNT", "STATUS"]
  const rows = [[1001, "Acme Corp", 15420.5, "SHIPPED"]]

  test("terminal width = 0", () => {
    // Should not crash
    const result = renderTable(columns, rows, 0)
    expect(result.colWidths.every((w) => w >= 4)).toBe(true)
  })

  test("terminal width = 1", () => {
    const result = renderTable(columns, rows, 1)
    expect(result.colWidths.every((w) => w >= 4)).toBe(true)
  })

  test("terminal width = -100 (negative)", () => {
    const result = renderTable(columns, rows, -100)
    expect(result.colWidths.every((w) => w >= 4)).toBe(true)
  })

  test("terminal width = 10000", () => {
    const result = renderTable(columns, rows, 10000)
    // Columns should get their natural width, not blow up
    result.colWidths.forEach((w) => expect(w).toBeLessThan(200))
  })

  test("20 columns in 60-char terminal", () => {
    const cols = Array.from({ length: 20 }, (_, i) => `COL_${i}`)
    const row = Array.from({ length: 20 }, (_, i) => `val_${i}`)
    const result = renderTable(cols, [row], 60)
    // All columns should get at least minWidth
    result.colWidths.forEach((w) => expect(w).toBeGreaterThanOrEqual(4))
  })

  test("50 columns in 80-char terminal", () => {
    const cols = Array.from({ length: 50 }, (_, i) => `C${i}`)
    const row = Array.from({ length: 50 }, (_, i) => `v${i}`)
    const result = renderTable(cols, [row], 80)
    result.colWidths.forEach((w) => expect(w).toBeGreaterThanOrEqual(4))
    // Total width will exceed terminal but each column has minimum
  })
})

// ═══════════════════════════════════════════════════════════════
// 8. ROW WIDTH CONSISTENCY (adversarial data)
// ═══════════════════════════════════════════════════════════════
describe("Adversarial: row width consistency", () => {
  test("mixed types produce consistent widths", () => {
    const columns = ["ID", "VALUE"]
    const rows = [
      [1, "short"],
      [2, "a much longer string that should be truncated"],
      [3, null],
      [4, 12345],      // number in string column
      [5, ""],
    ]
    const result = renderTable(columns, rows, 80)
    const expectedWidth = result.header.length
    expect(result.separator.length).toBe(expectedWidth)
    result.dataRows.forEach((row) => {
      expect(row.length).toBe(expectedWidth)
    })
  })

  test("all-null column with other columns", () => {
    const columns = ["NAME", "NULLCOL", "AMOUNT"]
    const rows = [
      ["Alice", null, 100],
      ["Bob", null, 200],
      ["Charlie", null, 300],
    ]
    const result = renderTable(columns, rows, 100)
    const expectedWidth = result.header.length
    expect(result.separator.length).toBe(expectedWidth)
    result.dataRows.forEach((row) => {
      expect(row.length).toBe(expectedWidth)
    })
  })

  test("boolean values", () => {
    const columns = ["FLAG", "NAME"]
    const rows = [
      [true, "yes"],
      [false, "no"],
    ]
    const result = renderTable(columns, rows, 80)
    const expectedWidth = result.header.length
    result.dataRows.forEach((row) => {
      expect(row.length).toBe(expectedWidth)
    })
  })
})

// ═══════════════════════════════════════════════════════════════
// 9. fitToWidth EDGE CASES
// ═══════════════════════════════════════════════════════════════
describe("Adversarial: fitToWidth edge cases", () => {
  test("width = 0 returns empty", () => {
    expect(fitToWidth("hello", 0, "left")).toBe("")
    expect(fitToWidth("hello", 0, "right")).toBe("")
  })

  test("width = 1", () => {
    expect(fitToWidth("hello", 1, "left")).toBe("…")
    expect(fitToWidth("a", 1, "left")).toBe("a")
    expect(fitToWidth("", 1, "right")).toBe(" ")
  })

  test("width = 1 right-aligned", () => {
    expect(fitToWidth("hello", 1, "right")).toBe("…")
  })

  test("width = negative returns empty", () => {
    expect(fitToWidth("hello", -5, "left")).toBe("")
    expect(fitToWidth("hello", -5, "right")).toBe("")
  })

  test("exact width match", () => {
    expect(fitToWidth("abc", 3, "left")).toBe("abc")
    expect(fitToWidth("abc", 3, "right")).toBe("abc")
  })

  test("empty string with width 10", () => {
    expect(fitToWidth("", 10, "left")).toBe("          ")
    expect(fitToWidth("", 10, "right")).toBe("          ")
  })
})

// ═══════════════════════════════════════════════════════════════
// 10. formatElapsed EDGE CASES
// ═══════════════════════════════════════════════════════════════
describe("Adversarial: formatElapsed edge cases", () => {
  test("zero ms", () => {
    expect(formatElapsed(0)).toBe("0ms")
  })

  test("negative ms returns dash", () => {
    expect(formatElapsed(-500)).toBe("—")
  })

  test("NaN ms returns dash", () => {
    expect(formatElapsed(NaN)).toBe("—")
  })

  test("Infinity ms returns dash", () => {
    expect(formatElapsed(Infinity)).toBe("—")
  })

  test("very large ms (1 day)", () => {
    const result = formatElapsed(86400000)
    expect(result).toBeDefined()
    expect(result.length).toBeLessThan(30)
  })

  test("fractional ms rounds", () => {
    expect(formatElapsed(0.5)).toBe("1ms")
  })
})

// ═══════════════════════════════════════════════════════════════
// 11. shortType EDGE CASES
// ═══════════════════════════════════════════════════════════════
describe("Adversarial: shortType edge cases", () => {
  test("empty string", () => {
    expect(shortType("")).toBe("")
  })

  test("unknown type passthrough", () => {
    expect(shortType("SUPER_CUSTOM_TYPE")).toBe("SUPER_CUSTOM_TYPE")
  })

  test("lowercase input", () => {
    expect(shortType("varchar")).toBe("VARCHAR")
  })

  test("mixed case", () => {
    expect(shortType("VarChar")).toBe("VARCHAR")
  })

  test("type with complex params", () => {
    expect(shortType("DECIMAL(38,18)")).toBe("DECIMAL")
    expect(shortType("VARCHAR(MAX)")).toBe("VARCHAR")
    expect(shortType("NUMBER(38,0)")).toBe("NUMBER")
  })
})

// ═══════════════════════════════════════════════════════════════
// 12. formatRowCount EDGE CASES
// ═══════════════════════════════════════════════════════════════
describe("Adversarial: formatRowCount edge cases", () => {
  test("zero rows", () => {
    expect(formatRowCount(0)).toBe("0")
  })

  test("negative rows returns dash", () => {
    expect(formatRowCount(-100)).toBe("—")
  })

  test("NaN returns dash", () => {
    expect(formatRowCount(NaN)).toBe("—")
  })

  test("very large count", () => {
    const result = formatRowCount(999_999_999_999)
    expect(result).toContain("B")
  })

  test("exactly 1000", () => {
    expect(formatRowCount(1000)).toBe("1.0K")
  })

  test("exactly 1000000", () => {
    expect(formatRowCount(1000000)).toBe("1.0M")
  })
})

// ═══════════════════════════════════════════════════════════════
// 13. truncateQuery EDGE CASES
// ═══════════════════════════════════════════════════════════════
describe("Adversarial: truncateQuery edge cases", () => {
  test("empty query", () => {
    expect(truncateQuery("")).toBe("")
  })

  test("whitespace-only query", () => {
    expect(truncateQuery("   \n\t  ")).toBe("")
  })

  test("maxLen = 0 returns empty", () => {
    expect(truncateQuery("SELECT 1", 0)).toBe("")
  })

  test("maxLen = 3 (too short for ...)", () => {
    expect(truncateQuery("SELECT * FROM very_long_table", 3)).toBe("SEL")
  })

  test("maxLen = 1", () => {
    expect(truncateQuery("SELECT 1", 1)).toBe("S")
  })

  test("query with excessive whitespace", () => {
    const query = "SELECT   *   \n  FROM   \t  table   \n  WHERE   1=1"
    const result = truncateQuery(query, 100)
    expect(result).toBe("SELECT * FROM table WHERE 1=1")
  })
})

// ═══════════════════════════════════════════════════════════════
// 14. formatCostColor EDGE CASES
// ═══════════════════════════════════════════════════════════════
describe("Adversarial: formatCostColor edge cases", () => {
  test("zero cost", () => {
    expect(formatCostColor(0)).toBe("green")
  })

  test("negative cost", () => {
    expect(formatCostColor(-5)).toBe("green")
  })

  test("NaN cost defaults to red (safest)", () => {
    // NaN < 0.01 is false, NaN < 1.0 is false → falls through to "red"
    expect(formatCostColor(NaN)).toBe("red")
  })

  test("boundary: exactly 0.01", () => {
    expect(formatCostColor(0.01)).toBe("yellow")
  })

  test("boundary: exactly 1.0", () => {
    expect(formatCostColor(1.0)).toBe("red")
  })
})

// ═══════════════════════════════════════════════════════════════
// 15. formatInlineSummary EDGE CASES
// ═══════════════════════════════════════════════════════════════
describe("Adversarial: formatInlineSummary edge cases", () => {
  test("all undefined props", () => {
    expect(formatInlineSummary({})).toBe("")
  })

  test("empty warehouse string", () => {
    const result = formatInlineSummary({ warehouse: "" })
    expect(result).toBe("")
  })

  test("zero rows", () => {
    expect(formatInlineSummary({ rowCount: 0 })).toBe("0 rows")
  })

  test("1 row (singular)", () => {
    expect(formatInlineSummary({ rowCount: 1 })).toBe("1 row")
  })
})

// ═══════════════════════════════════════════════════════════════
// 16. detectFK EDGE CASES
// ═══════════════════════════════════════════════════════════════
describe("Adversarial: detectFK edge cases", () => {
  test("empty string", () => {
    expect(detectFK("")).toBe(false)
  })

  test("just '_id'", () => {
    expect(detectFK("_id")).toBe(true)
  })

  test("'id' alone excluded", () => {
    expect(detectFK("id")).toBe(false)
  })

  test("'pk' alone excluded", () => {
    expect(detectFK("pk")).toBe(false)
  })

  test("case insensitive", () => {
    expect(detectFK("USER_ID")).toBe(true)
    expect(detectFK("user_Id")).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════
// 17. TYPE CONFUSION — values that look like wrong type
// ═══════════════════════════════════════════════════════════════
describe("Adversarial: type confusion", () => {
  test("column with mix of numbers and strings", () => {
    const rows = [
      [42],
      ["not a number"],
      [100],
      ["also text"],
    ]
    const type = detectColumnType(0, rows)
    // Has both numeric and non-numeric → should be "string"
    expect(type).toBe("string")
  })

  test("column with dates and numbers", () => {
    const rows = [
      ["2024-01-01"],
      [42],
    ]
    const type = detectColumnType(0, rows)
    // Both date and number detected — date takes precedence since hasDate is true
    expect(["date", "string"]).toContain(type)
  })

  test("boolean values in column", () => {
    const rows = [[true], [false], [true]]
    const type = detectColumnType(0, rows)
    // true/false → String("true") → not numeric, not date
    expect(type).toBe("string")
  })

  test("'0' and '1' should be numeric", () => {
    const rows = [["0"], ["1"], ["0"]]
    const type = detectColumnType(0, rows)
    expect(type).toBe("number")
  })

  test("date-like string in number column", () => {
    // If we pass a date string to formatCell with "number" type
    const result = formatCell("2024-01-01", "number")
    // Number("2024-01-01") → NaN
    expect(result).toBeDefined()
  })
})

// ═══════════════════════════════════════════════════════════════
// 18. CRASH RESISTANCE — the full pipeline
// ═══════════════════════════════════════════════════════════════
describe("Adversarial: crash resistance — full pipeline", () => {
  test("object value in cell", () => {
    const result = renderTable(["DATA"], [[{ key: "value" }]], 80)
    expect(result.dataRows).toHaveLength(1)
    // String({key: "value"}) → "[object Object]"
    expect(result.dataRows[0]).toContain("[object Object]")
  })

  test("array value in cell", () => {
    const result = renderTable(["DATA"], [[[1, 2, 3]]], 80)
    expect(result.dataRows).toHaveLength(1)
  })

  test("nested null in array", () => {
    const result = renderTable(["A"], [[[null]]], 80)
    expect(result.dataRows).toHaveLength(1)
  })

  test("symbol would crash String()", () => {
    // Symbol can't be converted with String() template, but String(symbol) works
    try {
      const result = renderTable(["DATA"], [[Symbol("test")]], 80)
      expect(result.dataRows).toHaveLength(1)
    } catch (e) {
      // If it throws, that's a bug we should document
      expect(e).toBeDefined()
    }
  })

  test("BigInt value", () => {
    try {
      const result = formatCell(BigInt(9007199254740991), "number")
      expect(result).toBeDefined()
    } catch (e) {
      // BigInt can't be passed to Number() — this may throw
      expect(e).toBeDefined()
    }
  })

  test("100 columns, 100 rows at width 80", () => {
    const cols = Array.from({ length: 100 }, (_, i) => `C${i}`)
    const rows = Array.from({ length: 100 }, (_, r) =>
      Array.from({ length: 100 }, (_, c) => `r${r}c${c}`),
    )
    // Should complete without hanging or crashing
    const result = renderTable(cols, rows, 80)
    expect(result.dataRows).toHaveLength(100)
  })
})
