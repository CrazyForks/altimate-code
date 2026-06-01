import { describe, expect, test } from "bun:test"
import { Verifier } from "../../src/router/verifier"
import { Router } from "../../src/router/router"
import { Verdict } from "../../src/router/verdict"

const { Strength, Decision } = Verifier
const PASS = "Done. PASS=5 WARN=0 ERROR=0 SKIP=0 TOTAL=5"
const FAIL = "Failure in test not_null_x (models/schema.yml)\nDone. PASS=4 WARN=0 ERROR=1 SKIP=0 TOTAL=5"

describe("fromDbt sets strength + decision", () => {
  test("clean build → BUILD / OK", () => {
    const v = Verifier.fromDbt(PASS, 0)
    expect(v.ok).toBe(true)
    expect(v.strength).toBe(Strength.BUILD)
    expect(v.decision).toBe(Decision.OK)
  })
  test("failed build → BUILD / FAILED", () => {
    const v = Verifier.fromDbt(FAIL, 1)
    expect(v.ok).toBe(false)
    expect(v.strength).toBe(Strength.BUILD)
    expect(v.decision).toBe(Decision.FAILED)
  })
  // Regression: non-zero exit with a CLEAN summary (e.g. dbt killed/OOM mid-run) must
  // still be FAILED with a reason set — the `else if (exitCode !== 0)` branch IS reachable.
  test("non-zero exit + clean summary → FAILED with reason (not a silent pass)", () => {
    const v = Verifier.fromDbt("Done. PASS=5 WARN=0 ERROR=0 SKIP=0 TOTAL=5", 5)
    expect(v.ok).toBe(false)
    expect(v.decision).toBe(Decision.FAILED)
    expect(v.reason).toContain("exited 5")
  })
})

describe("fromEquivalence folds per-model results soundly", () => {
  test("all equivalent → OK at EQUIVALENCE strength", () => {
    const v = Verifier.fromEquivalence([
      { model: "a", result: { equivalent: true, confidence: 0.95 } },
      { model: "b", result: { equivalent: true, confidence: 0.9 } },
    ])
    expect(v.ok).toBe(true)
    expect(v.decision).toBe(Decision.OK)
    expect(v.strength).toBe(Strength.EQUIVALENCE)
    expect(v.confidence).toBe(0.9) // min across models
  })

  test("a material difference → PROVEN_DIFFERENT, not ok", () => {
    const v = Verifier.fromEquivalence([
      { model: "a", result: { equivalent: true } },
      { model: "b", result: { equivalent: false, differences: [{ description: "extra row" }] } },
    ])
    expect(v.ok).toBe(false)
    expect(v.decision).toBe(Decision.PROVEN_DIFFERENT)
    expect(v.strength).toBe(Strength.EQUIVALENCE)
    expect(v.reason).toContain("b")
  })

  test("validation errors → UNDECIDABLE (NOT different), drops to BUILD strength", () => {
    const v = Verifier.fromEquivalence([
      { model: "a", result: { equivalent: false, validation_errors: ["unsupported: QUALIFY"] } },
    ])
    expect(v.ok).toBe(false)
    expect(v.decision).toBe(Decision.UNDECIDABLE)
    expect(v.strength).toBe(Strength.BUILD)
  })

  test("proven-different outranks undecidable", () => {
    const v = Verifier.fromEquivalence([
      { model: "a", result: { equivalent: false, validation_errors: ["undecidable"] } },
      { model: "b", result: { equivalent: false, differences: [{ severity: "Semantic" }] } },
    ])
    expect(v.decision).toBe(Decision.PROVEN_DIFFERENT)
  })

  test("no reference resolved → UNDECIDABLE / UNVERIFIABLE (never silent pass)", () => {
    const v = Verifier.fromEquivalence([])
    expect(v.ok).toBe(false)
    expect(v.decision).toBe(Decision.UNDECIDABLE)
    expect(v.strength).toBe(Strength.UNVERIFIABLE)
  })
})

describe("Router.shouldEscalate is decision-aware", () => {
  const tiers: Router.Tier[] = [{ model: "m1", label: "m1" }, { model: "m2", label: "m2" }]
  const mk = (decision: Verifier.Decision): Verifier.Verdict => ({ ok: decision === Decision.OK, decision, checks: [] })

  test("FAILED escalates", () => expect(Router.shouldEscalate(mk(Decision.FAILED), 0, tiers)).toBe(true))
  test("PROVEN_DIFFERENT escalates", () => expect(Router.shouldEscalate(mk(Decision.PROVEN_DIFFERENT), 0, tiers)).toBe(true))
  test("UNDECIDABLE does NOT escalate (fallback, not stronger model)", () =>
    expect(Router.shouldEscalate(mk(Decision.UNDECIDABLE), 0, tiers)).toBe(false))
  test("OK does NOT escalate", () => expect(Router.shouldEscalate(mk(Decision.OK), 0, tiers)).toBe(false))
  test("never escalates past the last tier", () =>
    expect(Router.shouldEscalate(mk(Decision.FAILED), 1, tiers)).toBe(false))
  test("legacy verdict without decision falls back to !ok", () => {
    expect(Router.shouldEscalate({ ok: false, checks: [] }, 0, tiers)).toBe(true)
    expect(Router.shouldEscalate({ ok: true, checks: [] }, 0, tiers)).toBe(false)
  })
})

describe("Verdict.Envelope carries strength + decision (v2)", () => {
  test("schema version bumped to 2", () => expect(Verdict.SCHEMA_VERSION).toBe("2"))
  test("envelope records the accepted result's strength + decision", () => {
    const result: Router.RouteResult = {
      solved: true,
      solvedBy: { model: "m1", label: "m1" },
      attempts: [
        { tier: { model: "m1", label: "m1" }, verdict: Verifier.fromEquivalence([{ model: "x", result: { equivalent: true, confidence: 0.95 } }]) },
      ],
    }
    const env = Verdict.build(result, { now: "2026-05-31T00:00:00Z" })
    expect(env.schemaVersion).toBe("2")
    expect(env.strength).toBe(Strength.EQUIVALENCE)
    expect(env.decision).toBe(Decision.OK)
    expect(env.attempts[0].strength).toBe(Strength.EQUIVALENCE)
    expect(env.attempts[0].decision).toBe(Decision.OK)
  })
})
