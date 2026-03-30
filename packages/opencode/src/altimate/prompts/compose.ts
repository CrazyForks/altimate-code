/**
 * Domain prompt composition — selects domain-specific prompt modules
 * based on environment fingerprint tags.
 *
 * When `experimental.modular_prompts` is enabled, the agent prompt is
 * composed from a thin base + domain modules instead of the monolithic
 * builder.txt / analyst.txt.
 */

import { Fingerprint } from "../fingerprint"
import { Config } from "../../config/config"
import { Log } from "../../util/log"
import { Tracer } from "../observability/tracing"
import { normalizeTag, expandTags } from "./tags"

import PROMPT_BUILDER_BASE from "./builder-base.txt"
import PROMPT_ANALYST_BASE from "./analyst-base.txt"

import DOMAIN_DBT from "./domain/dbt.txt"
import DOMAIN_DBT_ANALYST from "./domain/dbt-analyst.txt"
import DOMAIN_SQL from "./domain/sql.txt"
import DOMAIN_SQL_ANALYST from "./domain/sql-analyst.txt"
import DOMAIN_SNOWFLAKE from "./domain/snowflake.txt"
import DOMAIN_MONGODB from "./domain/mongodb.txt"
import DOMAIN_TRAINING from "./domain/training.txt"

const log = Log.create({ service: "domain-prompts" })

/** Explicit domain ordering — do not rely on Object.keys() insertion order. */
const DOMAIN_ORDER = ["dbt", "sql", "snowflake", "mongodb"] as const

/** Map from fingerprint tag to domain prompt content, keyed by agent type. */
const TAG_TO_DOMAIN: Record<string, { builder: string; analyst: string }> = {
  dbt: { builder: DOMAIN_DBT, analyst: DOMAIN_DBT_ANALYST },
  sql: { builder: DOMAIN_SQL, analyst: DOMAIN_SQL_ANALYST },
  snowflake: { builder: DOMAIN_SNOWFLAKE, analyst: DOMAIN_SNOWFLAKE },
  mongodb: { builder: DOMAIN_MONGODB, analyst: DOMAIN_MONGODB },
}

/** Resolve the final tag set from fingerprint + config override. */
export async function resolveTags(cfg?: { experimental?: { domains?: string[] } }): Promise<string[]> {
  const config = cfg ?? await Config.get()

  // Signal 6: User config override — replaces auto-detection entirely.
  // An explicit empty array means "no domains" (training-only prompt), not "fall through to auto-detection".
  const configDomains = config.experimental?.domains
  if (configDomains !== undefined) {
    return configDomains.length > 0 ? expandTags(configDomains.map(normalizeTag)) : []
  }

  // Auto-detection from fingerprint (signals 1-4 are collected there)
  // Tags are already normalized at fingerprint detection time — no re-normalization needed
  const fp = Fingerprint.get()
  return expandTags(fp?.tags ?? [])
}

/**
 * Compose the full agent prompt for a given agent type.
 *
 * When `experimental.modular_prompts` is enabled:
 *   base prompt + agent-specific domain modules + training
 *
 * When disabled (default):
 *   returns undefined — the caller preserves the existing agent prompt
 */
export async function composeAgentPrompt(agentName: string): Promise<string | undefined> {
  const cfg = await Config.get()

  // Feature flag — default off. Return undefined to preserve existing agent prompt.
  if (!cfg.experimental?.modular_prompts) {
    return undefined
  }

  const startTime = Date.now()
  const tags = await resolveTags(cfg)

  // Select base prompt
  const base = agentName === "analyst" ? PROMPT_ANALYST_BASE : PROMPT_BUILDER_BASE
  const agentKey = agentName === "analyst" ? "analyst" : "builder"

  // Collect matching domain prompts (deduplicated, explicit stable order)
  const seen = new Set<string>()
  const domains: string[] = []

  for (const key of DOMAIN_ORDER) {
    if (tags.includes(key) && !seen.has(key)) {
      domains.push(TAG_TO_DOMAIN[key][agentKey])
      seen.add(key)
    }
  }

  // Fallback: only when NO tags were detected at all (not for detected-but-unsupported tags like airflow)
  let fallbackUsed = false
  if (tags.length === 0) {
    domains.push(TAG_TO_DOMAIN["sql"][agentKey], TAG_TO_DOMAIN["dbt"][agentKey])
    seen.add("sql")
    seen.add("dbt")
    fallbackUsed = true
  }

  // Always include training
  domains.push(DOMAIN_TRAINING)
  seen.add("training")

  // False-negative safeguard: list tools for tags that were DETECTED but have
  // no domain module loaded (uncovered detections, not all unloaded modules).
  // Only show tools the user might actually need based on their environment.
  const detectedButUncovered = tags.filter((t) => !seen.has(t) && t !== "data-engineering" && t !== "dbt-packages")
  let footer = ""
  if (detectedButUncovered.length > 0) {
    const toolHints: Record<string, string> = {
      dbt: "dbt tools (altimate-dbt, dbt_lineage)",
      sql: "SQL tools (sql_analyze, altimate_core_validate, sql_execute)",
      snowflake: "Snowflake FinOps tools (finops_analyze_credits, finops_warehouse_advice)",
      mongodb: "MongoDB tools (MQL commands via sql_execute)",
      postgres: "PostgreSQL tools (sql_execute with Postgres connection)",
      bigquery: "BigQuery tools (sql_execute with BigQuery connection)",
      databricks: "Databricks tools (sql_execute with Databricks connection)",
      airflow: "Airflow DAG management",
    }
    const hints = detectedButUncovered.map((t) => toolHints[t] ?? `${t} tools`).filter(Boolean)
    if (hints.length > 0) {
      footer = "\n\n## Other Available Tools\nYour environment also includes: " + hints.join(", ") + ". Use `warehouse_list` to discover connections."
    }
  }

  const result = [base, ...domains].join("\n\n") + footer

  log.info("composed", {
    agent: agentName,
    tags: tags.join(","),
    domains: [...seen].join(","),
    fallback: fallbackUsed,
  })

  Tracer.active?.logSpan({
    name: "domain-prompt-composition",
    startTime,
    endTime: Date.now(),
    input: { agent: agentName, detectedTags: tags },
    output: {
      domainsIncluded: [...seen],
      fallbackUsed,
      totalChars: result.length,
    },
  })

  return result
}
