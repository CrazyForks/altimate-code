import { afterAll, beforeAll, describe, expect, test } from "bun:test"

import { runDataDiff } from "../../src/altimate/native/connections/data-diff"
import * as Registry from "../../src/altimate/native/connections/registry"

const RUN = process.env.ALTIMATE_RUN_WAREHOUSE_E2E === "1"
const e2eTest = RUN ? test : test.skip

describe("data.diff DuckDB e2e", () => {
  beforeAll(() => {
    process.env.ALTIMATE_TELEMETRY_DISABLED = "true"
  })

  afterAll(() => {
    delete process.env.ALTIMATE_TELEMETRY_DISABLED
    Registry.reset()
  })

  e2eTest("detects value and row deltas through a real DuckDB warehouse", async () => {
    Registry.reset()
    Registry.setConfigs({ duck_e2e: { type: "duckdb", path: ":memory:" } })
    const conn = await Registry.get("duck_e2e")

    await conn.execute("CREATE TABLE base_orders (order_id INTEGER, amount INTEGER)")
    await conn.execute("CREATE TABLE head_orders (order_id INTEGER, amount INTEGER)")
    await conn.execute("INSERT INTO base_orders VALUES (1, 100), (2, 200)")
    await conn.execute("INSERT INTO head_orders VALUES (1, 100), (2, 250), (3, 300)")

    const result = await runDataDiff({
      source: "base_orders",
      target: "head_orders",
      key_columns: ["order_id"],
      extra_columns: ["amount"],
      source_warehouse: "duck_e2e",
      target_warehouse: "duck_e2e",
      algorithm: "joindiff",
    })

    expect(result.success).toBe(true)
    expect((result.outcome as any)?.mode).toBe("diff")
    expect((result.outcome as any)?.stats?.exclusive_table2).toBe(1)
    expect((result.outcome as any)?.stats?.updated).toBe(1)
  })
})
