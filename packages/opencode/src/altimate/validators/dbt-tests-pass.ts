// altimate_change start — dbt tests-pass validator (harness-side enforcement)
/**
 * dbt tests-pass validator.
 *
 * Fires after the agent declares done. Detects which dbt models the session
 * touched, runs `altimate-dbt test --model <name>` against each, and refuses
 * to terminate if any dbt test fails or errors.
 *
 * Catches row-data correctness errors that the column-shape validator does
 * not: a model whose schema.yml matches the actual columns can still fail
 * `relationships`, `unique`, `not_null`, `accepted_values`, or AUTO_equality
 * tests because the SELECT logic produces wrong values or wrong row counts.
 *
 * The agent does not see this validator existing — it runs in the harness
 * AFTER `finishReason === "stop"`. Its output is surfaced to the agent only
 * if there are failures, via a synthetic user message the framework injects
 * to force one more turn. See types.ts header for the rationale.
 */

import { promises as fs } from "fs"
import { join } from "path"
import { spawn } from "child_process"
import type { Validator, ValidatorContext, ValidatorResult } from "../../session/validators/types"

interface TestSummary {
  /** Total tests run for this model (across the dbt test invocation). */
  total: number
  /** Tests that passed. */
  pass: number
  /** Tests that errored OR failed (dbt collapses both into ERROR=N in the summary). */
  error: number
  /** Names of failing or erroring tests, captured from per-line output. */
  failingTests: string[]
}

interface TestRunOutput {
  /** Model the test was run against. */
  model: string
  /** Parsed summary, when output was parseable. */
  summary?: TestSummary
  /** Top-level error from altimate-dbt (manifest missing, compile error, etc.). */
  error?: string
}

/**
 * Best-effort check that the working directory looks like a dbt project.
 * Scans the directory itself and one level of subdirs for `dbt_project.yml`.
 */
async function isDbtProject(cwd: string): Promise<boolean> {
  try {
    const direct = await fs.stat(join(cwd, "dbt_project.yml")).then(
      () => true,
      () => false,
    )
    if (direct) return true
    const entries = await fs.readdir(cwd, { withFileTypes: true })
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const nested = await fs.stat(join(cwd, e.name, "dbt_project.yml")).then(
        () => true,
        () => false,
      )
      if (nested) return true
    }
    return false
  } catch {
    return false
  }
}

/**
 * Find dbt model `.sql` files under the working directory that were modified
 * since the session started.
 */
async function modelsModifiedSince(cwd: string, sinceMs: number): Promise<string[]> {
  const found: string[] = []
  async function scan(dir: string, depth: number): Promise<void> {
    if (depth > 4) return
    let entries: import("fs").Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "target") continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        await scan(full, depth + 1)
      } else if (entry.isFile() && entry.name.endsWith(".sql")) {
        try {
          const stat = await fs.stat(full)
          if (stat.mtimeMs >= sinceMs) {
            if (full.split("/").includes("models")) {
              found.push(full)
            }
          }
        } catch {
          // ignore unstattable files
        }
      }
    }
  }
  await scan(cwd, 0)
  return found
}

/** Extract bare model name from a `.sql` file path. `models/marts/foo.sql` -> `foo`. */
function modelNameFromPath(p: string): string {
  const base = p.split("/").pop() ?? p
  return base.replace(/\.sql$/i, "")
}

/**
 * Parse a dbt `test` output blob into a structured summary. Looks for the
 * `Done. PASS=X WARN=Y ERROR=Z SKIP=W NO-OP=V TOTAL=N` line that dbt prints
 * at the end. Also extracts the names of failing tests from per-line output
 * (`N of M FAIL ... <test_name>` / `N of M ERROR ... <test_name>`).
 *
 * Returns null if no summary line is found (e.g. dbt itself errored before
 * running tests, or the output was clipped).
 */
