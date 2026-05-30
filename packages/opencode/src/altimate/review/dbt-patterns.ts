import path from "node:path"
import { type Finding, type Severity, makeFinding } from "./finding"
import { type ChangedFile, classifyDbtFile } from "./diff-filter"
import { type Rubric, clampSeverity, exclusionReason } from "./rubric"

/** Local copy to avoid a cycle with orchestrate.ts. */
function modelNameFromPath(p: string): string {
  return path.basename(p).replace(/\.(sql|py)$/i, "")
}

/**
 * Deterministic dbt/SQL anti-pattern detectors.
 *
 * These operate on the RAW model text + the unified diff — NOT on parsed/
 * compiled SQL — because the highest-frequency real-world review failures are
 * dbt-STRUCTURAL: Jinja config (`materialized`, `is_incremental()`), the diff
 * itself (a WHERE added on a left-joined table), and schema.yml test removal.
 * The SQL-AST engine (altimate-core) can't see any of that, so these belong
 * here in the orchestrator.
 *
 * Each detector is conservative (high precision over recall) — a false positive
 * erodes trust faster than a missed nit — and emits a finding clamped to `high`
 * confidence since the signal is a concrete textual pattern in the change.
 *
 * Scenario sources: r/dataengineering, dbt-core issues (#7597, #1256, #11766),
 * dbt Developer Blog, Datafold/Tobiko writeups. See docs/REVIEW_DEMO.md.
 */

interface DiffLines {
  added: string[]
  removed: string[]
}

/** Split a unified diff into added/removed payload lines (no +++/--- headers). */
export function splitDiff(diff: string | undefined): DiffLines {
  const added: string[] = []
  const removed: string[] = []
  for (const raw of (diff ?? "").split("\n")) {
    if (raw.startsWith("+") && !raw.startsWith("+++")) added.push(raw.slice(1))
    else if (raw.startsWith("-") && !raw.startsWith("---")) removed.push(raw.slice(1))
  }
  return { added, removed }
}

