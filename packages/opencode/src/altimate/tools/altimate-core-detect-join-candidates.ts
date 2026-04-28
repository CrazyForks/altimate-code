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
  /** Heuristic ranking score in [0, 1] — overlap / min(|left|, |right|). NOT a probability. */
  match_score: number
}

// Upper bounds on tool inputs. These caps prevent an LLM-issued call with
// outsized parameters from blowing up memory or holding warehouse connections
// for an unbounded period. Defaults stay at 50 / 50 (see native handler).
const MAX_CONNECTIONS = 16
const MAX_SAMPLE_SIZE = 1000
const MAX_TABLES_PER_CONNECTION = 500

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
        .max(MAX_CONNECTIONS)
        .describe(`Warehouse connection names to compare (>= 2, <= ${MAX_CONNECTIONS}).`),
      schema_name: z
        .string()
        .optional()
        .describe("Restrict each warehouse to a single schema (default: scan all)."),
      sample_size: z
        .number()
        .int()
        .positive()
        .max(MAX_SAMPLE_SIZE)
        .optional()
        .describe(`Sample values to pull per column (default 50, max ${MAX_SAMPLE_SIZE}).`),
      max_tables_per_connection: z
        .number()
        .int()
        .positive()
        .max(MAX_TABLES_PER_CONNECTION)
        .optional()
        .describe(
          `Cap on tables scanned per connection (default 50, max ${MAX_TABLES_PER_CONNECTION}).`,
        ),
    }),
    async execute(args, ctx) {
      // Gate execution on the read-permission flow used by other warehouse-reading
      // tools (e.g. data_diff, sql_execute). The detector issues many SELECT
      // statements across every string column on every scanned table, so a
      // single approval is appropriate for the whole batch.
      await ctx.ask({
        permission: "sql_execute_read",
        patterns: [`detect_join_candidates: ${args.connections.join(", ")}`],
        always: ["*"],
        metadata: {
          connections: args.connections,
          schema_name: args.schema_name,
        },
      })

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
        const partialErrors = (data.partial_errors ?? {}) as Record<string, string[]>
        const connectionErrorCount = Object.keys(connectionErrors).length
        const partialErrorCount = Object.values(partialErrors).reduce(
          (sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0),
          0,
        )

        // Native handler returns `{ success: false, error }` for input-validation
        // failures (e.g. fewer than two connections) without throwing. Surface
        // those as a FAILED envelope rather than a clean zero-result.
        if (!result.success || error) {
          return {
            title: "Join candidates: FAILED",
            metadata: {
              success: false,
              candidate_count: 0,
              ...(connectionErrorCount > 0 && { connection_errors: connectionErrors }),
              ...(partialErrorCount > 0 && { partial_errors: partialErrors }),
              ...(error && { error }),
            },
            output: `Failed to detect join candidates: ${error ?? "Unknown error"}`,
          }
        }

        return {
          title: `Join candidates: ${candidates.length} found`,
          metadata: {
            success: true,
            candidate_count: candidates.length,
            bags_scanned: data.bags_scanned ?? 0,
            ...(connectionErrorCount > 0 && { connection_errors: connectionErrors }),
            ...(partialErrorCount > 0 && {
              partial_errors: partialErrors,
              partial_error_count: partialErrorCount,
            }),
          },
          output: formatCandidates(candidates, connectionErrors, partialErrors),
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
  partialErrors: Record<string, string[]> = {},
): string {
  const lines: string[] = []
  if (candidates.length === 0) {
    lines.push("No cross-DB join candidates detected.")
  } else {
    lines.push(`Found ${candidates.length} cross-DB join candidate(s), ranked by overlap:`)
    lines.push("")
    for (const c of candidates) {
      const score = c.match_score.toFixed(2)
      lines.push(
        `- ${c.left_db}.${c.left_table}.${c.left_col} (${c.prefix_rule.left}...) <-> ` +
          `${c.right_db}.${c.right_table}.${c.right_col} (${c.prefix_rule.right}...)`,
      )
      lines.push(
        `    rule: replace prefix \`${c.prefix_rule.left}\` with \`${c.prefix_rule.right}\`; ` +
          `${c.suffix_overlap} matching suffix(es); match_score ${score} ` +
          `(heuristic, not a probability)`,
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
  const partialEntries = Object.entries(partialErrors).filter(([, arr]) => arr.length > 0)
  if (partialEntries.length > 0) {
    lines.push("")
    lines.push("Partial errors (some tables/columns skipped within a live connection):")
    for (const [name, errs] of partialEntries) {
      lines.push(`  - ${name}: ${errs.length} error(s)`)
      for (const err of errs.slice(0, 5)) {
        lines.push(`      - ${err}`)
      }
      if (errs.length > 5) {
        lines.push(`      ... and ${errs.length - 5} more`)
      }
    }
  }
  return lines.join("\n")
}
// altimate_change end