function parseDbtTestOutput(stdout: string): TestSummary | null {
  if (!stdout) return null
  const summaryMatch = stdout.match(
    /Done\.\s+PASS=(\d+)\s+WARN=(\d+)\s+ERROR=(\d+)\s+SKIP=(\d+)(?:\s+NO-OP=\d+)?\s+TOTAL=(\d+)/i,
  )
  if (!summaryMatch) return null
  const pass = parseInt(summaryMatch[1] ?? "0", 10)
  const error = parseInt(summaryMatch[3] ?? "0", 10)
  const total = parseInt(summaryMatch[5] ?? "0", 10)
  // Pull individual FAIL/ERROR test names. dbt formats lines like:
  //   17:04:14  3 of 7 FAIL 5 unique_my_model_id [FAIL 5 in 0.05s]
  //   17:04:14  4 of 7 ERROR not_null_my_model_id [ERROR in 0.05s]
  // The test name follows the optional failure count.
  const failingTests: string[] = []
  const lineRe = /\d+\s+of\s+\d+\s+(?:FAIL|ERROR)(?:\s+\d+)?\s+(\S+)/g
  let m: RegExpExecArray | null
  while ((m = lineRe.exec(stdout)) !== null) {
    const name = m[1]
    if (name && name !== "[FAIL" && name !== "[ERROR" && !failingTests.includes(name)) {
      failingTests.push(name)
    }
  }
  return { total, pass, error, failingTests }
}

/**
 * Run `altimate-dbt test --model <name>` and parse its summary. The altimate-dbt
 * CLI wraps dbt's stdout in a `{"stdout": "..."}` JSON envelope on success
 * (or `{"error": "..."}` on failure). We unwrap then parse the dbt text.
 *
 * Returns null on spawn failure so the caller can fall back gracefully.
 */
async function runDbtTest(model: string, cwd: string): Promise<TestRunOutput | null> {
  return new Promise((resolve) => {
    const child = spawn("altimate-dbt", ["test", "--model", model], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => (stdout += String(chunk)))
    child.stderr.on("data", (chunk) => (stderr += String(chunk)))
    child.on("error", () => resolve(null))
    child.on("close", () => {
      // altimate-dbt writes its envelope JSON to stdout. The envelope itself
      // is either { "stdout": "<dbt log>" } or { "error": "...", "stdout": "..." }.
      // Find the last balanced { ... } block (the envelope tends to be at the
      // end after any leading log noise).
      const envelope = extractLastJsonObject(stdout)
      if (!envelope) {
        if (stderr) resolve({ model, error: stderr.slice(0, 500) })
        else if (stdout) resolve({ model, error: `unparseable stdout: ${stdout.slice(-400)}` })
        else resolve(null)
        return
      }
      if (typeof envelope.error === "string") {
        resolve({ model, error: envelope.error.slice(0, 500) })
        return
      }
      const dbtLog = typeof envelope.stdout === "string" ? envelope.stdout : ""
      const summary = parseDbtTestOutput(dbtLog)
      if (!summary) {
        resolve({ model, error: `no PASS/ERROR summary in dbt output: ${dbtLog.slice(-300)}` })
        return
      }
      resolve({ model, summary })
    })
  })
}

/**
 * Find the LAST top-level `{ ... }` block in a string and JSON-parse it.
 * Mirrors the helper in dbt-schema-verify.ts — keeps each validator file
 * standalone, no shared utility to import.
 */
