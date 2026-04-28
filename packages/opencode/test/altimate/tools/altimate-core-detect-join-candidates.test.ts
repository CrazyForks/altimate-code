/**
 * Tests for AltimateCoreDetectJoinCandidatesTool — cross-DB join key inference.
 *
 * Three layers of coverage:
 *   1. Pure algorithm (commonPrefix): catches the prefix-overlap edge cases.
 *   2. Pure algorithm (detectJoinCandidatesFromBags): catches the suffix-overlap
 *      and ranking semantics.
 *   3. Integration: a real bun:sqlite Connector pair holding the canonical
 *      `businessid_X` ↔ `businessref_X` pattern, driven through the native
 *      handler with `Registry.get` stubbed to return our test connectors.
 */

import { describe, test, expect, spyOn, beforeEach, afterEach } from "bun:test"
import { Database } from "bun:sqlite"
import * as Dispatcher from "../../../src/altimate/native/dispatcher"
import * as Registry from "../../../src/altimate/native/connections/registry"
import {
  commonPrefix,
  detectJoinCandidatesFromBags,
  detectJoinCandidates,
  type ColumnSampleBag,
} from "../../../src/altimate/native/connections/detect-join-candidates"
import {
  AltimateCoreDetectJoinCandidatesTool,
  _altimateCoreDetectJoinCandidatesInternal as toolInternals,
} from "../../../src/altimate/tools/altimate-core-detect-join-candidates"
import { SessionID, MessageID } from "../../../src/session/schema"
import type { Connector, ConnectorResult, SchemaColumn } from "@altimateai/drivers"

beforeEach(() => {
  process.env.ALTIMATE_TELEMETRY_DISABLED = "true"
})

afterEach(() => {
  delete process.env.ALTIMATE_TELEMETRY_DISABLED
})

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

// ---------------------------------------------------------------------------
// 1. Pure: commonPrefix — prefix-overlap edge cases
// ---------------------------------------------------------------------------

describe("commonPrefix", () => {
  test("returns the full prefix when it already ends in `_`", () => {
    expect(commonPrefix(["businessid_1", "businessid_2", "businessid_42"])).toBe("businessid_")
  })

  test("walks back to the last separator when the LCP overshoots a token", () => {
    // LCP is "biz_alpha", which is a partial token — must be trimmed back to "biz_".
    expect(commonPrefix(["biz_alpha1", "biz_alpha2", "biz_alpha3", "biz_alpha"])).toBe("biz_")
  })

  test("supports `-` and `:` as separators", () => {
    expect(commonPrefix(["region-eu-1", "region-eu-2"])).toBe("region-eu-")
    expect(commonPrefix(["urn:abc:1", "urn:abc:2"])).toBe("urn:abc:")
  })

  test("returns empty string when no separator is present in the LCP", () => {
    // "abcd" / "abce" share LCP "abc" but no separator — not a join key shape.
    expect(commonPrefix(["abcd", "abce"])).toBe("")
  })

  test("returns empty string when values share nothing", () => {
    expect(commonPrefix(["red", "blue"])).toBe("")
  })

  test("returns empty string for an empty input", () => {
    expect(commonPrefix([])).toBe("")
  })

  test("ignores non-string entries defensively", () => {
    // The runtime contract restricts to strings, but the helper must not throw
    // if a malformed bag slips through.
    const bag = ["id_1", "id_2", null, undefined, 7] as unknown as string[]
    expect(commonPrefix(bag)).toBe("id_")
  })
})

// ---------------------------------------------------------------------------
// 2. Pure: detectJoinCandidatesFromBags — suffix-overlap & ranking
// ---------------------------------------------------------------------------

