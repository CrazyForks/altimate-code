import { describe, test, expect } from "bun:test"
import {
  makeFinding,
  fingerprint,
  parseJsonl,
  toJsonl,
  dedupe,
  type Finding,
  DEFAULT_RUBRIC,
  Rubric,
  exclusionReason,
  clampSeverity,
  computeIdealVerdict,
  applyMode,
  buildEnvelope,
  signEnvelope,
  verifyEnvelope,
  applyOverride,
  classifyDbtFile,
  shouldReview,
  classifyPR,
  classifyFile,
  type ChangedFile,
  runReview,
  modelNameFromPath,
  type ReviewRunner,
  type ImpactResult,
  type EquivalenceResult,
  renderSummary,
  inlineComments,
  parseReviewConfig,
  resolveRubric,
  DEFAULT_REVIEW_CONFIG,
} from "../../src/altimate/review"

// ---------------------------------------------------------------------------
// finding.ts
// ---------------------------------------------------------------------------
describe("finding", () => {
  test("fingerprint is stable and identity-based (ignores line/body)", () => {
    const a = fingerprint({ category: "lineage_breakage", file: "models/a.sql", model: "a", ruleKey: "drop" })
    const b = fingerprint({ category: "lineage_breakage", file: "models/a.sql", model: "a", ruleKey: "drop" })
    const c = fingerprint({ category: "lineage_breakage", file: "models/a.sql", model: "a", ruleKey: "rename" })
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a.startsWith("f_")).toBe(true)
  })

  test("makeFinding auto-assigns fingerprint from ruleKey", () => {
    const f1 = makeFinding({
      severity: "warning",
      category: "sql_quality",
      title: "SELECT * detected",
      body: "avoid select star",
      file: "models/x.sql",
      ruleKey: "no-select-star",
    })
    const f2 = makeFinding({
      severity: "warning",
      category: "sql_quality",
      title: "SELECT * detected on line 9", // different title/body
      body: "different wording",
      file: "models/x.sql",
      ruleKey: "no-select-star",
    })
    expect(f1.id).toBe(f2.id) // identity survives rewording
  })

  test("parseJsonl tolerates malformed lines", () => {
    const good = makeFinding({
      severity: "critical",
      category: "pii_exposure",
      title: "pii",
      body: "b",
      file: "m.sql",
      ruleKey: "pii",
    })
    const jsonl = [toJsonl([good]), "{not json", "// a comment", '{"foo":"bar"}'].join("\n")
    const { findings, skipped } = parseJsonl(jsonl)
    expect(findings.length).toBe(1)
    expect(skipped).toBe(2) // bad json + invalid finding shape; comment ignored not counted
  })

  test("dedupe keeps highest severity per fingerprint", () => {
    const base = { category: "sql_quality" as const, file: "m.sql", title: "t", body: "b", ruleKey: "r" }
    const sug = makeFinding({ ...base, severity: "suggestion" })
    const warn = makeFinding({ ...base, severity: "warning" })
    const out = dedupe([sug, warn])
    expect(out.length).toBe(1)
    expect(out[0].severity).toBe("warning")
  })
})

// ---------------------------------------------------------------------------
// rubric.ts
// ---------------------------------------------------------------------------
describe("rubric", () => {
  test("UNKNOWN/low confidence can never be critical (the safety invariant)", () => {
    expect(clampSeverity("semantic_change", "critical", "unknown")).toBe("warning")
    expect(clampSeverity("lineage_breakage", "critical", "low")).toBe("warning")
    expect(clampSeverity("pii_exposure", "critical", "high")).toBe("critical")
  })

  test("exclusion: non-prod models are skipped", () => {
    const f = makeFinding({
      severity: "warning",
      category: "warehouse_cost",
      title: "scan",
      body: "x",
      file: "models/dev/scratch.sql",
      ruleKey: "scan",
    })
    expect(exclusionReason(f, DEFAULT_RUBRIC)).toContain("non-prod")
  })

  test("exclusion: SELECT * allowed in staging", () => {
    const f = makeFinding({
      severity: "suggestion",
      category: "warehouse_cost",
      title: "SELECT * found",
      body: "select * from t",
      file: "models/staging/stg_x.sql",
      model: "stg_x",
      ruleKey: "select-star",
    })
    expect(exclusionReason(f, DEFAULT_RUBRIC)).toContain("staging")
  })
})

