import { describe, expect, test } from "bun:test"
import { elapsedSeverity, formatInlineSummary } from "../../../src/cli/cmd/tui/util/cost-badge-utils"

// ---------------------------------------------------------------------------
// elapsedSeverity
// ---------------------------------------------------------------------------

describe("CostBadge.elapsedSeverity", () => {
  test("returns fast for sub-second queries", () => {
    expect(elapsedSeverity(0)).toBe("fast")
    expect(elapsedSeverity(100)).toBe("fast")
    expect(elapsedSeverity(500)).toBe("fast")
    expect(elapsedSeverity(999)).toBe("fast")
  })

  test("returns normal for 1-10 second queries", () => {
    expect(elapsedSeverity(1000)).toBe("normal")
    expect(elapsedSeverity(5000)).toBe("normal")
    expect(elapsedSeverity(9999)).toBe("normal")
  })

  test("returns slow for 10+ second queries", () => {
    expect(elapsedSeverity(10000)).toBe("slow")
    expect(elapsedSeverity(30000)).toBe("slow")
    expect(elapsedSeverity(60000)).toBe("slow")
    expect(elapsedSeverity(300000)).toBe("slow")
  })

  test("handles exact boundary values", () => {
    expect(elapsedSeverity(999)).toBe("fast")
    expect(elapsedSeverity(1000)).toBe("normal")
    expect(elapsedSeverity(9999)).toBe("normal")
    expect(elapsedSeverity(10000)).toBe("slow")
  })
})

// ---------------------------------------------------------------------------
// formatInlineSummary
// ---------------------------------------------------------------------------

describe("CostBadge.formatInlineSummary", () => {
  test("formats row count only", () => {
    expect(formatInlineSummary({ rowCount: 42 })).toBe("42 rows")
  })

  test("formats singular row", () => {
    expect(formatInlineSummary({ rowCount: 1 })).toBe("1 row")
  })

  test("formats zero rows", () => {
    expect(formatInlineSummary({ rowCount: 0 })).toBe("0 rows")
  })

  test("formats elapsed time only", () => {
    expect(formatInlineSummary({ elapsedMs: 1500 })).toBe("1.5s")
  })

  test("formats truncated indicator", () => {
    expect(formatInlineSummary({ truncated: true })).toBe("truncated")
  })

  test("formats warehouse name", () => {
    expect(formatInlineSummary({ warehouse: "COMPUTE_WH" })).toBe("COMPUTE_WH")
  })

  test("combines all fields with dot separator", () => {
    const result = formatInlineSummary({
      rowCount: 1247,
      elapsedMs: 4200,
      truncated: true,
      warehouse: "ANALYTICS_WH",
    })
    expect(result).toBe("1,247 rows · 4.2s · truncated · ANALYTICS_WH")
  })

  test("combines subset of fields", () => {
    const result = formatInlineSummary({
      rowCount: 50,
      elapsedMs: 300,
    })
    expect(result).toBe("50 rows · 300ms")
  })

  test("returns empty string for no fields", () => {
    expect(formatInlineSummary({})).toBe("")
  })

  test("omits false-y truncated", () => {
    const result = formatInlineSummary({ rowCount: 10, truncated: false })
    expect(result).toBe("10 rows")
  })

  test("formats large row counts with locale separators", () => {
    const result = formatInlineSummary({ rowCount: 1000000 })
    expect(result).toBe("1,000,000 rows")
  })
})

// ---------------------------------------------------------------------------
// Integration: different data scenarios
// ---------------------------------------------------------------------------

describe("CostBadge data scenarios", () => {
  test("quick small query", () => {
    const summary = formatInlineSummary({
      rowCount: 5,
      elapsedMs: 50,
    })
    expect(summary).toBe("5 rows · 50ms")
    expect(elapsedSeverity(50)).toBe("fast")
  })

  test("medium warehouse query", () => {
    const summary = formatInlineSummary({
      rowCount: 10000,
      elapsedMs: 3500,
      warehouse: "COMPUTE_WH",
    })
    expect(summary).toContain("10,000 rows")
    expect(summary).toContain("3.5s")
    expect(summary).toContain("COMPUTE_WH")
    expect(elapsedSeverity(3500)).toBe("normal")
  })

  test("slow truncated query", () => {
    const summary = formatInlineSummary({
      rowCount: 100,
      elapsedMs: 45000,
      truncated: true,
      warehouse: "LARGE_WH",
    })
    expect(summary).toContain("100 rows")
    expect(summary).toContain("45.0s")
    expect(summary).toContain("truncated")
    expect(elapsedSeverity(45000)).toBe("slow")
  })
})
