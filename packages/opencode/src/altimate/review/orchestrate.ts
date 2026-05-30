import path from "node:path"
import {
  type Finding,
  type ReviewCategory,
  type Severity,
  ReviewCategory as ReviewCategoryEnum,
  makeFinding,
  dedupe,
  SEVERITY_ORDER,
} from "./finding"
import { type ChangedFile, filterChangedFiles } from "./diff-filter"
import { classifyPR, TIER_LANES } from "./risk-tier"
import { type Rubric, exclusionReason, clampSeverity } from "./rubric"
import { type ReviewConfig } from "./config"
import { type ReviewMode, type VerdictEnvelope, buildEnvelope, signEnvelope } from "./verdict"
import { detectModelPatterns, detectSchemaYmlPatterns } from "./dbt-patterns"

/**
 * The deterministic review recipe.
 *
 * The LLM (when present) is a coordinator that turns engine output into prose —
 * but the findings and the verdict are produced HERE, mechanically, from
 * deterministic engine calls behind the `ReviewRunner` interface. That is the
 * defensible core: a generic reviewer guesses; this proves.
 *
 * `ReviewRunner` is intentionally high-level so the orchestrator is pure and
 * unit-testable. Production backs it with the native Dispatcher (see
 * tools/dbt-pr-review.ts); tests pass a fake.
 */

/** Impact-analysis result, normalized. */
export interface ImpactResult {
  hasManifest: boolean
  /** SAFE | LOW | MEDIUM | HIGH | BREAKING (from the DAG walk). */
  severity: "SAFE" | "LOW" | "MEDIUM" | "HIGH" | "BREAKING" | "UNKNOWN"
  directCount: number
  transitiveCount: number
  testCount: number
}

/** Equivalence result, normalized with a first-class undecidable state. */
export interface EquivalenceResult {
  /** False when the engine could not decide (no schema / undecidable). */
  decided: boolean
  equivalent?: boolean
  differences?: string[]
  confidence?: "high" | "medium" | "low"
}

export interface GradeResult {
  grade?: string // A–F
  issues?: Array<{ rule: string; message: string; line?: number; severity?: string }>
}

export interface CheckResult {
  issues?: Array<{ rule: string; message: string; line?: number; severity?: string; category?: string }>
  piiColumns?: string[]
}

/** High-level engine surface the orchestrator depends on. */
export interface ReviewRunner {
  impact(model: string): Promise<ImpactResult>
  grade(sql: string, dialect: string): Promise<GradeResult>
  check(sql: string, dialect: string): Promise<CheckResult>
  equivalence(oldSql: string, newSql: string, dialect: string): Promise<EquivalenceResult>
  detectPii(sql: string, dialect: string): Promise<{ columns: string[] }>
}

export interface OrchestrateInput {
  changedFiles: ChangedFile[]
  config: ReviewConfig
  rubric: Rubric
  mode: ReviewMode
  runner: ReviewRunner
  /** Resolve RAW model contents (Jinja) from the working tree / git refs. */
  getContent?: (file: string, side: "old" | "new") => Promise<string | undefined>
  /** Resolve dbt-COMPILED SQL (rendered) for the engine lanes; undefined when
   *  no compiled artifact exists. The dbt-patterns lane always uses raw. */
  getCompiled?: (file: string, side: "old" | "new") => Promise<string | undefined>
  generatedAt?: string
  manifestHash?: string
  coreVersion?: string
  modelVersion?: string
}

/** Derive the dbt model name from a model file path. */
export function modelNameFromPath(p: string): string {
  return path.basename(p).replace(/\.(sql|py)$/i, "")
}

const VALID_CATEGORIES = new Set<string>(ReviewCategoryEnum.options)

/**
 * Map a raw engine-issue category to a ReviewCategory WITHOUT discarding it.
 * Preserving the engine's category is what keeps the rubric's blockers (e.g.
 * contract_violation) effective — coercing everything to sql_quality would
 * silently neuter them.
 */
function mapCheckCategory(raw?: string): ReviewCategory {
  if (!raw) return "sql_quality"
  const norm = raw.toLowerCase()
  if (VALID_CATEGORIES.has(norm)) return norm as ReviewCategory
  if (/contract/.test(norm)) return "contract_violation"
  if (/idempoten/.test(norm)) return "idempotency"
  if (/\btest\b|coverage/.test(norm)) return "test_coverage"
  if (/pii|sensitive/.test(norm)) return "pii_exposure"
  if (/cost|perf|scan|spill|prune/.test(norm)) return "warehouse_cost"
  if (/freshness|stale/.test(norm)) return "freshness"
  return "sql_quality"
}

