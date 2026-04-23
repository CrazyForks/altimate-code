/**
 * FinOps Integration Tests — BigQuery
 *
 * Tests query execution and response shape for all finops functions against
 * real BigQuery INFORMATION_SCHEMA views. Skips if ALTIMATE_CODE_CONN_BIGQUERY_TEST
 * is not set. Requires the service account to have
 * `bigquery.jobs.listAll` (roles/bigquery.resourceAdmin or
 * roles/bigquery.jobUser + INFORMATION_SCHEMA view) in the target region.
 *
 * Tests accept success OR a graceful permission error — the goal is to verify
 * the SQL is valid (no "Unrecognized name" errors), binds are correct, and the
 * response has the right shape. This catches regressions like the
 * `error_message` / `total_rows` column typos that shipped in v0.5.21.
 *
 * Run:
 *   export ALTIMATE_CODE_CONN_BIGQUERY_TEST='{"type":"bigquery","project":"your-project","credentials_path":"/absolute/path/to/key.json","location":"us"}'
 *   bun test test/altimate/finops-bigquery-e2e.test.ts --timeout 120000
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test"

process.env.ALTIMATE_TELEMETRY_DISABLED = "true"

import * as Registry from "../../src/altimate/native/connections/registry"
import { getQueryHistory } from "../../src/altimate/native/finops/query-history"
import { analyzeCredits, getExpensiveQueries } from "../../src/altimate/native/finops/credit-analyzer"
import { adviseWarehouse } from "../../src/altimate/native/finops/warehouse-advisor"

const BQ_CONFIG = process.env.ALTIMATE_CODE_CONN_BIGQUERY_TEST
const HAS_BIGQUERY = !!BQ_CONFIG
const WH = "bigquery_finops_e2e"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Accept success OR a graceful error (permission / region mismatch / no jobs
 * in window). The key invariant: no SQL parse errors — those indicate a
 * template regression and must fail the test.
 */
