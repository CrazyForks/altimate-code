/**
 * Tests for cross-dialect partitioned diff and joindiff cross-warehouse guard.
 *
 * These cover the two CRITICAL/MAJOR bugs fixed in the review follow-up:
 *   1. Partitioned WHERE was built with sourceDialect only and applied to both
 *      warehouses; cross-dialect diffs blew up the target with foreign syntax.
 *   2. Explicit `algorithm: "joindiff"` with different warehouses silently
 *      produced SQL referencing an undefined CTE alias.
 *
 * Both fixes live purely in the TS orchestrator (`runDataDiff` /
 * `runPartitionedDiff`). The Rust engine is mocked so these tests run without
 * the NAPI binary.
 */
import { describe, test, expect, mock, beforeEach } from "bun:test"

// --- Mock NAPI so tests don't require the native binary ---

let lastSpec: any = null
const fakeStartAction = JSON.stringify({
  type: "ExecuteSql",
  tasks: [
    { id: "fp1_1", table_side: "Table1", sql: "SELECT COUNT(*) FROM [__diff_source]", expected_shape: "SingleRow" },
    { id: "fp2_2", table_side: "Table2", sql: "SELECT COUNT(*) FROM [__diff_target]", expected_shape: "SingleRow" },
  ],
})

mock.module("@altimateai/altimate-core", () => ({
  DataParitySession: class {
    constructor(specJson: string) { lastSpec = JSON.parse(specJson) }
    start() { return fakeStartAction }
    step(_responses: string) {
      return JSON.stringify({
        type: "Done",
        outcome: {
          mode: "diff",
          diff_rows: [],
          stats: { rows_table1: 0, rows_table2: 0, exclusive_table1: 0, exclusive_table2: 0, updated: 0, unchanged: 0 },
        },
      })
    }
  },
}))

// --- Mock the Registry module itself so tests can inject fake connectors.
// The real Registry's `get` creates connectors via dynamic driver import; we
// replace the whole surface here with configurable in-memory state. ---

type Rows = (string | null)[][]
const sqlLog: Array<{ warehouse: string; sql: string }> = []
const fakeConfigs = new Map<string, { type: string; [k: string]: any }>()

function makeFakeConnector(warehouseName: string, discoveryRows: Rows = [["2026-04-01"]]) {
  return {
    connect: async () => {},
    close: async () => {},
    execute: async (sql: string) => {
      sqlLog.push({ warehouse: warehouseName, sql })
      if (sql.includes("SELECT DISTINCT")) {
        return { columns: ["_p"], rows: discoveryRows, row_count: discoveryRows.length, truncated: false }
      }
      return { columns: ["c", "h"], rows: [["0", "0"]], row_count: 1, truncated: false }
    },
    listSchemas: async () => [],
    listTables: async () => [],
    describeTable: async () => [],
  }
}

mock.module("../../src/altimate/native/connections/registry", () => ({
  list: () => ({
    warehouses: Array.from(fakeConfigs.entries()).map(([name, cfg]) => ({ name, type: cfg.type })),
  }),
  getConfig: (name: string) => fakeConfigs.get(name),
  setConfigs: (configs: Record<string, any>) => {
    fakeConfigs.clear()
    for (const [k, v] of Object.entries(configs)) fakeConfigs.set(k, v as any)
  },
  get: async (name: string) => makeFakeConnector(name),
  add: async () => ({ success: true, name: "x", type: "x" }),
  remove: async () => ({ success: true, name: "x" }),
  test: async () => ({ success: true, name: "x", status: "connected" }),
}))

// Import after mocks are wired
const Registry = await import("../../src/altimate/native/connections/registry")
const { runDataDiff } = await import("../../src/altimate/native/connections/data-diff")

beforeEach(() => {
  sqlLog.length = 0
  lastSpec = null
})

describe("cross-warehouse joindiff guard", () => {
  test("returns early error when joindiff + cross-warehouse", async () => {
    Registry.setConfigs({
      src: { type: "sqlserver", host: "s1", database: "d" },
      tgt: { type: "postgres", host: "s2", database: "d" },
    })
    const result = await runDataDiff({
      source: "dbo.orders",
      target: "public.orders",
      key_columns: ["id"],
      source_warehouse: "src",
      target_warehouse: "tgt",
      algorithm: "joindiff",
    })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/joindiff requires both tables in the same warehouse/i)
    expect(result.steps).toBe(0)
    // Nothing should have been sent to the warehouses
    expect(sqlLog.length).toBe(0)
  })

  test("same-warehouse joindiff is allowed", async () => {
    Registry.setConfigs({
      shared: { type: "sqlserver", host: "s", database: "d" },
    })
    const result = await runDataDiff({
      source: "dbo.orders",
      target: "dbo.orders_v2",
      key_columns: ["id"],
      source_warehouse: "shared",
      target_warehouse: "shared",
      algorithm: "joindiff",
    })
    expect(result.success).toBe(true)
  })
})

describe("cross-dialect partitioned diff", () => {
  test("source and target receive their own dialect's partition WHERE", async () => {
    Registry.setConfigs({
      msrc: { type: "sqlserver", host: "mssql-host", database: "src" },
      ptgt: { type: "postgres", host: "pg-host", database: "tgt" },
    })
    const result = await runDataDiff({
      source: "dbo.orders",
      target: "public.orders",
      key_columns: ["id"],
      source_warehouse: "msrc",
      target_warehouse: "ptgt",
      partition_column: "order_date",
      partition_granularity: "month",
      algorithm: "hashdiff",
    })
    expect(result.success).toBe(true)

    // Gather SQL by warehouse
    const msrcSql = sqlLog.filter((x) => x.warehouse === "msrc").map((x) => x.sql).join("\n")
    const ptgtSql = sqlLog.filter((x) => x.warehouse === "ptgt").map((x) => x.sql).join("\n")

    // Source (MSSQL) must see T-SQL syntax: DATETRUNC + CONVERT(DATE, ..., 23) + [brackets]
    expect(msrcSql).toMatch(/DATETRUNC\(MONTH,\s*\[order_date\]\)/i)
    expect(msrcSql).toMatch(/CONVERT\(DATE, '2026-04-01', 23\)/i)
    // Source must NOT see Postgres syntax
    expect(msrcSql).not.toMatch(/DATE_TRUNC\('month'/i)
    // Source must never see the Postgres table reference
    expect(msrcSql).not.toContain('"public"."orders"')

    // Target (Postgres) must see DATE_TRUNC + ANSI-quoted identifiers
    expect(ptgtSql).toMatch(/DATE_TRUNC\('month',\s*"order_date"\)/i)
    // Target must NOT see T-SQL syntax
    expect(ptgtSql).not.toMatch(/DATETRUNC/i)
    expect(ptgtSql).not.toMatch(/CONVERT\(DATE/i)
    // Target must never see the MSSQL bracketed reference
    expect(ptgtSql).not.toContain("[dbo].[orders]")
  })
})
