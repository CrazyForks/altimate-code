import { describe, expect, test } from "bun:test"
import { Verifier } from "../../src/router/verifier"
import { EquivalenceVerifier } from "../../src/router/equivalence-verifier"

const { Decision, Strength } = Verifier

// a fallback that records whether it was consulted
function recordingFallback(verdict: Verifier.Verdict) {
  let called = false
  const impl: Verifier.Impl = { verify: async () => { called = true; return verdict } }
  return { impl, called: () => called }
}

const resolver = (pairs: EquivalenceVerifier.Pair[] | null): EquivalenceVerifier.ReferenceResolver => ({
  resolve: async () => pairs,
})

describe("EquivalenceVerifier", () => {
  test("all models proven equivalent → OK at EQUIVALENCE strength, no fallback", async () => {
    const fb = recordingFallback({ ok: true, checks: [] })
    const impl = EquivalenceVerifier.create(
      async () => ({ equivalent: true, confidence: 0.95 }),
      resolver([{ model: "m1", baseSql: "a", headSql: "a" }]),
      fb.impl,
    )
    const v = await impl.verify("/ws")
    expect(v.decision).toBe(Decision.OK)
    expect(v.strength).toBe(Strength.EQUIVALENCE)
    expect(v.ok).toBe(true)
    expect(fb.called()).toBe(false)
  })

  test("a proven material difference → PROVEN_DIFFERENT, no fallback (escalation-worthy)", async () => {
    const fb = recordingFallback({ ok: true, checks: [] })
    const impl = EquivalenceVerifier.create(
      async () => ({ equivalent: false, differences: [{ severity: "semantic", description: "extra filter" }] }),
      resolver([{ model: "m1", baseSql: "a", headSql: "b" }]),
      fb.impl,
    )
    const v = await impl.verify("/ws")
    expect(v.decision).toBe(Decision.PROVEN_DIFFERENT)
    expect(v.ok).toBe(false)
    expect(fb.called()).toBe(false)
  })

  test("undecidable equivalence + fallback PASSES → OK at BUILD strength (ok⟺OK invariant holds)", async () => {
    const fb = recordingFallback({ ok: true, strength: Strength.BUILD, decision: Decision.OK, checks: [{ name: "dbt build", ok: true }] })
    const impl = EquivalenceVerifier.create(
      async () => ({ equivalent: false, validation_errors: ["unsupported: STRFTIME"] }),
      resolver([{ model: "m1", baseSql: "a", headSql: "b" }]),
      fb.impl,
    )
    const v = await impl.verify("/ws")
    expect(fb.called()).toBe(true)
    expect(v.ok).toBe(true)
    expect(v.decision).toBe(Decision.OK) // accepted; NOT silently UNDECIDABLE (ok⟺OK)
    expect(v.strength).toBe(Strength.BUILD) // the "equivalence couldn't decide" fact lives here
    expect(v.reason).toContain("undecidable")
  })

  test("undecidable equivalence + fallback FAILS → FAILED (must escalate, not be swallowed)", async () => {
    const fb = recordingFallback({ ok: false, strength: Strength.BUILD, decision: Decision.FAILED, checks: [{ name: "dbt build", ok: false }] })
    const impl = EquivalenceVerifier.create(
      async () => ({ equivalent: false, validation_errors: ["unsupported: STRFTIME"] }),
      resolver([{ model: "m1", baseSql: "a", headSql: "b" }]),
      fb.impl,
    )
    const v = await impl.verify("/ws")
    expect(fb.called()).toBe(true)
    expect(v.ok).toBe(false)
    expect(v.decision).toBe(Decision.FAILED) // a real build failure must surface as FAILED so the router escalates
  })

  test("greenfield (no reference) → uses fallback verifier directly", async () => {
    const fb = recordingFallback({ ok: true, strength: Strength.BUILD, decision: Decision.OK, checks: [] })
    const impl = EquivalenceVerifier.create(async () => ({ equivalent: true }), resolver(null), fb.impl)
    const v = await impl.verify("/ws")
    expect(fb.called()).toBe(true)
    expect(v.strength).toBe(Strength.BUILD)
  })

  test("equivalence engine throw on one model → undecidable (NOT 'different'), routes to fallback", async () => {
    const fb = recordingFallback({ ok: true, strength: Strength.BUILD, decision: Decision.OK, checks: [] })
    const impl = EquivalenceVerifier.create(
      async () => { throw new Error("napi panic") },
      resolver([{ model: "m1", baseSql: "a", headSql: "b" }]),
      fb.impl,
    )
    const v = await impl.verify("/ws")
    // engine error ⇒ undecidable (NOT PROVEN_DIFFERENT) ⇒ fallback consulted, decision from fallback
    expect(fb.called()).toBe(true)
    expect(v.decision).not.toBe(Decision.PROVEN_DIFFERENT)
    expect(v.decision).toBe(Decision.OK) // fallback passed → accepted at BUILD strength
    expect(v.strength).toBe(Strength.BUILD)
  })

  test("resolver throw → degrade to fallback (fail-open, honest)", async () => {
    const fb = recordingFallback({ ok: true, unverifiable: true, strength: Strength.UNVERIFIABLE, decision: Decision.UNDECIDABLE, checks: [] })
    const impl = EquivalenceVerifier.create(
      async () => ({ equivalent: true }),
      { resolve: async () => { throw new Error("git failed") } },
      fb.impl,
    )
    const v = await impl.verify("/ws")
    expect(fb.called()).toBe(true)
    expect(v.strength).toBe(Strength.UNVERIFIABLE)
  })
})
