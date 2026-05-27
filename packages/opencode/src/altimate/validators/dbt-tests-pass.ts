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

import { spawn } from "child_process"
import type { Validator, ValidatorContext, ValidatorResult } from "../../session/validators/types"
import {
  VALIDATOR_TIMEOUT_MS,
  findDbtProjectRoot,
  modelsModifiedSince,
  modelNameFromPath,
  extractLastJsonObject,
} from "./validator-utils"

export interface TestSummary {
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
 * Parse a dbt `test` output blob into a structured summary. Looks for the
 * `Done. PASS=X WARN=Y ERROR=Z SKIP=W NO-OP=V TOTAL=N` line that dbt prints
 * at the end. Also extracts the names of failing tests from per-line output
 * (`N of M FAIL ... <test_name>` / `N of M ERROR ... <test_name>`).
 *
 * Uses named capture groups so the parser is resilient to future field
 * reordering in dbt's summary line format.
 *
 * Returns null if no summary line is found (e.g. dbt itself errored before
 * running tests, or the output was clipped).
 */
export function parseDbtTestOutput(stdout: string): TestSummary | null {
  if (!stdout) return null
  const summaryMatch = stdout.match(
    /Done\.\s+PASS=(?<pass>\d+)\s+WARN=(?<warn>\d+)\s+ERROR=(?<err>\d+)\s+SKIP=(?<skip>\d+)(?:\s+NO-OP=\d+)?\s+TOTAL=(?<total>\d+)/i,
  )
  if (!summaryMatch) return null
  const pass = parseInt(summaryMatch.groups?.pass ?? "0", 10)
  const error = parseInt(summaryMatch.groups?.err ?? "0", 10)
  const total = parseInt(summaryMatch.groups?.total ?? "0", 10)
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
 * Times out after ALTIMATE_VALIDATORS_TIMEOUT_MS (default 60 s) and kills the
 * subprocess to prevent the agent loop from hanging indefinitely on stalled
 * warehouse connections or DuckDB file-lock contention.
 *
 * Returns null on spawn failure so the caller can track it separately.
 */
async function runDbtTest(model: string, cwd: string): Promise<TestRunOutput | null> {
  return new Promise((resolve) => {
    const child = spawn("altimate-dbt", ["test", "--model", model], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      resolve({ model, error: `timed out after ${VALIDATOR_TIMEOUT_MS}ms` })
    }, VALIDATOR_TIMEOUT_MS)
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => (stdout += String(chunk)))
    child.stderr.on("data", (chunk) => (stderr += String(chunk)))
    child.on("error", () => {
      clearTimeout(timer)
      resolve(null)
    })
    child.on("close", () => {
      clearTimeout(timer)
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
    return (await findDbtProjectRoot(ctx.workingDirectory)) !== null
  },

  async check(ctx: ValidatorContext): Promise<ValidatorResult> {
    const dbtRoot = await findDbtProjectRoot(ctx.workingDirectory)
    if (!dbtRoot) return { ok: true, details: { models_touched: 0 } }

    const touched = await modelsModifiedSince(dbtRoot, ctx.sessionStartMs)
    if (touched.length === 0) {
      return { ok: true, details: { models_touched: 0 } }
    }

    // Run all model tests in parallel; track spawn failures separately so the
    // caller can see which models were not verifiable vs which passed/failed.
    let spawnFailures = 0
    const outputs = await Promise.all(
      touched.map((path) => runDbtTest(modelNameFromPath(path), dbtRoot)),
    )
    const results: TestRunOutput[] = []
    for (const out of outputs) {
      if (out) results.push(out)
      else spawnFailures++
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
          spawn_failures: spawnFailures,
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
        spawn_failures: spawnFailures,
        failing_models: failures.map((f) => f.model),
        errored_models: errored.map((f) => f.model),
      },
    }
  },
}
// altimate_change end
