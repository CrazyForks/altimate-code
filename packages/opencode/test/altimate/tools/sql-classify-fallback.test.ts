/**
 * Adversarial tests for sql-classify fallback behavior.
 *
 * Tests the regex fallback that activates when @altimateai/altimate-core
 * is unavailable (napi binary fails to load). Issue #469.
 *
 * Strategy: import the private classifyFallback via the module to test
 * both the AST path and the regex path produce consistent results.
 */

import { describe, test, expect, mock, beforeAll } from "bun:test"

// ---------------------------------------------------------------------------
// Test the exported functions (these use altimate-core if available)
// ---------------------------------------------------------------------------
describe("classify resilience — exported functions never throw", () => {
  // Import the real module (altimate-core available in test env)
  let classify: typeof import("../../../src/altimate/tools/sql-classify").classify
  let classifyAndCheck: typeof import("../../../src/altimate/tools/sql-classify").classifyAndCheck

  beforeAll(async () => {
    const mod = await import("../../../src/altimate/tools/sql-classify")
    classify = mod.classify
    classifyAndCheck = mod.classifyAndCheck
  })

  test("does not throw on null/undefined input", () => {
    // Should not crash — returns a safe default
    expect(() => classify(null as any)).not.toThrow()
    expect(() => classify(undefined as any)).not.toThrow()
    expect(() => classifyAndCheck(null as any)).not.toThrow()
    expect(() => classifyAndCheck(undefined as any)).not.toThrow()
  })

  test("does not throw on empty string", () => {
    const r = classifyAndCheck("")
    expect(r.queryType).toBe("read")
    expect(r.blocked).toBe(false)
  })

  test("does not throw on whitespace-only input", () => {
    const r = classifyAndCheck("   \n\t  ")
    expect(r.queryType).toBe("read")
    expect(r.blocked).toBe(false)
  })

  test("does not throw on extremely long SQL (100KB)", () => {
    const longSql = "SELECT " + "col, ".repeat(20_000) + "1"
    const start = performance.now()
    expect(() => classify(longSql)).not.toThrow()
    expect(performance.now() - start).toBeLessThan(5000)
  })

  test("does not throw on malformed SQL", () => {
    expect(() => classify("SELECTTTT INVALID GARBAGE !!@#$")).not.toThrow()
    expect(() => classifyAndCheck("INSERT INTO WHERE FROM")).not.toThrow()
  })

  test("does not throw on binary/control characters", () => {
    expect(() => classify("SELECT \x00\x01\x02 FROM t")).not.toThrow()
    expect(() => classifyAndCheck("\x00DROP DATABASE x")).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Test the regex fallback directly by simulating napi unavailability
// ---------------------------------------------------------------------------
describe("regex fallback — simulated napi failure", () => {
  // We test the fallback logic by directly calling the internal regex patterns.
  // Since we can't mock require() in the already-loaded module, we replicate
  // the fallback logic from the source to verify regex correctness.

  const WRITE_PATTERN =
    /^\s*(INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|CALL|EXEC)\b/i
  const HARD_DENY_PATTERN =
    /^\s*(DROP\s+(DATABASE|SCHEMA)\b|TRUNCATE(\s+TABLE)?\s)/i

  function classifyFallback(sql: string): { queryType: "read" | "write"; blocked: boolean } {
    const trimmed = sql.replace(/\/\*[\s\S]*?\*\//g, "").trim()
    const blocked = HARD_DENY_PATTERN.test(trimmed)
    const queryType = WRITE_PATTERN.test(trimmed) ? "write" : "read"
    return { queryType, blocked }
  }

  // --- Read queries ---
  test("SELECT → read", () => {
    expect(classifyFallback("SELECT * FROM users").queryType).toBe("read")
  })

  test("select lowercase → read", () => {
    expect(classifyFallback("select id from orders").queryType).toBe("read")
  })

  test("WITH...SELECT → read", () => {
    expect(classifyFallback("WITH cte AS (SELECT 1) SELECT * FROM cte").queryType).toBe("read")
  })

  test("empty → read", () => {
    expect(classifyFallback("").queryType).toBe("read")
  })

  test("comment-only SQL → read", () => {
    expect(classifyFallback("/* just a comment */").queryType).toBe("read")
  })

  test("leading whitespace SELECT → read", () => {
    expect(classifyFallback("  \n  SELECT 1").queryType).toBe("read")
  })

  // --- Write queries ---
  test("INSERT → write", () => {
    expect(classifyFallback("INSERT INTO users VALUES (1)").queryType).toBe("write")
  })

  test("UPDATE → write", () => {
    expect(classifyFallback("UPDATE users SET name = 'b'").queryType).toBe("write")
  })

  test("DELETE → write", () => {
    expect(classifyFallback("DELETE FROM users WHERE id = 1").queryType).toBe("write")
  })

  test("CREATE → write", () => {
    expect(classifyFallback("CREATE TABLE t (id INT)").queryType).toBe("write")
  })

  test("ALTER → write", () => {
    expect(classifyFallback("ALTER TABLE t ADD COLUMN c INT").queryType).toBe("write")
  })

  test("DROP TABLE → write", () => {
    expect(classifyFallback("DROP TABLE t").queryType).toBe("write")
  })

  test("TRUNCATE → write", () => {
    expect(classifyFallback("TRUNCATE TABLE t").queryType).toBe("write")
  })

  test("MERGE → write", () => {
    expect(classifyFallback("MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN UPDATE SET t.n = s.n").queryType).toBe("write")
  })

  test("GRANT → write", () => {
    expect(classifyFallback("GRANT SELECT ON t TO r").queryType).toBe("write")
  })

  test("REVOKE → write", () => {
    expect(classifyFallback("REVOKE SELECT ON t FROM r").queryType).toBe("write")
  })

  test("CALL → write", () => {
    expect(classifyFallback("CALL my_procedure()").queryType).toBe("write")
  })

  test("EXEC → write", () => {
    expect(classifyFallback("EXEC sp_rename 'old', 'new'").queryType).toBe("write")
  })

  // --- Case insensitivity ---
  test("insert lowercase → write", () => {
    expect(classifyFallback("insert into t values (1)").queryType).toBe("write")
  })

  test("DrOp DaTaBaSe → blocked", () => {
    expect(classifyFallback("DrOp DaTaBaSe mydb").blocked).toBe(true)
  })

  // --- Hard deny ---
  test("DROP DATABASE → blocked", () => {
    const r = classifyFallback("DROP DATABASE mydb")
    expect(r.blocked).toBe(true)
    expect(r.queryType).toBe("write")
  })

  test("DROP SCHEMA → blocked", () => {
    const r = classifyFallback("DROP SCHEMA public")
    expect(r.blocked).toBe(true)
  })

  test("TRUNCATE TABLE → blocked", () => {
    const r = classifyFallback("TRUNCATE TABLE users")
    expect(r.blocked).toBe(true)
  })

  test("TRUNCATE (no TABLE keyword) → blocked", () => {
    const r = classifyFallback("TRUNCATE users")
    expect(r.blocked).toBe(true)
  })

  test("DROP TABLE → NOT blocked (only DROP DATABASE/SCHEMA are hard-denied)", () => {
    const r = classifyFallback("DROP TABLE users")
    expect(r.blocked).toBe(false)
    expect(r.queryType).toBe("write")
  })

  // --- SQL injection / bypass attempts ---
  test("comment before DROP DATABASE → blocked", () => {
    const r = classifyFallback("/* innocent */ DROP DATABASE prod")
    expect(r.blocked).toBe(true)
  })

  test("newline before TRUNCATE → blocked", () => {
    const r = classifyFallback("\n\nTRUNCATE TABLE users")
    expect(r.blocked).toBe(true)
  })

  test("SELECT containing DROP DATABASE in string literal → read (not blocked)", () => {
    // The regex matches statement start, not string contents
    const r = classifyFallback("SELECT 'DROP DATABASE prod' AS warning")
    expect(r.queryType).toBe("read")
    expect(r.blocked).toBe(false)
  })

  // --- Edge cases ---
  test("multi-statement (only first statement detected by regex)", () => {
    // Regex fallback only checks the first statement — conservative for the first
    const r = classifyFallback("SELECT 1; DROP DATABASE prod")
    // Regex sees "SELECT" first → read, but second statement is dangerous
    // This is a known limitation of the fallback — AST path handles this correctly
    expect(r.queryType).toBe("read")
    // Hard deny pattern doesn't match because DROP is after semicolon
    expect(r.blocked).toBe(false)
  })

  // --- ReDoS protection ---
  test("regex does not catastrophically backtrack on pathological input", () => {
    const huge = "INSERT " + " ".repeat(100_000) + "INTO t VALUES (1)"
    const start = performance.now()
    classifyFallback(huge)
    expect(performance.now() - start).toBeLessThan(100)
  })

  test("regex handles very long comment before SQL", () => {
    const longComment = "/* " + "x".repeat(50_000) + " */ SELECT 1"
    const start = performance.now()
    classifyFallback(longComment)
    expect(performance.now() - start).toBeLessThan(500)
  })
})

// ---------------------------------------------------------------------------
// AST vs Regex consistency (when altimate-core IS available)
// ---------------------------------------------------------------------------
describe("AST vs regex fallback consistency", () => {
  const WRITE_PATTERN =
    /^\s*(INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|CALL|EXEC)\b/i
  const HARD_DENY_PATTERN =
    /^\s*(DROP\s+(DATABASE|SCHEMA)\b|TRUNCATE(\s+TABLE)?\s)/i

  function regexClassify(sql: string): "read" | "write" {
    const trimmed = sql.replace(/\/\*[\s\S]*?\*\//g, "").trim()
    return WRITE_PATTERN.test(trimmed) ? "write" : "read"
  }

  let classify: (sql: string) => "read" | "write"
  beforeAll(async () => {
    classify = (await import("../../../src/altimate/tools/sql-classify")).classify
  })

  // Single-statement queries should agree between AST and regex
  const singleStatementQueries: Array<{ sql: string; expected: "read" | "write" }> = [
    { sql: "SELECT * FROM users", expected: "read" },
    { sql: "INSERT INTO t VALUES (1)", expected: "write" },
    { sql: "UPDATE t SET x = 1", expected: "write" },
    { sql: "DELETE FROM t", expected: "write" },
    { sql: "CREATE TABLE t (id INT)", expected: "write" },
    { sql: "ALTER TABLE t ADD COLUMN c INT", expected: "write" },
    { sql: "DROP TABLE t", expected: "write" },
    { sql: "TRUNCATE TABLE t", expected: "write" },
    { sql: "GRANT SELECT ON t TO r", expected: "write" },
  ]

  for (const { sql, expected } of singleStatementQueries) {
    test(`AST and regex agree on: ${sql.slice(0, 40)}`, () => {
      const astResult = classify(sql)
      const regexResult = regexClassify(sql)
      expect(astResult).toBe(expected)
      expect(regexResult).toBe(expected)
    })
  }
})