describe("detectJoinCandidatesFromBags", () => {
  test("emits a candidate for the canonical businessid_/businessref_ pattern", () => {
    const bags: ColumnSampleBag[] = [
      {
        db: "ops",
        table: "main.invoices",
        column: "business_id",
        values: ["businessid_1", "businessid_2", "businessid_3", "businessid_4"],
      },
      {
        db: "crm",
        table: "main.accounts",
        column: "business_ref",
        values: ["businessref_1", "businessref_2", "businessref_3", "businessref_5"],
      },
    ]
    const out = detectJoinCandidatesFromBags(bags)
    expect(out).toHaveLength(1)
    expect(out[0].left_db).toBe("ops")
    expect(out[0].right_db).toBe("crm")
    expect(out[0].prefix_rule).toEqual({ left: "businessid_", right: "businessref_" })
    // Suffixes 1, 2, 3 overlap; 4 vs 5 does not.
    expect(out[0].suffix_overlap).toBe(3)
    expect(out[0].confidence).toBeCloseTo(0.75, 5)
  })

  test("rejects same-DB pairs (cross-DB only)", () => {
    const bags: ColumnSampleBag[] = [
      { db: "x", table: "t", column: "a", values: ["aa_1", "aa_2"] },
      { db: "x", table: "u", column: "b", values: ["bb_1", "bb_2"] },
    ]
    expect(detectJoinCandidatesFromBags(bags)).toEqual([])
  })

  test("rejects pairs with identical prefixes (no transformation needed)", () => {
    const bags: ColumnSampleBag[] = [
      { db: "x", table: "t", column: "a", values: ["id_1", "id_2"] },
      { db: "y", table: "u", column: "b", values: ["id_1", "id_2"] },
    ]
    expect(detectJoinCandidatesFromBags(bags)).toEqual([])
  })

  test("rejects pairs with zero suffix overlap", () => {
    const bags: ColumnSampleBag[] = [
      { db: "x", table: "t", column: "a", values: ["foo_1", "foo_2"] },
      { db: "y", table: "u", column: "b", values: ["bar_9", "bar_8"] },
    ]
    expect(detectJoinCandidatesFromBags(bags)).toEqual([])
  })

  test("rejects pairs whose LCP has no separator (not a join key shape)", () => {
    const bags: ColumnSampleBag[] = [
      { db: "x", table: "t", column: "a", values: ["abcd", "abce"] },
      { db: "y", table: "u", column: "b", values: ["xyzd", "xyze"] },
    ]
    expect(detectJoinCandidatesFromBags(bags)).toEqual([])
  })

  test("ranks by suffix_overlap descending, then by confidence", () => {
    const bags: ColumnSampleBag[] = [
      // pair A: 1 overlap
      { db: "a1", table: "t", column: "k", values: ["aa_1", "aa_99"] },
      { db: "a2", table: "t", column: "k", values: ["bb_1", "bb_42"] },
      // pair B: 3 overlaps — should outrank pair A
      { db: "b1", table: "t", column: "k", values: ["cc_1", "cc_2", "cc_3"] },
      { db: "b2", table: "t", column: "k", values: ["dd_1", "dd_2", "dd_3"] },
    ]
    const out = detectJoinCandidatesFromBags(bags)
    // Pair B at position 0; pair A appears later.
    expect(out[0].suffix_overlap).toBe(3)
    expect(out[0].left_db).toBe("b1")
    expect(out.find((c) => c.left_db === "a1" && c.right_db === "a2")?.suffix_overlap).toBe(1)
  })

  test("produces N*(N-1)/2 cross-DB candidates when all pairs match", () => {
    const bags: ColumnSampleBag[] = [
      { db: "d1", table: "t", column: "k", values: ["x1_1", "x1_2"] },
      { db: "d2", table: "t", column: "k", values: ["x2_1", "x2_2"] },
      { db: "d3", table: "t", column: "k", values: ["x3_1", "x3_2"] },
    ]
    const out = detectJoinCandidatesFromBags(bags)
    expect(out).toHaveLength(3)
  })
})

// ---------------------------------------------------------------------------
// 3. Integration: SQLite-backed Connectors driven through the native handler
// ---------------------------------------------------------------------------

/**
 * Wrap a bun:sqlite Database in a minimal Connector for testing. We only need
 * the surface the detector touches: listSchemas, listTables, describeTable,
 * execute (SELECT-only).
 */
function makeSqliteConnector(db: Database): Connector {
  return {
    async connect() {},
    async close() {
      db.close()
    },
    async execute(sql: string): Promise<ConnectorResult> {
      const stmt = db.prepare(sql)
      const rows = stmt.all() as Array<Record<string, unknown>>
      const columns = rows.length > 0 ? Object.keys(rows[0]) : []
      return {
        columns,
        rows: rows.map((r) => columns.map((c) => r[c])),
        row_count: rows.length,
        truncated: false,
      }
    },
    async listSchemas() {
      return ["main"]
    },
    async listTables() {
      const rows = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all() as Array<{ name: string }>
      return rows.map((r) => ({ name: r.name, type: "table" }))
    },
    async describeTable(_schema: string, table: string): Promise<SchemaColumn[]> {
      const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
        name: string
        type: string
        notnull: number
      }>
      return rows.map((r) => ({
        name: r.name,
        // bun:sqlite returns the declared type verbatim — TEXT for our string columns.
        data_type: r.type || "TEXT",
        nullable: r.notnull === 0,
      }))
    },
  }
}

