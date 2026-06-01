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

  /** Run a shell command; returns stdout + exit code. Injected so `gitDbtDeps` is testable. */
  export type Exec = (cmd: string, args: string[], cwd: string) => Promise<{ stdout: string; code: number }>

  export interface GitDbtOptions {
    /** dbt binary (e.g. "dbt" or "altimate-dbt"). */
    dbt?: string
    /** Read compiled model SQL after a `dbt compile` in `dir` → Map<model, sql>. */
    readCompiled: (dir: string) => Promise<Map<string, string>>
    /** Build the engine schema for the project (best-effort; empty Schema ⇒ engine abstains → build-fallback). */
    buildSchema: (workdir: string) => Promise<unknown>
    /** Make an isolated checkout of `ref` for base-side compilation (e.g. git worktree); returns its path + a cleanup. */
    checkoutBase: (workdir: string, ref: string) => Promise<{ dir: string; cleanup: () => Promise<void> }>
  }

  /**
   * Production `Deps`: git for base/changed detection, dbt to compile each side, an
   * injected schema builder. All process IO goes through `exec`/`opts` so the orchestration
   * is unit-tested without git/dbt. NOTE: the live path (git-worktree base compile +
   * warehouse schema) is pending E2E validation — it ships behind a flag and degrades to a
   * build verdict (the engine abstains without a resolvable schema / unsupported dialect).
   */
  export function gitDbtDeps(exec: Exec, opts: GitDbtOptions): Deps {
    const dbt = opts.dbt ?? "dbt"
    return {
      async baseRef(workdir) {
        const r = await exec("git", ["rev-parse", "--verify", "HEAD"], workdir)
        return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null // no commits ⇒ greenfield
      },
      async changedModels(workdir, base) {
        const r = await exec("git", ["diff", "--name-only", base, "--", "models"], workdir)
        if (r.code !== 0) return []
        return r.stdout
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.endsWith(".sql"))
          .map((l) => l.split("/").pop()!.replace(/\.sql$/, ""))
      },
      async compiledSql(workdir, ref) {
        if (ref === "WORKING") {
          await exec(dbt, ["compile"], workdir)
          return opts.readCompiled(workdir)
        }
        const base = await opts.checkoutBase(workdir, ref)
        try {
          await exec(dbt, ["deps"], base.dir)
          await exec(dbt, ["compile"], base.dir)
          return await opts.readCompiled(base.dir)
        } finally {
          await base.cleanup()
        }
      },
      schema: (workdir) => opts.buildSchema(workdir),
    }
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
