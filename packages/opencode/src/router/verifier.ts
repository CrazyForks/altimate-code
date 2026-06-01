/**
 * Deterministic verifier for the verifier-gated router.
 *
 * After an agent run completes, a verifier inspects the resulting workspace and
 * returns a Verdict: did the work actually succeed? For dbt/SQL this is checkable,
 * not estimated — `dbt build` exits 0 and `dbt test` passes. A not-ok verdict means
 * the attempt is wrong, so the router escalates to a stronger model.
 *
 * The default `dbtVerifier` runs `dbt build`; a different verifier can be injected
 * via the `Impl` interface (e.g. a semantic-equivalence check).
 *
 * Pure parsing + an injected command runner → fully testable without dbt.
 */

export namespace Verifier {
  /** One graded check (a dbt test, a model build, or an equivalence assertion). */
  export interface Check {
    name: string
    ok: boolean
    detail?: string
  }

  /**
   * How strong is the evidence behind a verdict? Ordered weakest → strongest.
   * The signed envelope carries this so a consumer knows whether a result was
   * merely build-verified (value unknown) or proven equivalent to a reference.
   */
  export enum Strength {
    /** No gate could run (fail-open). The result is NOT proven. */
    UNVERIFIABLE = "unverifiable",
    /** `dbt build` exited 0 with no errors: it compiles, but value-correctness is unknown. */
    BUILD = "build",
    /** dbt schema/unit tests passed: asserted invariants hold (still not full correctness). */
    DBT_TEST = "dbt_test",
    /** Proven semantically equivalent to a reference by the equivalence engine. */
    EQUIVALENCE = "equivalence",
  }

  /**
   * What did the gate conclude? Distinct from {@link Strength} (how it was judged).
   * `UNDECIDABLE` is the equivalence engine's honest abstain — it must NEVER be
   * silently treated as a pass, and must NOT trigger escalation (a stronger model
   * does not make an undecidable query decidable); the caller falls back + flags.
   */
  export enum Decision {
    OK = "ok",
    /** The equivalence engine found a MATERIAL difference vs the reference. */
    PROVEN_DIFFERENT = "proven_different",
    /** The engine could not decide (validation errors / unsupported syntax / no reference). */
    UNDECIDABLE = "undecidable",
    /** A build/test gate failed. */
    FAILED = "failed",
  }

  export interface Verdict {
    ok: boolean
    /**
     * True when verification could not actually run (e.g. no dbt project, dbt binary
     * missing). Distinct from a genuine pass: `ok` is true so the run is not blocked
     * (fail-open), but the result was NOT proven — consumers/the envelope can tell.
     */
    unverifiable?: boolean
    /**
     * Evidence strength (optional for back-compat; populated by every constructor).
     * Lets the signed envelope say "verified at strength EQUIVALENCE" vs "BUILD only".
     */
    strength?: Strength
    /**
     * Gate conclusion (optional for back-compat; populated by every constructor).
     * Drives decision-aware escalation in the router.
     */
    decision?: Decision
    /** Engine confidence in [0,1] when available (equivalence). Never 1.0 — soundness margin. */
    confidence?: number
    /** Human/agent-readable reason when not ok (fed to the next tier on escalation). */
    reason?: string
    checks: Check[]
    /** Raw evidence excerpt (for the verdict envelope / audit). */
    evidence?: string
  }

  /** One model's equivalence result (subset of altimate-core's EquivalenceResult). */
  export interface EquivalenceResult {
    equivalent: boolean
    /** Non-empty ⇒ the engine could not decide (undecidable), NOT "different". */
    validation_errors?: string[]
    /** Material differences when decidably non-equivalent. */
    differences?: { severity?: string; description?: string }[]
    confidence?: number
  }

  /** dbt's "Done. PASS=.. WARN=.. ERROR=.. SKIP=.. TOTAL=.." summary. */
  export interface DbtSummary {
    pass: number
    warn: number
    error: number
    skip: number
    total: number
  }

