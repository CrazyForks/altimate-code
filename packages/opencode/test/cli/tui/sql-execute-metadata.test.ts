import { describe, expect, test } from "bun:test"
import {
  detectColumnType,
  formatCell,
  calculateColumnWidths,
  fitToWidth,
} from "../../../src/cli/cmd/tui/util/data-table-utils"
import { elapsedSeverity, formatInlineSummary } from "../../../src/cli/cmd/tui/util/cost-badge-utils"
import { truncateQuery } from "../../../src/cli/cmd/tui/util/query-progress-utils"
import { shortType, detectFK, formatRowCount } from "../../../src/cli/cmd/tui/util/schema-preview-utils"

/**
 * Integration tests that verify the complete data flow from tool metadata
 * through formatting utilities, simulating what the TUI components would do.
 */

// ---------------------------------------------------------------------------
// SQL Execute result rendering pipeline
// ---------------------------------------------------------------------------

describe("SQL Execute rendering pipeline", () => {
  const sampleMetadata = {
    rowCount: 42,
    truncated: false,
    columns: ["id", "name", "email", "amount", "created_at"],
    rows: [
      [1, "Alice Johnson", "alice@example.com", 99.99, "2024-01-15"],
      [2, "Bob Smith", "bob@example.com", 150.0, "2024-02-20"],
      [3, null, "charlie@example.com", null, "2024-03-25"],
    ],
    elapsedMs: 1234,
    warehouse: "COMPUTE_WH",
  }

  test("detects column types correctly from metadata", () => {
    const types = sampleMetadata.columns.map((_, i) => detectColumnType(i, sampleMetadata.rows))
    expect(types[0]).toBe("number") // id
    expect(types[1]).toBe("string") // name (has null + strings)
    expect(types[2]).toBe("string") // email
    expect(types[3]).toBe("number") // amount (has null + numbers)
    expect(types[4]).toBe("date") // created_at
  })

  test("formats cells correctly for each type", () => {
    expect(formatCell(1, "number")).toBe("1")
    expect(formatCell("Alice Johnson", "string")).toBe("Alice Johnson")
    expect(formatCell(null, "string")).toBe("NULL")
    expect(formatCell(99.99, "number")).toContain("99.99")
    expect(formatCell("2024-01-15", "date")).toBe("2024-01-15")
  })

  test("calculates column widths for standard terminal", () => {
    const types = sampleMetadata.columns.map((_, i) =>
      detectColumnType(i, sampleMetadata.rows),
    ) as Array<"number" | "date" | "null" | "string">
    const widths = calculateColumnWidths(sampleMetadata.columns, sampleMetadata.rows, 80, types)
    expect(widths.length).toBe(5)
    widths.forEach((w) => expect(w).toBeGreaterThanOrEqual(4))
  })

  test("generates correct cost badge summary", () => {
    const summary = formatInlineSummary({
      rowCount: sampleMetadata.rowCount,
      elapsedMs: sampleMetadata.elapsedMs,
      truncated: sampleMetadata.truncated,
      warehouse: sampleMetadata.warehouse,
    })
    expect(summary).toContain("42 rows")
    expect(summary).toContain("1.2s")
    expect(summary).toContain("COMPUTE_WH")
    expect(summary).not.toContain("truncated")
  })

  test("determines correct severity for 1.2s query", () => {
    expect(elapsedSeverity(1234)).toBe("normal")
  })
})

// ---------------------------------------------------------------------------
// Schema Inspect rendering pipeline
// ---------------------------------------------------------------------------