/** Map an impact severity bucket to a finding severity. */
function impactToSeverity(impact: ImpactResult): Severity | null {
  switch (impact.severity) {
    case "BREAKING":
    case "HIGH":
      return "critical"
    case "MEDIUM":
      return "warning"
    case "LOW":
      return "suggestion"
    default:
      return null // SAFE / UNKNOWN → no standalone finding
  }
}

function lineageBreakageLane(file: ChangedFile & { kind: string }, impact: ImpactResult, rubric: Rubric): Finding[] {
  const model = modelNameFromPath(file.path)
  const total = impact.directCount + impact.transitiveCount
  const degraded = !impact.hasManifest

  // Deleted/renamed model with downstream consumers is the canonical break.
  if ((file.status === "deleted" || file.status === "renamed") && total >= rubric.thresholds.lineageWarnConsumers) {
    const sev = clampSeverity(
      "lineage_breakage",
      total >= rubric.thresholds.lineageCriticalConsumers ? "critical" : "warning",
      degraded ? "unknown" : "high",
    )
    return [
      makeFinding({
        severity: sev,
        category: "lineage_breakage",
        title: `Model ${model} ${file.status} — ${total} downstream consumer${total !== 1 ? "s" : ""}`,
        body:
          `\`${model}\` is ${file.status} but ${total} downstream model${total !== 1 ? "s" : ""}` +
          ` (+${impact.testCount} test${impact.testCount !== 1 ? "s" : ""}) still depend on it.` +
          (degraded ? "\n\n_No manifest available — verify the blast radius locally._" : ""),
        file: file.path,
        model,
        confidence: degraded ? "unknown" : "high",
        degraded,
        evidence: { tool: "impact_analysis", result: impact },
        ruleKey: `lineage_breakage:${file.status}`,
      }),
    ]
  }

  const sev = impactToSeverity(impact)
  if (!sev) return []
  // For a MODIFIED model, blast radius alone is NOT a breaking change — a wide
  // fan-out doesn't mean the edit broke anything (it may be additive/safe). Until
  // a real column-drop classifier exists, cap modified-model lineage impact at
  // `warning` so merely touching a popular model never blocks. Only delete/rename
  // (handled above) is treated as a genuine break.
  const capped: Severity = sev === "critical" ? "warning" : sev
  const clamped = clampSeverity("lineage_breakage", capped, degraded ? "unknown" : "high")
  return [
    makeFinding({
      severity: clamped,
      category: "lineage_breakage",
      title: `${model}: high downstream fan-out (${total} model${total !== 1 ? "s" : ""})`,
      body:
        `\`${model}\` has ${impact.directCount} direct and ${impact.transitiveCount} transitive` +
        ` downstream models (+${impact.testCount} tests). Blast radius is informational — verify the` +
        ` change is backward-compatible (no removed/renamed columns) for these consumers.` +
        (degraded ? "\n\n_Lint-only: no manifest, blast radius unverified._" : ""),
      file: file.path,
      model,
      confidence: degraded ? "unknown" : "high",
      degraded,
      evidence: { tool: "impact_analysis", result: impact },
      ruleKey: "lineage_breakage:impact",
    }),
  ]
}

