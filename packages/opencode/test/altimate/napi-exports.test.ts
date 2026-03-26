/**
 * CI gate: verify @altimateai/altimate-core napi binary exports.
 *
 * This test fails when the installed altimate-core binary is missing expected
 * function exports. Catches:
 *   - Stale platform binary from a cached npm install
 *   - Version bump in package.json without updating the lock file
 *   - Broken napi build that silently drops exports
 *
 * Maintenance: when adding new #[napi] functions in altimate-core-internal,
 * add them to EXPECTED_EXPORTS below.
 */

import { describe, test, expect } from "bun:test"

// Every function exported by @altimateai/altimate-core that altimate-code uses.
// This list must be kept in sync with the Rust source at:
//   altimate-core-internal/crates/altimate-core-node/src/*.rs (#[napi] functions)
const EXPECTED_EXPORTS = [
  // polyglot.rs
  "transpile",
  "formatSql",
  "extractMetadata",
  "extractOutputColumns",
  "getStatementTypes",
  "compareQueries",
  // context.rs
  "optimizeContext",
  "optimizeForQuery",
  "pruneSchema",
  "diffSchemas",
  "importDdl",
  "exportDdl",
  "schemaFingerprint",
  "introspectionSql",
  // safety.rs
  "lint",
  "scanSql",
  "isSafe",
  "classifyPii",
  "checkQueryPii",
  "resolveTerm",
  "analyzeTags",
  // lineage.rs
  "columnLineage",
  "diffLineage",
  "trackLineage",
  // tools.rs
  "complete",
  "rewrite",
  "generateTests",
  "analyzeMigration",
  "parseDbtProject",
  // intelligence.rs (via tools)
  "correct",
  "evaluate",
  "explain",
  "fix",
  "validate",
  "checkEquivalence",
  "checkPolicy",
  "checkSemantics",
  // sdk.rs
  "initSdk",
  "resetSdk",
  "flushSdk",
] as const

describe("@altimateai/altimate-core napi exports", () => {
  let core: Record<string, unknown>

  test("module loads without error", () => {
    core = require("@altimateai/altimate-core")
    expect(core).toBeDefined()
  })

  test("all expected function exports exist", () => {
    if (!core) return // skip if module failed to load

    const missing: string[] = []
    for (const name of EXPECTED_EXPORTS) {
      if (typeof core[name] !== "function") {
        missing.push(name)
      }
    }

    if (missing.length > 0) {
      throw new Error(
        `@altimateai/altimate-core is missing ${missing.length} expected export(s):\n` +
          `  ${missing.join(", ")}\n\n` +
          `This usually means the platform binary is stale. Fix:\n` +
          `  rm -rf node_modules && bun install\n\n` +
          `If you added new #[napi] exports in altimate-core-internal,\n` +
          `publish a new version and update the dependency in package.json.`,
      )
    }
  })

  test("Schema class is exported", () => {
    if (!core) return
    expect(typeof core.Schema).toBe("function")
  })

  test("getStatementTypes returns expected shape", () => {
    if (!core || typeof core.getStatementTypes !== "function") return
    const result = (core.getStatementTypes as (sql: string) => any)("SELECT 1")
    expect(result).toHaveProperty("statements")
    expect(result).toHaveProperty("statement_count")
    expect(result).toHaveProperty("types")
    expect(result).toHaveProperty("categories")
    expect(result.statement_count).toBe(1)
    expect(result.categories).toContain("query")
  })

  test("no unexpected exports removed (detect accidental deletion)", () => {
    if (!core) return
    const actual = Object.keys(core).filter((k) => typeof core[k] === "function").sort()
    // Should have at least as many exports as expected
    expect(actual.length).toBeGreaterThanOrEqual(EXPECTED_EXPORTS.length)
  })
})
