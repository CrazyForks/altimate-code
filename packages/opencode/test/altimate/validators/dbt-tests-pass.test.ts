import { describe, expect, test } from "bun:test"
import { parseDbtTestOutput } from "../../../src/altimate/validators/dbt-tests-pass"
import type { TestSummary } from "../../../src/altimate/validators/dbt-tests-pass"

// ---------------------------------------------------------------------------
// parseDbtTestOutput
// ---------------------------------------------------------------------------

describe("parseDbtTestOutput", () => {
  test("returns null for empty string", () => {
    expect(parseDbtTestOutput("")).toBeNull()
  })

  test("returns null when no summary line is present", () => {
    const output = "Running tests...\n[error] something failed\n"
    expect(parseDbtTestOutput(output)).toBeNull()
  })

  test("parses a clean all-pass summary", () => {
    const stdout = [
      "17:04:14  Running with dbt=1.8.0",
      "17:04:15  1 of 3 START test not_null_orders_order_id ........ [RUN]",
      "17:04:16  1 of 3 PASS not_null_orders_order_id .............. [PASS in 0.10s]",
      "17:04:16  2 of 3 PASS unique_orders_order_id ................. [PASS in 0.08s]",
      "17:04:17  3 of 3 PASS relationships_orders_customer_id ....... [PASS in 0.12s]",
      "17:04:17",
      "17:04:17  Finished running 3 tests in 0 hours 0 minutes and 0.30 seconds (0.30s).",
      "17:04:17",
      "17:04:17  Done. PASS=3 WARN=0 ERROR=0 SKIP=0 TOTAL=3",
      "17:04:17",
      "17:04:17  Completed successfully",
    ].join("\n")
    const result = parseDbtTestOutput(stdout)
    expect(result).not.toBeNull()
    const summary = result as TestSummary
    expect(summary.pass).toBe(3)
    expect(summary.error).toBe(0)
    expect(summary.total).toBe(3)
    expect(summary.failingTests).toEqual([])
  })

  test("parses a summary with failures and extracts failing test names", () => {
    const stdout = [
      "17:04:14  Running with dbt=1.8.0",
      "17:04:15  1 of 4 PASS not_null_orders_order_id .............. [PASS in 0.10s]",
      "17:04:16  2 of 4 FAIL 5 unique_orders_order_id .............. [FAIL 5 in 0.05s]",
      "17:04:17  3 of 4 ERROR not_null_orders_amount ............... [ERROR in 0.04s]",
      "17:04:17  4 of 4 PASS relationships_orders_customer_id ....... [PASS in 0.12s]",
      "17:04:17  Done. PASS=2 WARN=0 ERROR=2 SKIP=0 TOTAL=4",
    ].join("\n")
    const result = parseDbtTestOutput(stdout)
    expect(result).not.toBeNull()
    const summary = result as TestSummary
    expect(summary.pass).toBe(2)
    expect(summary.error).toBe(2)
    expect(summary.total).toBe(4)
    expect(summary.failingTests).toContain("unique_orders_order_id")
    expect(summary.failingTests).toContain("not_null_orders_amount")
  })

  test("parses NO-OP variant (dbt runs with no tests)", () => {
    const stdout = [
      "17:04:14  Running with dbt=1.8.0",
      "17:04:14  Done. PASS=0 WARN=0 ERROR=0 SKIP=0 NO-OP=1 TOTAL=0",
    ].join("\n")
    const result = parseDbtTestOutput(stdout)
    expect(result).not.toBeNull()
    const summary = result as TestSummary
    expect(summary.total).toBe(0)
    expect(summary.error).toBe(0)
  })

  test("is case-insensitive for the Done. line", () => {
    const stdout = "done. PASS=1 WARN=0 ERROR=0 SKIP=0 TOTAL=1"
    const result = parseDbtTestOutput(stdout)
    expect(result).not.toBeNull()
    expect(result!.pass).toBe(1)
  })

  test("handles multi-failure output (only unique names collected)", () => {
    const stdout = [
      "17:04:16  2 of 5 FAIL 3 unique_orders_id [FAIL 3 in 0.05s]",
      "17:04:16  2 of 5 FAIL 3 unique_orders_id [FAIL 3 in 0.05s]", // duplicate line
      "17:04:17  3 of 5 ERROR not_null_amount [ERROR in 0.04s]",
      "17:04:17  Done. PASS=2 WARN=0 ERROR=2 SKIP=0 TOTAL=5",
    ].join("\n")
    const result = parseDbtTestOutput(stdout)
    expect(result).not.toBeNull()
    // unique_orders_id should appear only once
    const names = result!.failingTests
    expect(names.filter((n) => n === "unique_orders_id").length).toBe(1)
    expect(names).toContain("not_null_amount")
  })

  test("does not include [FAIL or [ERROR tokens as test names", () => {
    const stdout = [
      "17:04:16  1 of 2 FAIL 1 my_test [FAIL 1 in 0.01s]",
      "17:04:17  Done. PASS=0 WARN=0 ERROR=1 SKIP=0 TOTAL=1",
    ].join("\n")
    const result = parseDbtTestOutput(stdout)
    expect(result).not.toBeNull()
    expect(result!.failingTests).not.toContain("[FAIL")
    expect(result!.failingTests).not.toContain("[ERROR")
    expect(result!.failingTests).toContain("my_test")
  })

  test("handles dbt 1.x full output with timestamps and ANSI prefix noise", () => {
    // Simulates ANSI escape codes and timestamp prefixes that dbt emits
    const stdout = [
      "\x1b[32m17:04:14\x1b[0m  \x1b[32mRunning with dbt=1.8.3\x1b[0m",
      "\x1b[32m17:04:15\x1b[0m  \x1b[32mDone. PASS=5 WARN=0 ERROR=0 SKIP=0 TOTAL=5\x1b[0m",
    ].join("\n")
    const result = parseDbtTestOutput(stdout)
    expect(result).not.toBeNull()
    expect(result!.pass).toBe(5)
    expect(result!.total).toBe(5)
  })

  test("handles SKIP count in summary", () => {
    const stdout = "Done. PASS=2 WARN=0 ERROR=1 SKIP=2 TOTAL=5"
    const result = parseDbtTestOutput(stdout)
    expect(result).not.toBeNull()
    // SKIP is parsed but not exposed in TestSummary — just verify parse doesn't break
    expect(result!.error).toBe(1)
    expect(result!.total).toBe(5)
  })
})