  /** Result of running a verification command (injected; real impl shells out). */
  export interface RunResult {
    output: string
    exitCode: number
  }

  /** Pluggable judgment. Default = dbtVerifier; a custom verifier can be injected. */
  export interface Impl {
    verify(workdir: string): Verdict | Promise<Verdict>
  }

  /**
   * Parse the dbt run summary line. Returns null if not present (build never finished).
   *
   * Hardening: takes the LAST matching line, not the first. dbt prints its real run
   * summary last; a malicious/confused model could emit SQL containing a fake
   * "Done. PASS=99 ERROR=0" that dbt echoes earlier in its error log. (The exitCode
   * check in `fromDbt` is the primary backstop; last-match is defense in depth.)
   */
  export function parseDbtSummary(output: string): DbtSummary | null {
    const re = /PASS=(\d+)\s+WARN=(\d+)\s+ERROR=(\d+)\s+SKIP=(\d+)(?:\s+NO-OP=\d+)?\s+TOTAL=(\d+)/gi
    let last: RegExpExecArray | null = null
    let m: RegExpExecArray | null
    while ((m = re.exec(output))) last = m
    if (!last) return null
    return { pass: +last[1], warn: +last[2], error: +last[3], skip: +last[4], total: +last[5] }
  }

  /**
   * Extract the dbt nodes that failed (the actionable detail for escalation).
   * Matches dbt's standard phrasings:
   *   "Failure in test not_null_orders_id (models/schema.yml)"
   *   "Error in model my_model (models/my_model.sql)"
   *   "Compilation Error in model stg_x (...)"
   */
  export function failingNodes(output: string): Check[] {
    const out: Check[] = []
    const re = /(?:Compilation Error|Failure|Error|Runtime Error) in (test|model|seed|snapshot|unit_test) ([\w.]+)/gi
    let m: RegExpExecArray | null
    const seen = new Set<string>()
    while ((m = re.exec(output))) {
      const name = `${m[1]}:${m[2]}`
      if (seen.has(name)) continue
      seen.add(name)
      out.push({ name: m[2], ok: false, detail: m[0] })
    }
    return out
  }

  /**
   * Build a Verdict from a `dbt build`/`dbt test` run.
   * ok ⇔ command exited 0 AND a summary was produced AND it had zero ERRORs.
   * A missing summary (build crashed / never ran) is NOT ok.
   */
  export function fromDbt(output: string, exitCode: number): Verdict {
    const s = parseDbtSummary(output)
    const failing = failingNodes(output)
    const ok = exitCode === 0 && !!s && s.error === 0
    let reason: string | undefined
    if (!ok) {
      if (!s) reason = "dbt build did not complete (no run summary found)"
      else if (s.error > 0)
        reason = `${s.error} dbt error(s); ${s.pass}/${s.total} passed` +
          (failing.length ? ` — failing: ${failing.map((f) => f.name).join(", ")}` : "")
      else if (exitCode !== 0) reason = `dbt exited ${exitCode}`
    }
    const checks: Check[] = failing.length
      ? failing
      : s
        ? [{ name: "dbt build", ok, detail: `PASS=${s.pass} ERROR=${s.error} TOTAL=${s.total}` }]
        : [{ name: "dbt build", ok: false, detail: "no summary" }]
    return {
      ok,
      strength: Strength.BUILD,
      decision: ok ? Decision.OK : Decision.FAILED,
      reason,
      checks,
      evidence: output.slice(-800),
    }
  }

