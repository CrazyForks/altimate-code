import z from "zod"
import { Tool } from "../../tool/tool"
import { Dispatcher } from "../native"

/**
 * Verified query optimization.
 *
 * Composes two altimate-core capabilities into one trust-preserving primitive:
 *   1. `altimate_core.rewrite`     — propose optimization rewrites of a query.
 *   2. `altimate_core.equivalence` — prove each rewrite returns the same results.
 *
 * A rewrite is reported as VERIFIED only when equivalence is proven (`equivalent
 * === true`). Anything the engine cannot prove equivalent — including rewrites it
 * is merely unsure about, or any rewrite when no schema is supplied — is returned
 * but explicitly labeled UNVERIFIED ("review before applying"). The gate is
 * deliberately conservative: it never marks a rewrite verified unless the
 * equivalence check affirmatively says so, so a "verified" optimization is safe
 * to apply without changing results.
 *
 * This is the core mechanic behind one-click "optimize this query" UX: surface
 * the savings, but only promise safety where it is actually provable.
 */
export const AltimateVerifiedOptimizeTool = Tool.define("altimate_verified_optimize", {
  description:
    "Suggest query optimizations that are PROVEN to preserve results. Runs altimate-core rewrite, then verifies each proposed rewrite is semantically equivalent to the original; only rewrites that pass the equivalence check are marked verified-safe to apply. Rewrites that cannot be proven equivalent are still returned but clearly labeled 'review before applying'. Provide schema_context or schema_path so table/column references can be resolved — without a schema, equivalence cannot be verified and all rewrites are returned unverified.",
  parameters: z.object({
    sql: z.string().describe("SQL query to optimize"),
    schema_path: z.string().optional().describe("Path to YAML/JSON schema file"),
    schema_context: z.record(z.string(), z.any()).optional().describe("Inline schema definition"),
    dialect: z.string().optional().describe("SQL dialect for the rewrite engine"),
  }),
  async execute(args) {
    const hasSchema = !!(args.schema_path || (args.schema_context && Object.keys(args.schema_context).length > 0))
    const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase()
    try {
      const rw = await Dispatcher.call("altimate_core.rewrite", {
        sql: args.sql,
        schema_path: args.schema_path ?? "",
        schema_context: args.schema_context,
      })
      const data = (rw.data ?? {}) as Record<string, any>
      const rwError = rw.error ?? data.error
      if (rwError) {
        return {
          title: "Verified Optimize: ERROR",
          metadata: { success: false, verified_count: 0, unverified_count: 0, error: rwError },
          output: `Failed to generate rewrites: ${rwError}`,
        }
      }

      // Collect candidate rewrites: the whole-query rewrite plus any per-suggestion
      // rewrites. Drop blanks and no-ops (rewrite identical to the original).
      const suggestions: any[] = data.suggestions ?? data.rewrites ?? []
      const raw: Array<{ sql: string; rule?: string; explanation?: string }> = []
      if (typeof data.rewritten_sql === "string" && data.rewritten_sql.trim()) {
        raw.push({ sql: data.rewritten_sql })
      }
      for (const s of suggestions) {
        if (typeof s?.rewritten_sql === "string" && s.rewritten_sql.trim()) {
          raw.push({ sql: s.rewritten_sql, rule: s.rule ?? s.type, explanation: s.explanation ?? s.description })
        }
      }
      const seen = new Set<string>([norm(args.sql)])
      const candidates = raw.filter((c) => {
        const n = norm(c.sql)
        if (seen.has(n)) return false
        seen.add(n)
        return true
      })

      if (!candidates.length) {
        return {
          title: "Verified Optimize: no rewrites",
          metadata: { success: true, verified_count: 0, unverified_count: 0, has_schema: hasSchema },
          output: "No optimizations suggested for this query.",
        }
      }

      // Verify each candidate against the original via the equivalence engine.
      const verified: Array<{ sql: string; rule?: string; confidence?: number }> = []
      const unverified: Array<{ sql: string; rule?: string; reason: string }> = []
      for (const c of candidates) {
        if (!hasSchema) {
          unverified.push({ sql: c.sql, rule: c.rule, reason: "no schema supplied — equivalence cannot be verified" })
          continue
        }
        const eq = await Dispatcher.call("altimate_core.equivalence", {
          sql1: args.sql,
          sql2: c.sql,
          schema_path: args.schema_path ?? "",
          schema_context: args.schema_context,
        })
        const ed = (eq.data ?? {}) as Record<string, any>
        if (ed.equivalent === true) {
          verified.push({ sql: c.sql, rule: c.rule, confidence: ed.confidence })
        } else {
          const diffs: any[] = ed.differences ?? []
          const reason =
            (eq.error ?? ed.error) ||
            (diffs.length
              ? `not proven equivalent: ${diffs.map((d) => d.description).filter(Boolean).slice(0, 2).join("; ")}`
              : "could not be proven equivalent")
          unverified.push({ sql: c.sql, rule: c.rule, reason })
        }
      }

      return {
        title: `Verified Optimize: ${verified.length} verified, ${unverified.length} unverified`,
        metadata: {
          success: true,
          verified_count: verified.length,
          unverified_count: unverified.length,
          has_schema: hasSchema,
        },
        output: formatVerifiedOptimize(verified, unverified, hasSchema),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: "Verified Optimize: ERROR",
        metadata: { success: false, verified_count: 0, unverified_count: 0, error: msg },
        output: `Failed: ${msg}`,
      }
    }
  },
})

function formatVerifiedOptimize(
  verified: Array<{ sql: string; rule?: string; confidence?: number }>,
  unverified: Array<{ sql: string; rule?: string; reason: string }>,
  hasSchema: boolean,
): string {
  const lines: string[] = []
  if (verified.length) {
    lines.push("✓ VERIFIED-EQUIVALENT optimizations (safe to apply — proven to return the same results):")
    for (const v of verified) {
      lines.push(`  • ${v.rule ?? "rewrite"}${v.confidence != null ? ` (confidence ${v.confidence})` : ""}`)
      lines.push(`    ${v.sql}`)
    }
    lines.push("")
  }
  if (unverified.length) {
    lines.push("⚠ UNVERIFIED optimizations (review before applying — equivalence NOT proven):")
    for (const u of unverified) {
      lines.push(`  • ${u.rule ?? "rewrite"} — ${u.reason}`)
      lines.push(`    ${u.sql}`)
    }
    lines.push("")
  }
  if (!verified.length && !unverified.length) {
    return "No optimizations suggested for this query."
  }
  if (!hasSchema) {
    lines.push("Note: no schema was supplied, so no rewrite could be verified. Provide schema_context or schema_path to verify equivalence.")
  } else if (!verified.length) {
    lines.push("Note: optimizations were found but none could be proven equivalent. Apply only after manual review.")
  }
  return lines.join("\n").trimEnd()
}
