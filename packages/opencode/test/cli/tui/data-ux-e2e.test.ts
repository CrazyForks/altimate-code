import { describe, expect, test } from "bun:test"
import {
  isNumeric,
  isDateLike,
  detectColumnType,
  formatCell,
  calculateColumnWidths,
  fitToWidth,
  formatElapsed,
  type ColumnType,
} from "../../../src/cli/cmd/tui/util/data-table-utils"
import { elapsedSeverity, formatInlineSummary } from "../../../src/cli/cmd/tui/util/cost-badge-utils"
import { formatCostColor, truncateQuery } from "../../../src/cli/cmd/tui/util/query-progress-utils"
import { shortType, detectFK, formatRowCount } from "../../../src/cli/cmd/tui/util/schema-preview-utils"

/**
 * End-to-end tests simulating real warehouse query results flowing through
 * the full formatting pipeline. Each test represents a realistic user scenario
 * that a data engineer would encounter.
 */

// ---------------------------------------------------------------------------
// Helper: render a full text table (simulates what DataTable component does)
// ---------------------------------------------------------------------------

function renderTable(
  columns: string[],
  rows: any[][],
  termWidth: number,
): { header: string; separator: string; dataRows: string[]; footer: string } {
  const colTypes = columns.map((_, i) => detectColumnType(i, rows))
  const colWidths = calculateColumnWidths(columns, rows, termWidth, colTypes)

  const header = columns
    .map((col, i) => {
      const align = colTypes[i] === "number" ? "right" : "left"
      return fitToWidth(col, colWidths[i], align)
    })
    .join(" │ ")

  const separator = colWidths
    .map((w, i) => {
      if (colTypes[i] === "number") return "─".repeat(w - 1) + "┤"
      return "─".repeat(w)
    })
    .join("─┼─")

  const dataRows = rows.map((row) =>
    row
      .map((val, i) => {
        const cellText = formatCell(val, colTypes[i])
        const align = colTypes[i] === "number" ? "right" : "left"
        return fitToWidth(cellText, colWidths[i], align)
      })
      .join(" │ "),
  )

  const rc = rows.length
  const footer = `${rc.toLocaleString()} row${rc !== 1 ? "s" : ""}`

  return { header, separator, dataRows, footer }
}

// ---------------------------------------------------------------------------
// Helper: render a schema preview tree (simulates SchemaPreview component)
// ---------------------------------------------------------------------------

function renderSchemaTree(
  tableName: string,
  schemaName: string | undefined,
  columns: Array<{ name: string; data_type: string; nullable: boolean; primary_key: boolean; description?: string }>,
  rowCount: number | undefined,
): string[] {
  const lines: string[] = []
  const qualified = schemaName ? `${schemaName}.${tableName}` : tableName
  const parts = [qualified]
  if (rowCount !== undefined) parts.push(`${formatRowCount(rowCount)} rows`)
  parts.push(`${columns.length} columns`)
  lines.push(parts.join(" · "))

  columns.forEach((col, i) => {
    const isLast = i === columns.length - 1
    const prefix = isLast ? "└─" : "├─"
    const pk = col.primary_key ? " PK" : ""
    const fk = detectFK(col.name) ? " FK" : ""
    const nullable = col.nullable ? " NULL" : ""
    lines.push(`${prefix} ${col.name}  ${shortType(col.data_type)}${pk}${fk}${nullable}`)
  })

  return lines
}

// ===========================================================================
// E2E SCENARIO 1: Snowflake orders query
// ===========================================================================

