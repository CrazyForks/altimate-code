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

describe("ReferenceResolver.gitDbtDeps (orchestration, mocked exec)", () => {
  const mkExec = (calls: string[][], outputs: Record<string, { stdout: string; code: number }>) =>
    (async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args])
      return outputs[`${cmd} ${args[0]}`] ?? { stdout: "", code: 0 }
    }) as ReferenceResolver.Exec

  const baseOpts = (over: Partial<ReferenceResolver.GitDbtOptions> = {}): ReferenceResolver.GitDbtOptions => ({
    readCompiled: async () => new Map([["m1", "select 1"]]),
    buildSchema: async () => ({ schema: true }),
    checkoutBase: async () => ({ dir: "/tmp/base", cleanup: async () => {} }),
    ...over,
  })

  test("baseRef: HEAD present → sha; absent → null (greenfield)", async () => {
    const d1 = ReferenceResolver.gitDbtDeps(mkExec([], { "git rev-parse": { stdout: "abc123\n", code: 0 } }), baseOpts())
    expect(await d1.baseRef("/ws")).toBe("abc123")
    const d2 = ReferenceResolver.gitDbtDeps(mkExec([], { "git rev-parse": { stdout: "", code: 128 } }), baseOpts())
    expect(await d2.baseRef("/ws")).toBeNull()
  })

  test("changedModels: parses git diff to bare model names, filters non-.sql", async () => {
    const d = ReferenceResolver.gitDbtDeps(
      mkExec([], { "git diff": { stdout: "models/agg/m1.sql\nmodels/schema.yml\nmodels/dim/m2.sql\n", code: 0 } }),
      baseOpts(),
    )
    expect(await d.changedModels("/ws", "HEAD")).toEqual(["m1", "m2"])
  })

  test("compiledSql WORKING → dbt compile in workdir then readCompiled", async () => {
    const calls: string[][] = []
    const d = ReferenceResolver.gitDbtDeps(mkExec(calls, {}), baseOpts())
    const sql = await d.compiledSql("/ws", "WORKING")
    expect(sql.get("m1")).toBe("select 1")
    expect(calls.some((c) => c[0] === "dbt" && c[1] === "compile")).toBe(true)
  })

  test("compiledSql base → checkout, deps+compile in the checkout, cleanup always runs", async () => {
    let cleaned = false
    const d = ReferenceResolver.gitDbtDeps(
      mkExec([], {}),
      baseOpts({ checkoutBase: async () => ({ dir: "/tmp/base", cleanup: async () => { cleaned = true } }) }),
    )
    await d.compiledSql("/ws", "abc123")
    expect(cleaned).toBe(true)
  })
})
