/**
 * Verdict envelope — a machine-checkable record of a routed result.
 *
 * Records which tier produced the accepted result, the checks that passed, an
 * evidence fingerprint, and an optional signature — a structured summary of "this
 * output passed deterministic verification by tier X" for downstream/audit use.
 *
 * Pure + dependency-free: the timestamp and signer are injected so this never
 * reaches for Date.now / crypto itself.
 */
import type { Verifier } from "./verifier"
import type { Router } from "./router"

export namespace Verdict {
  export interface AttemptRecord {
    model: string
    ok: boolean
    /** Gate conclusion for this attempt (ok / proven_different / undecidable / failed). */
    decision?: Verifier.Decision
    /** Evidence strength for this attempt (unverifiable / build / dbt_test / equivalence). */
    strength?: Verifier.Strength
    reason?: string
    failing: string[]
  }

  export interface Envelope {
    /** Envelope schema version, for forward-compat as the shape evolves. */
    schemaVersion: string
    solved: boolean
    solvedBy: string | null
    /** ladder index that produced the passing verdict, or null if unsolved. */
    tier: number | null
    /** true when the accepted result could not actually be verified (fail-open). */
    unverifiable: boolean
    /**
     * Evidence strength of the accepted result — the core trust signal. EQUIVALENCE
     * means proven equivalent to a reference; BUILD means it merely compiled.
     */
    strength?: Verifier.Strength
    /** Gate conclusion of the accepted result. */
    decision?: Verifier.Decision
    attempts: AttemptRecord[]
    checks: Verifier.Check[]
    evidenceHash: string
    createdAt: string
    signature?: string
  }

  /** Envelope schema. v2 adds per-result `strength` + `decision` (the trust signal). */
  export const SCHEMA_VERSION = "2"

  /** Deterministic, dependency-free fingerprint of the evidence (djb2 → hex). Not a signature. */
  export function evidenceHash(s: string): string {
    let h = 5381
    for (let i = 0; i < s.length; i++) h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0
    return "djb2:" + h.toString(16).padStart(8, "0")
  }

  /**
   * Build the envelope from a routing result. `now` (ISO string) and an optional
   * `sign` function are injected — the product wires a real signer here.
   */
  export function build(
    result: Router.RouteResult,
    opts: { now: string; sign?: (unsigned: Omit<Envelope, "signature">) => string },
  ): Envelope {
    const attempts: AttemptRecord[] = result.attempts.map((a) => ({
      model: a.tier.label,
      ok: a.verdict.ok,
      decision: a.verdict.decision,
      strength: a.verdict.strength,
      reason: a.verdict.reason,
      failing: a.verdict.checks.filter((c) => !c.ok).map((c) => c.name),
    }))
    const last = result.attempts.at(-1)
    const unsigned: Omit<Envelope, "signature"> = {
      schemaVersion: SCHEMA_VERSION,
      solved: result.solved,
      solvedBy: result.solvedBy?.label ?? null,
      tier: result.solved ? result.attempts.length - 1 : null,
      unverifiable: result.solved ? !!last?.verdict.unverifiable : false,
      strength: last?.verdict.strength,
      decision: last?.verdict.decision,
      attempts,
      checks: last?.verdict.checks ?? [],
      evidenceHash: evidenceHash(last?.verdict.evidence ?? ""),
      createdAt: opts.now,
    }
    const signature = opts.sign?.(unsigned)
    return signature ? { ...unsigned, signature } : unsigned
  }

  export function serialize(e: Envelope): string {
    return JSON.stringify(e)
  }
}