describe("E2E: Snowflake orders query", () => {
  const columns = ["ORDER_ID", "CUSTOMER_ID", "ORDER_DATE", "TOTAL_AMOUNT", "STATUS", "WAREHOUSE"]
  const rows = [
    [10001, 42, "2024-01-15 10:30:00", 1299.99, "COMPLETED", "US-EAST"],
    [10002, 87, "2024-01-15 11:45:00", 49.99, "COMPLETED", "EU-WEST"],
    [10003, 42, "2024-01-16 09:00:00", 599.0, "PENDING", "US-EAST"],
    [10004, 156, "2024-01-16 14:20:00", null, "CANCELLED", "APAC"],
    [10005, null, "2024-01-17 08:00:00", 2500.0, "COMPLETED", "US-EAST"],
  ]
  const metadata = {
    rowCount: 5,
    truncated: false,
    elapsedMs: 342,
    warehouse: "COMPUTE_WH_M",
  }

  test("detects column types correctly", () => {
    const types = columns.map((_, i) => detectColumnType(i, rows))
    expect(types).toEqual(["number", "number", "date", "number", "string", "string"])
  })

  test("renders table at 80 char width without crashing", () => {
    const { header, separator, dataRows, footer } = renderTable(columns, rows, 80)
    expect(header.length).toBeGreaterThan(0)
    expect(separator.length).toBeGreaterThan(0)
    expect(dataRows.length).toBe(5)
    expect(footer).toContain("5 rows")

    // All rows should have same visual width
    const headerLen = header.length
    dataRows.forEach((row) => {
      expect(row.length).toBe(headerLen)
    })
  })

  test("renders table at 120 char width", () => {
    const { header, dataRows } = renderTable(columns, rows, 120)
    expect(header.length).toBeGreaterThan(0)
    dataRows.forEach((row) => expect(row.length).toBe(header.length))
  })

  test("renders table at narrow 50 char width", () => {
    const { header, dataRows } = renderTable(columns, rows, 50)
    expect(header.length).toBeGreaterThan(0)
    dataRows.forEach((row) => expect(row.length).toBe(header.length))
  })

  test("NULL values display as NULL", () => {
    const { dataRows } = renderTable(columns, rows, 120)
    // Row 3 (index 3) has null TOTAL_AMOUNT
    expect(dataRows[3]).toContain("NULL")
    // Row 4 (index 4) has null CUSTOMER_ID
    expect(dataRows[4]).toContain("NULL")
  })

  test("numbers are right-aligned", () => {
    const types = columns.map((_, i) => detectColumnType(i, rows))
    const widths = calculateColumnWidths(columns, rows, 120, types)
    // ORDER_ID column (index 0) is number
    const cell = fitToWidth(formatCell(10001, "number"), widths[0], "right")
    // Should have leading spaces
    expect(cell.trimStart().length).toBeLessThan(cell.length)
  })

  test("generates correct cost badge summary", () => {
    const summary = formatInlineSummary(metadata)
    expect(summary).toBe("5 rows · 342ms · COMPUTE_WH_M")
    expect(elapsedSeverity(342)).toBe("fast")
  })
})

// ===========================================================================
// E2E SCENARIO 2: BigQuery analytics — large result with truncation
// ===========================================================================

describe("E2E: BigQuery analytics with truncation", () => {
  const columns = ["event_date", "user_id", "event_type", "page_url", "session_duration_ms", "revenue"]
  const rows = Array.from({ length: 100 }, (_, i) => [
    `2024-0${(i % 3) + 1}-${String((i % 28) + 1).padStart(2, "0")}`,
    1000 + i,
    i % 4 === 0 ? "purchase" : i % 3 === 0 ? "signup" : "pageview",
    `https://example.com/page/${i}`,
    Math.floor(Math.random() * 300000),
    i % 4 === 0 ? (Math.random() * 500).toFixed(2) : null,
  ])
  const metadata = {
    rowCount: 1247892,
    truncated: true,
    elapsedMs: 8723,
    warehouse: "analytics_bq",
  }

  test("handles 100 rows × 6 columns at 80 width", () => {
    const { header, dataRows } = renderTable(columns, rows, 80)
    expect(dataRows.length).toBe(100)
    // All rows same width
    const w = header.length
    dataRows.forEach((row) => expect(row.length).toBe(w))
  })

  test("handles 100 rows × 6 columns at 200 width", () => {
    const { header, dataRows } = renderTable(columns, rows, 200)
    expect(dataRows.length).toBe(100)
    dataRows.forEach((row) => expect(row.length).toBe(header.length))
  })

  test("generates correct truncated summary", () => {
    const summary = formatInlineSummary(metadata)
    expect(summary).toContain("1,247,892 rows")
    expect(summary).toContain("8.7s")
    expect(summary).toContain("truncated")
    expect(summary).toContain("analytics_bq")
    expect(elapsedSeverity(8723)).toBe("normal")
  })

  test("truncateQuery handles multiline BigQuery SQL", () => {
    const sql = `
      SELECT
        event_date,
        user_id,
        event_type,
        page_url,
        session_duration_ms,
        revenue
      FROM \`project.dataset.events\`
      WHERE event_date BETWEEN '2024-01-01' AND '2024-03-31'
        AND revenue IS NOT NULL
      ORDER BY revenue DESC
      LIMIT 100
    `
    const result = truncateQuery(sql, 80)
    expect(result.length).toBe(80)
    expect(result.endsWith("...")).toBe(true)
    // Should be single line with collapsed whitespace
    expect(result).not.toContain("\n")
  })
})

