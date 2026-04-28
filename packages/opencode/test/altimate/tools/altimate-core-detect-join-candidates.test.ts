/**
 * Tests for AltimateCoreDetectJoinCandidatesTool — cross-DB join key inference.
 *
 * Four layers of coverage:
 *   1. Pure algorithm (commonPrefix): catches the prefix-overlap edge cases.
 *   2. Pure algorithm (detectJoinCandidatesFromBags): catches the suffix-overlap
 *      and ranking semantics.
 *   3. Dialect-aware SQL emission (buildSampleSql): proves the detector emits
 *      portable SQL for MySQL, T-SQL, ClickHouse, and ANSI dialects.
 *   4. Integration: a real bun:sqlite Connector pair holding the canonical
 *      `businessid_X` ↔ `businessref_X` pattern, driven through the native
 *      handler with `Registry.get` stubbed to return our test connectors.
 *   5. Tool surface: title/output formatting, permission-gating, dispatcher
 *      contract, and the success=false envelope.
 */

import { describe, test, expect, spyOn, beforeEach, afterEach } from "bun:test"
import { Database } from "bun:sqlite"
import * as Dispatcher from "../../../src/altimate/native/dispatcher"
import * as Registry from "../../../src/altimate/native/connections/registry"
import {
  buildSampleSql,
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
    expect(out[0].match_score).toBeCloseTo(0.75, 5)
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

  test("ranks by suffix_overlap descending, then by match_score", () => {
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
// 3. Pure: buildSampleSql — dialect-aware identifier quoting
// ---------------------------------------------------------------------------

describe("buildSampleSql (dialect-aware quoting)", () => {
  test("uses backticks on MySQL/MariaDB/ClickHouse", () => {
    expect(buildSampleSql("mysql", "ops", "invoices", "business_id")).toBe(
      "SELECT `business_id` FROM `ops`.`invoices` WHERE `business_id` IS NOT NULL",
    )
    expect(buildSampleSql("clickhouse", undefined, "events", "user_id")).toBe(
      "SELECT `user_id` FROM `events` WHERE `user_id` IS NOT NULL",
    )
  })

  test("uses square brackets on T-SQL / Fabric / SQL Server", () => {
    expect(buildSampleSql("tsql", "dbo", "Orders", "CustomerKey")).toBe(
      "SELECT [CustomerKey] FROM [dbo].[Orders] WHERE [CustomerKey] IS NOT NULL",
    )
    expect(buildSampleSql("fabric", undefined, "DimUser", "id")).toBe(
      "SELECT [id] FROM [DimUser] WHERE [id] IS NOT NULL",
    )
  })

  test("uses ANSI double quotes on Postgres / Snowflake / BigQuery / unknown", () => {
    expect(buildSampleSql("postgres", "public", "orders", "user_id")).toBe(
      'SELECT "user_id" FROM "public"."orders" WHERE "user_id" IS NOT NULL',
    )
    expect(buildSampleSql("snowflake", "ANALYTICS", "EVENTS", "ACCOUNT_ID")).toBe(
      'SELECT "ACCOUNT_ID" FROM "ANALYTICS"."EVENTS" WHERE "ACCOUNT_ID" IS NOT NULL',
    )
    expect(buildSampleSql("generic", undefined, "t", "c")).toBe(
      'SELECT "c" FROM "t" WHERE "c" IS NOT NULL',
    )
  })

  test("does NOT include a LIMIT clause — drivers handle row capping", () => {
    // Hardcoded LIMIT breaks SQL Server / pre-12c Oracle. The detector relies
    // on `Connector.execute(sql, sampleSize)` instead so each driver can use
    // its own dialect-specific limit syntax (TOP, FETCH FIRST, LIMIT, etc).
    const sql = buildSampleSql("postgres", "public", "t", "c")
    expect(sql).not.toMatch(/\bLIMIT\b/i)
    expect(sql).not.toMatch(/\bTOP\b/i)
    expect(sql).not.toMatch(/\bFETCH\s+FIRST\b/i)
  })

  test("escapes embedded delimiter characters per dialect", () => {
    // Backticks doubled on MySQL
    expect(buildSampleSql("mysql", undefined, "t`able", "c`ol")).toBe(
      "SELECT `c``ol` FROM `t``able` WHERE `c``ol` IS NOT NULL",
    )
    // Closing brackets doubled on T-SQL
    expect(buildSampleSql("tsql", undefined, "t]bl", "c]ol")).toBe(
      "SELECT [c]]ol] FROM [t]]bl] WHERE [c]]ol] IS NOT NULL",
    )
    // Double quotes doubled on ANSI
    expect(buildSampleSql("postgres", undefined, 't"bl', 'c"ol')).toBe(
      'SELECT "c""ol" FROM "t""bl" WHERE "c""ol" IS NOT NULL',
    )
  })
})

// ---------------------------------------------------------------------------
// 4. Integration: SQLite-backed Connectors driven through the native handler
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
    async execute(sql: string, limit?: number): Promise<ConnectorResult> {
      // The detector no longer inlines LIMIT; mimic the production sqlite driver
      // by appending it from the `limit` argument when missing.
      let query = sql
      if (limit && /^\s*select/i.test(sql) && !/\bLIMIT\b/i.test(sql)) {
        query = `${sql.replace(/;\s*$/, "")} LIMIT ${limit + 1}`
      }
      const stmt = db.prepare(query)
      const rows = stmt.all() as Array<Record<string, unknown>>
      const columns = rows.length > 0 ? Object.keys(rows[0]) : []
      const truncated = limit ? rows.length > limit : false
      const limitedRows = limit && truncated ? rows.slice(0, limit) : rows
      return {
        columns,
        rows: limitedRows.map((r) => columns.map((c) => r[c])),
        row_count: limitedRows.length,
        truncated,
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
      'CREATE TABLE invoices (id INTEGER PRIMARY KEY, "business_id" TEXT NOT NULL, amount INTEGER)',
    )
    const insertOps = opsDb.prepare('INSERT INTO invoices("business_id", amount) VALUES (?, ?)')
    for (let i = 1; i <= 10; i++) insertOps.run(`businessid_${i}`, i * 100)

    crmDb = new Database(":memory:")
    crmDb.exec('CREATE TABLE accounts (id INTEGER PRIMARY KEY, "business_ref" TEXT NOT NULL)')
    const insertCrm = crmDb.prepare('INSERT INTO accounts("business_ref") VALUES (?)')
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
    // match_score replaces the previous `confidence` field.
    expect(typeof top.match_score).toBe("number")
    expect(top).not.toHaveProperty("confidence")
  })

  test("filters out non-string columns (INTEGER amount is not sampled)", async () => {
    const result = await detectJoinCandidates({
      connections: ["ops", "crm"],
      sample_size: 50,
    })
    expect(result.success).toBe(true)
    // bags_scanned counts (db, table, column) bags of non-empty string samples.
    // Two string columns total — business_id on ops, business_ref on crm.
    expect(result.data.bags_scanned).toBe(2)
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

  test("surfaces per-table sampling failures via partial_errors", async () => {
    // listSchemas → ["main"]; listTables succeeds; but describeTable on a
    // bogus table will throw. We exercise the partial-error path by stubbing
    // a connector whose describeTable rejects on a specific table.
    const opsConn: Connector = {
      async connect() {},
      async close() {},
      async execute() {
        return { columns: [], rows: [], row_count: 0, truncated: false }
      },
      async listSchemas() {
        return ["main"]
      },
      async listTables() {
        return [{ name: "t_ok", type: "table" }, { name: "t_perm_denied", type: "table" }]
      },
      async describeTable(_schema, table) {
        if (table === "t_perm_denied") throw new Error("permission denied: t_perm_denied")
        return [{ name: "id", data_type: "TEXT", nullable: false }]
      },
    }
    const crmConn = makeSqliteConnector(new Database(":memory:"))
    const spy = spyOn(Registry, "get").mockImplementation(async (name: string) => {
      if (name === "ops") return opsConn
      if (name === "crm") return crmConn
      throw new Error(`Unknown: ${name}`)
    })
    try {
      const result = await detectJoinCandidates({
        connections: ["ops", "crm"],
        sample_size: 50,
      })
      expect(result.success).toBe(true)
      const partial = (result.data.partial_errors ?? {}) as Record<string, string[]>
      expect(partial.ops?.length ?? 0).toBeGreaterThan(0)
      expect(partial.ops?.[0]).toMatch(/t_perm_denied/)
    } finally {
      spy.mockRestore()
    }
  })

  test("surfaces listSchemas failures as a connection error (no `public` fallback)", async () => {
    const brokenConn: Connector = {
      async connect() {},
      async close() {},
      async execute() {
        return { columns: [], rows: [], row_count: 0, truncated: false }
      },
      async listSchemas() {
        throw new Error("permission denied: list schemas")
      },
      async listTables() {
        return []
      },
      async describeTable() {
        return []
      },
    }
    const opsConn = makeSqliteConnector(new Database(":memory:"))
    const spy = spyOn(Registry, "get").mockImplementation(async (name: string) => {
      if (name === "broken") return brokenConn
      if (name === "ops") return opsConn
      throw new Error(`Unknown: ${name}`)
    })
    try {
      const result = await detectJoinCandidates({
        connections: ["ops", "broken"],
        sample_size: 50,
      })
      expect(result.success).toBe(true)
      const errors = (result.data.connection_errors ?? {}) as Record<string, string>
      expect(errors.broken).toMatch(/list schemas|permission denied/i)
    } finally {
      spy.mockRestore()
    }
  })
})

// ---------------------------------------------------------------------------
// 5. Tool surface: title/output formatting and dispatcher contract
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
            match_score: 0.8,
          },
        ],
        bags_scanned: 4,
        connection_errors: {},
        partial_errors: {},
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
    expect(String(result.output)).toContain("match_score")
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

  test("appends partial errors when present", () => {
    const out = toolInternals.formatCandidates([], {}, {
      ops: ["sample(main.t.c): permission denied", "describeTable(main.x): timeout"],
    })
    expect(out).toContain("Partial errors")
    expect(out).toContain("permission denied")
    expect(out).toContain("ops: 2 error(s)")
  })

  test("returns FAILED envelope when dispatcher returns success: false", async () => {
    mockDispatcher({
      success: false,
      data: {},
      error: "detect_join_candidates requires at least two warehouse connections.",
    })
    const tool = await AltimateCoreDetectJoinCandidatesTool.init()
    const result = await tool.execute(
      { connections: ["a", "b"] },
      ctx as never,
    )
    expect(result.metadata.success).toBe(false)
    expect(result.title).toContain("FAILED")
    expect(String(result.output)).toContain("at least two")
    // Must NOT silently render "0 found".
    expect(result.title).not.toContain("0 found")
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

  test("requests sql_execute_read permission before issuing any SELECT", async () => {
    const askCalls: unknown[] = []
    const askingCtx = {
      ...ctx,
      ask: async (req: unknown) => {
        askCalls.push(req)
      },
    }
    mockDispatcher({
      success: true,
      data: {
        candidates: [],
        bags_scanned: 0,
        connection_errors: {},
        partial_errors: {},
      },
    })
    const tool = await AltimateCoreDetectJoinCandidatesTool.init()
    await tool.execute({ connections: ["a", "b"] }, askingCtx as never)
    expect(askCalls).toHaveLength(1)
    expect((askCalls[0] as { permission: string }).permission).toBe("sql_execute_read")
  })

  test("rejects sample_size above the configured upper bound", async () => {
    const tool = await AltimateCoreDetectJoinCandidatesTool.init()
    await expect(
      tool.execute(
        { connections: ["a", "b"], sample_size: 1_000_000 },
        ctx as never,
      ),
    ).rejects.toThrow()
  })

  test("rejects max_tables_per_connection above the configured upper bound", async () => {
    const tool = await AltimateCoreDetectJoinCandidatesTool.init()
    await expect(
      tool.execute(
        { connections: ["a", "b"], max_tables_per_connection: 999_999 },
        ctx as never,
      ),
    ).rejects.toThrow()
  })

  test("rejects connections array longer than the configured upper bound", async () => {
    const tool = await AltimateCoreDetectJoinCandidatesTool.init()
    const tooMany = Array.from({ length: 100 }, (_, i) => `conn_${i}`)
    await expect(
      tool.execute({ connections: tooMany }, ctx as never),
    ).rejects.toThrow()
  })
})
