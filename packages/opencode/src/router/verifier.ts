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

  export interface Verdict {
    ok: boolean
    /**
     * True when verification could not actually run (e.g. no dbt project, dbt binary
     * missing). Distinct from a genuine pass: `ok` is true so the run is not blocked
     * (fail-open), but the result was NOT proven — consumers/the envelope can tell.
     */
    unverifiable?: boolean
    /** Human/agent-readable reason when not ok (fed to the next tier on escalation). */
    reason?: string
    checks: Check[]
    /** Raw evidence excerpt (for the verdict envelope / audit). */
    evidence?: string
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
    return { ok, reason, checks, evidence: output.slice(-800) }
  }

  /** Default that passes everything (ungated) — used when no real verifier is configured. */
  export const ALLOW_ALL: Impl = { verify: () => ({ ok: true, checks: [] }) }

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
          return { ok: true, unverifiable: true, reason: `verifier error: ${String(e)}`, checks: [], evidence: "verifier-error" }
        }
      },
    }
  }
}