// ===========================================================================
// E2E SCENARIO 3: Snowflake schema inspection — wide table
// ===========================================================================

describe("E2E: Snowflake schema inspection", () => {
  const schemaColumns = [
    { name: "order_id", data_type: "NUMBER(38,0)", nullable: false, primary_key: true },
    { name: "customer_id", data_type: "NUMBER(38,0)", nullable: false, primary_key: false },
    { name: "order_date", data_type: "TIMESTAMP_NTZ", nullable: false, primary_key: false },
    { name: "ship_date", data_type: "TIMESTAMP_NTZ", nullable: true, primary_key: false },
    { name: "total_amount", data_type: "NUMBER(10,2)", nullable: true, primary_key: false },
    { name: "discount_pct", data_type: "FLOAT", nullable: true, primary_key: false },
    { name: "status", data_type: "VARCHAR(50)", nullable: false, primary_key: false },
    { name: "warehouse_id", data_type: "NUMBER(38,0)", nullable: true, primary_key: false },
    { name: "shipping_address", data_type: "VARIANT", nullable: true, primary_key: false },
    { name: "line_items", data_type: "ARRAY", nullable: true, primary_key: false },
    { name: "metadata", data_type: "OBJECT", nullable: true, primary_key: false },
    { name: "created_at", data_type: "TIMESTAMP_TZ", nullable: false, primary_key: false },
    { name: "updated_at", data_type: "TIMESTAMP_TZ", nullable: false, primary_key: false },
  ]

  test("renders schema tree with correct types", () => {
    const lines = renderSchemaTree("orders", "analytics", schemaColumns, 12500000)
    expect(lines[0]).toBe("analytics.orders · 12.5M rows · 13 columns")
    // Check type mappings
    expect(lines[1]).toContain("NUMBER") // order_id
    expect(lines[1]).toContain("PK") // primary key
    expect(lines[3]).toContain("TIMESTAMP") // order_date → TIMESTAMP_NTZ → TIMESTAMP
    expect(lines[9]).toContain("VARIANT") // shipping_address
    expect(lines[10]).toContain("ARRAY") // line_items
    expect(lines[11]).toContain("OBJECT") // metadata
    expect(lines[12]).toContain("TIMESTAMPTZ") // created_at → TIMESTAMP_TZ → TIMESTAMPTZ
  })

  test("detects foreign keys correctly", () => {
    const fks = schemaColumns.map((c) => detectFK(c.name))
    expect(fks[0]).toBe(true) // order_id — has _id suffix
    expect(fks[1]).toBe(true) // customer_id
    expect(fks[4]).toBe(false) // total_amount
    expect(fks[7]).toBe(true) // warehouse_id
    expect(fks[8]).toBe(false) // shipping_address
  })

  test("maps all Snowflake types", () => {
    expect(shortType("NUMBER(38,0)")).toBe("NUMBER")
    expect(shortType("TIMESTAMP_NTZ")).toBe("TIMESTAMP")
    expect(shortType("TIMESTAMP_TZ")).toBe("TIMESTAMPTZ")
    expect(shortType("TIMESTAMP_LTZ")).toBe("TIMESTAMPTZ")
    expect(shortType("VARIANT")).toBe("VARIANT")
    expect(shortType("ARRAY")).toBe("ARRAY")
    expect(shortType("OBJECT")).toBe("OBJECT")
    expect(shortType("VARCHAR(50)")).toBe("VARCHAR")
    expect(shortType("FLOAT")).toBe("FLOAT")
  })

  test("formats row counts at various scales", () => {
    expect(formatRowCount(0)).toBe("0")
    expect(formatRowCount(500)).toBe("500")
    expect(formatRowCount(12500)).toBe("12.5K")
    expect(formatRowCount(12500000)).toBe("12.5M")
    expect(formatRowCount(7800000000)).toBe("7.8B")
  })
})

