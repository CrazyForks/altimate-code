/**
 * Equivalence-backed verifier (reference-available regime).
 *
 * For a change to an EXISTING model, the strongest deterministic signal is not
 * "does it build" but "is the new SQL semantically equivalent to the prior version".
 * This Impl resolves a reference (base) compiled SQL per touched model, compares it
 * to the head compiled SQL via the altimate-core equivalence engine, and folds the
 * per-model results into one Verdict (see `Verifier.fromEquivalence`).
 *
 * Soundness is preserved end-to-end: the engine never reports false-equivalence, and
 * an undecidable result (validation errors / unsupported dialect) maps to UNDECIDABLE,
 * which the router does NOT escalate on — the caller falls back to build/test. A
 * stronger model cannot make an undecidable query decidable.
 *
 * Both the equivalence call and the reference resolution are injected, so this is
 * fully unit-testable without the native engine, dbt, or git.
 */
import { Verifier } from "./verifier"

export namespace EquivalenceVerifier {
  /** One model's base→head SQL pair plus the schema needed to resolve refs. */
  export interface Pair {
    model: string
    baseSql: string
    headSql: string
    /** Opaque schema handle passed through to the engine (e.g. altimate-core Schema). */
    schema?: unknown
  }

  /**
   * Resolves the comparison inputs for the touched models in a workspace.
   * Returns null when there is NO reference (greenfield) — the caller then uses the
   * build/test verifier instead. Returns [] when a reference regime applies but no
   * models were touched (treated as nothing-to-verify).
   */
  export interface ReferenceResolver {
    resolve(workdir: string): Promise<Pair[] | null>
  }

  /** The raw equivalence call (native `altimate_core.equivalence`), injected for testability. */
  export type CheckEquivalence = (
    headSql: string,
    baseSql: string,
    schema: unknown,
  ) => Promise<Verifier.EquivalenceResult>

  /**
   * Build an Impl. `check` performs one equivalence comparison; `resolver` provides the
   * base/head pairs. `fallback` (typically the dbt build verifier) is used when there is
   * no reference (greenfield) or when the engine is undecidable — never a silent pass.
   */
  export function create(
    check: CheckEquivalence,
    resolver: ReferenceResolver,
    fallback: Verifier.Impl,
  ): Verifier.Impl {
    return {
      async verify(workdir: string): Promise<Verifier.Verdict> {
        let pairs: Awaited<ReturnType<ReferenceResolver["resolve"]>>
        try {
          pairs = await resolver.resolve(workdir)
        } catch (e) {
          // Can't resolve a reference → degrade to the build/test verifier (honest).
          return fallback.verify(workdir)
        }
        // Greenfield (no reference): equivalence is not applicable.
        if (pairs === null) return fallback.verify(workdir)

        const results: { model: string; result: Verifier.EquivalenceResult }[] = []
        for (const p of pairs) {
          try {
            results.push({ model: p.model, result: await check(p.headSql, p.baseSql, p.schema) })
          } catch (e) {
            // A failed comparison is undecidable for that model, not "different".
            results.push({
              model: p.model,
              result: { equivalent: false, validation_errors: [`equivalence error: ${String(e)}`] },
            })
          }
        }
        const verdict = Verifier.fromEquivalence(results)
        // Undecidable equivalence → fall back to the reference-free gate (build/test),
        // so we never accept on an abstain alone. The DECISION must come from the
        // fallback, not be blanket-stamped UNDECIDABLE: if the fallback build FAILS we
        // must surface FAILED so the router escalates — stamping UNDECIDABLE here would
        // swallow a real build failure (UNDECIDABLE never escalates). If it passes, the
        // result is accepted at BUILD strength (the "equivalence couldn't decide" fact is
        // carried by strength<EQUIVALENCE + reason), keeping the ok⟺OK invariant intact.
        if (verdict.decision === Verifier.Decision.UNDECIDABLE) {
          const fb = await fallback.verify(workdir)
          return {
            ...fb,
            decision: fb.ok ? Verifier.Decision.OK : Verifier.Decision.FAILED,
            reason: `equivalence undecidable; fell back to build/test (${fb.reason ?? (fb.ok ? "passed" : "failed")})`,
            checks: [...verdict.checks, ...fb.checks],
          }
        }
        return verdict
      },
    }
  }
}
