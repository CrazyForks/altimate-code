// altimate_change start — cross-DB join key inference
import z from "zod"
import { Tool } from "../../tool/tool"
import { Dispatcher } from "../native"

interface JoinCandidate {
  left_db: string
  left_table: string
  left_col: string
  right_db: string
  right_table: string
  right_col: string
  prefix_rule: { left: string; right: string }
  suffix_overlap: number
  confidence: number
}

export const AltimateCoreDetectJoinCandidatesTool = Tool.define(
  "altimate_core_detect_join_candidates",
  {
    description:
      "Infer cross-DB join keys from sample data. For each pair of (db, table, " +
      "string-typed column) drawn from different warehouse connections, look for a " +
      "shared value-shape: both sides have a non-empty common prefix that ends in " +
      "`_`, `-`, or `:`, the prefixes differ, and stripping the prefixes leaves at " +
      "least one matching suffix. Useful for stitching datasets where one side stores " +
      "`businessid_42` and the other stores `businessref_42`. Pass two or more " +
      "connection names from `warehouse_list`.",
    parameters: z.object({
      connections: z
        .array(z.string())
        .min(2)
        .describe("Warehouse connection names to compare (>= 2)."),
      schema_name: z
        .string()
        .optional()
        .describe("Restrict each warehouse to a single schema (default: scan all)."),
      sample_size: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Sample values to pull per column (default 50)."),
      max_tables_per_connection: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Cap on tables scanned per connection (default 50)."),
    }),
    async execute(args, _ctx) {
      try {
        const result = await Dispatcher.call("altimate_core.detect_join_candidates", {
          connections: args.connections,
          schema_name: args.schema_name,
          sample_size: args.sample_size,
          max_tables_per_connection: args.max_tables_per_connection,
        })
        const data = (result.data ?? {}) as Record<string, unknown>
        const candidates = (data.candidates ?? []) as JoinCandidate[]
        const error = result.error ?? (data.error as string | undefined)
        const connectionErrors = (data.connection_errors ?? {}) as Record<string, string>
        const connectionErrorCount = Object.keys(connectionErrors).length

        return {
          title: `Join candidates: ${candidates.length} found`,
          metadata: {
            success: result.success && !error,
            candidate_count: candidates.length,
            bags_scanned: data.bags_scanned ?? 0,
            ...(connectionErrorCount > 0 && { connection_errors: connectionErrors }),
            ...(error && { error }),
          },
          output: formatCandidates(candidates, connectionErrors),
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return {
          title: "Join candidates: ERROR",
          metadata: { success: false, candidate_count: 0, error: msg },
          output: `Failed: ${msg}`,
        }
      }
    },
  },
)

// Exported for unit tests.
export const _altimateCoreDetectJoinCandidatesInternal = {
  formatCandidates,
}

function formatCandidates(
  candidates: JoinCandidate[],
  connectionErrors: Record<string, string>,
): string {
  const lines: string[] = []
  if (candidates.length === 0) {
    lines.push("No cross-DB join candidates detected.")
  } else {
    lines.push(`Found ${candidates.length} cross-DB join candidate(s), ranked by overlap:`)
    lines.push("")
    for (const c of candidates) {
      const conf = c.confidence.toFixed(2)
      lines.push(
        `- ${c.left_db}.${c.left_table}.${c.left_col} (${c.prefix_rule.left}…) ↔ ` +
          `${c.right_db}.${c.right_table}.${c.right_col} (${c.prefix_rule.right}…)`,
      )
      lines.push(
        `    rule: replace prefix \`${c.prefix_rule.left}\` with \`${c.prefix_rule.right}\`; ` +
          `${c.suffix_overlap} matching suffix(es); confidence ${conf}`,
      )
    }
  }
  const errEntries = Object.entries(connectionErrors)
  if (errEntries.length > 0) {
    lines.push("")
    lines.push("Connection errors (skipped):")
    for (const [name, err] of errEntries) {
      lines.push(`  - ${name}: ${err}`)
    }
  }
  return lines.join("\n")
}
// altimate_change end
