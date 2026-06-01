/**
 * Reference resolver for the equivalence verifier (reference-available regime).
 *
 * To compare a changed dbt model against its prior version, we need the COMPILED SQL
 * of both sides (equivalence runs on compiled SQL, never raw Jinja) plus the schema to
 * resolve table/column refs. This module produces `EquivalenceVerifier.Pair[]` for the
 * models a change touched, or `null` when there is no reference (greenfield — the caller
 * then uses the build/test verifier).
 *
 * All IO (git, dbt compile, schema) is injected via `Deps`, so the orchestration is
 * fully unit-testable without git/dbt. A git+dbt-backed `Deps` is the production impl.
 */
import { EquivalenceVerifier } from "./equivalence-verifier"

export namespace ReferenceResolver {
  /** "WORKING" = the current working tree; otherwise a git ref (the base/PR-target). */
  export type Ref = string

  export interface Deps {
    /** The base ref to diff against (PR merge-base or HEAD~), or null when none exists (greenfield). */
    baseRef(workdir: string): Promise<string | null>
    /** Model names whose .sql changed vs the base. */
    changedModels(workdir: string, base: Ref): Promise<string[]>
    /** model -> compiled SQL at a given ref ("WORKING" or a git ref). */
    compiledSql(workdir: string, ref: Ref): Promise<Map<string, string>>
    /** Opaque schema handle passed to the equivalence engine (e.g. altimate-core Schema). */
    schema(workdir: string): Promise<unknown>
  }

  /**
   * Build a `EquivalenceVerifier.ReferenceResolver` from injected deps.
   * Returns null (→ greenfield/build-fallback) when there is no base ref; returns [] when a
   * base exists but no models changed; otherwise one Pair per changed model present on BOTH
   * sides (a model that's new on head has no base → not equivalence-checkable, skipped here).
   */
  export function create(deps: Deps): EquivalenceVerifier.ReferenceResolver {
    return {
      async resolve(workdir: string): Promise<EquivalenceVerifier.Pair[] | null> {
        const base = await deps.baseRef(workdir)
        if (base === null) return null // greenfield — no reference

        const changed = await deps.changedModels(workdir, base)
        if (changed.length === 0) return []

        const [headSql, baseSql, schema] = await Promise.all([
          deps.compiledSql(workdir, "WORKING"),
          deps.compiledSql(workdir, base),
          deps.schema(workdir),
        ])

        const pairs: EquivalenceVerifier.Pair[] = []
        for (const model of changed) {
          const head = headSql.get(model)
          const baseM = baseSql.get(model)
          // Both sides must compile to a SQL string; a model new on head (no base) is not
          // equivalence-checkable and is left to the build/test gate.
          if (head && baseM) pairs.push({ model, baseSql: baseM, headSql: head, schema })
        }
        return pairs
      },
    }
  }
}