// ===========================================================================
// E2E SCENARIO 4: PostgreSQL — simple query with all data types
// ===========================================================================

describe("E2E: PostgreSQL mixed data types", () => {
  const columns = ["id", "name", "email", "is_active", "balance", "signup_date", "tags"]
  const rows = [
    [1, "Alice", "alice@corp.com", true, 1234.56, "2023-06-15", '["admin","user"]'],
    [2, "Bob", null, false, 0.0, "2024-01-20", '["user"]'],
    [3, "Charlie", "charlie@corp.com", true, -50.25, "2024-03-01", null],
    [null, null, null, null, null, null, null],
  ]

  test("handles boolean and JSON-like string values", () => {
    const types = columns.map((_, i) => detectColumnType(i, rows))
    expect(types[0]).toBe("number") // id
    expect(types[1]).toBe("string") // name
    expect(types[2]).toBe("string") // email
    expect(types[3]).toBe("string") // is_active (boolean rendered as string in results)
    expect(types[4]).toBe("number") // balance
    expect(types[5]).toBe("date") // signup_date
    expect(types[6]).toBe("string") // tags (JSON string)
  })

  test("renders complete table consistently", () => {
    for (const width of [40, 60, 80, 100, 120, 160]) {
      const { header, separator, dataRows } = renderTable(columns, rows, width)
      // Header and separator same width
      expect(separator.length).toBe(header.length)
      // All data rows same width as header
      dataRows.forEach((row, i) => {
        expect(row.length).toBe(header.length)
      })
    }
  })

  test("all-null row renders correctly", () => {
    const { dataRows } = renderTable(columns, rows, 120)
    const nullRow = dataRows[3]
    // Should contain multiple NULL values
    const nullCount = (nullRow.match(/NULL/g) || []).length
    expect(nullCount).toBe(7) // all 7 columns
  })

  test("negative numbers format correctly", () => {
    const formatted = formatCell(-50.25, "number")
    expect(formatted).toContain("-50.25")
  })
})

// ===========================================================================
// E2E SCENARIO 5: Databricks — very wide result set
// ===========================================================================

describe("E2E: Databricks wide result (30 columns)", () => {
  const columns = Array.from({ length: 30 }, (_, i) => `metric_${String(i).padStart(2, "0")}`)
  const rows = Array.from({ length: 10 }, () =>
    Array.from({ length: 30 }, () => Math.round(Math.random() * 10000) / 100),
  )

  test("renders without crashing at 80 width", () => {
    const { header, dataRows } = renderTable(columns, rows, 80)
    expect(header.length).toBeGreaterThan(0)
    expect(dataRows.length).toBe(10)
    // All rows same width
    dataRows.forEach((row) => expect(row.length).toBe(header.length))
  })

  test("renders without crashing at 200 width", () => {
    const { header, dataRows } = renderTable(columns, rows, 200)
    expect(header.length).toBeGreaterThan(0)
    dataRows.forEach((row) => expect(row.length).toBe(header.length))
  })

  test("renders without crashing at tiny 30 width", () => {
    const { header, dataRows } = renderTable(columns, rows, 30)
    expect(header.length).toBeGreaterThan(0)
    dataRows.forEach((row) => expect(row.length).toBe(header.length))
  })

  test("all columns get minimum 4 char width", () => {
    const types = columns.map((_, i) => detectColumnType(i, rows))
    const widths = calculateColumnWidths(columns, rows, 80, types)
    widths.forEach((w) => expect(w).toBeGreaterThanOrEqual(4))
  })
})

// ===========================================================================
// E2E SCENARIO 6: DuckDB — empty result and single row
// ===========================================================================