function expectValidResult(result: { success: boolean; error?: string }) {
  if (!result.success) {
    expect(result.error).toBeDefined()
    expect(typeof result.error).toBe("string")
    // SQL parse errors from BQ should never occur — they mean the template is broken
    expect(result.error).not.toMatch(/Unrecognized name|Syntax error|unbound|invalid identifier/i)
  }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_BIGQUERY)("BigQuery FinOps Integration", () => {
  beforeAll(async () => {
    Registry.reset()
    Registry.setConfigs({ [WH]: JSON.parse(BQ_CONFIG!) })
  }, 30000)

  afterAll(() => {
    Registry.reset()
  })

  // -------------------------------------------------------------------------
  // Query History — the main regression surface
  // -------------------------------------------------------------------------
  describe("query_history", () => {
    let result: Awaited<ReturnType<typeof getQueryHistory>>

    beforeAll(async () => {
      result = await getQueryHistory({ warehouse: WH, days: 7, limit: 10 })
    }, 60000)

    test("returns valid shape (no SQL parse errors)", () => {
      expectValidResult(result)
      if (result.success) {
        expect(Array.isArray(result.queries)).toBe(true)
        expect(typeof result.summary).toBe("object")
        expect(typeof result.summary.query_count).toBe("number")
        expect(result.warehouse_type).toBe("bigquery")
      }
    })

    test("respects limit parameter", () => {
      if (result.success) {
        expect(result.queries.length).toBeLessThanOrEqual(10)
      }
    })

    test("query rows have expected columns when data exists", () => {
      if (result.success && result.queries.length > 0) {
        const row = result.queries[0]
        expect(row).toHaveProperty("query_id")
        expect(row).toHaveProperty("query_text")
        expect(row).toHaveProperty("execution_status")
        expect(row).toHaveProperty("execution_time_sec")
        // The regression columns — they must exist and be accessible even if NULL
        expect(row).toHaveProperty("error_message")
        expect(row).toHaveProperty("error_code")
        expect(row).toHaveProperty("rows_produced")
      }
    })

    test("execution_status is derived correctly (never contains 'DONE')", () => {
      // BQ's raw `state` column returns 'DONE' for every finished job. Our template
      // maps error_result IS NULL → 'SUCCESS' / 'FAILED' so the summary error
      // count in getQueryHistory() works. A row reading 'DONE' means the mapping
      // regressed back to a bare `state as execution_status`.
      if (result.success && result.queries.length > 0) {
        for (const row of result.queries) {
          expect(row.execution_status).not.toBe("DONE")
          expect(["SUCCESS", "FAILED"]).toContain(String(row.execution_status))
        }
      }
    })

    test("summary error_count uses the derived status (SUCCESS vs FAILED)", () => {
      if (result.success) {
        // error_count is computed from rows where execution_status !== 'SUCCESS';
        // if the mapping is wrong, every row would read as FAILED and the count
        // would equal queries.length.
        const errCount = Number(result.summary.error_count ?? 0)
        expect(errCount).toBeLessThanOrEqual(result.queries.length)
      }
    })
  })

  // -------------------------------------------------------------------------
  // Credit / Cost Analysis — BQ templates share the same region qualifier bug
  // surface as query history.
  // -------------------------------------------------------------------------
  describe("credit_analyzer", () => {
    let creditsResult: Awaited<ReturnType<typeof analyzeCredits>>
    let expensiveResult: Awaited<ReturnType<typeof getExpensiveQueries>>

    beforeAll(async () => {
      ;[creditsResult, expensiveResult] = await Promise.all([
        analyzeCredits({ warehouse: WH, days: 14, limit: 10 }),
        getExpensiveQueries({ warehouse: WH, days: 14, limit: 10 }),
      ])
    }, 60000)

    test("analyzeCredits returns valid shape (no SQL parse errors)", () => {
      expectValidResult(creditsResult)
      if (creditsResult.success) {
        expect(Array.isArray(creditsResult.daily_usage)).toBe(true)
        expect(Array.isArray(creditsResult.warehouse_summary)).toBe(true)
        expect(typeof creditsResult.total_credits).toBe("number")
        expect(creditsResult.days_analyzed).toBe(14)
        expect(Array.isArray(creditsResult.recommendations)).toBe(true)
      }
    })

    test("getExpensiveQueries returns valid shape (no SQL parse errors)", () => {
      expectValidResult(expensiveResult)
      if (expensiveResult.success) {
        expect(Array.isArray(expensiveResult.queries)).toBe(true)
        expect(typeof expensiveResult.query_count).toBe("number")
        expect(expensiveResult.days_analyzed).toBe(14)
      }
    })

    test("expensive query rows have expected columns when data exists", () => {
      if (expensiveResult.success && expensiveResult.queries.length > 0) {
        const row = expensiveResult.queries[0]
        expect(row).toHaveProperty("query_id")
        expect(row).toHaveProperty("query_preview")
        expect(row).toHaveProperty("execution_time_sec")
        expect(row).toHaveProperty("bytes_scanned")
      }
    })
  })

  // -------------------------------------------------------------------------
  // Warehouse Advisor — BQ uses JOBS_TIMELINE + JOBS, both region-qualified.
  // -------------------------------------------------------------------------
  describe("warehouse_advisor", () => {
    let result: Awaited<ReturnType<typeof adviseWarehouse>>

    beforeAll(async () => {
      result = await adviseWarehouse({ warehouse: WH, days: 14 })
    }, 60000)

    test("returns valid shape (no SQL parse errors)", () => {
      expectValidResult(result)
      if (result.success) {
        expect(Array.isArray(result.warehouse_load)).toBe(true)
        expect(Array.isArray(result.warehouse_performance)).toBe(true)
        expect(Array.isArray(result.recommendations)).toBe(true)
        expect(result.days_analyzed).toBe(14)
      }
    })
  })

  // -------------------------------------------------------------------------
  // Region sanity — tolerate a bogus region by surfacing a graceful error
  // rather than crashing. Supports the multi-region story.
  // -------------------------------------------------------------------------
  describe("region handling", () => {
    const BAD_REGION_WH = "bigquery_bad_region"

    beforeAll(() => {
      const baseConfig = JSON.parse(BQ_CONFIG!)
      Registry.setConfigs({
        [WH]: baseConfig,
        [BAD_REGION_WH]: { ...baseConfig, location: "mars-central99" },
      })
    })

    test("invalid region returns graceful error, not an unhandled crash", async () => {
      const r = await getQueryHistory({ warehouse: BAD_REGION_WH, days: 1, limit: 1 })
      // Either the dataset-not-found error (graceful) or success (if BQ is
      // tolerant) — both are fine. The key is: no unhandled throw.
      if (!r.success) {
        expect(r.error).toBeDefined()
        expect(typeof r.error).toBe("string")
      }
    }, 60000)
  })
})
