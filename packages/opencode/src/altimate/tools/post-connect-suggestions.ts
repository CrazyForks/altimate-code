/**
 * Post-connect feature suggestions and progressive disclosure.
 *
 * After warehouse connect, users often don't know what to do next.
 * This module provides contextual suggestions based on the user's
 * environment and progressive next-step hints after tool usage.
 */

import { Telemetry } from "../../telemetry"

export namespace PostConnectSuggestions {
  export interface SuggestionContext {
    warehouseType: string
    schemaIndexed: boolean
    dbtDetected: boolean
    connectionCount: number
    toolsUsedInSession: string[]
  }

  export function getPostConnectSuggestions(ctx: SuggestionContext): string {
    const suggestions: string[] = []

    if (!ctx.schemaIndexed) {
      suggestions.push(
        "Index your schema — enables SQL analysis, column-level lineage, and data quality checks. Use the schema_index tool.",
      )
    }

    suggestions.push(
      "Run SQL queries against your " +
        ctx.warehouseType +
        " warehouse using sql_execute",
    )
    suggestions.push(
      "Analyze SQL quality and find potential issues with sql_analyze",
    )

    if (ctx.dbtDetected) {
      suggestions.push(
        "dbt project detected — try /dbt-develop to help build models or /dbt-troubleshoot to debug issues",
      )
    }

    suggestions.push(
      "Trace data lineage across your models with lineage_check",
    )
    suggestions.push("Audit for PII exposure with schema_detect_pii")

    if (ctx.connectionCount > 1) {
      suggestions.push("Compare data across warehouses with data_diff")
    }

    return (
      "\n\n---\nAvailable capabilities for your " +
      ctx.warehouseType +
      " warehouse:\n" +
      suggestions.map((s, i) => `${i + 1}. ${s}`).join("\n")
    )
  }

  /**
   * Progressive disclosure: suggest next tool based on what was just used.
   * Returns null if no suggestion applies or tool is unknown.
   */
  export function getProgressiveSuggestion(
    lastToolUsed: string,
  ): string | null {
    const progression: Record<string, string | null> = {
      sql_execute:
        "Tip: Use sql_analyze to check this query for potential issues, performance optimizations, and best practices.",
      sql_analyze:
        "Tip: Use schema_inspect to explore the tables and columns referenced in your query.",
      schema_inspect:
        "Tip: Use lineage_check to see how this data flows through your models.",
      schema_index:
        "Schema indexed! You can now use sql_analyze for quality checks, schema_inspect for exploration, and lineage_check for data flow analysis.",
      warehouse_add: null, // Handled by post-connect suggestions
    }
    return progression[lastToolUsed] ?? null
  }

  /**
   * Track that feature suggestions were shown, for measuring discovery rates.
   */
  export function trackSuggestions(opts: {
    suggestionType:
      | "post_warehouse_connect"
      | "dbt_detected"
      | "progressive_disclosure"
    suggestionsShown: string[]
    warehouseType?: string
  }): void {
    try {
      const sessionId = Telemetry.getContext().sessionId || "unknown-session"
      Telemetry.track({
        type: "feature_suggestion",
        timestamp: Date.now(),
        session_id: sessionId,
        suggestion_type: opts.suggestionType,
        suggestions_shown: opts.suggestionsShown,
        warehouse_type: opts.warehouseType ?? "unknown",
      })
    } catch {
      // Telemetry must never break tool execution
    }
  }
}
