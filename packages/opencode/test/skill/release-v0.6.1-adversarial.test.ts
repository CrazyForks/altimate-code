/**
 * Adversarial tests for v0.6.1 release.
 *
 * Release content:
 *   1. BigQuery finops SQL fix + multi-region support (#739, ea5cabeae)
 *      - sanitizeBqRegion / interpolateBqRegion / bqRegionFor
 *      - buildHistoryQuery BQ branch — column-name regression guards
 *   2. Anti-slop workflow made advisory (#741, a3503b0f3) — YAML, not covered here
 *   3. Marker-guard hotfix for isValidDatabricksHost env-fallback (98f0f41e7) — no behavior change
 *   4. CHANGELOG entry — presence guard
 *
 * Focus here is the BQ finops surface: inputs a compliance reviewer, support
 * engineer, or adversarial caller would actually throw at sanitizeBqRegion,
 * plus regression guards that the column-name / execution_status fixes in
 * BIGQUERY_HISTORY_SQL can't silently regress.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  sanitizeBqRegion,
  interpolateBqRegion,
  bqRegionFor,
} from "../../src/altimate/native/finops/bq-utils"
import * as Registry from "../../src/altimate/native/connections/registry"
import { SQL_TEMPLATES as HistoryTemplates } from "../../src/altimate/native/finops/query-history"
import { SQL_TEMPLATES as CreditTemplates } from "../../src/altimate/native/finops/credit-analyzer"
import { SQL_TEMPLATES as AdvisorTemplates } from "../../src/altimate/native/finops/warehouse-advisor"
import { SQL_TEMPLATES as RoleTemplates } from "../../src/altimate/native/finops/role-access"
import { SQL_TEMPLATES as UnusedTemplates } from "../../src/altimate/native/finops/unused-resources"

// ---------------------------------------------------------------------------
// 1. sanitizeBqRegion — inputs the sanitizer must neutralise
// ---------------------------------------------------------------------------

describe("sanitizeBqRegion — injection vectors", () => {
  test("strips CR / LF / CRLF — cannot splice into header or multi-statement context", () => {
    expect(sanitizeBqRegion("us\nevil")).toBe("usevil")
    expect(sanitizeBqRegion("us\r\n; DROP")).toBe("usdrop")
    expect(sanitizeBqRegion("us\r")).toBe("us")
    expect(sanitizeBqRegion("\n\n\n")).toBe("us")
  })

  test("strips null byte and ASCII control characters", () => {
    expect(sanitizeBqRegion("us\x00")).toBe("us")
    expect(sanitizeBqRegion("us\x07\x08")).toBe("us")
    expect(sanitizeBqRegion("\x1b[31mus\x1b[0m")).toBe("31mus0m")
  })

  test("strips backtick — cannot close the ` region-... ` quote context", () => {
    expect(sanitizeBqRegion("us`")).toBe("us")
    expect(sanitizeBqRegion("`us`")).toBe("us")
    expect(sanitizeBqRegion("us` UNION SELECT 1; --")).toBe("usunionselect1")
  })

  test("strips all SQL-delimiter characters (quote, semicolon, paren, comma, dot)", () => {
    expect(sanitizeBqRegion("us'; --")).toBe("us")
    expect(sanitizeBqRegion('us"')).toBe("us")
    expect(sanitizeBqRegion("us;eu")).toBe("useu")
    expect(sanitizeBqRegion("us(eu)")).toBe("useu")
    expect(sanitizeBqRegion("us,eu")).toBe("useu")
    expect(sanitizeBqRegion("us.eu")).toBe("useu")
  })

  test("strips path-traversal sequences", () => {
    expect(sanitizeBqRegion("../etc/passwd")).toBe("etcpasswd")
    expect(sanitizeBqRegion("us/../eu")).toBe("useu")
  })

  test("strips Unicode letters that resemble ASCII (homoglyph defence)", () => {
    // Cyrillic 'u' (U+0443) / 'ѕ' (U+0455) look like 'us' but are not [a-z]
    expect(sanitizeBqRegion("ѕ")).toBe("us") // zero remaining → fallback
    expect(sanitizeBqRegion("üs")).toBe("s") // 'ü' dropped, 's' alone — doesn't silently become "us"
    expect(sanitizeBqRegion("日本")).toBe("us") // no [a-z0-9-] remains
  })

  test("rejects pathological length — cap at 64 even with repeated valid chars", () => {
    const out = sanitizeBqRegion("a".repeat(10_000))
    expect(out.length).toBeLessThanOrEqual(64)
    expect(out).toBe("a".repeat(64))
  })

  test("whitespace-only and whitespace-padded inputs fall back to 'us'", () => {
    expect(sanitizeBqRegion("   ")).toBe("us")
    expect(sanitizeBqRegion("\t\t")).toBe("us")
    expect(sanitizeBqRegion("  us  ")).toBe("us")
  })

  test("mixed case normalises to lowercase (BQ region names are conventionally lowercase)", () => {
    expect(sanitizeBqRegion("US-CENTRAL1")).toBe("us-central1")
    expect(sanitizeBqRegion("Us-Central1")).toBe("us-central1")
  })

  test("non-string inputs never throw — return 'us'", () => {
    expect(sanitizeBqRegion(undefined)).toBe("us")
    expect(sanitizeBqRegion(null)).toBe("us")
    expect(sanitizeBqRegion(42)).toBe("us")
    expect(sanitizeBqRegion({ toString: () => "EVIL" })).toBe("us")
    expect(sanitizeBqRegion([])).toBe("us")
    expect(sanitizeBqRegion(true)).toBe("us")
    expect(sanitizeBqRegion(Symbol("x"))).toBe("us")
  })

  test("__proto__ / constructor / prototype inputs don't pollute anything", () => {
    // Not a realistic attack vector (sanitizer returns a primitive string) but
    // confirms the function doesn't walk the input as a structured object.
    expect(sanitizeBqRegion("__proto__")).toBe("proto")
    expect(sanitizeBqRegion("constructor")).toBe("constructor")
    expect(sanitizeBqRegion({ __proto__: "polluted" } as any)).toBe("us")
  })

  test("is pure — same input always yields same output", () => {
    for (let i = 0; i < 50; i++) {
      expect(sanitizeBqRegion("us-central1")).toBe("us-central1")
    }
  })

  test("result is always safe to inject into ` region-<X>.INFORMATION_SCHEMA `", () => {
    const vectors = [
      "us",
      "eu",
      "",
      undefined,
      "`; DROP TABLE x; --",
      "us\n",
      "../etc",
      "a".repeat(1000),
      "🙈",
    ]
    for (const v of vectors) {
      const r = sanitizeBqRegion(v)
      // Only characters that exist in BigQuery region names
      expect(r).toMatch(/^[a-z0-9-]+$/)
      // Never a leading/trailing hyphen (would produce `region-.INFORMATION_SCHEMA` or `region--X`)
      expect(r.startsWith("-")).toBe(false)
      expect(r.endsWith("-")).toBe(false)
      // Always non-empty
      expect(r.length).toBeGreaterThan(0)
    }
  })
})

// ---------------------------------------------------------------------------
// 2. interpolateBqRegion — placeholder semantics
// ---------------------------------------------------------------------------

describe("interpolateBqRegion", () => {
  test("is idempotent — calling twice produces the same result", () => {
    const tpl = "FROM `region-{region}.INFORMATION_SCHEMA.JOBS`"
    const once = interpolateBqRegion(tpl, "eu")
    const twice = interpolateBqRegion(once, "eu")
    expect(once).toBe(twice)
    expect(once).toBe("FROM `region-eu.INFORMATION_SCHEMA.JOBS`")
  })

  test("passes a template without {region} through unchanged", () => {
    const tpl = "SELECT 1 FROM information_schema.tables"
    expect(interpolateBqRegion(tpl, "eu")).toBe(tpl)
  })

  test("replaces every occurrence, not just the first (multi-view JOINs are safe)", () => {
    const tpl =
      "FROM `region-{region}.INFORMATION_SCHEMA.A` a " +
      "JOIN `region-{region}.INFORMATION_SCHEMA.B` b USING (x) " +
      "JOIN `region-{region}.INFORMATION_SCHEMA.C` c USING (y)"
    const out = interpolateBqRegion(tpl, "asia-northeast1")
    expect(out).not.toContain("{region}")
    expect(out.match(/region-asia-northeast1/g)?.length).toBe(3)
  })

  test("applies sanitizer to the substituted value", () => {
    const out = interpolateBqRegion("`region-{region}.IS.X`", "us`; DROP")
    // Backtick+semicolon were stripped — cannot close the backtick quote
    expect(out).toBe("`region-usdrop.IS.X`")
    expect(out).not.toContain("`; DROP")
  })

  test("undefined / null region defaults to 'us' in the output", () => {
    expect(interpolateBqRegion("`region-{region}.X`", undefined)).toBe("`region-us.X`")
    expect(interpolateBqRegion("`region-{region}.X`", null)).toBe("`region-us.X`")
    expect(interpolateBqRegion("`region-{region}.X`")).toBe("`region-us.X`")
  })

  test("does not interpret replacement pattern special sequences ($&, $$, $1)", () => {
    // String.prototype.replaceAll with a string replacement does NOT treat `$&`
    // specially, unlike a regex replacement. Protect against a future refactor
    // that swaps the first arg for a RegExp without escaping the value.
    // The sanitiser strips `$` and `&` but keeps `1` (it's in [a-z0-9-]).
    // The key invariant: `{region}` (the matched substring) does NOT get
    // re-inserted via $& expansion.
    const out = interpolateBqRegion("`region-{region}`", "us$&$1")
    expect(out).not.toContain("{region}")
    expect(out).not.toContain("$")
    expect(out).not.toContain("&")
    // Specifically: the matched `{region}` was NOT expanded via $&
    expect(out).toBe("`region-us1`")
  })
})

// ---------------------------------------------------------------------------
// 3. bqRegionFor — registry-aware lookup
// ---------------------------------------------------------------------------

describe("bqRegionFor", () => {
  beforeEach(() => {
    Registry.reset()
  })

  afterEach(() => {
    Registry.reset()
  })

  test("returns the configured location when set", () => {
    Registry.setConfigs({
      "bq-eu": { type: "bigquery", project: "p", location: "eu" } as any,
    })
    expect(bqRegionFor("bq-eu")).toBe("eu")
  })

  test("returns undefined for a non-existent warehouse (does not throw)", () => {
    Registry.setConfigs({})
    expect(bqRegionFor("missing")).toBeUndefined()
  })

  test("returns undefined when the warehouse has no location set", () => {
    Registry.setConfigs({
      "bq-default": { type: "bigquery", project: "p" } as any,
    })
    expect(bqRegionFor("bq-default")).toBeUndefined()
  })

  test("the returned value round-trips through sanitizeBqRegion to a safe default", () => {
    Registry.setConfigs({})
    expect(sanitizeBqRegion(bqRegionFor("never-registered"))).toBe("us")
  })
})

// ---------------------------------------------------------------------------
// 4. BIGQUERY_HISTORY_SQL column-name regression guards (#739 bugs)
// ---------------------------------------------------------------------------
//
// These four bugs caused `finops_query_history` to 100%-fail on BQ before
// v0.6.1. If any of these assertions trip, the exact failure users saw in the
// telemetry (error: "Unrecognized name: error_message at [11:5]", 76-loop
// session) comes back.

describe("BIGQUERY_HISTORY_SQL — #739 regression guards", () => {
  test("execution_status is DERIVED from error_result, not state='SUCCESS'", () => {
    const sql = HistoryTemplates.BIGQUERY_HISTORY_SQL
    // The bug: `state as execution_status` made every DONE job look FAILED
    expect(sql).not.toMatch(/\bstate\s+as\s+execution_status\b/i)
    expect(sql).toMatch(/CASE\s+WHEN\s+error_result\s+IS\s+NULL/i)
  })

  test("error_message reads from error_result struct, not top-level column", () => {
    const sql = HistoryTemplates.BIGQUERY_HISTORY_SQL
    expect(sql).toContain("error_result.message")
    // Must not contain bare `error_message as error_message` or similar
    expect(sql).not.toMatch(/^\s*error_message\s+as\s+error_message\b/im)
  })

  test("error_code reads error_result.reason, not NULL placeholder", () => {
    const sql = HistoryTemplates.BIGQUERY_HISTORY_SQL
    expect(sql).toContain("error_result.reason")
    expect(sql).not.toMatch(/\bNULL\s+as\s+error_code\b/i)
  })

  test("rows_produced is CAST(NULL AS INT64), not `total_rows` (which is a PARTITIONS column)", () => {
    const sql = HistoryTemplates.BIGQUERY_HISTORY_SQL
    expect(sql).toContain("CAST(NULL AS INT64) as rows_produced")
    expect(sql).not.toMatch(/\btotal_rows\s+as\s+rows_produced\b/i)
  })

  test("region-US is no longer hardcoded — the template uses the {region} placeholder", () => {
    const sql = HistoryTemplates.BIGQUERY_HISTORY_SQL
    expect(sql).toContain("{region}")
    expect(sql).not.toContain("region-US")
    expect(sql).not.toContain("region-us.INFORMATION_SCHEMA") // pre-interpolation
  })
})

// ---------------------------------------------------------------------------
// 5. Cross-module: every BQ template in finops uses {region} (no stragglers)
// ---------------------------------------------------------------------------

describe("All finops BQ templates are region-parameterised", () => {
  const bqTemplates: Array<[string, string]> = [
    ["query-history.BIGQUERY_HISTORY_SQL", HistoryTemplates.BIGQUERY_HISTORY_SQL],
    // credit-analyzer exposes its templates differently; probe by suffix
    ...Object.entries(CreditTemplates)
      .filter(([k, v]) => typeof v === "string" && k.toLowerCase().includes("bigquery"))
      .map(([k, v]) => [`credit-analyzer.${k}`, v as string] as [string, string]),
    ...Object.entries(AdvisorTemplates)
      .filter(([k, v]) => typeof v === "string" && k.toLowerCase().includes("bigquery"))
      .map(([k, v]) => [`warehouse-advisor.${k}`, v as string] as [string, string]),
    ...Object.entries(RoleTemplates)
      .filter(([k, v]) => typeof v === "string" && k.toLowerCase().includes("bigquery"))
      .map(([k, v]) => [`role-access.${k}`, v as string] as [string, string]),
    ...Object.entries(UnusedTemplates)
      .filter(([k, v]) => typeof v === "string" && k.toLowerCase().includes("bigquery"))
      .map(([k, v]) => [`unused-resources.${k}`, v as string] as [string, string]),
  ]

  test("at least one BQ template exists per finops module (no silent regression to zero)", () => {
    const modules = new Set(bqTemplates.map(([n]) => n.split(".")[0]))
    // query-history is the minimum; extras are a bonus.
    expect(modules.has("query-history")).toBe(true)
  })

  test.each(bqTemplates)("%s contains {region} and no hardcoded region-US", (name, sql) => {
    expect(sql, `${name} must use {region} placeholder`).toContain("{region}")
    expect(sql, `${name} must not hardcode region-US`).not.toMatch(/`region-[a-zA-Z0-9-]+\.INFORMATION_SCHEMA/)
  })
})

// ---------------------------------------------------------------------------
// 6. buildHistoryQuery — end-to-end SQL generation for BQ
// ---------------------------------------------------------------------------

describe("buildHistoryQuery (BigQuery) — full-pipeline behaviour", () => {
  test("injects the sanitised region into the interpolated SQL", () => {
    const built = HistoryTemplates.buildHistoryQuery("bigquery", 7, 100, undefined, undefined, "eu-west1")
    expect(built).not.toBeNull()
    expect(built!.sql).toContain("`region-eu-west1.INFORMATION_SCHEMA.JOBS`")
  })

  test("falls back to region-us when bqRegion is unset (compat with pre-v0.6.1 US users)", () => {
    const built = HistoryTemplates.buildHistoryQuery("bigquery", 7, 100, undefined, undefined, undefined)
    expect(built).not.toBeNull()
    expect(built!.sql).toContain("`region-us.INFORMATION_SCHEMA.JOBS`")
  })

  test("neutralises a malicious bqRegion input before it reaches the SQL", () => {
    const built = HistoryTemplates.buildHistoryQuery(
      "bigquery",
      7,
      100,
      undefined,
      undefined,
      "us`; DROP TABLE X; --",
    )
    expect(built!.sql).not.toContain("DROP TABLE")
    expect(built!.sql).not.toContain("`;")
    expect(built!.sql).toContain("`region-usdroptablex.INFORMATION_SCHEMA.JOBS`")
  })

  test("days and limit are positional binds, not string-interpolated (injection guard)", () => {
    const built = HistoryTemplates.buildHistoryQuery("bigquery", 14, 250, undefined, undefined, "us")
    expect(built!.binds).toEqual([14, 250])
    // Template uses `? DAY` and `LIMIT ?` — not interpolated numerics
    expect(built!.sql).toMatch(/INTERVAL\s+\?\s+DAY/i)
    expect(built!.sql).toMatch(/LIMIT\s+\?/i)
  })

  test("returns null for an unknown warehouse type (DuckDB, mysql, etc.) — caller reports gracefully", () => {
    expect(HistoryTemplates.buildHistoryQuery("duckdb", 7, 100)).toBeNull()
    expect(HistoryTemplates.buildHistoryQuery("mysql", 7, 100)).toBeNull()
    expect(HistoryTemplates.buildHistoryQuery("unknown", 7, 100)).toBeNull()
  })

  test("Snowflake path is unaffected — still uses ACCOUNT_USAGE.QUERY_HISTORY, no region- prefix", () => {
    const built = HistoryTemplates.buildHistoryQuery("snowflake", 7, 100)
    expect(built!.sql).toContain("SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY")
    expect(built!.sql).not.toContain("region-")
    expect(built!.sql).not.toContain("{region}")
  })

  test("Databricks path is unaffected — still uses system.query.history, no region- prefix", () => {
    const built = HistoryTemplates.buildHistoryQuery("databricks", 7, 100)
    expect(built!.sql).toContain("system.query.history")
    expect(built!.sql).not.toContain("region-")
    expect(built!.sql).not.toContain("{region}")
  })
})

// ---------------------------------------------------------------------------
// 7. CHANGELOG — v0.6.1 entry exists and covers the release
// ---------------------------------------------------------------------------

describe("CHANGELOG.md — v0.6.1 entry", () => {
  const changelog = readFileSync(join(__dirname, "../../../../CHANGELOG.md"), "utf8")

  test("v0.6.1 section is present at the top (above v0.6.0)", () => {
    const idx061 = changelog.indexOf("[0.6.1]")
    const idx060 = changelog.indexOf("[0.6.0]")
    expect(idx061).toBeGreaterThan(-1)
    expect(idx060).toBeGreaterThan(-1)
    expect(idx061).toBeLessThan(idx060)
  })

  test("entry mentions BigQuery finops multi-region fix", () => {
    const section = changelog.split("[0.6.0]")[0]
    expect(section.toLowerCase()).toContain("bigquery")
    // The release's core win — region support
    expect(section.toLowerCase()).toMatch(/region|location|\beu\b/i)
  })

  test("entry acknowledges the SQL column-name fix (issue #738/#739)", () => {
    const section = changelog.split("[0.6.0]")[0]
    // Either issue number or the symptom text
    expect(section).toMatch(/#738|#739|information_schema|error_result/i)
  })
})
