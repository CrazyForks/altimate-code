import { Dispatcher } from "../native"
import type { CheckResult, EquivalenceResult, GradeResult, ImpactResult, ReviewRunner } from "./orchestrate"
import { buildReviewSchemaContext, type SchemaContext } from "./schema-context"

/**
 * Production ReviewRunner backed by the native Dispatcher (the Rust core).
 *
 * Every method is defensive: on any error or unexpected shape it degrades to a
 * safe, lint-only result rather than throwing — a review must never crash CI.
 * That is the "degrade loudly" contract: when the manifest/schema is missing,
 * findings are emitted as unverified rather than silently dropped or fabricated.
 */

interface ManifestModel {
  unique_id: string
  name: string
  depends_on: string[]
}

interface CachedManifest {
  models: Map<string, ManifestModel> // unique_id -> model
  byName: Map<string, ManifestModel>
  children: Map<string, string[]> // unique_id -> direct child unique_ids
  testDeps: Map<string, Set<string>> // model unique_id -> set of test unique_ids depending on it
  schemaContext?: SchemaContext // model/source columns for equivalence resolution
  ok: boolean
}

function asArray<T = any>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : []
}

/** Extract a column name from a PII-flavored check issue, best-effort. */
function piiColumnOf(issue: any): string | undefined {
  return issue?.column ?? issue?.target ?? issue?.name ?? undefined
}

export interface DispatcherRunnerOptions {
  manifestPath: string
  /** Optional inline schema context to enable real equivalence proofs. */
  schemaContext?: Record<string, any>
}