describe("E2E: DuckDB edge cases", () => {
  test("empty result set", () => {
    const { header, dataRows } = renderTable(["id", "name"], [], 80)
    expect(header.length).toBeGreaterThan(0)
    expect(dataRows.length).toBe(0)
  })

  test("single row result", () => {
    const { header, dataRows, footer } = renderTable(["count"], [[42]], 80)
    expect(dataRows.length).toBe(1)
    expect(footer).toContain("1 row")
    // Note: singular "row" not "rows"
    expect(footer).not.toContain("rows")
  })

  test("single column result", () => {
    const { header, dataRows } = renderTable(["total"], [[100], [200], [300]], 80)
    expect(dataRows.length).toBe(3)
    // With right alignment for numbers
    const widths = calculateColumnWidths(["total"], [[100], [200], [300]], 80, ["number"])
    expect(widths.length).toBe(1)
  })

  test("fast DuckDB query badge", () => {
    const summary = formatInlineSummary({
      rowCount: 1,
      elapsedMs: 3,
    })
    expect(summary).toBe("1 row · 3ms")
    expect(elapsedSeverity(3)).toBe("fast")
  })
})

// ===========================================================================
// E2E SCENARIO 7: Redshift — slow query with cost concerns
// ===========================================================================

describe("E2E: Redshift slow query scenario", () => {
  test("slow query with high cost markers", () => {
    const summary = formatInlineSummary({
      rowCount: 50000,
      elapsedMs: 127000,
      truncated: true,
      warehouse: "REDSHIFT_PROD",
    })
    expect(summary).toContain("50,000 rows")
    expect(summary).toContain("2m7s")
    expect(summary).toContain("truncated")
    expect(summary).toContain("REDSHIFT_PROD")
    expect(elapsedSeverity(127000)).toBe("slow")
  })

  test("cost color thresholds reflect FinOps concerns", () => {
    // Free tier query
    expect(formatCostColor(0)).toBe("green")
    // Small cost
    expect(formatCostColor(0.005)).toBe("green")
    // Noticeable cost
    expect(formatCostColor(0.15)).toBe("yellow")
    // Expensive query
    expect(formatCostColor(5.0)).toBe("red")
    // Very expensive
    expect(formatCostColor(50.0)).toBe("red")
  })
})

// ===========================================================================
// E2E SCENARIO 8: Schema types across all supported warehouses
// ===========================================================================

describe("E2E: Cross-warehouse type mapping", () => {
  const testCases: Array<[string, string, string]> = [
    // [warehouse, input_type, expected_short]
    // Snowflake
    ["Snowflake", "NUMBER(38,0)", "NUMBER"],
    ["Snowflake", "VARCHAR(16777216)", "VARCHAR"],
    ["Snowflake", "TIMESTAMP_NTZ", "TIMESTAMP"],
    ["Snowflake", "TIMESTAMP_LTZ", "TIMESTAMPTZ"],
    ["Snowflake", "VARIANT", "VARIANT"],
    // BigQuery
    ["BigQuery", "INT64", "INT64"], // unknown → pass through
    ["BigQuery", "FLOAT64", "FLOAT64"], // unknown → pass through
    ["BigQuery", "BOOLEAN", "BOOL"],
    ["BigQuery", "TIMESTAMP", "TIMESTAMP"],
    ["BigQuery", "DATE", "DATE"],
    ["BigQuery", "JSON", "JSON"],
    // PostgreSQL
    ["PostgreSQL", "integer", "INT"],
    ["PostgreSQL", "bigint", "BIGINT"],
    ["PostgreSQL", "boolean", "BOOL"],
    ["PostgreSQL", "character varying", "VARCHAR"],
    ["PostgreSQL", "timestamp with time zone", "TIMESTAMPTZ"],
    ["PostgreSQL", "timestamp without time zone", "TIMESTAMP"],
    ["PostgreSQL", "jsonb", "JSONB"],
    ["PostgreSQL", "bytea", "BINARY"],
    ["PostgreSQL", "uuid", "UUID"],
    // MySQL
    ["MySQL", "INT", "INT"],
    ["MySQL", "VARCHAR", "VARCHAR"],
    ["MySQL", "DECIMAL", "DECIMAL"],
    ["MySQL", "DOUBLE", "DOUBLE"],
    ["MySQL", "BOOLEAN", "BOOL"],
    // Redshift
    ["Redshift", "INT4", "INT"],
    ["Redshift", "INT8", "BIGINT"],
    ["Redshift", "INT2", "SMALLINT"],
    ["Redshift", "FLOAT4", "FLOAT"],
    ["Redshift", "FLOAT8", "DOUBLE"],
  ]

  for (const [warehouse, inputType, expected] of testCases) {
    test(`${warehouse}: ${inputType} → ${expected}`, () => {
      expect(shortType(inputType)).toBe(expected)
    })
  }
})

