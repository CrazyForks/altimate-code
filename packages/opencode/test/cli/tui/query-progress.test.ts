import { describe, expect, test } from "bun:test"
import { formatCostColor, truncateQuery } from "../../../src/cli/cmd/tui/util/query-progress-utils"

// ---------------------------------------------------------------------------
// formatCostColor
// ---------------------------------------------------------------------------

describe("QueryProgress.formatCostColor", () => {
  test("returns green for costs under $0.01", () => {
    expect(formatCostColor(0)).toBe("green")
    expect(formatCostColor(0.001)).toBe("green")
    expect(formatCostColor(0.009)).toBe("green")
  })

  test("returns yellow for costs between $0.01 and $1.00", () => {
    expect(formatCostColor(0.01)).toBe("yellow")
    expect(formatCostColor(0.5)).toBe("yellow")
    expect(formatCostColor(0.99)).toBe("yellow")
  })

  test("returns red for costs $1.00 and above", () => {
    expect(formatCostColor(1.0)).toBe("red")
    expect(formatCostColor(5.0)).toBe("red")
    expect(formatCostColor(100.0)).toBe("red")
  })

  test("handles exact boundary values", () => {
    expect(formatCostColor(0.01)).toBe("yellow")
    expect(formatCostColor(1.0)).toBe("red")
  })
})

// ---------------------------------------------------------------------------
// truncateQuery
// ---------------------------------------------------------------------------

describe("QueryProgress.truncateQuery", () => {
  test("returns short queries unchanged", () => {
    expect(truncateQuery("SELECT 1")).toBe("SELECT 1")
    expect(truncateQuery("SELECT * FROM users")).toBe("SELECT * FROM users")
  })

  test("truncates long queries with ellipsis", () => {
    const longQuery = "SELECT a, b, c, d, e, f, g, h, i, j FROM very_long_table_name WHERE condition = true"
    const result = truncateQuery(longQuery, 60)
    expect(result.length).toBe(60)
    expect(result.endsWith("...")).toBe(true)
  })

  test("collapses whitespace", () => {
    const query = "SELECT\n  *\n  FROM\n  users\n  WHERE\n  id = 1"
    const result = truncateQuery(query)
    expect(result).toBe("SELECT * FROM users WHERE id = 1")
  })

  test("collapses tabs and multiple spaces", () => {
    const query = "SELECT  *   FROM\t\tusers"
    expect(truncateQuery(query)).toBe("SELECT * FROM users")
  })

  test("respects custom maxLen", () => {
    const query = "SELECT * FROM users WHERE id = 1"
    const result = truncateQuery(query, 20)
    expect(result.length).toBe(20)
    expect(result.endsWith("...")).toBe(true)
  })

  test("handles exact length queries", () => {
    const query = "SELECT * FROM users"
    expect(truncateQuery(query, 19)).toBe("SELECT * FROM users")
  })

  test("handles empty strings", () => {
    expect(truncateQuery("")).toBe("")
  })

  test("handles whitespace-only strings", () => {
    expect(truncateQuery("   ")).toBe("")
  })

  test("handles very short maxLen", () => {
    const result = truncateQuery("SELECT * FROM users", 5)
    expect(result.length).toBe(5)
    expect(result.endsWith("...")).toBe(true)
  })
})
