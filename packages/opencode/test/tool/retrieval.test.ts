import { describe, expect, test } from "bun:test"
import { Retrieval } from "../../src/tool/retrieval"

const TOOLS = [
  ...Retrieval.CORE.map((name) => ({ name })),
  ...Array.from({ length: 20 }, (_, i) => ({ name: `warehouse_op${i}`, description: `warehouse operation ${i}` })),
  { name: "dbt_run", description: "run dbt models build" },
  { name: "sql_execute", description: "execute SQL query against warehouse" },
]

describe("Retrieval.select", () => {
  test("always keeps core tools", () => {
    const sel = Retrieval.select("run the dbt models", TOOLS, { topk: 12 })
    expect(sel.has("bash")).toBe(true)
    expect(sel.has("read")).toBe(true)
  })

  test("picks lexically relevant tools", () => {
    expect(Retrieval.select("run the dbt models and build", TOOLS, { topk: 12 }).has("dbt_run")).toBe(true)
    expect(Retrieval.select("execute a SQL query on the warehouse", TOOLS, { topk: 12 }).has("sql_execute")).toBe(true)
  })

  test("never drops in-flight (keep) tools, even if irrelevant", () => {
    const sel = Retrieval.select("hello", TOOLS, { topk: 12, keep: ["warehouse_op19"] })
    expect(sel.has("warehouse_op19")).toBe(true)
  })

  test("no-op for small tool sets (returns all)", () => {
    const small = [{ name: "a" }, { name: "b" }]
    expect(Retrieval.select("x", small, { topk: 12 }).size).toBe(2)
  })

  test("enabled() reads the env flag", () => {
    const prev = process.env["ALTIMATE_TOOL_RETRIEVAL"]
    process.env["ALTIMATE_TOOL_RETRIEVAL"] = "1"
    expect(Retrieval.enabled()).toBe(true)
    delete process.env["ALTIMATE_TOOL_RETRIEVAL"]
    expect(Retrieval.enabled()).toBe(false)
    if (prev !== undefined) process.env["ALTIMATE_TOOL_RETRIEVAL"] = prev
  })
})