// ---------------------------------------------------------------------------
// verdict.ts
// ---------------------------------------------------------------------------
describe("verdict", () => {
  const mk = (severity: Finding["severity"], category: any = "sql_quality") =>
    makeFinding({
      severity,
      category,
      title: "t",
      body: "b",
      file: `m_${Math.random()}.sql`,
      ruleKey: String(Math.random()),
    })

  test("empty findings → APPROVE", () => {
    expect(computeIdealVerdict([], DEFAULT_RUBRIC)).toBe("APPROVE")
  })

  test("blocking-category critical → REQUEST_CHANGES", () => {
    expect(computeIdealVerdict([mk("critical", "lineage_breakage")], DEFAULT_RUBRIC)).toBe("REQUEST_CHANGES")
  })

  test("non-blocking critical does not force block by category", () => {
    // sql_quality is not in blockOn; a lone non-blocking critical → COMMENT
    expect(computeIdealVerdict([mk("critical", "sql_quality")], DEFAULT_RUBRIC)).toBe("COMMENT")
  })

  test(">= threshold warnings → REQUEST_CHANGES (risk pattern)", () => {
    const f = [mk("warning"), mk("warning"), mk("warning")]
    expect(computeIdealVerdict(f, DEFAULT_RUBRIC)).toBe("REQUEST_CHANGES")
  })

  test("unknown-confidence warnings do NOT accumulate into a block", () => {
    const u = (i: number) =>
      makeFinding({
        severity: "warning",
        category: "semantic_change",
        title: "t" + i,
        body: "b",
        file: `m${i}.sql`,
        confidence: "unknown",
        ruleKey: "r" + i,
      })
    // Three unprovable refactors must not fail the gate.
    expect(computeIdealVerdict([u(1), u(2), u(3)], DEFAULT_RUBRIC)).toBe("COMMENT")
  })

  test("single suggestion → COMMENT", () => {
    expect(computeIdealVerdict([mk("suggestion")], DEFAULT_RUBRIC)).toBe("COMMENT")
  })

  test("comment mode softens REQUEST_CHANGES → COMMENT", () => {
    expect(applyMode("REQUEST_CHANGES", "comment")).toBe("COMMENT")
    expect(applyMode("REQUEST_CHANGES", "gate")).toBe("REQUEST_CHANGES")
  })

  test("envelope signs and verifies; tamper is detected", () => {
    const env = buildEnvelope({
      findings: [mk("critical", "pii_exposure")],
      tier: "full",
      mode: "gate",
      generatedAt: "2026-05-29T00:00:00Z",
    })
    const signed = signEnvelope(env, "test-key")
    expect(signed.signature).toBeDefined()
    expect(verifyEnvelope(signed, "test-key")).toBe(true)
    expect(verifyEnvelope(signed, "wrong-key")).toBe(false)
    const tampered = { ...signed, verdict: "APPROVE" as const }
    expect(verifyEnvelope(tampered, "test-key")).toBe(false)
  })

  test("tampering a NESTED finding field is detected (signature covers findings)", () => {
    const f = makeFinding({
      severity: "warning",
      category: "sql_quality",
      title: "t",
      body: "b",
      file: "m.sql",
      ruleKey: "r",
    })
    const signed = signEnvelope(
      buildEnvelope({ findings: [f], tier: "lite", mode: "comment", generatedAt: "2026-05-29T00:00:00Z" }),
      "k",
    )
    expect(verifyEnvelope(signed, "k")).toBe(true)
    const tampered = { ...signed, findings: [{ ...signed.findings[0], severity: "critical" as const }] }
    expect(verifyEnvelope(tampered, "k")).toBe(false)
  })

  test("break-glass override records prior verdict and re-signs", () => {
    const env = signEnvelope(
      buildEnvelope({ findings: [mk("critical", "contract_violation")], tier: "full", mode: "gate" }),
      "k",
    )
    const overridden = applyOverride(env, "alice", "hotfix", "k")
    expect(overridden.verdict).toBe("COMMENT")
    expect(overridden.override?.priorVerdict).toBe("REQUEST_CHANGES")
    expect(verifyEnvelope(overridden, "k")).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// diff-filter.ts + risk-tier.ts
// ---------------------------------------------------------------------------
describe("diff-filter", () => {
  test("skips build artifacts, keeps models/macros/snapshots", () => {
    expect(shouldReview("target/compiled/x.sql")).toBe(false)
    expect(shouldReview("dbt_packages/dbt_utils/x.sql")).toBe(false)
    expect(shouldReview("target/manifest.json")).toBe(false)
    expect(shouldReview("models/marts/fct_orders.sql")).toBe(true)
    expect(shouldReview("macros/x.sql")).toBe(true)
    expect(shouldReview("snapshots/s.sql")).toBe(true)
  })

  test("classifies dbt file kinds", () => {
    expect(classifyDbtFile("models/marts/fct_orders.sql")).toBe("model_sql")
    expect(classifyDbtFile("models/marts/_marts.yml")).toBe("schema_yml")
    expect(classifyDbtFile("macros/x.sql")).toBe("macro")
    expect(classifyDbtFile("snapshots/s.sql")).toBe("snapshot")
    expect(classifyDbtFile("seeds/c.csv")).toBe("seed")
    expect(classifyDbtFile("dbt_project.yml")).toBe("project_config")
    expect(classifyDbtFile("models/marts/m.py")).toBe("python_model")
  })
})

describe("risk-tier", () => {
  const file = (path: string, diff: string, status: ChangedFile["status"] = "modified"): ChangedFile => ({
    path,
    status,
    diff,
  })

  test("trivial: schema-yml description-only, no downstream", () => {
    const r = classifyPR([file("models/marts/_m.yml", "+    description: better docs\n")])
    expect(r.tier).toBe("trivial")
  })

  test("full: PII touch forces full regardless of size", () => {
    const r = classifyPR([file("models/marts/dim.sql", "+select email from x\n")], {
      touchesPiiOf: () => true,
    })
    expect(r.tier).toBe("full")
    expect(r.reasons.join(" ")).toContain("PII")
  })

  test("full: materialization change forces full", () => {
    const r = classifyPR([file("models/marts/big.sql", "+{{ config(materialized='table') }}\nselect 1\n")])
    expect(r.tier).toBe("full")
  })

  test("full: contract touch forces full", () => {
    const r = classifyPR([file("models/marts/_m.yml", "+    contract:\n+      enforced: true\n")])
    expect(r.tier).toBe("full")
  })

  test("lite: small SQL logic change with bounded blast radius", () => {
    const diff = "+select a, b\n-select a\n"
    const r = classifyPR([file("models/intermediate/int_x.sql", diff)], { blastRadiusOf: () => 2 })
    expect(r.tier).toBe("lite")
  })

  test("full: blast radius > 5", () => {
    const r = classifyPR([file("models/staging/stg_x.sql", "+select a\n")], { blastRadiusOf: () => 12 })
    expect(r.tier).toBe("full")
  })

  test("full: source definition (+sources:) forces full despite diff prefix", () => {
    const r = classifyPR([file("models/staging/_sources.yml", "+sources:\n+  - name: raw_orders\n")])
    expect(r.tier).toBe("full")
    expect(r.reasons.join(" ")).toContain("source")
  })
})

// ---------------------------------------------------------------------------
// config.ts
// ---------------------------------------------------------------------------
describe("config", () => {
  test("parses yaml and applies defaults", () => {
    const cfg = parseReviewConfig("mode: gate\nseverityThreshold: warning\nexclude:\n  - legacy/**\n")
    expect(cfg.mode).toBe("gate")
    expect(cfg.severityThreshold).toBe("warning")
    expect(cfg.manifestPath).toBe("target/manifest.json") // default
  })

  test("empty config yields defaults", () => {
    expect(parseReviewConfig("").mode).toBe("comment")
  })

  test("resolveRubric folds exclude globs into rubric", () => {
    const cfg = { ...DEFAULT_REVIEW_CONFIG, exclude: ["legacy/old.sql"] }
    const rubric = resolveRubric(cfg)
    expect(rubric.exclusions.excludeGlobs).toContain("legacy/old.sql")
  })
})

// ---------------------------------------------------------------------------
// orchestrate.ts — the integration test with a fake engine
// ---------------------------------------------------------------------------
describe("orchestrate", () => {
  test("modelNameFromPath", () => {
    expect(modelNameFromPath("models/marts/fct_revenue.sql")).toBe("fct_revenue")
    expect(modelNameFromPath("models/x/m.py")).toBe("m")
  })

  // A scripted fake engine keyed by model name.
  function fakeRunner(opts: {
    impact?: Record<string, ImpactResult>
    equivalence?: Record<string, EquivalenceResult>
    pii?: Record<string, string[]>
    checkIssues?: Record<
      string,
      Array<{ rule: string; message: string; line?: number; severity?: string; category?: string }>
    >
  }): ReviewRunner {
    return {
      async impact(model) {
        return (
          opts.impact?.[model] ?? {
            hasManifest: true,
            severity: "SAFE",
            directCount: 0,
            transitiveCount: 0,
            testCount: 0,
          }
        )
      },
      async grade() {
        return { grade: "B" }
      },
      async check(_sql, _d) {
        // keyed by nothing here — issues injected via closure when needed
        return { issues: [] }
      },
      async equivalence(_o, _n, _d) {
        return { decided: false }
      },
      async detectPii() {
        return { columns: [] }
      },
    } as ReviewRunner
  }

  const content = (newSql: string, oldSql?: string) => async (_f: string, side: "old" | "new") =>
    side === "new" ? newSql : (oldSql ?? newSql)

  test("breaking deletion of a model with downstream → critical lineage_breakage + REQUEST_CHANGES (gate)", async () => {
    const files: ChangedFile[] = [{ path: "models/staging/stg_orders.sql", status: "deleted", diff: "" }]
    const runner = fakeRunner({
      impact: {
        stg_orders: { hasManifest: true, severity: "BREAKING", directCount: 3, transitiveCount: 8, testCount: 4 },
      },
    })
    const env = await runReview({
      changedFiles: files,
      config: { ...DEFAULT_REVIEW_CONFIG, mode: "gate" },
      rubric: DEFAULT_RUBRIC,
      mode: "gate",
      runner,
      generatedAt: "2026-05-29T00:00:00Z",
    })
    const breakage = env.findings.find((f) => f.category === "lineage_breakage")
    expect(breakage).toBeDefined()
    expect(breakage!.severity).toBe("critical")
    expect(env.verdict).toBe("REQUEST_CHANGES")
    expect(verifyEnvelope(signEnvelope({ ...env, signature: undefined }))).toBe(true)
  })

  test("FUSION: proven non-equivalent + downstream → critical → blocks (gate)", async () => {
    const files: ChangedFile[] = [{ path: "models/marts/fct_revenue.sql", status: "modified", diff: "+x\n-y\n" }]
    const runner: ReviewRunner = {
      ...fakeRunner({}),
      async impact() {
        return { hasManifest: true, severity: "MEDIUM", directCount: 4, transitiveCount: 2, testCount: 1 }
      },
      async equivalence() {
        return {
          decided: true,
          equivalent: false,
          differences: ["LEFT JOIN became INNER → drops NULL rows"],
          confidence: "high",
        }
      },
    }
    const env = await runReview({
      changedFiles: files,
      config: { ...DEFAULT_REVIEW_CONFIG },
      rubric: DEFAULT_RUBRIC,
      mode: "gate",
      runner,
      getContent: content("select 2", "select 1"),
      generatedAt: "2026-05-29T00:00:00Z",
    })
    const sem = env.findings.find((f) => f.category === "semantic_change")
    expect(sem).toBeDefined()
    expect(sem!.severity).toBe("critical") // proven break + downstream consumers
    expect(sem!.body).toContain("NULL")
    expect(env.verdict).toBe("REQUEST_CHANGES")
  })

  test("proven non-equivalent with NO downstream → warning (not critical)", async () => {
    const files: ChangedFile[] = [{ path: "models/marts/leaf.sql", status: "modified", diff: "+x\n-y\n" }]
    const runner: ReviewRunner = {
      ...fakeRunner({}),
      async impact() {
        return { hasManifest: true, severity: "SAFE", directCount: 0, transitiveCount: 0, testCount: 0 }
      },
      async equivalence() {
        return { decided: true, equivalent: false, differences: ["filter changed"], confidence: "high" }
      },
    }
    const env = await runReview({
      changedFiles: files,
      config: { ...DEFAULT_REVIEW_CONFIG },
      rubric: DEFAULT_RUBRIC,
      mode: "gate",
      runner,
      getContent: content("select 2", "select 1"),
      generatedAt: "2026-05-29T00:00:00Z",
    })
    const sem = env.findings.find((f) => f.category === "semantic_change")
    expect(sem!.severity).toBe("warning")
    expect(env.verdict).not.toBe("REQUEST_CHANGES")
  })

  test("modified high-fanout model → warning (not critical), does not block", async () => {
    const files: ChangedFile[] = [{ path: "models/staging/stg_orders.sql", status: "modified", diff: "+select 1\n" }]
    const runner: ReviewRunner = {
      ...fakeRunner({}),
      async impact() {
        return { hasManifest: true, severity: "HIGH", directCount: 12, transitiveCount: 30, testCount: 5 }
      },
    }
    const env = await runReview({
      changedFiles: files,
      config: { ...DEFAULT_REVIEW_CONFIG },
      rubric: DEFAULT_RUBRIC,
      mode: "gate",
      runner,
      getContent: content("select 1", "select 1"), // identical → no semantic finding, isolates lineage
      generatedAt: "2026-05-29T00:00:00Z",
    })
    const lin = env.findings.find((f) => f.category === "lineage_breakage")
    expect(lin?.severity).toBe("warning")
    expect(env.verdict).not.toBe("REQUEST_CHANGES")
  })

  test("engine contract_violation is preserved (not coerced to sql_quality) and blocks", async () => {
    const files: ChangedFile[] = [{ path: "models/marts/fct_orders.sql", status: "modified", diff: "+x\n" }]
    const runner: ReviewRunner = {
      ...fakeRunner({}),
      async check() {
        return {
          issues: [{ rule: "contract.enforced", message: "type narrowed", severity: "error", category: "contract" }],
        }
      },
    }
    const env = await runReview({
      changedFiles: files,
      config: { ...DEFAULT_REVIEW_CONFIG },
      rubric: DEFAULT_RUBRIC,
      mode: "gate",
      runner,
      getContent: content("select 1", "select 1"), // identical → isolate the quality lane
      generatedAt: "2026-05-29T00:00:00Z",
    })
    const cv = env.findings.find((f) => f.category === "contract_violation")
    expect(cv).toBeDefined()
    expect(cv!.severity).toBe("critical")
    expect(env.verdict).toBe("REQUEST_CHANGES")
  })

  test("provably equivalent refactor → no semantic finding (don't nitpick what's safe)", async () => {
    const files: ChangedFile[] = [{ path: "models/marts/fct_revenue.sql", status: "modified", diff: "+x\n-y\n" }]
    const runner: ReviewRunner = {
      ...fakeRunner({}),
      async equivalence() {
        return { decided: true, equivalent: true, confidence: "high" }
      },
    }
    const env = await runReview({
      changedFiles: files,
      config: { ...DEFAULT_REVIEW_CONFIG },
      rubric: DEFAULT_RUBRIC,
      mode: "comment",
      runner,
      getContent: content("select 2 /*refactor*/", "select 1"),
    })
    expect(env.findings.find((f) => f.category === "semantic_change")).toBeUndefined()
  })

  test("undecidable equivalence → unknown-confidence warning, never critical", async () => {
    const files: ChangedFile[] = [{ path: "models/marts/fct_revenue.sql", status: "modified", diff: "+x\n" }]
    const runner: ReviewRunner = {
      ...fakeRunner({}),
      async equivalence() {
        return { decided: false }
      },
    }
    const env = await runReview({
      changedFiles: files,
      config: { ...DEFAULT_REVIEW_CONFIG },
      rubric: DEFAULT_RUBRIC,
      mode: "gate",
      runner,
      getContent: content("select 2", "select 1"),
    })
    const sem = env.findings.find((f) => f.category === "semantic_change")
    expect(sem).toBeDefined()
    expect(sem!.confidence).toBe("unknown")
    expect(sem!.severity).not.toBe("critical")
  })

  test("PII exposure → critical pii_exposure finding", async () => {
    const files: ChangedFile[] = [{ path: "models/marts/dim_customers.sql", status: "modified", diff: "+email\n" }]
    const runner: ReviewRunner = {
      ...fakeRunner({}),
      async detectPii() {
        return { columns: ["email", "ssn"] }
      },
    }
    const env = await runReview({
      changedFiles: files,
      config: { ...DEFAULT_REVIEW_CONFIG },
      rubric: DEFAULT_RUBRIC,
      mode: "gate",
      runner,
      getContent: content("select email, ssn from x"),
    })
    const pii = env.findings.find((f) => f.category === "pii_exposure")
    expect(pii).toBeDefined()
    expect(pii!.severity).toBe("critical")
    expect(env.verdict).toBe("REQUEST_CHANGES")
  })

  test("clean change with no manifest → degraded, APPROVE/COMMENT, lint-only labeled", async () => {
    const files: ChangedFile[] = [{ path: "models/staging/stg_x.sql", status: "modified", diff: "+select 1\n" }]
    const runner: ReviewRunner = {
      ...fakeRunner({}),
      async impact() {
        return { hasManifest: false, severity: "UNKNOWN", directCount: 0, transitiveCount: 0, testCount: 0 }
      },
    }
    const env = await runReview({
      changedFiles: files,
      config: { ...DEFAULT_REVIEW_CONFIG },
      rubric: DEFAULT_RUBRIC,
      mode: "comment",
      runner,
      getContent: content("select 1"),
    })
    expect(env.summary.degraded).toBe(true)
    expect(["APPROVE", "COMMENT"]).toContain(env.verdict)
  })

  test("renderSummary + inlineComments produce marker + structured output", async () => {
    const env = buildEnvelope({
      findings: [
        makeFinding({
          severity: "warning",
          category: "sql_quality",
          title: "issue",
          body: "body",
          file: "models/x.sql",
          startLine: 5,
          ruleKey: "r",
        }),
      ],
      tier: "lite",
      mode: "comment",
      generatedAt: "2026-05-29T00:00:00Z",
    })
    const summary = renderSummary(env)
    expect(summary).toContain("altimate-code-review")
    expect(summary).toContain("Reviewed with comments")
    const inline = inlineComments(env)
    expect(inline.length).toBe(1)
    expect(inline[0]).toMatchObject({ path: "models/x.sql", line: 5, side: "RIGHT" })
  })
})
