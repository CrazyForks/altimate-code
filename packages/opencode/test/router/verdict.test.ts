import { describe, expect, test } from "bun:test"
import { Verdict } from "../../src/router/verdict"
import type { Router } from "../../src/router/router"

const NOW = "2026-05-31T05:00:00.000Z"

const solvedResult: Router.RouteResult = {
  solved: true,
  solvedBy: { model: "openrouter/z-ai/glm-5.1", label: "glm-5.1" },
  attempts: [
    {
      tier: { model: "openrouter/deepseek/deepseek-v4-flash", label: "deepseek-v4-flash" },
      verdict: { ok: false, reason: "1 error — failing: not_null_x", checks: [{ name: "not_null_x", ok: false }] },
    },
    {
      tier: { model: "openrouter/z-ai/glm-5.1", label: "glm-5.1" },
      verdict: { ok: true, checks: [{ name: "dbt build", ok: true }], evidence: "PASS=12 ERROR=0" },
    },
  ],
}

const unsolvedResult: Router.RouteResult = {
  solved: false,
  attempts: [
    {
      tier: { model: "m", label: "deepseek-v4-flash" },
      verdict: { ok: false, reason: "fail", checks: [{ name: "t1", ok: false }], evidence: "ERROR=2" },
    },
  ],
}

describe("Verdict.evidenceHash", () => {
  test("deterministic + prefixed", () => {
    expect(Verdict.evidenceHash("abc")).toBe(Verdict.evidenceHash("abc"))
    expect(Verdict.evidenceHash("abc")).toMatch(/^djb2:[0-9a-f]{8}$/)
    expect(Verdict.evidenceHash("abc")).not.toBe(Verdict.evidenceHash("abd"))
  })
})

describe("Verdict.build", () => {
  test("solved: records solving tier, index, and per-attempt history", () => {
    const e = Verdict.build(solvedResult, { now: NOW })
    expect(e.solved).toBe(true)
    expect(e.solvedBy).toBe("glm-5.1")
    expect(e.tier).toBe(1)
    expect(e.attempts).toHaveLength(2)
    expect(e.attempts[0]).toMatchObject({ model: "deepseek-v4-flash", ok: false, failing: ["not_null_x"] })
    expect(e.checks[0].ok).toBe(true)
    expect(e.createdAt).toBe(NOW)
    expect(e.signature).toBeUndefined()
  })

  test("unsolved: solvedBy null, tier null", () => {
    const e = Verdict.build(unsolvedResult, { now: NOW })
    expect(e.solved).toBe(false)
    expect(e.solvedBy).toBeNull()
    expect(e.tier).toBeNull()
    expect(e.attempts[0].failing).toEqual(["t1"])
  })

  test("applies an injected signer", () => {
    const e = Verdict.build(solvedResult, { now: NOW, sign: (u) => "sig-" + u.evidenceHash })
    expect(e.signature).toContain("sig-djb2:")
  })

  test("serialize round-trips", () => {
    const e = Verdict.build(solvedResult, { now: NOW })
    expect(JSON.parse(Verdict.serialize(e)).solvedBy).toBe("glm-5.1")
  })
})