export function createDispatcherRunner(opts: DispatcherRunnerOptions): ReviewRunner {
  const checkCache = new Map<string, CheckResult>()
  let manifestPromise: Promise<CachedManifest> | undefined

  async function loadManifest(): Promise<CachedManifest> {
    if (!manifestPromise) {
      manifestPromise = (async () => {
        try {
          const res = await Dispatcher.call("dbt.manifest", { path: opts.manifestPath })
          const models = new Map<string, ManifestModel>()
          const byName = new Map<string, ManifestModel>()
          const children = new Map<string, string[]>()
          const nodes = [...asArray<ManifestModel>(res.models), ...asArray<ManifestModel>((res as any).snapshots)]
          for (const m of nodes) {
            models.set(m.unique_id, m)
            byName.set(m.name, m)
          }
          // Invert depends_on (upstream) into children (downstream).
          for (const m of nodes) {
            for (const parent of asArray<string>(m.depends_on)) {
              if (!children.has(parent)) children.set(parent, [])
              children.get(parent)!.push(m.unique_id)
            }
          }
          // Map each model to the SET of tests depending on it (by test
          // unique_id), so a multi-model test isn't counted more than once.
          const testDeps = new Map<string, Set<string>>()
          for (const t of asArray<{ unique_id: string; depends_on: string[] }>(res.tests)) {
            for (const dep of asArray<string>(t.depends_on)) {
              if (!testDeps.has(dep)) testDeps.set(dep, new Set())
              testDeps.get(dep)!.add(t.unique_id)
            }
          }
          // Schema context (model/source/seed/snapshot columns) for equivalence.
          const schemaContext = buildReviewSchemaContext(
            asArray(res.models),
            asArray(res.sources),
            asArray(res.seeds),
            asArray((res as any).snapshots),
          )
          return { models, byName, children, testDeps, schemaContext, ok: models.size > 0 }
        } catch {
          return {
            models: new Map(),
            byName: new Map(),
            children: new Map(),
            testDeps: new Map(),
            ok: false,
          }
        }
      })()
    }
    return manifestPromise
  }

  // Explicit override wins; otherwise derive schema from the manifest. This is
  // what makes equivalence decidable in CI instead of always-undecidable.
  async function resolveSchema(): Promise<Record<string, any> | undefined> {
    if (opts.schemaContext) return opts.schemaContext
    return (await loadManifest()).schemaContext
  }

  async function runCheck(sql: string): Promise<CheckResult> {
    const cached = checkCache.get(sql)
    if (cached) return cached
    let out: CheckResult = { issues: [], piiColumns: [] }
    try {
      const res = await Dispatcher.call("altimate_core.check", { sql, schema_context: await resolveSchema() })
      const data = (res.data ?? {}) as Record<string, any>
      const rawIssues = asArray(data.issues).concat(asArray(data.violations)).concat(asArray(data.findings))
      const issues = rawIssues.map((i: any) => ({
        rule: i.rule ?? i.code ?? i.name ?? "issue",
        message: i.message ?? i.description ?? String(i),
        line: typeof i.line === "number" ? i.line : i.location?.line,
        severity: i.severity ?? i.level,
        category: i.category ?? (/(pii|sensitive)/i.test(String(i.rule ?? i.code ?? "")) ? "pii" : i.kind),
      }))
      // PII columns: explicit data.pii, or PII-categorized issues. Extract from
      // RAW issues (which still carry column/target/name) — the normalized
      // `issues` drop those fields, so mapping over them would always miss.
      const piiColumns = [
        ...asArray<any>(data.pii).map(piiColumnOf),
        ...rawIssues
          .filter((i: any) => /pii|sensitive/i.test(String(i.category ?? i.rule ?? i.code ?? i.kind ?? "")))
          .map(piiColumnOf),
      ].filter((c): c is string => !!c)
      out = { issues, piiColumns: [...new Set(piiColumns)] }
    } catch {
      out = { issues: [], piiColumns: [] }
    }
    checkCache.set(sql, out)
    return out
  }

  return {
    async impact(model: string): Promise<ImpactResult> {
      const mf = await loadManifest()
      if (!mf.ok) {
        return { hasManifest: false, severity: "UNKNOWN", directCount: 0, transitiveCount: 0, testCount: 0 }
      }
      const target = mf.byName.get(model) ?? [...mf.models.values()].find((m) => m.name.endsWith(`.${model}`))
      if (!target) {
        return { hasManifest: true, severity: "SAFE", directCount: 0, transitiveCount: 0, testCount: 0 }
      }
      const direct = new Set(mf.children.get(target.unique_id) ?? [])
      const all = new Set<string>(direct)
      const queue = [...direct]
      while (queue.length) {
        const id = queue.shift()!
        for (const child of mf.children.get(id) ?? []) {
          if (!all.has(child)) {
            all.add(child)
            queue.push(child)
          }
        }
      }
      const transitive = [...all].filter((id) => !direct.has(id))
      // Distinct tests across the target + all downstream (a test asserting on
      // several of them counts once).
      const affectedTests = new Set<string>()
      for (const id of [target.unique_id, ...all]) {
        for (const tid of mf.testDeps.get(id) ?? []) affectedTests.add(tid)
      }
      const testCount = affectedTests.size
      const total = all.size
      const severity = total === 0 ? "SAFE" : total <= 3 ? "LOW" : total <= 10 ? "MEDIUM" : "HIGH"
      return {
        hasManifest: true,
        severity,
        directCount: direct.size,
        transitiveCount: transitive.length,
        testCount,
      }
    },

    async grade(sql: string): Promise<GradeResult> {
      try {
        const res = await Dispatcher.call("altimate_core.grade", { sql, schema_context: await resolveSchema() })
        const data = (res.data ?? {}) as Record<string, any>
        return { grade: data.grade ?? data.overall_grade }
      } catch {
        return {}
      }
    },

    check(sql: string): Promise<CheckResult> {
      return runCheck(sql)
    },

    async equivalence(oldSql: string, newSql: string): Promise<EquivalenceResult> {
      try {
        const schema = await resolveSchema()
        const res = await Dispatcher.call("altimate_core.equivalence", {
          sql1: oldSql,
          sql2: newSql,
          schema_context: schema,
        })
        const data = (res.data ?? {}) as Record<string, any>
        const validationErrors = asArray(data.validation_errors)
        // Undecidable when: call failed, no schema to resolve columns, or the
        // engine returned validation errors. Never guess equivalent=true.
        const decided =
          res.success === true &&
          typeof data.equivalent === "boolean" &&
          !res.error &&
          !data.error &&
          validationErrors.length === 0 &&
          !!schema
        if (!decided) return { decided: false }
        return {
          decided: true,
          equivalent: data.equivalent,
          differences: asArray<any>(data.differences).map((d) => d?.description ?? String(d)),
          confidence: data.confidence ?? "medium",
        }
      } catch {
        return { decided: false }
      }
    },

    async detectPii(sql: string): Promise<{ columns: string[] }> {
      // Text-based PII comes from altimate_core.check (schema.detect_pii is
      // warehouse-based and unavailable in CI). Reuses the memoized check.
      const result = await runCheck(sql)
      return { columns: result.piiColumns ?? [] }
    },
  }
}
