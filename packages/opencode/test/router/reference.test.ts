import { describe, expect, test } from "bun:test"
import { ReferenceResolver } from "../../src/router/reference"

const deps = (over: Partial<ReferenceResolver.Deps>): ReferenceResolver.Deps => ({
  baseRef: async () => "main",
  changedModels: async () => ["m1"],
  compiledSql: async (_w, ref) => new Map([["m1", ref === "WORKING" ? "select 1 as a" : "select 1 as b"]]),
  schema: async () => ({ schema: true }),
  ...over,
})

describe("ReferenceResolver", () => {
  test("no base ref → null (greenfield, caller uses build verifier)", async () => {
    const r = ReferenceResolver.create(deps({ baseRef: async () => null }))
    expect(await r.resolve("/ws")).toBeNull()
  })

  test("base exists but nothing changed → [] (nothing to verify)", async () => {
    const r = ReferenceResolver.create(deps({ changedModels: async () => [] }))
    expect(await r.resolve("/ws")).toEqual([])
  })

  test("changed model present on both sides → one pair with base/head compiled SQL + schema", async () => {
    const r = ReferenceResolver.create(deps({}))
    const pairs = await r.resolve("/ws")
    expect(pairs).toHaveLength(1)
    expect(pairs![0]).toMatchObject({ model: "m1", baseSql: "select 1 as b", headSql: "select 1 as a" })
    expect(pairs![0].schema).toEqual({ schema: true })
  })

  test("model new on head (no base compiled) is skipped — not equivalence-checkable", async () => {
    const r = ReferenceResolver.create(
      deps({
        changedModels: async () => ["m1", "m_new"],
        compiledSql: async (_w, ref) =>
          ref === "WORKING"
            ? new Map([["m1", "select 1"], ["m_new", "select 2"]])
            : new Map([["m1", "select 1 old"]]), // m_new absent at base
      }),
    )
    const pairs = await r.resolve("/ws")
    expect(pairs!.map((p) => p.model)).toEqual(["m1"]) // m_new dropped
  })
})