async function semanticChangeLane(
  file: ChangedFile & { kind: string },
  runner: ReviewRunner,
  oldSql: string | undefined,
  newSql: string | undefined,
  dialect: string,
  impact: ImpactResult,
  rubric: Rubric,
): Promise<Finding[]> {
  if (file.status !== "modified") return []
  if (!oldSql || !newSql || oldSql.trim() === newSql.trim()) return []
  const model = modelNameFromPath(file.path)
  const eq = await runner.equivalence(oldSql, newSql, dialect)

  // Provably equivalent: stay silent — never nitpick what's proven safe.
  if (eq.decided && eq.equivalent) return []

  if (!eq.decided) {
    // Undecidable / no schema → WARNING with unknown confidence, never block.
    return [
      makeFinding({
        severity: clampSeverity("semantic_change", "critical", "unknown"),
        category: "semantic_change",
        title: `${model}: refactor could not be proven equivalent`,
        body:
          `The logic of \`${model}\` changed and equivalence could not be decided` +
          ` (no schema, or unsupported SQL). Treat as a potential behavior change and verify with a data-diff.`,
        file: file.path,
        model,
        confidence: "unknown",
        degraded: true,
        evidence: { tool: "altimate_core.equivalence", result: { decided: false } },
        ruleKey: "semantic_change:undecidable",
      }),
    ]
  }

  // Decided NOT equivalent. THE FUSION: a proven behavior change to a model with
  // downstream consumers is a genuine break → critical (clamped by confidence, so
  // only high/medium can block). No downstream → warning. This is what makes
  // `semantic_change` ∈ blockOn meaningful: "provably not equivalent + N
  // downstream → BLOCK".
  const total = impact.directCount + impact.transitiveCount
  const baseSev: Severity = total >= rubric.thresholds.lineageCriticalConsumers ? "critical" : "warning"
  const diffs = (eq.differences ?? []).slice(0, 8)
  return [
    makeFinding({
      severity: clampSeverity("semantic_change", baseSev, eq.confidence ?? "medium"),
      category: "semantic_change",
      title:
        total > 0
          ? `${model}: rewrite is NOT row-equivalent — ${total} downstream consumer${total !== 1 ? "s" : ""} affected`
          : `${model}: rewrite is NOT row-equivalent`,
      body:
        `\`${model}\` is described as a refactor but produces different results:\n` +
        (diffs.length ? diffs.map((d) => `- ${d}`).join("\n") : "- output differs") +
        `\n\nConfidence: ${eq.confidence ?? "medium"}.`,
      file: file.path,
      model,
      confidence: eq.confidence ?? "medium",
      evidence: { tool: "altimate_core.equivalence", result: { equivalent: false, differences: diffs } },
      ruleKey: "semantic_change:not-equivalent",
    }),
  ]
}

async function qualityLane(
  file: ChangedFile & { kind: string },
  runner: ReviewRunner,
  sql: string | undefined,
  dialect: string,
): Promise<Finding[]> {
  if (!sql || file.status === "deleted") return []
  const model = modelNameFromPath(file.path)
  const findings: Finding[] = []

  const check = await runner.check(sql, dialect)
  for (const issue of check.issues ?? []) {
    const cat = mapCheckCategory(issue.category)
    const isError = issue.severity === "error"
    // Error-severity contract/PII issues are blockable; others are warning/suggestion.
    let sev: Severity = isError ? "warning" : "suggestion"
    if (isError && (cat === "contract_violation" || cat === "pii_exposure")) sev = "critical"
    sev = clampSeverity(cat, sev, "high")
    findings.push(
      makeFinding({
        severity: sev,
        category: cat,
        title: `${model}: ${issue.rule}`,
        body: issue.message,
        file: file.path,
        model,
        startLine: issue.line,
        endLine: issue.line,
        evidence: { tool: "altimate_core.check", result: issue },
        ruleKey: `quality:${issue.rule}`,
      }),
    )
  }
  return findings
}