describe("Schema Inspect rendering pipeline", () => {
  const sampleSchemaMetadata = {
    columnCount: 5,
    rowCount: 1200000,
    tableName: "orders",
    schemaName: "public",
    columns: [
      { name: "order_id", data_type: "INTEGER", nullable: false, primary_key: true },
      { name: "customer_id", data_type: "INTEGER", nullable: false, primary_key: false },
      { name: "total", data_type: "DECIMAL(10,2)", nullable: true, primary_key: false },
      { name: "status", data_type: "VARCHAR(50)", nullable: false, primary_key: false },
      { name: "created_at", data_type: "TIMESTAMP WITH TIME ZONE", nullable: false, primary_key: false },
    ],
  }

  test("maps all column types correctly", () => {
    const mapped = sampleSchemaMetadata.columns.map((c) => shortType(c.data_type))
    expect(mapped[0]).toBe("INT")
    expect(mapped[1]).toBe("INT")
    expect(mapped[2]).toBe("DECIMAL")
    expect(mapped[3]).toBe("VARCHAR")
    expect(mapped[4]).toBe("TIMESTAMPTZ")
  })

  test("detects foreign keys correctly", () => {
    const fks = sampleSchemaMetadata.columns.map((c) => detectFK(c.name))
    expect(fks[0]).toBe(true) // order_id - has _id suffix → detected as FK
    expect(fks[1]).toBe(true) // customer_id
    expect(fks[2]).toBe(false) // total
    expect(fks[3]).toBe(false) // status
    expect(fks[4]).toBe(false) // created_at
  })

  test("formats row count correctly", () => {
    expect(formatRowCount(1200000)).toBe("1.2M")
  })
})

// ---------------------------------------------------------------------------
// Edge cases and error conditions
// ---------------------------------------------------------------------------

describe("Edge cases", () => {
  test("handles empty result set", () => {
    const types = [] as Array<"number" | "date" | "null" | "string">
    const widths = calculateColumnWidths([], [], 80, types)
    expect(widths).toEqual([])
  })

  test("handles single row with all nulls", () => {
    const rows = [[null, null, null]]
    const types = ["id", "name", "value"].map((_, i) => detectColumnType(i, rows))
    types.forEach((t) => expect(t).toBe("null"))
  })

  test("handles very long column names", () => {
    const longName = "a_very_long_column_name_that_exceeds_reasonable_display_width_in_terminal"
    const result = fitToWidth(longName, 20, "left")
    expect(result.length).toBe(20)
    expect(result.endsWith("…")).toBe(true)
  })

  test("handles special characters in values", () => {
    expect(formatCell("hello\nworld", "string")).toBe("hello\nworld")
    expect(formatCell("tab\there", "string")).toBe("tab\there")
    expect(formatCell("unicode: ñ é ü", "string")).toBe("unicode: ñ é ü")
  })

  test("truncateQuery handles SQL injection-like patterns safely", () => {
    const query = "SELECT * FROM users WHERE name = 'Robert'; DROP TABLE users;--'"
    const result = truncateQuery(query, 60)
    expect(result.length).toBe(60)
  })

  test("handles extremely large numbers in formatCell", () => {
    const result = formatCell(999999999999, "number")
    expect(result.length).toBeGreaterThan(0)
    expect(result).toContain(",")
  })

  test("handles negative numbers", () => {
    const result = formatCell(-42.5, "number")
    expect(result).toContain("-42.5")
  })
})

// ---------------------------------------------------------------------------
// Screen size matrix tests
// ---------------------------------------------------------------------------

describe("Screen size matrix", () => {
  const widths = [20, 40, 60, 80, 100, 120, 160, 200, 300]
  const columnCounts = [1, 2, 5, 10, 20]

  for (const termWidth of widths) {
    for (const colCount of columnCounts) {
      test(`${colCount} columns at ${termWidth} chars`, () => {
        const columns = Array.from({ length: colCount }, (_, i) => `col_${i}`)
        const rows = [
          Array.from({ length: colCount }, (_, i) => (i % 3 === 0 ? i * 100 : `value_${i}`)),
          Array.from({ length: colCount }, () => null),
        ]
        const types = columns.map((_, i) =>
          detectColumnType(i, rows),
        ) as Array<"number" | "date" | "null" | "string">

        const result = calculateColumnWidths(columns, rows, termWidth, types)

        expect(result.length).toBe(colCount)
        result.forEach((w) => expect(w).toBeGreaterThanOrEqual(4))
      })
    }
  }
})