/** Strip line/block comments so detectors don't fire on commented-out code. */
function stripComments(s: string): string {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .replace(/\{#[\s\S]*?#\}/g, " ")
}

const CLOCK_RE = /\b(current_timestamp|current_date|getdate|sysdate|systimestamp|now)\s*\(/i
/** Audit/metadata columns where a clock value is expected and fine. */
const AUDIT_COL_RE = /\b(_?loaded_at|_?dbt_|_etl_|_ingested|_synced|audit_|_meta_|extracted_at)\b/i

function isModelSql(kind: string): boolean {
  return kind === "model_sql"
}

interface Ctx {
  file: ChangedFile
  kind: string
  newSql: string
  added: string[]
  removed: string[]
  model: string
  inMartOrReporting: boolean
}

type Detector = (c: Ctx) => Finding | null

// 1. Non-idempotent clock function added to a transform (not a snapshot/audit col).
const detectClock: Detector = (c) => {
  if (c.kind === "snapshot") return null
  const hits = c.added.filter((l) => CLOCK_RE.test(stripComments(l)) && !AUDIT_COL_RE.test(l))
  if (!hits.length) return null
  return makeFinding({
    severity: "warning",
    category: "idempotency",
    title: `${c.model}: non-idempotent clock function in transform`,
    body:
      "A run-time clock (`current_timestamp`/`now`/`current_date`) was added to the model logic. " +
      "The same input now yields different output across runs/backfills, breaking reproducibility " +
      "and (in incremental filters) row membership. Pass an `as_of` var or use a load-time audit column instead.",
    file: c.file.path,
    model: c.model,
    confidence: "high",
    evidence: { tool: "dbt-patterns", result: { rule: "clock_in_transform", lines: hits.slice(0, 3) } },
    ruleKey: "idempotency:clock",
  })
}

// 2. Incremental model with no is_incremental() guard.
const detectIncrementalNoGuard: Detector = (c) => {
  const isIncremental = /materialized\s*[=:]\s*['"]?incremental/i.test(c.newSql)
  if (!isIncremental) return null
  if (/is_incremental\s*\(/i.test(c.newSql)) return null
  return makeFinding({
    severity: "warning",
    category: "materialization",
    title: `${c.model}: incremental model has no is_incremental() guard`,
    body:
      "This model is materialized `incremental` but has no `{% if is_incremental() %}` filter, so every run " +
      "reprocesses the entire source (a silent cost blowup) and `{{ this }}`-based filters can fail on first build. " +
      "Wrap the late-arriving predicate in an `is_incremental()` block.",
    file: c.file.path,
    model: c.model,
    confidence: "high",
    evidence: { tool: "dbt-patterns", result: { rule: "incremental_no_guard" } },
    ruleKey: "materialization:incremental-no-guard",
  })
}

// 3. Materialization changed (added/flipped config), incl. incremental→table full-refresh risk.
const detectMaterializationChange: Detector = (c) => {
  const addedMat = c.added.find((l) => /materialized\s*[=:]/i.test(stripComments(l)))
  if (!addedMat) return null
  const toTable = /materialized\s*[=:]\s*['"]?table/i.test(addedMat)
  const removedIncremental = c.removed.some((l) => /materialized\s*[=:]\s*['"]?incremental/i.test(l))
  const fullRefreshRisk = toTable && removedIncremental
  return makeFinding({
    severity: "warning",
    category: "materialization",
    title: fullRefreshRisk
      ? `${c.model}: incremental → table will rebuild full history every run`
      : `${c.model}: materialization changed`,
    body: fullRefreshRisk
      ? "Switching an incremental model to `table` rebuilds the entire history on every run — a large, recurring " +
        "scan/compute cost. Confirm this is intended and the model is small enough."
      : "The model's materialization changed. Verify the cost/latency trade-off (view↔table↔incremental) for a model " +
        "of this size and downstream query frequency.",
    file: c.file.path,
    model: c.model,
    confidence: "high",
    evidence: { tool: "dbt-patterns", result: { rule: "materialization_change", line: addedMat.trim() } },
    ruleKey: "materialization:change",
  })
}

// 4. SELECT * added (warehouse cost + fragility on columnar warehouses).
const detectSelectStar: Detector = (c) => {
  const hit = c.added.find((l) => /^\s*select\s+\*/i.test(stripComments(l)) && !/select\s+\*\s+from\s+\{\{/i.test(l))
  if (!hit) return null
  return makeFinding({
    severity: "suggestion",
    category: "warehouse_cost",
    title: `${c.model}: SELECT * scans all columns`,
    body:
      "`SELECT *` reads every column on a columnar warehouse (Snowflake/BigQuery) and makes the model fragile to " +
      "upstream column adds. Select only the columns you need.",
    file: c.file.path,
    model: c.model,
    confidence: "high",
    evidence: { tool: "dbt-patterns", result: { rule: "select_star", line: hit.trim() } },
    ruleKey: "warehouse_cost:select-star",
  })
}

// 5. LEFT/RIGHT JOIN silently collapsed to INNER by a WHERE/AND on the outer table.
const detectLeftToInner: Detector = (c) => {
  // Collect outer-joined aliases from the new SQL.
  const aliases = new Set<string>()
  const joinRe = /\b(left|right)\s+(?:outer\s+)?join\b[\s\S]*?\bon\b/gi
  const sql = stripComments(c.newSql)
  let m: RegExpExecArray | null
  while ((m = joinRe.exec(sql))) {
    // alias is the last identifier before ON, optionally after AS
    const seg = m[0]
    const am = seg.match(/(?:as\s+)?([A-Za-z_]\w*)\s+on\b/i)
    if (am) aliases.add(am[1].toLowerCase())
  }
  if (!aliases.size) return null
  for (const line of c.added) {
    const l = stripComments(line)
    if (!/^\s*(where|and)\b/i.test(l)) continue
    if (/is\s+(not\s+)?null/i.test(l)) continue // anti-join intent is legitimate
    for (const a of aliases) {
      if (new RegExp(`\\b${a}\\.`, "i").test(l)) {
        return makeFinding({
          severity: "critical",
          category: "join_risk",
          title: `${c.model}: WHERE on left-joined \`${a}\` silently turns the LEFT JOIN into an INNER JOIN`,
          body:
            `A predicate on the outer-joined relation \`${a}\` was added in a WHERE clause. Unmatched left rows have ` +
            "NULL for those columns, so the predicate is false and they are dropped — the LEFT JOIN collapses to an " +
            "INNER JOIN and rows vanish with no error. Move the predicate into the `ON` clause, or use `IS NULL` if an " +
            "anti-join is intended.",
          file: c.file.path,
          model: c.model,
          confidence: "high",
          evidence: { tool: "dbt-patterns", result: { rule: "left_to_inner", alias: a, line: line.trim() } },
          ruleKey: "join_risk:left-to-inner",
        })
      }
    }
  }
  return null
}

// 6. Cross join / cartesian product added.
const detectCrossJoin: Detector = (c) => {
  const hit = c.added.find((l) => /\bcross\s+join\b/i.test(stripComments(l)))
  if (!hit) return null
  return makeFinding({
    severity: "critical",
    category: "join_risk",
    title: `${c.model}: CROSS JOIN creates a cartesian product`,
    body:
      "A CROSS JOIN multiplies every left row by every right row — an M×N explosion that inflates row counts, " +
      "every downstream aggregate, and warehouse cost. Confirm a join key is intended and add an `ON` clause.",
    file: c.file.path,
    model: c.model,
    confidence: "high",
    evidence: { tool: "dbt-patterns", result: { rule: "cross_join", line: hit.trim() } },
    ruleKey: "join_risk:cross-join",
  })
}

// 7. A new JOIN added into a model that aggregates → likely fan-out inflating SUM/COUNT.
const detectFanout: Detector = (c) => {
  const sql = stripComments(c.newSql)
  const aggregates = /\b(sum|count|avg|min|max)\s*\(/i.test(sql) && /\bgroup\s+by\b/i.test(sql)
  if (!aggregates) return null
  const newJoins = c.added.filter((l) => /\bjoin\b/i.test(stripComments(l)) && !/\bcross\s+join\b/i.test(l))
  if (newJoins.length < 1) return null
  return makeFinding({
    severity: "warning",
    category: "fanout",
    title: `${c.model}: new join before an aggregate may fan out and inflate metrics`,
    body:
      "A join was added to a model that aggregates (SUM/COUNT … GROUP BY). If the joined relation has multiple rows " +
      "per group key, the aggregate double-counts and metrics inflate — a classic, syntactically-valid bug. " +
      "Pre-aggregate the child to the group grain before joining, or verify the join is one-to-one.",
    file: c.file.path,
    model: c.model,
    confidence: "high",
    evidence: {
      tool: "dbt-patterns",
      result: { rule: "fanout_join", joins: newJoins.map((j) => j.trim()).slice(0, 2) },
    },
    ruleKey: "fanout:join-before-agg",
  })
}

// 8. NOT IN (subquery) — empties the result when the subquery yields a NULL.
const detectNotIn: Detector = (c) => {
  const hit = c.added.find((l) => /\bnot\s+in\s*\(\s*select\b/i.test(stripComments(l)))
  if (!hit) return null
  return makeFinding({
    severity: "warning",
    category: "sql_correctness",
    title: `${c.model}: NOT IN (subquery) returns zero rows if the subquery contains NULL`,
    body:
      "`NOT IN` against a subquery evaluates to UNKNOWN for every row once the subquery returns a single NULL, " +
      "silently emptying the result. Use `NOT EXISTS`, or filter `IS NOT NULL` inside the subquery.",
    file: c.file.path,
    model: c.model,
    confidence: "high",
    evidence: { tool: "dbt-patterns", result: { rule: "not_in_nullable", line: hit.trim() } },
    ruleKey: "sql_correctness:not-in",
  })
}

// 9. Dedup via ROW_NUMBER()/QUALIFY whose ORDER BY has no unique tiebreaker.
const detectDedupTie: Detector = (c) => {
  const hit = c.added.find((l) => /row_number\s*\(\s*\)\s*over\s*\(/i.test(stripComments(l)))
  if (!hit) return null
  const orderBy = hit.match(/order\s+by\s+([^)]+)\)/i)
  // A single order-by term (no comma) is unlikely to be unique → ties are arbitrary.
  if (orderBy && orderBy[1].includes(",")) return null
  return makeFinding({
    severity: "warning",
    category: "dedup",
    title: `${c.model}: ROW_NUMBER() dedup has no unique tiebreaker`,
    body:
      "Deduplicating with `row_number() over (partition by … order by …)` where the ORDER BY isn't provably unique " +
      "makes which row survives non-deterministic — values flap between rebuilds. Add a unique tiebreaker (e.g. a PK) " +
      "to the ORDER BY.",
    file: c.file.path,
    model: c.model,
    confidence: "high",
    evidence: { tool: "dbt-patterns", result: { rule: "dedup_no_tiebreaker", line: hit.trim() } },
    ruleKey: "dedup:no-tiebreaker",
  })
}

// 10. Surrogate-key macro argument list changed → breaks downstream joins / collisions.
const detectSurrogateKeyChange: Detector = (c) => {
  const skRe = /generate_surrogate_key\s*\(\s*\[([^\]]*)\]/i
  const addedSk = c.added.map((l) => stripComments(l).match(skRe)?.[1]).find(Boolean)
  const removedSk = c.removed.map((l) => stripComments(l).match(skRe)?.[1]).find(Boolean)
  if (!addedSk || !removedSk || addedSk.trim() === removedSk.trim()) return null
  return makeFinding({
    severity: "warning",
    category: "dedup",
    title: `${c.model}: surrogate key column set changed`,
    body:
      "The columns feeding `generate_surrogate_key` changed, so the hash changes — every downstream model that joins " +
      "on the old key breaks, and the grain may collide. Confirm downstream consumers and the key's uniqueness.",
    file: c.file.path,
    model: c.model,
    confidence: "high",
    evidence: {
      tool: "dbt-patterns",
      result: { rule: "surrogate_key_change", from: removedSk.trim(), to: addedSk.trim() },
    },
    ruleKey: "dedup:surrogate-key-change",
  })
}

// 11. Function/cast wrapped around a column in an added WHERE — defeats partition pruning.
const detectPartitionFunction: Detector = (c) => {
  const hit = c.added.find((l) => {
    const s = stripComments(l)
    return /^\s*(where|and)\b/i.test(s) && /\b(extract|date_trunc|date|year|month|cast|trunc)\s*\(/i.test(s)
  })
  if (!hit) return null
  return makeFinding({
    severity: "suggestion",
    category: "warehouse_cost",
    title: `${c.model}: function on a column in WHERE can defeat partition pruning`,
    body:
      "Wrapping a column in a function/cast inside a WHERE (e.g. `year(event_date) = 2024`) prevents the warehouse " +
      "from pruning partitions, forcing a full scan. Rewrite as a range predicate on the bare column " +
      "(`event_date >= '2024-01-01' and event_date < '2025-01-01'`).",
    file: c.file.path,
    model: c.model,
    confidence: "high",
    evidence: { tool: "dbt-patterns", result: { rule: "partition_function", line: hit.trim() } },
    ruleKey: "warehouse_cost:partition-function",
  })
}

// 12. COUNT(DISTINCT x) downgraded to COUNT(x) (or vice versa) — metric meaning change.
const COUNT_RE = /count\s*\(/i
const COUNT_DISTINCT_RE = /count\s*\(\s*distinct/i
const hasCount = (l: string) => COUNT_RE.test(stripComments(l))
const hasCountDistinct = (l: string) => COUNT_DISTINCT_RE.test(stripComments(l))
const hasPlainCount = (l: string) => hasCount(l) && !hasCountDistinct(l)
const detectCountDistinct: Detector = (c) => {
  const removedDistinct = c.removed.some(hasCountDistinct)
  const addedPlain = c.added.some(hasPlainCount)
  const addedDistinct = c.added.some(hasCountDistinct)
  const removedPlain = c.removed.some(hasPlainCount)
  if (!((removedDistinct && addedPlain) || (addedDistinct && removedPlain))) return null
  return makeFinding({
    severity: "warning",
    category: "sql_correctness",
    title: `${c.model}: COUNT distinctness changed — metric definition shifted`,
    body:
      "A `COUNT(DISTINCT …)` ↔ `COUNT(…)` change silently redefines the metric (e.g. 'orders' becomes 'line items'), " +
      "especially dangerous combined with a fan-out join. Confirm the intended grain.",
    file: c.file.path,
    model: c.model,
    confidence: "high",
    evidence: { tool: "dbt-patterns", result: { rule: "count_distinct_change" } },
    ruleKey: "sql_correctness:count-distinct",
  })
}

// 13. PII column pulled into a marts/reporting model.
const PII_RE =
  /\b(email|ssn|social_security|phone_number|first_name|last_name|full_name|street_address|date_of_birth|dob|passport|credit_card)\b/i
const detectPiiIntoMart: Detector = (c) => {
  if (!c.inMartOrReporting) return null
  const hit = c.added.find((l) => {
    const s = stripComments(l)
    return (
      PII_RE.test(s) &&
      /^\s*[\w.]*\b(email|ssn|social_security|phone_number|first_name|last_name|full_name|street_address|date_of_birth|dob|passport|credit_card)\b/i.test(
        s,
      )
    )
  })
  if (!hit) return null
  const sev: Severity = /\b(ssn|social_security|credit_card|passport)\b/i.test(hit) ? "critical" : "warning"
  return makeFinding({
    severity: sev,
    category: "pii_exposure",
    title: `${c.model}: PII column added to a marts/reporting model`,
    body:
      "A PII-named column was added to a model in `marts/`/`reporting/`, widening PII exposure into a broadly-read " +
      "layer. Confirm the column is needed here, that masking/access policy applies, and that the downstream grant is appropriate.",
    file: c.file.path,
    model: c.model,
    confidence: "high",
    evidence: { tool: "dbt-patterns", result: { rule: "pii_into_mart", line: hit.trim() } },
    ruleKey: "pii_exposure:into-mart",
  })
}

const MODEL_DETECTORS: Detector[] = [
  detectClock,
  detectIncrementalNoGuard,
  detectMaterializationChange,
  detectSelectStar,
  detectLeftToInner,
  detectCrossJoin,
  detectFanout,
  detectNotIn,
  detectDedupTie,
  detectSurrogateKeyChange,
  detectPartitionFunction,
  detectCountDistinct,
  detectPiiIntoMart,
]

/** Run the dbt anti-pattern detectors over a changed MODEL file. */
export function detectModelPatterns(file: ChangedFile, newSql: string | undefined, rubric: Rubric): Finding[] {
  const kind = classifyDbtFile(file.path)
  if (!isModelSql(kind) || file.status === "deleted" || !newSql) return []
  const { added, removed } = splitDiff(file.diff)
  const ctx: Ctx = {
    file,
    kind,
    newSql,
    added,
    removed,
    model: modelNameFromPath(file.path),
    inMartOrReporting: /(^|\/)(marts|reporting)\//.test(file.path),
  }
  const out: Finding[] = []
  for (const d of MODEL_DETECTORS) {
    const f = d(ctx)
    if (f) out.push({ ...f, severity: clampSeverity(f.category, f.severity, f.confidence) })
  }
  return out.filter((f) => !exclusionReason(f, rubric))
}

/**
 * Detect removal of `unique` / `not_null` / `relationships` tests in a schema.yml
 * diff — the guardrail that catches fan-out/dupes is the thing being deleted.
 */
export function detectSchemaYmlPatterns(file: ChangedFile, rubric: Rubric): Finding[] {
  const kind = classifyDbtFile(file.path)
  if (kind !== "schema_yml" || file.status === "deleted") return []
  const { added, removed } = splitDiff(file.diff)
  const removedTests = removed.filter((l) => /^\s*-\s*(unique|not_null|relationships)\b/i.test(l))
  // A test still present (just moved) shouldn't fire.
  const addedTests = new Set(added.map((l) => l.trim()))
  const genuinelyRemoved = removedTests.filter((l) => !addedTests.has(l.trim()))
  if (!genuinelyRemoved.length) return []
  const removedUnique = genuinelyRemoved.some((l) => /\bunique\b/i.test(l))
  const f = makeFinding({
    severity: removedUnique ? "warning" : "suggestion",
    category: "test_coverage",
    title: `${file.path.split("/").pop()}: removed ${genuinelyRemoved.length} data test(s)`,
    body:
      "This change deletes `unique`/`not_null`/`relationships` test(s) — the guardrails that catch fan-out, duplicate, " +
      "and broken-FK regressions. Removing a `unique` test on a grain key is how silent duplicate bugs ship. " +
      "Confirm the test is genuinely obsolete, not removed to make CI green.",
    file: file.path,
    confidence: "high",
    evidence: {
      tool: "dbt-patterns",
      result: { rule: "removed_tests", removed: genuinelyRemoved.map((l) => l.trim()) },
    },
    ruleKey: "test_coverage:removed-tests",
  })
  return [{ ...f, severity: clampSeverity(f.category, f.severity, f.confidence) }].filter(
    (x) => !exclusionReason(x, rubric),
  )
}