function piiLane(file: ChangedFile & { kind: string }, columns: string[]): Finding[] {
  if (file.status === "deleted" || !columns.length) return []
  const model = modelNameFromPath(file.path)
  return [
    makeFinding({
      severity: "critical",
      category: "pii_exposure",
      title: `${model}: exposes PII column${columns.length !== 1 ? "s" : ""} (${columns.join(", ")})`,
      body:
        `This model surfaces PII-classified column(s): ${columns.map((c) => `\`${c}\``).join(", ")}.` +
        ` Confirm masking/access policy before merging to a non-restricted schema.`,
      file: file.path,
      model,
      confidence: "high",
      evidence: { tool: "schema.detect_pii", result: { columns } },
      ruleKey: "pii:exposure",
    }),
  ]
}

/**
 * Run the full review and return a signed verdict envelope.
 */
interface ModelContext {
  file: ChangedFile & { kind: string }
  impact: ImpactResult
  pii: string[]
  /** RAW Jinja SQL (for the dbt-patterns lane + the diff). */
  newSql?: string
  oldSql?: string
  /** dbt-COMPILED SQL (preferred) for the engine lanes; falls back to raw. */
  engineNewSql?: string
  engineOldSql?: string
}

export async function runReview(input: OrchestrateInput): Promise<VerdictEnvelope> {
  const reviewable = filterChangedFiles(input.changedFiles, input.rubric.exclusions.excludeGlobs)
  const dialect = input.config.dialect
  const getContent = input.getContent
  const getCompiled = input.getCompiled

  // Pre-compute every engine result ONCE per model file: blast radius (for
  // tiering + lineage), PII columns (hard-floor → must precede tiering), and
  // both SQL sides. This avoids duplicate engine calls and lets tiering see PII.
  const modelFiles = reviewable.filter((f) => f.kind === "model_sql" || f.kind === "python_model")
  const ctxByPath = new Map<string, ModelContext>()
  let anyManifest = false
  await Promise.all(
    modelFiles.map(async (file) => {
      const model = modelNameFromPath(file.path)
      // For renames the previous content lives at oldPath, not the new path.
      const oldRef = file.oldPath ?? file.path
      const [newSql, oldSql, compiledNew, compiledOld] = await Promise.all([
        file.status !== "deleted" ? getContent?.(file.path, "new") : Promise.resolve(undefined),
        file.status === "modified" ? getContent?.(oldRef, "old") : Promise.resolve(undefined),
        file.status !== "deleted" ? getCompiled?.(file.path, "new") : Promise.resolve(undefined),
        file.status === "modified" ? getCompiled?.(oldRef, "old") : Promise.resolve(undefined),
      ])
      // Engine lanes prefer dbt-compiled SQL (correct rendered SQL); raw is the
      // fallback. The dbt-patterns lane always uses raw (it needs the Jinja).
      const engineNewSql = compiledNew ?? newSql
      const engineOldSql = compiledOld ?? oldSql
      const impact = await input.runner.impact(model)
      if (impact.hasManifest) anyManifest = true
      const pii = engineNewSql ? (await input.runner.detectPii(engineNewSql, dialect)).columns : []
      ctxByPath.set(file.path, { file, impact, pii, newSql, oldSql, engineNewSql, engineOldSql })
    }),
  )

  // A run is degraded when model files exist but none resolved against a manifest.
  const runDegraded = modelFiles.length > 0 ? !anyManifest : reviewable.length === 0

  const tier = classifyPR(reviewable, {
    blastRadiusOf: (p) => {
      const c = ctxByPath.get(p)
      return c ? c.impact.directCount + c.impact.transitiveCount : 0
    },
    touchesPiiOf: (f) => (ctxByPath.get(f.path)?.pii.length ?? 0) > 0,
  }).tier

  const lanes = new Set(input.config.reviewers.length ? input.config.reviewers : TIER_LANES[tier])

  const all: Finding[][] = []
  for (const ctx of ctxByPath.values()) {
    const tasks: Promise<Finding[]>[] = []
    // Engine lanes consume COMPILED SQL (rendered by dbt) when available.
    if (lanes.has("sql_quality") || lanes.has("warehouse_cost"))
      tasks.push(qualityLane(ctx.file, input.runner, ctx.engineNewSql, dialect))
    if (lanes.has("semantic_change"))
      tasks.push(
        semanticChangeLane(
          ctx.file,
          input.runner,
          ctx.engineOldSql,
          ctx.engineNewSql,
          dialect,
          ctx.impact,
          input.rubric,
        ),
      )
    if (lanes.has("lineage_breakage")) all.push(lineageBreakageLane(ctx.file, ctx.impact, input.rubric))
    if (lanes.has("pii_exposure")) all.push(piiLane(ctx.file, ctx.pii))
    // Deterministic dbt anti-pattern detectors run on RAW SQL + diff (need Jinja).
    if (lanes.has("dbt_patterns")) all.push(detectModelPatterns(ctx.file, ctx.newSql, input.rubric))
    all.push(...(await Promise.all(tasks)))
  }

  // schema.yml-level detectors (test removal) — run on changed YAML files
  // regardless of tier, since deleting a guardrail test is always worth flagging.
  for (const file of reviewable) {
    if (file.kind === "schema_yml") all.push(detectSchemaYmlPatterns(file, input.rubric))
  }

  // Flatten, drop excluded, dedupe, threshold-filter.
  let findings = dedupe(all.flat())
  findings = findings.filter((f) => !exclusionReason(f, input.rubric))
  const minSev = SEVERITY_ORDER[input.config.severityThreshold]
  findings = findings.filter((f) => SEVERITY_ORDER[f.severity] >= minSev)
  // Sort by severity desc, then file.
  findings.sort((a, b) => SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity] || a.file.localeCompare(b.file))

  const degraded = runDegraded || findings.some((f) => f.degraded)
  const envelope = buildEnvelope({
    findings,
    tier,
    mode: input.mode,
    rubric: input.rubric,
    engine: { core: input.coreVersion, model: input.modelVersion },
    manifestHash: input.manifestHash,
    generatedAt: input.generatedAt,
    degraded,
  })
  return signEnvelope(envelope)
}
