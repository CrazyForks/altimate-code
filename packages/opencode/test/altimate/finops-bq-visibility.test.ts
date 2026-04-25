/**
 * Tests for the BigQuery finops UX + visibility improvements.
 *
 * Covers the items from #754 shipped in this PR:
 *   1. `augmentBqError` — region-hint appended to BQ errors that look
 *      region-related (and only those), idempotent under double-wrapping.
 *   2. `isBqPermissionError` — detects the TABLE_STORAGE 403 pattern that
 *      `finops_unused_resources` routinely hits on project-scoped SAs.
 *   3. `warehouse_add` emits a non-fatal warning when a BigQuery connection
 *      is registered without a `location` field.
 *   4. `getQueryHistory` + friends surface `bq_region` in their responses
 *      on the BigQuery branch (only).
 */

import { describe, test, expect, mock, beforeEach, afterEach, afterAll, spyOn } from "bun:test"
import { SessionID, MessageID } from "../../src/session/schema"
import { Telemetry } from "../../src/telemetry"
import * as Dispatcher from "../../src/altimate/native/dispatcher"
import * as Registry from "../../src/altimate/native/connections/registry"
import { WarehouseAddTool } from "../../src/altimate/tools/warehouse-add"
import { augmentBqError, isBqPermissionError } from "../../src/altimate/native/finops/bq-utils"
import { getQueryHistory } from "../../src/altimate/native/finops/query-history"

// ---------------------------------------------------------------------------
// 1. augmentBqError
// ---------------------------------------------------------------------------

describe("augmentBqError", () => {
  test("appends a region hint when the error mentions region-<X>", () => {
    const out = augmentBqError("Not found: Dataset region-eu:INFORMATION_SCHEMA", "eu")
    expect(out).toContain("Not found: Dataset region-eu:INFORMATION_SCHEMA")
    expect(out).toContain('set "location" on the BigQuery connection')
    expect(out).toContain("region-eu")
  })

  test("appends a region hint on generic 'Not found: ... INFORMATION_SCHEMA' errors", () => {
    const out = augmentBqError(
      "Not found: Table my_project.INFORMATION_SCHEMA.JOBS",
      "asia-northeast1",
    )
    expect(out).toContain("region-asia-northeast1")
    expect(out).toContain('set "location"')
  })

  test("passes non-region errors through unchanged", () => {
    // Syntax errors, auth errors, quota errors — nothing region-related in the message
    expect(augmentBqError("Syntax error at line 5: unexpected token", "us")).toBe(
      "Syntax error at line 5: unexpected token",
    )
    expect(augmentBqError("Quota exceeded: too many queries", "us")).toBe(
      "Quota exceeded: too many queries",
    )
    expect(augmentBqError("Invalid credentials", "us")).toBe("Invalid credentials")
  })

  test("is idempotent — never double-wraps the hint", () => {
    const once = augmentBqError("Not found: Dataset region-eu:INFORMATION_SCHEMA", "eu")
    const twice = augmentBqError(once, "eu")
    expect(twice).toBe(once)
    // Only one hint in the final message
    const hintCount = (twice.match(/set "location"/g) ?? []).length
    expect(hintCount).toBe(1)
  })

  test("accepts non-string errors (Error object, null, undefined, number)", () => {
    const err = new Error("Not found: Dataset region-us:INFORMATION_SCHEMA.JOBS")
    expect(augmentBqError(err, "us")).toContain('set "location"')
    // Non-region/non-string inputs just round-trip through String()
    expect(augmentBqError(null, "us")).toBe("null")
    expect(augmentBqError(undefined, "us")).toBe("undefined")
    expect(augmentBqError(42, "us")).toBe("42")
  })

  test("does not leak the sanitised region into unrelated error text", () => {
    // The word "region" appears in unrelated contexts — don't trigger on those
    expect(augmentBqError("Target region parameter missing for backup", "eu")).not.toContain(
      'set "location"',
    )
  })

  test("does not trigger on `region-<word>` text that is not a BQ INFORMATION_SCHEMA reference", () => {
    // Tightened in convergence: the regex used to match any "region-<word>"
    // and would falsely tag these as BQ region errors. After the fix the hint
    // is appended only when the message contains a region-qualified
    // INFORMATION_SCHEMA reference or a "Not found" line.
    expect(augmentBqError("region-based routing policy denied", "us")).not.toContain(
      'set "location"',
    )
    expect(augmentBqError("multi-region-aware feature disabled", "us")).not.toContain(
      'set "location"',
    )
    expect(augmentBqError("Invalid region-europe parameter in config", "eu")).not.toContain(
      'set "location"',
    )
    expect(augmentBqError("backup policy target region-eu is invalid", "us")).not.toContain(
      'set "location"',
    )
  })

  test("bare `region-` (zero chars after the hyphen) does not trigger the hint", () => {
    // Pre-fix the regex used `*` which matched zero chars — `region-` alone
    // would be tagged. After the fix this only matches with at least one
    // [a-z0-9] char before the dot.
    expect(augmentBqError("Configuration key region- is reserved", "us")).not.toContain(
      'set "location"',
    )
  })

  test("does trigger on canonical BQ region-qualified INFORMATION_SCHEMA references", () => {
    expect(
      augmentBqError(
        "Not found: Table region-eu.INFORMATION_SCHEMA.JOBS",
        "eu",
      ),
    ).toContain('set "location"')
    expect(
      augmentBqError(
        "Could not resolve `region-asia-northeast1.INFORMATION_SCHEMA.JOBS`",
        "asia-northeast1",
      ),
    ).toContain('set "location"')
  })

  test("triggers on `Not found: Dataset region-<x>` shape", () => {
    expect(
      augmentBqError("Not found: Dataset region-eu was not found", "eu"),
    ).toContain('set "location"')
  })
})

