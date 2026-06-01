import { afterEach, describe, expect, test } from "bun:test"
import { Router } from "../../src/router/router"
import { Verifier } from "../../src/router/verifier"

const OK: Verifier.Verdict = { ok: true, checks: [{ name: "dbt build", ok: true }] }
const FAIL: Verifier.Verdict = {
  ok: false,
  reason: "1 dbt error(s) — failing: not_null_x",
  checks: [{ name: "not_null_x", ok: false, detail: "Failure in test not_null_x" }],
}

afterEach(() => {
  delete process.env["ALTIMATE_ROUTER"]
  delete process.env["ALTIMATE_ROUTER_LADDER"]
})

describe("Router config", () => {
  test("enabled reads the flag", () => {
    expect(Router.enabled()).toBe(false)
    process.env["ALTIMATE_ROUTER"] = "1"
    expect(Router.enabled()).toBe(true)
  })
  test("default ladder is cheap→strong", () => {
    expect(Router.DEFAULT_LADDER[0].label).toBe("deepseek-v4-flash")
    expect(Router.DEFAULT_LADDER.at(-1)!.label).toBe("claude-opus-4.8")
  })
  test("ladder() honors env override", () => {
    process.env["ALTIMATE_ROUTER_LADDER"] = "openrouter/a/m1, openrouter/b/m2"
    const l = Router.ladder()
    expect(l.map((t) => t.label)).toEqual(["m1", "m2"])
  })
})

describe("Router.shouldEscalate", () => {
  const tiers = Router.DEFAULT_LADDER
  test("escalates on failure with tiers remaining", () => {
    expect(Router.shouldEscalate(FAIL, 0, tiers)).toBe(true)
  })
  test("does not escalate on success", () => {
    expect(Router.shouldEscalate(OK, 0, tiers)).toBe(false)
  })
  test("does not escalate past the top tier", () => {
    expect(Router.shouldEscalate(FAIL, tiers.length - 1, tiers)).toBe(false)
  })
})

describe("Router.shouldEscalate — decision-aware (soundness)", () => {
  const tiers = Router.DEFAULT_LADDER
  const D = Verifier.Decision
  const v = (decision: Verifier.Decision, ok = false): Verifier.Verdict => ({ ok, decision, checks: [] })

  test("escalates on a build/test FAILED verdict", () => {
    expect(Router.shouldEscalate(v(D.FAILED), 0, tiers)).toBe(true)
  })
  test("escalates on a PROVEN_DIFFERENT equivalence verdict", () => {
    expect(Router.shouldEscalate(v(D.PROVEN_DIFFERENT), 0, tiers)).toBe(true)
  })
  test("NEVER escalates on UNDECIDABLE — a stronger model can't make it decidable", () => {
    expect(Router.shouldEscalate(v(D.UNDECIDABLE), 0, tiers)).toBe(false)
    // even though ok is false, the decision gate wins over the legacy !ok rule
    expect(Router.shouldEscalate(v(D.UNDECIDABLE, false), 0, tiers)).toBe(false)
  })
  test("does not escalate on an OK decision", () => {
    expect(Router.shouldEscalate(v(D.OK, true), 0, tiers)).toBe(false)
  })
  test("falls back to the !ok rule when no decision is present (back-compat)", () => {
    expect(Router.shouldEscalate({ ok: false, checks: [] }, 0, tiers)).toBe(true)
    expect(Router.shouldEscalate({ ok: true, checks: [] }, 0, tiers)).toBe(false)
  })
  test("never escalates past the top tier regardless of decision", () => {
    expect(Router.shouldEscalate(v(D.PROVEN_DIFFERENT), tiers.length - 1, tiers)).toBe(false)
  })
})

describe("Router.route — decision-aware", () => {
  const D = Verifier.Decision
  test("UNDECIDABLE verdict stops routing (no escalation, marked unsolved)", async () => {
    const calls: string[] = []
    const r = await Router.route({
      tiers: Router.DEFAULT_LADDER,
      runAgent: async (m) => void calls.push(m),
      verify: async () => ({ ok: false, decision: D.UNDECIDABLE, reason: "engine abstained", checks: [] }),
    })
    expect(r.solved).toBe(false)
    expect(calls).toHaveLength(1) // only tier 0 ran — did NOT escalate on undecidable
    expect(r.attempts).toHaveLength(1)
  })
  test("PROVEN_DIFFERENT escalates to the next tier until one passes", async () => {
    const calls: string[] = []
    let n = 0
    const r = await Router.route({
      tiers: Router.DEFAULT_LADDER,
      runAgent: async (m) => void calls.push(m),
      verify: async () =>
        ++n === 1 ? { ok: false, decision: D.PROVEN_DIFFERENT, checks: [] } : { ok: true, decision: D.OK, checks: [] },
    })
    expect(r.solved).toBe(true)
    expect(calls.length).toBe(2)
  })
})

describe("Router.escalationContext", () => {
  test("names the failing checks + reason for the next tier", () => {
    const ctx = Router.escalationContext({ model: "m", label: "deepseek-v4-flash" }, FAIL)
    expect(ctx).toContain("deepseek-v4-flash")
    expect(ctx).toContain("not_null_x")
    expect(ctx).toContain("do not start over")
  })
})

describe("Router.route", () => {
  test("stops at tier 0 when it passes (no escalation)", async () => {
    const models: string[] = []
    const r = await Router.route({
      tiers: Router.DEFAULT_LADDER,
      runAgent: async (m) => void models.push(m),
      verify: async () => OK,
    })
    expect(r.solved).toBe(true)
    expect(r.solvedBy!.label).toBe("deepseek-v4-flash")
    expect(models).toHaveLength(1) // only the cheap tier ran
  })

  test("escalates through tiers until one passes, threading failure context", async () => {
    const calls: { model: string; note?: string }[] = []
    let n = 0
    const r = await Router.route({
      tiers: Router.DEFAULT_LADDER,
      runAgent: async (model, note) => void calls.push({ model, note }),
      verify: async () => (++n >= 2 ? OK : FAIL), // tier0 fails, tier1 passes
    })
    expect(r.solved).toBe(true)
    expect(r.solvedBy!.label).toBe("glm-5.1")
    expect(calls).toHaveLength(2)
    expect(calls[0].note).toBeUndefined()
    expect(calls[1].note).toContain("not_null_x") // tier1 got the failure context
  })

  test("a thrown runAgent error becomes a failed attempt and escalates (does not abort)", async () => {
    const calls: string[] = []
    let n = 0
    const r = await Router.route({
      tiers: Router.DEFAULT_LADDER,
      runAgent: async (m) => {
        calls.push(m)
        if (++n === 1) throw new Error("model API down") // tier 0 throws
      },
      verify: async () => OK, // tier 1 verifies ok
    })
    expect(r.solved).toBe(true)
    expect(r.solvedBy!.label).toBe("glm-5.1") // escalated past the throwing tier
    expect(calls).toHaveLength(2)
    expect(r.attempts[0].verdict.ok).toBe(false)
    expect(r.attempts[0].verdict.reason).toContain("tier error")
  })

  test("unsolved when every tier fails (records all attempts)", async () => {
    const r = await Router.route({
      tiers: Router.DEFAULT_LADDER,
      runAgent: async () => {},
      verify: async () => FAIL,
    })
    expect(r.solved).toBe(false)
    expect(r.attempts).toHaveLength(Router.DEFAULT_LADDER.length)
  })
})