// ===========================================================================
// E2E SCENARIO 9: Consistent row width across all screen sizes
// ===========================================================================

describe("E2E: Row width consistency guarantee", () => {
  const scenarios = [
    {
      name: "2 cols × 3 rows",
      columns: ["id", "name"],
      rows: [
        [1, "Alice"],
        [2, "Bob"],
        [3, "Charlie"],
      ],
    },
    {
      name: "5 cols mixed types",
      columns: ["id", "name", "amount", "date", "active"],
      rows: [
        [1, "Alice", 99.99, "2024-01-15", "true"],
        [null, null, null, null, null],
      ],
    },
    {
      name: "10 cols all numbers",
      columns: Array.from({ length: 10 }, (_, i) => `m${i}`),
      rows: [Array.from({ length: 10 }, (_, i) => i * 100)],
    },
    {
      name: "1 col 50 rows",
      columns: ["value"],
      rows: Array.from({ length: 50 }, (_, i) => [i]),
    },
  ]

  const widths = [30, 40, 50, 60, 80, 100, 120, 160, 200, 250]

  for (const scenario of scenarios) {
    for (const w of widths) {
      test(`${scenario.name} at ${w} chars`, () => {
        const { header, separator, dataRows } = renderTable(scenario.columns, scenario.rows, w)

        // CRITICAL: All lines must have identical width
        const expectedWidth = header.length
        expect(separator.length).toBe(expectedWidth)
        dataRows.forEach((row, i) => {
          expect(row.length).toBe(expectedWidth)
        })
      })
    }
  }
})

// ===========================================================================
// E2E SCENARIO 10: Full tool metadata → display pipeline
// ===========================================================================

describe("E2E: Full metadata pipeline simulation", () => {
  test("sql_execute tool → table + badge", () => {
    // Simulate what happens when sql_execute returns
    const toolMetadata = {
      rowCount: 42,
      truncated: false,
      columns: ["id", "name", "amount"],
      rows: [
        [1, "Widget A", 29.99],
        [2, "Widget B", 49.99],
      ],
      elapsedMs: 156,
      warehouse: "DEV_WH",
    }

    // 1. Table renders correctly
    const { header, dataRows } = renderTable(toolMetadata.columns, toolMetadata.rows, 80)
    expect(header).toContain("id")
    expect(header).toContain("name")
    expect(header).toContain("amount")
    expect(dataRows.length).toBe(2)

    // 2. Badge renders correctly
    const badge = formatInlineSummary({
      rowCount: toolMetadata.rowCount,
      elapsedMs: toolMetadata.elapsedMs,
      warehouse: toolMetadata.warehouse,
    })
    expect(badge).toBe("42 rows · 156ms · DEV_WH")

    // 3. Severity is fast
    expect(elapsedSeverity(toolMetadata.elapsedMs)).toBe("fast")
  })

  test("schema_inspect tool → tree preview", () => {
    const toolMetadata = {
      columnCount: 3,
      rowCount: 50000,
      tableName: "users",
      schemaName: "public",
      columns: [
        { name: "id", data_type: "INTEGER", nullable: false, primary_key: true },
        { name: "email", data_type: "VARCHAR(255)", nullable: false, primary_key: false },
        { name: "created_at", data_type: "TIMESTAMP WITH TIME ZONE", nullable: false, primary_key: false },
      ],
    }

    const lines = renderSchemaTree(
      toolMetadata.tableName,
      toolMetadata.schemaName,
      toolMetadata.columns,
      toolMetadata.rowCount,
    )

    expect(lines[0]).toBe("public.users · 50.0K rows · 3 columns")
    expect(lines[1]).toContain("id")
    expect(lines[1]).toContain("INT")
    expect(lines[1]).toContain("PK")
    expect(lines[2]).toContain("email")
    expect(lines[2]).toContain("VARCHAR")
    expect(lines[3]).toContain("created_at")
    expect(lines[3]).toContain("TIMESTAMPTZ")
  })
})