// ---------------------------------------------------------------------------
// 2. isBqPermissionError
// ---------------------------------------------------------------------------

describe("isBqPermissionError", () => {
  test("detects 'Permission denied' (case-insensitive)", () => {
    expect(isBqPermissionError("Permission denied on resource project X")).toBe(true)
    expect(isBqPermissionError("permission denied")).toBe(true)
    expect(isBqPermissionError("PERMISSION DENIED")).toBe(true)
  })

  test("detects explicit bigquery.resourceAdmin mentions", () => {
    expect(
      isBqPermissionError(
        "User does not have bigquery.resourceAdmin permission on organization",
      ),
    ).toBe(true)
  })

  test("detects 403 status code text", () => {
    expect(isBqPermissionError("HTTP 403: forbidden")).toBe(true)
  })

  test("detects 'Access denied' variant used by Google APIs", () => {
    expect(isBqPermissionError("Access Denied: BigQuery BigQuery")).toBe(true)
    expect(isBqPermissionError("accessDenied")).toBe(true)
  })

  test("detects 'IAM permission' framing", () => {
    expect(isBqPermissionError("IAM permission denied on foo")).toBe(true)
  })

  test("returns false for region/syntax/quota errors", () => {
    expect(isBqPermissionError("Not found: Dataset region-eu")).toBe(false)
    expect(isBqPermissionError("Syntax error at line 5")).toBe(false)
    expect(isBqPermissionError("Quota exceeded")).toBe(false)
    expect(isBqPermissionError("Invalid region: bogus")).toBe(false)
  })

  test("returns false for numeric prefixes containing `403` (word-boundary check)", () => {
    // Pre-fix the substring match `includes("403")` would match all of these
    // and falsely route non-permission errors to the TABLE_STORAGE/IAM hint.
    // After the fix `\b403\b` is anchored on word boundaries.
    expect(isBqPermissionError("Error code 4031 - rate limit exceeded")).toBe(false)
    expect(isBqPermissionError("Request id 40322 failed")).toBe(false)
    expect(isBqPermissionError("Connection failed on port 4030")).toBe(false)
    expect(isBqPermissionError("Error code 1403 - timeout")).toBe(false)
    expect(isBqPermissionError("Row 40314 has invalid data")).toBe(false)
  })

  test("returns true for canonical 403 surfaces (word-bounded)", () => {
    expect(isBqPermissionError("HTTP 403 Forbidden")).toBe(true)
    expect(isBqPermissionError("Status: 403 — denied")).toBe(true)
    expect(isBqPermissionError("403 Forbidden: insufficient privileges")).toBe(true)
  })

  test("accepts non-string inputs via String() coercion", () => {
    expect(isBqPermissionError(new Error("Permission denied"))).toBe(true)
    expect(isBqPermissionError(null)).toBe(false)
    expect(isBqPermissionError(undefined)).toBe(false)
    // `String(403)` yields "403" with implicit boundaries at start/end of string,
    // which `\b403\b` matches. This documents the helper's coercion contract.
    expect(isBqPermissionError(403)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 3. warehouse_add: BQ missing-location warning
// ---------------------------------------------------------------------------

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "call_test",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
  ask: async () => {},
}

let dispatcherSpy: ReturnType<typeof spyOn>

function mockDispatcherCall(handler: (method: string, params: any) => Promise<any>) {
  dispatcherSpy?.mockRestore()
  dispatcherSpy = spyOn(Dispatcher, "call").mockImplementation(handler as any)
}

describe("warehouse_add — BigQuery missing-location warning", () => {
  beforeEach(() => {
    process.env.ALTIMATE_TELEMETRY_DISABLED = "true"
    spyOn(Telemetry, "track").mockImplementation(() => {})
    spyOn(Telemetry, "getContext").mockReturnValue({
      sessionId: "test-session",
      projectId: "",
    } as any)
  })

  afterEach(() => {
    dispatcherSpy?.mockRestore()
    mock.restore()
  })

  afterAll(() => {
    dispatcherSpy?.mockRestore()
    delete process.env.ALTIMATE_TELEMETRY_DISABLED
  })

  test("warns when BigQuery connection is added without location", async () => {
    mockDispatcherCall(async (method: string) => {
      if (method === "warehouse.add") return { success: true, name: "bq-eu", type: "bigquery" }
      if (method === "schema.cache_status") return { total_tables: 0 }
      if (method === "warehouse.list") return { warehouses: [{ name: "bq-eu" }] }
      return {}
    })

    const tool = await WarehouseAddTool.init()
    const result = await tool.execute(
      { name: "bq-eu", config: { type: "bigquery", project: "my-project" } },
      ctx as any,
    )

    expect(result.output).toContain("Successfully added warehouse")
    expect(result.output).toContain('no "location" set')
    expect(result.output).toContain("us")
    expect(result.output).toContain("re-add")
    // The suggestion block still runs
    expect(result.metadata).toMatchObject({ success: true, type: "bigquery" })
  })

  test("does NOT warn when BigQuery connection has location set", async () => {
    mockDispatcherCall(async (method: string) => {
      if (method === "warehouse.add") return { success: true, name: "bq-eu", type: "bigquery" }
      if (method === "schema.cache_status") return { total_tables: 0 }
      if (method === "warehouse.list") return { warehouses: [{ name: "bq-eu" }] }
      return {}
    })

    const tool = await WarehouseAddTool.init()
    const result = await tool.execute(
      { name: "bq-eu", config: { type: "bigquery", project: "my-project", location: "eu" } },
      ctx as any,
    )

    expect(result.output).toContain("Successfully added warehouse")
    expect(result.output).not.toContain('no "location" set')
  })

  test("does NOT warn for non-BigQuery warehouses (Snowflake, Postgres, etc.)", async () => {
    mockDispatcherCall(async (method: string) => {
      if (method === "warehouse.add") return { success: true, name: "sf", type: "snowflake" }
      if (method === "schema.cache_status") return { total_tables: 0 }
      if (method === "warehouse.list") return { warehouses: [{ name: "sf" }] }
      return {}
    })

    const tool = await WarehouseAddTool.init()
    const result = await tool.execute(
      {
        name: "sf",
        config: { type: "snowflake", account: "xy12345", user: "admin", password: "pw" },
      },
      ctx as any,
    )

    expect(result.output).not.toContain('no "location" set')
  })

  test("empty-string location is treated as missing (falsy)", async () => {
    mockDispatcherCall(async (method: string) => {
      if (method === "warehouse.add") return { success: true, name: "bq", type: "bigquery" }
      if (method === "schema.cache_status") return { total_tables: 0 }
      if (method === "warehouse.list") return { warehouses: [{ name: "bq" }] }
      return {}
    })

    const tool = await WarehouseAddTool.init()
    const result = await tool.execute(
      { name: "bq", config: { type: "bigquery", project: "p", location: "" } },
      ctx as any,
    )

    expect(result.output).toContain('no "location" set')
  })

  test("whitespace-only location triggers the warning (sanitizer would strip and fall back to us)", async () => {
    // Convergence-driven: the original guard used !cfg.location (truthy-check),
    // which would have passed for "  ". sanitizeBqRegion trims and falls back
    // to "us" at query time, so the user thinks they configured a region but
    // silently queries US. Now caught at warehouse_add time.
    mockDispatcherCall(async (method: string) => {
      if (method === "warehouse.add") return { success: true, name: "bq", type: "bigquery" }
      if (method === "schema.cache_status") return { total_tables: 0 }
      if (method === "warehouse.list") return { warehouses: [{ name: "bq" }] }
      return {}
    })

    const tool = await WarehouseAddTool.init()
    const result = await tool.execute(
      { name: "bq", config: { type: "bigquery", project: "p", location: "   " } },
      ctx as any,
    )

    expect(result.output).toContain('no "location" set')
  })

  test("null location triggers the warning", async () => {
    mockDispatcherCall(async (method: string) => {
      if (method === "warehouse.add") return { success: true, name: "bq", type: "bigquery" }
      if (method === "schema.cache_status") return { total_tables: 0 }
      if (method === "warehouse.list") return { warehouses: [{ name: "bq" }] }
      return {}
    })

    const tool = await WarehouseAddTool.init()
    const result = await tool.execute(
      { name: "bq", config: { type: "bigquery", project: "p", location: null as any } },
      ctx as any,
    )

    expect(result.output).toContain('no "location" set')
  })
})

// ---------------------------------------------------------------------------
// 4. finops getQueryHistory surfaces bq_region
// ---------------------------------------------------------------------------

describe("getQueryHistory — bq_region in response", () => {
  beforeEach(() => {
    Registry.reset()
    process.env.ALTIMATE_TELEMETRY_DISABLED = "true"
  })

  afterEach(() => {
    Registry.reset()
    delete process.env.ALTIMATE_TELEMETRY_DISABLED
  })

  test("bq_region appears on the error result when a BQ connector fails", async () => {
    // No connector registered → Registry.get() will throw → we exercise
    // the catch branch of getQueryHistory. The key invariant: the response
    // still carries bq_region so the agent can tell which region was queried.
    Registry.setConfigs({
      "bq-eu": { type: "bigquery", project: "p", location: "eu" } as any,
    })

    const result = await getQueryHistory({ warehouse: "bq-eu" })
    expect(result.success).toBe(false)
    expect(result.bq_region).toBe("eu")
  })

  test("bq_region defaults to 'us' when BQ warehouse has no location set", async () => {
    Registry.setConfigs({
      "bq-default": { type: "bigquery", project: "p" } as any,
    })

    const result = await getQueryHistory({ warehouse: "bq-default" })
    expect(result.success).toBe(false)
    expect(result.bq_region).toBe("us")
  })

  test("bq_region sanitises malicious location values before exposing them", async () => {
    Registry.setConfigs({
      "bq-evil": { type: "bigquery", project: "p", location: "us`; DROP TABLE X" } as any,
    })

    const result = await getQueryHistory({ warehouse: "bq-evil" })
    expect(result.bq_region).toBe("usdroptablex")
    expect(result.bq_region).not.toContain("`")
    expect(result.bq_region).not.toContain(";")
  })

  test("bq_region is absent for non-BigQuery warehouses", async () => {
    Registry.setConfigs({
      "sf": { type: "snowflake", account: "xy", user: "u", password: "p" } as any,
    })

    const result = await getQueryHistory({ warehouse: "sf" })
    expect(result.bq_region).toBeUndefined()
  })

  test("bq_region is absent when no warehouse is registered (unknown type)", async () => {
    Registry.setConfigs({})
    const result = await getQueryHistory({ warehouse: "nonexistent" })
    expect(result.success).toBe(false)
    expect(result.bq_region).toBeUndefined()
  })
})
