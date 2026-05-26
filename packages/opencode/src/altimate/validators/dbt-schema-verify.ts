// altimate_change start — dbt schema-verify validator (harness-side enforcement)
/**
 * dbt schema-verify validator.
 *
 * Fires after the agent declares done. Detects whether the session touched
 * any dbt models, runs `altimate-dbt schema-verify` against each touched
 * model, and reports a mismatch if the produced column shape diverges from
 * the schema.yml spec.
 *
 * The agent does not see this validator existing — it runs in the harness
 * AFTER `finishReason === "stop"`. Its output is surfaced to the agent only
 * if there is a mismatch, via a synthetic user message the framework injects
 * to force one more turn. This is the only enforcement layer not bypassable
 * by the agent — see types.ts header for the rationale.
 */

import { promises as fs } from "fs"
import { join } from "path"
import { spawn } from "child_process"
import type { Validator, ValidatorContext, ValidatorResult } from "../../session/validators/types"

interface SchemaVerifyOutput {
  model?: string
  verdict?: "match" | "mismatch" | "no-spec"
  columns_extra?: string[]
  columns_missing?: string[]
  columns_reordered?: unknown[]
  type_mismatches?: unknown[]
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
    // Some benchmark layouts nest the project one level deep. Cheap scan.
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
 * since the session started. Limited to two-level deep search to keep cost
 * bounded on large projects.
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
            // Convention: dbt models live under a `models/` ancestor.
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
 * Run `altimate-dbt schema-verify --model <name>` and parse its JSON output.
 * Returns null on spawn failure so the caller can fall back gracefully.
 */
async function runSchemaVerify(model: string, cwd: string): Promise<SchemaVerifyOutput | null> {
  return new Promise((resolve) => {
    const child = spawn("altimate-dbt", ["schema-verify", "--model", model], {
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
      try {
        const parsed = JSON.parse(stdout) as SchemaVerifyOutput
        resolve(parsed)
      } catch {
        if (stderr) resolve({ error: stderr.slice(0, 500) })
        else resolve(null)
      }
    })
  })
}

/** Format a list of mismatches into a single concise synthetic-message block. */
function formatFixHint(mismatches: SchemaVerifyOutput[]): string {
  const lines: string[] = []
  for (const m of mismatches) {
    if (!m.model) continue
    lines.push(`Model \`${m.model}\`:`)
    if (m.columns_extra && m.columns_extra.length > 0) {
      lines.push(`  • Columns in your model NOT in spec — REMOVE: ${m.columns_extra.join(", ")}`)
    }
    if (m.columns_missing && m.columns_missing.length > 0) {
      lines.push(`  • Columns in spec NOT in your model — ADD: ${m.columns_missing.join(", ")}`)
    }
    if (m.columns_reordered && m.columns_reordered.length > 0) {
      lines.push(`  • Columns in wrong order — REORDER the SELECT to match schema.yml`)
    }
    if (m.type_mismatches && m.type_mismatches.length > 0) {
      lines.push(`  • Type mismatches — CAST or change the upstream source`)
    }
  }
  return lines.join("\n")
}

export const DbtSchemaVerifyValidator: Validator = {
  name: "dbt-schema-verify",
  description:
    "After the agent declares done, runs `altimate-dbt schema-verify` on every dbt model the agent modified during this session and refuses to terminate if any model's actual columns diverge from the schema.yml spec (extra, missing, reordered, or type-mismatched).",

  async appliesTo(ctx: ValidatorContext): Promise<boolean> {
    // Only run for sessions that took place inside a dbt project. Quick check.
    return isDbtProject(ctx.workingDirectory)
  },

  async check(ctx: ValidatorContext): Promise<ValidatorResult> {
    const touched = await modelsModifiedSince(ctx.workingDirectory, ctx.sessionStartMs)
    if (touched.length === 0) {
      // No models touched — nothing to verify.
      return { ok: true, details: { models_touched: 0 } }
    }

    const results: SchemaVerifyOutput[] = []
    for (const path of touched) {
      const name = modelNameFromPath(path)
      const out = await runSchemaVerify(name, ctx.workingDirectory)
      if (out) results.push({ ...out, model: out.model ?? name })
    }

    const mismatches = results.filter((r) => r.verdict === "mismatch")
    const noSpec = results.filter((r) => r.verdict === "no-spec").length
    const matches = results.filter((r) => r.verdict === "match").length
    const errored = results.filter((r) => r.error).length

    if (mismatches.length === 0) {
      return {
        ok: true,
        details: {
          models_touched: touched.length,
          verified: results.length,
          match: matches,
          no_spec: noSpec,
          errored,
        },
      }
    }

    return {
      ok: false,
      reason: `${mismatches.length} of ${results.length} models you edited have a column-shape mismatch against schema.yml. The build may be green, but equality tests will fail.`,
      fixHint:
        formatFixHint(mismatches) +
        `\n\nFix the model SQL to match the schema.yml spec (do not edit the spec), rebuild, and the harness will re-check before declaring done.`,
      details: {
        models_touched: touched.length,
        verified: results.length,
        match: matches,
        mismatch: mismatches.length,
        no_spec: noSpec,
        errored,
        mismatch_models: mismatches.map((m) => m.model).filter(Boolean),
      },
    }
  },
}
// altimate_change end