describe("detectJoinCandidates (integration with SQLite)", () => {
  let opsDb: Database
  let crmDb: Database
  let registrySpy: ReturnType<typeof spyOn> | undefined

  beforeEach(() => {
    opsDb = new Database(":memory:")
    opsDb.exec(
      "CREATE TABLE invoices (id INTEGER PRIMARY KEY, business_id TEXT NOT NULL, amount INTEGER)",
    )
    const insertOps = opsDb.prepare("INSERT INTO invoices(business_id, amount) VALUES (?, ?)")
    for (let i = 1; i <= 10; i++) insertOps.run(`businessid_${i}`, i * 100)

    crmDb = new Database(":memory:")
    crmDb.exec("CREATE TABLE accounts (id INTEGER PRIMARY KEY, business_ref TEXT NOT NULL)")
    const insertCrm = crmDb.prepare("INSERT INTO accounts(business_ref) VALUES (?)")
    // Suffixes 1..8 overlap with ops; 11, 12 do not.
    for (let i = 1; i <= 8; i++) insertCrm.run(`businessref_${i}`)
    insertCrm.run("businessref_11")
    insertCrm.run("businessref_12")

    const opsConn = makeSqliteConnector(opsDb)
    const crmConn = makeSqliteConnector(crmDb)

    registrySpy = spyOn(Registry, "get").mockImplementation(async (name: string) => {
      if (name === "ops") return opsConn
      if (name === "crm") return crmConn
      throw new Error(`Unknown test connection: ${name}`)
    })
  })

  afterEach(() => {
    registrySpy?.mockRestore()
    registrySpy = undefined
    try {
      opsDb.close()
    } catch {}
    try {
      crmDb.close()
    } catch {}
  })

  test("finds the businessid_/businessref_ join across two real SQLite DBs", async () => {
    const result = await detectJoinCandidates({
      connections: ["ops", "crm"],
      sample_size: 50,
    })
    expect(result.success).toBe(true)
    const candidates = (result.data.candidates ?? []) as Array<Record<string, unknown>>
    expect(candidates.length).toBeGreaterThan(0)
    const top = candidates[0]
    expect(top.left_db).toBe("ops")
    expect(top.right_db).toBe("crm")
    expect(top.left_col).toBe("business_id")
    expect(top.right_col).toBe("business_ref")
    expect(top.prefix_rule).toEqual({ left: "businessid_", right: "businessref_" })
    expect(top.suffix_overlap).toBe(8)
  })

  test("rejects calls with fewer than two connections", async () => {
    const result = await detectJoinCandidates({ connections: ["ops"] })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/at least two/i)
  })

  test("records connection errors without aborting the scan", async () => {
    const result = await detectJoinCandidates({
      connections: ["ops", "crm", "missing"],
      sample_size: 50,
    })
    expect(result.success).toBe(true)
    const errors = (result.data.connection_errors ?? {}) as Record<string, string>
    expect(errors.missing).toMatch(/Unknown test connection/)
    // The good pair still produced candidates.
    expect((result.data.candidates as unknown[]).length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// 4. Tool surface: title/output formatting and dispatcher contract
// ---------------------------------------------------------------------------

describe("AltimateCoreDetectJoinCandidatesTool.execute", () => {
  let dispatcherSpy: ReturnType<typeof spyOn> | undefined

  afterEach(() => {
    dispatcherSpy?.mockRestore()
    dispatcherSpy = undefined
  })

  function mockDispatcher(response: unknown) {
    dispatcherSpy?.mockRestore()
    dispatcherSpy = spyOn(Dispatcher, "call").mockImplementation(async () => response as never)
  }

  test("formats a non-empty candidate list with prefix rule and overlap", async () => {
    mockDispatcher({
      success: true,
      data: {
        candidates: [
          {
            left_db: "ops",
            left_table: "main.invoices",
            left_col: "business_id",
            right_db: "crm",
            right_table: "main.accounts",
            right_col: "business_ref",
            prefix_rule: { left: "businessid_", right: "businessref_" },
            suffix_overlap: 8,
            confidence: 0.8,
          },
        ],
        bags_scanned: 4,
        connection_errors: {},
      },
    })

    const tool = await AltimateCoreDetectJoinCandidatesTool.init()
    const result = await tool.execute(
      { connections: ["ops", "crm"] },
      ctx as never,
    )
    expect(result.metadata.success).toBe(true)
    expect(result.metadata.candidate_count).toBe(1)
    expect(result.title).toContain("1 found")
    expect(String(result.output)).toContain("businessid_")
    expect(String(result.output)).toContain("businessref_")
    expect(String(result.output)).toContain("8 matching suffix")
  })

  test("renders 'No cross-DB join candidates detected' when the list is empty", () => {
    const out = toolInternals.formatCandidates([], {})
    expect(out).toContain("No cross-DB join candidates detected")
  })

  test("appends connection errors when present", () => {
    const out = toolInternals.formatCandidates([], { broken: "ECONNREFUSED" })
    expect(out).toContain("Connection errors")
    expect(out).toContain("broken: ECONNREFUSED")
  })

  test("returns ERROR envelope when dispatcher throws", async () => {
    dispatcherSpy = spyOn(Dispatcher, "call").mockImplementation(async () => {
      throw new Error("dispatcher down")
    })
    const tool = await AltimateCoreDetectJoinCandidatesTool.init()
    const result = await tool.execute(
      { connections: ["a", "b"] },
      ctx as never,
    )
    expect(result.metadata.success).toBe(false)
    expect(result.title).toContain("ERROR")
    expect(String(result.output)).toContain("dispatcher down")
  })
})