  /**
   * Build a Verdict from per-model equivalence results (reference-available regime).
   *
   * Folds N model verdicts into one, honoring the engine's soundness:
   *  - any model with `validation_errors` (or a no-reference/error result) ⇒ UNDECIDABLE
   *    for the whole verdict (the caller MUST fall back to build/test, never pass silently);
   *  - else any model decidably non-equivalent ⇒ PROVEN_DIFFERENT (escalation-worthy);
   *  - else (every model proven equivalent) ⇒ OK at EQUIVALENCE strength.
   *
   * `ok` is true only for the all-equivalent case. UNDECIDABLE and PROVEN_DIFFERENT are
   * NOT `ok` (the run is not accepted on equivalence alone), but they differ in how the
   * router reacts (see Router.shouldEscalate): escalate on PROVEN_DIFFERENT, fall back on
   * UNDECIDABLE.
   */
  export function fromEquivalence(results: { model: string; result: EquivalenceResult }[]): Verdict {
    if (results.length === 0) {
      return {
        ok: false,
        strength: Strength.UNVERIFIABLE,
        decision: Decision.UNDECIDABLE,
        reason: "no models to compare (no reference resolved)",
        checks: [],
      }
    }
    const checks: Check[] = []
    let anyUndecidable = false
    let anyDifferent = false
    // Track confidence only when a model actually reports it — never synthesize a
    // 1.0 default (that would read as "100% confident" on a non-OK verdict).
    let minConfidence: number | undefined
    for (const { model, result } of results) {
      const undecidable = !!(result.validation_errors && result.validation_errors.length > 0)
      if (typeof result.confidence === "number")
        minConfidence = minConfidence === undefined ? result.confidence : Math.min(minConfidence, result.confidence)
      if (undecidable) {
        anyUndecidable = true
        checks.push({ name: model, ok: false, detail: `undecidable: ${result.validation_errors!.join("; ")}` })
      } else if (!result.equivalent) {
        anyDifferent = true
        const diff = (result.differences ?? []).map((d) => d.description ?? d.severity ?? "diff").join("; ")
        checks.push({ name: model, ok: false, detail: `not equivalent: ${diff || "material difference"}` })
      } else {
        checks.push({ name: model, ok: true, detail: "equivalent" })
      }
    }
    // PROVEN_DIFFERENT outranks UNDECIDABLE: a proven material diff is actionable (escalate),
    // even if another model in the change was undecidable.
    if (anyDifferent) {
      return {
        ok: false,
        strength: Strength.EQUIVALENCE,
        decision: Decision.PROVEN_DIFFERENT,
        confidence: minConfidence,
        reason: `not equivalent to reference: ${checks.filter((c) => !c.ok).map((c) => c.name).join(", ")}`,
        checks,
      }
    }
    if (anyUndecidable) {
      return {
        ok: false,
        strength: Strength.BUILD, // equivalence couldn't decide; caller falls back to build/test
        decision: Decision.UNDECIDABLE,
        reason: "equivalence undecidable for some models — falling back to build/test",
        checks,
      }
    }
    return {
      ok: true,
      strength: Strength.EQUIVALENCE,
      decision: Decision.OK,
      confidence: minConfidence,
      checks,
    }
  }

  /** Default that passes everything (ungated) — used when no real verifier is configured. */
  export const ALLOW_ALL: Impl = {
    verify: () => ({ ok: true, strength: Strength.UNVERIFIABLE, decision: Decision.OK, unverifiable: true, checks: [] }),
  }

  /**
   * Default deterministic verifier: runs `dbt build` in the workspace and judges
   * the result. The command runner is injected so this is unit-testable without dbt.
   * NEVER throws — a verifier crash must not break the run (fail-open to a soft verdict).
   */
  export function dbtVerifier(run: (cmd: string, workdir: string) => Promise<RunResult>): Impl {
    return {
      async verify(workdir: string): Promise<Verdict> {
        try {
          const r = await run("dbt build", workdir)
          return fromDbt(r.output, r.exitCode)
        } catch (e) {
          // Fail-open: can't verify → don't block, but mark unverifiable so it's not
          // mistaken for a real pass.
          return {
            ok: true,
            unverifiable: true,
            strength: Strength.UNVERIFIABLE,
            decision: Decision.UNDECIDABLE,
            reason: `verifier error: ${String(e)}`,
            checks: [],
            evidence: "verifier-error",
          }
        }
      },
    }
  }
}