function extractLastJsonObject(stdout: string): Record<string, unknown> | null {
  if (!stdout) return null
  // Fast path
  try {
    return JSON.parse(stdout) as Record<string, unknown>
  } catch {
    // fall through
  }
  let best: Record<string, unknown> | null = null
  for (let i = 0; i < stdout.length; i++) {
    if (stdout[i] !== "{") continue
    let depth = 0
    let inString: '"' | null = null
    let escaped = false
    for (let j = i; j < stdout.length; j++) {
      const ch = stdout[j]
      if (escaped) {
        escaped = false
        continue
      }
      if (ch === "\\") {
        escaped = true
        continue
      }
      if (inString) {
        if (ch === inString) inString = null
        continue
      }
      if (ch === '"') {
        inString = '"'
        continue
      }
      if (ch === "{") depth++
      else if (ch === "}") {
        depth--
        if (depth === 0) {
          try {
            const parsed = JSON.parse(stdout.slice(i, j + 1)) as Record<string, unknown>
            best = parsed
          } catch {
            // skip
          }
          break
        }
      }
    }
  }
  return best
}

/** Format a list of failing-test runs into a single concise synthetic-message block. */
function formatFixHint(failures: TestRunOutput[]): string {
  const lines: string[] = []
  for (const f of failures) {
    if (f.summary) {
      lines.push(
        `Model \`${f.model}\` — ${f.summary.error} of ${f.summary.total} tests failed/errored:`,
      )
      if (f.summary.failingTests.length > 0) {
        for (const name of f.summary.failingTests.slice(0, 10)) {
          lines.push(`  • ${name}`)
        }
        if (f.summary.failingTests.length > 10) {
          lines.push(`  • …and ${f.summary.failingTests.length - 10} more`)
        }
      }
    } else if (f.error) {
      lines.push(`Model \`${f.model}\` — could not run tests: ${f.error.slice(0, 200)}`)
    }
  }
  return lines.join("\n")
}

export const DbtTestsPassValidator: Validator = {
  name: "dbt-tests-pass",
  description:
    "After the agent declares done, runs `altimate-dbt test` against every dbt model the agent modified during this session and refuses to terminate if any model's tests fail or error. Catches row-data correctness errors (relationships, unique, not_null, accepted_values, AUTO_*_equality) that column-shape verification cannot detect.",

  async appliesTo(ctx: ValidatorContext): Promise<boolean> {
    return isDbtProject(ctx.workingDirectory)
  },

  async check(ctx: ValidatorContext): Promise<ValidatorResult> {
    const touched = await modelsModifiedSince(ctx.workingDirectory, ctx.sessionStartMs)
    if (touched.length === 0) {
      return { ok: true, details: { models_touched: 0 } }
    }

    const results: TestRunOutput[] = []
    for (const path of touched) {
      const name = modelNameFromPath(path)
      const out = await runDbtTest(name, ctx.workingDirectory)
      if (out) results.push(out)
    }

    const failures = results.filter((r) => r.summary && r.summary.error > 0)
    const errored = results.filter((r) => r.error && !r.summary)
    const passed = results.filter((r) => r.summary && r.summary.error === 0)
    // A model with no tests at all isn't a failure — it's just nothing to verify.
    const noTests = results.filter((r) => r.summary && r.summary.total === 0)

    if (failures.length === 0 && errored.length === 0) {
      return {
        ok: true,
        details: {
          models_touched: touched.length,
          checked: results.length,
          passed: passed.length,
          no_tests: noTests.length,
        },
      }
    }

    const hintBlocks: TestRunOutput[] = [...failures, ...errored]
    return {
      ok: false,
      reason:
        failures.length > 0
          ? `${failures.length} of ${results.length} models you edited have failing dbt tests.`
          : `${errored.length} of ${results.length} models could not be tested. Investigate before declaring done.`,
      fixHint:
        formatFixHint(hintBlocks) +
        `\n\nFix the model SQL (not the tests). Common causes: wrong JOIN type (LEFT vs INNER changing row counts), missing GROUP BY columns, dropped/added rows from filters, type coercion mismatch on join keys. Rebuild and the harness will re-check before declaring done.`,
      details: {
        models_touched: touched.length,
        checked: results.length,
        passed: passed.length,
        failed: failures.length,
        errored: errored.length,
        failing_models: failures.map((f) => f.model),
        errored_models: errored.map((f) => f.model),
      },
    }
  },
}
// altimate_change end
