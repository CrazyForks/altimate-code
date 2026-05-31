import { describe, expect, test } from "bun:test"
import { Verifier } from "../../src/router/verifier"

const PASS = "01:23:45  Done. PASS=12 WARN=0 ERROR=0 SKIP=0 NO-OP=0 TOTAL=12"
const FAIL =
  "Failure in test not_null_fct_reviews_review_id (models/schema.yml)\n" +
  "01:23:45  Done. PASS=11 WARN=0 ERROR=1 SKIP=0 TOTAL=12"
const COMPILE_ERR = "Compilation Error in model stg_orders (models/stg_orders.sql)\n  unexpected token"

describe("Verifier.parseDbtSummary", () => {
  test("parses a clean summary", () => {
    expect(Verifier.parseDbtSummary(PASS)).toEqual({ pass: 12, warn: 0, error: 0, skip: 0, total: 12 })
  })
  test("parses summary with errors", () => {
    expect(Verifier.parseDbtSummary(FAIL)).toEqual({ pass: 11, warn: 0, error: 1, skip: 0, total: 12 })
  })
  test("returns null when no summary present", () => {
    expect(Verifier.parseDbtSummary("nothing here")).toBeNull()
  })
})

describe("Verifier.failingNodes", () => {
  test("extracts a failing test", () => {
    const f = Verifier.failingNodes(FAIL)
    expect(f).toHaveLength(1)
    expect(f[0].name).toBe("not_null_fct_reviews_review_id")
    expect(f[0].ok).toBe(false)
  })
  test("extracts a compilation error model", () => {
    const f = Verifier.failingNodes(COMPILE_ERR)
    expect(f[0].name).toBe("stg_orders")
  })
  test("dedups repeated nodes", () => {
    const f = Verifier.failingNodes(FAIL + "\n" + FAIL)
    expect(f).toHaveLength(1)
  })
})

describe("Verifier.fromDbt", () => {
  test("ok when exit 0 + summary + zero errors", () => {
    const v = Verifier.fromDbt(PASS, 0)
    expect(v.ok).toBe(true)
    expect(v.reason).toBeUndefined()
  })
  test("not ok when there are dbt errors (and names the failing node for escalation)", () => {
    const v = Verifier.fromDbt(FAIL, 1)
    expect(v.ok).toBe(false)
    expect(v.reason).toContain("not_null_fct_reviews_review_id")
    expect(v.checks.some((c) => !c.ok)).toBe(true)
  })
  test("not ok when build never completed (no summary)", () => {
    const v = Verifier.fromDbt("crashed early", 1)
    expect(v.ok).toBe(false)
    expect(v.reason).toContain("did not complete")
  })
  test("not ok when summary clean but non-zero exit", () => {
    expect(Verifier.fromDbt(PASS, 2).ok).toBe(false)
  })
})

describe("Verifier — ADVERSARIAL", () => {
  test("summary-line INJECTION: fake 'PASS=99 ERROR=0' earlier is ignored; real (last) summary wins", () => {
    const malicious =
      "-- model output echoed by dbt on error:\n" +
      "Done. PASS=99 WARN=0 ERROR=0 SKIP=0 TOTAL=99\n" + // fake, injected via model SQL
      "Compilation Error in model evil (models/evil.sql)\n" +
      "01:00:00  Done. PASS=4 WARN=0 ERROR=1 SKIP=0 TOTAL=5" // dbt's REAL summary, last
    expect(Verifier.parseDbtSummary(malicious)).toEqual({ pass: 4, warn: 0, error: 1, skip: 0, total: 5 })
    expect(Verifier.fromDbt(malicious, 1).ok).toBe(false)
  })

  test("exitCode is the backstop: fake clean summary but non-zero exit -> not ok", () => {
    expect(Verifier.fromDbt("Done. PASS=99 WARN=0 ERROR=0 SKIP=0 TOTAL=99", 1).ok).toBe(false)
  })

  test("a real clean build (exit 0, real summary last) is ok even if a fake line precedes", () => {
    const out = "Done. PASS=1 ERROR=5 TOTAL=6\n...later...\nDone. PASS=12 WARN=0 ERROR=0 SKIP=0 TOTAL=12"
    expect(Verifier.fromDbt(out, 0).ok).toBe(true)
  })

  test("ANSI color codes around the summary do not break parsing", () => {
    const ansi = "[0m01:00:00  Done. PASS=12 WARN=0 ERROR=0 SKIP=0 TOTAL=12[0m"
    expect(Verifier.parseDbtSummary(ansi)?.pass).toBe(12)
  })

  test("empty / whitespace / non-dbt output -> not ok (no summary)", () => {
    for (const o of ["", "   \n\t", "Killed", "Traceback (most recent call last):"]) {
      expect(Verifier.fromDbt(o, 1).ok).toBe(false)
    }
  })

  test("huge output completes quickly (no catastrophic backtracking)", () => {
    const huge = "x ".repeat(500_000) + "\nDone. PASS=3 WARN=0 ERROR=0 SKIP=0 TOTAL=3"
    const t0 = Date.now()
    expect(Verifier.fromDbt(huge, 0).ok).toBe(true)
    expect(Date.now() - t0).toBeLessThan(2000)
  })

  test("multiple real summaries (incremental run + test run) -> last one is authoritative", () => {
    const multi = "Done. PASS=8 ERROR=0 TOTAL=8\n...tests...\nDone. PASS=10 WARN=0 ERROR=2 SKIP=0 TOTAL=12"
    expect(Verifier.fromDbt(multi, 1).ok).toBe(false)
    expect(Verifier.parseDbtSummary(multi)?.error).toBe(2)
  })
})

describe("Verifier impls", () => {
  test("ALLOW_ALL passes", async () => {
    expect((await Verifier.ALLOW_ALL.verify("/app")).ok).toBe(true)
  })
  test("dbtVerifier judges via injected runner", async () => {
    const good = Verifier.dbtVerifier(async () => ({ output: PASS, exitCode: 0 }))
    expect((await good.verify("/app")).ok).toBe(true)
    const bad = Verifier.dbtVerifier(async () => ({ output: FAIL, exitCode: 1 }))
    expect((await bad.verify("/app")).ok).toBe(false)
  })
  test("dbtVerifier fails open if the runner throws", async () => {
    const boom = Verifier.dbtVerifier(async () => {
      throw new Error("dbt missing")
    })
    const v = await boom.verify("/app")
    expect(v.ok).toBe(true)
    expect(v.reason).toContain("verifier error")
  })
})
