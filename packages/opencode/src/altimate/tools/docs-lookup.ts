import z from "zod"
import { Tool } from "../../tool/tool"
import { Telemetry } from "../telemetry"
import { Log } from "../../util/log"

const log = Log.create({ service: "docs-lookup" })

// Official documentation URLs — fetched directly from first-party sources (no third-party service).
const PLATFORM_DOCS: Record<string, { name: string; base: string; pages: Record<string, string> }> = {
  snowflake: {
    name: "Snowflake",
    base: "https://docs.snowflake.com/en",
    pages: {
      "sql-reference": "/sql-reference",
      "commands": "/sql-reference/sql-all",
      "functions": "/sql-reference/functions-reference",
      "data-types": "/sql-reference/data-types",
      "merge": "/sql-reference/sql/merge",
      "create-table": "/sql-reference/sql/create-table",
      "copy-into": "/sql-reference/sql/copy-into-table",
      "streams": "/user-guide/streams",
      "tasks": "/user-guide/tasks-intro",
      "dynamic-tables": "/user-guide/dynamic-tables-about",
      "stored-procedures": "/sql-reference/stored-procedures",
      "udfs": "/developer-guide/udf/udf-overview",
      "stages": "/user-guide/data-load-overview",
      "window-functions": "/sql-reference/functions-analytic",
    },
  },
  databricks: {
    name: "Databricks",
    base: "https://docs.databricks.com/aws/en",
    pages: {
      "sql-reference": "/sql/language-manual/index",
      "functions": "/sql/language-manual/sql-ref-functions-builtin",
      "delta": "/delta/index",
      "unity-catalog": "/data-governance/unity-catalog/index",
      "sql-warehouse": "/compute/sql-warehouse/index",
      "merge": "/sql/language-manual/delta-merge-into",
      "create-table": "/sql/language-manual/sql-ref-syntax-ddl-create-table",
      "volumes": "/volumes/index",
      "workflows": "/workflows/index",
      "streaming": "/structured-streaming/index",
    },
  },
  duckdb: {
    name: "DuckDB",
    base: "https://duckdb.org/docs",
    pages: {
      "sql-reference": "/sql/introduction",
      "data-types": "/sql/data_types/overview",
      "functions": "/sql/functions/overview",
      "aggregate-functions": "/sql/functions/aggregates",
      "window-functions": "/sql/functions/window_functions",
      "json": "/data/json/overview",
      "parquet": "/data/parquet/overview",
      "csv": "/data/csv/overview",
      "python-api": "/api/python/overview",
      "extensions": "/extensions/overview",
      "create-table": "/sql/statements/create_table",
      "select": "/sql/statements/select",
      "copy": "/sql/statements/copy",
      "joins": "/sql/query_syntax/from",
    },
  },
  postgresql: {
    name: "PostgreSQL",
    base: "https://www.postgresql.org/docs/current",
    pages: {
      "commands": "/sql-commands.html",
      "functions": "/functions.html",
      "data-types": "/datatype.html",
      "indexes": "/indexes.html",
      "json-functions": "/functions-json.html",
      "window-functions": "/functions-window.html",
      "aggregate-functions": "/functions-aggregate.html",
      "string-functions": "/functions-string.html",
      "datetime-functions": "/functions-datetime.html",
      "create-table": "/sql-createtable.html",
      "select": "/sql-select.html",
      "insert": "/sql-insert.html",
      "ctes": "/queries-with.html",
      "triggers": "/trigger-definition.html",
      "extensions": "/contrib.html",
      "explain": "/sql-explain.html",
    },
  },
  clickhouse: {
    name: "ClickHouse",
    base: "https://clickhouse.com/docs",
    pages: {
      "sql-reference": "/sql-reference",
      "statements": "/sql-reference/statements",
      "functions": "/sql-reference/functions",
      "aggregate-functions": "/sql-reference/aggregate-functions",
      "table-engines": "/engines/table-engines",
      "mergetree": "/engines/table-engines/mergetree-family/mergetree",
      "data-types": "/sql-reference/data-types",
      "create-table": "/sql-reference/statements/create/table",
      "select": "/sql-reference/statements/select",
      "insert": "/sql-reference/statements/insert-into",
      "materialized-views": "/materialized-view",
      "window-functions": "/sql-reference/window-functions",
      "json": "/sql-reference/data-types/json",
      "dictionaries": "/sql-reference/dictionaries",
    },
  },
  bigquery: {
    name: "BigQuery",
    base: "https://cloud.google.com/bigquery/docs/reference/standard-sql",
    pages: {
      "query-syntax": "/query-syntax",
      "functions": "/functions-and-operators",
      "data-types": "/data-types",
      "dml": "/dml-syntax",
      "ddl": "/data-definition-language",
      "window-functions": "/analytic-function-concepts",
      "json-functions": "/json_functions",
      "merge": "/dml-syntax#merge_statement",
    },
  },
}

// Context7 library IDs — only used when ALTIMATE_DOCS_PROVIDER=ctx7.
// Context7 is a third-party service (context7.com) that sends queries to external servers.
// By default this tool fetches docs directly from official documentation sites (webfetch)
// to avoid sending any user data to third parties.
const CTX7_LIBRARIES: Record<string, string> = {
  "dbt-core": "/dbt-labs/dbt-core",
  "airflow": "/apache/airflow",
  "pyspark": "/apache/spark",
  "snowflake-connector-python": "/snowflakedb/snowflake-connector-python",
  "snowpark-python": "/snowflakedb/snowpark-python",
  "google-cloud-bigquery": "/googleapis/python-bigquery",
  "databricks-sdk": "/databricks/databricks-sdk-py",
  "duckdb": "/duckdb/duckdb",
  "psycopg2": "/psycopg/psycopg2",
  "psycopg": "/psycopg/psycopg",
  "clickhouse-connect": "/clickhouse/clickhouse-connect",
  "confluent-kafka": "/confluentinc/confluent-kafka-python",
  "sqlalchemy": "/sqlalchemy/sqlalchemy",
  "polars": "/pola-rs/polars",
  "pandas": "/pandas-dev/pandas",
  "great-expectations": "/great-expectations/great_expectations",
  "dbt-utils": "/dbt-labs/dbt-utils",
  "dbt-expectations": "/calogica/dbt-expectations",
  "dbt-snowflake": "/dbt-labs/dbt-snowflake",
  "dbt-bigquery": "/dbt-labs/dbt-bigquery",
  "dbt-databricks": "/databricks/dbt-databricks",
  "dbt-postgres": "/dbt-labs/dbt-postgres",
  "dbt-redshift": "/dbt-labs/dbt-redshift",
  "dbt-spark": "/dbt-labs/dbt-spark",
  "dbt-duckdb": "/duckdb/dbt-duckdb",
  "dbt-clickhouse": "/clickhouse/dbt-clickhouse",
  "elementary": "/elementary-data/elementary",
}

// Map library tool names to their platform counterpart for webfetch fallback.
// e.g. "duckdb" appears in both CTX7_LIBRARIES and PLATFORM_DOCS.
const LIBRARY_TO_PLATFORM: Record<string, string> = {
  "snowflake-connector-python": "snowflake",
  "snowpark-python": "snowflake",
  "google-cloud-bigquery": "bigquery",
  "databricks-sdk": "databricks",
  "duckdb": "duckdb",
  "psycopg2": "postgresql",
  "psycopg": "postgresql",
  "clickhouse-connect": "clickhouse",
}

type DocsProvider = "webfetch" | "ctx7"

function getProvider(): DocsProvider {
  const env = process.env.ALTIMATE_DOCS_PROVIDER?.toLowerCase()
  if (env === "ctx7") return "ctx7"
  return "webfetch"
}

function findBestPage(platform: (typeof PLATFORM_DOCS)[string], query: string): string {
  const q = query.toLowerCase()
  let bestKey = ""
  let bestScore = 0

  for (const key of Object.keys(platform.pages)) {
    // Score based on keyword overlap between query and page key
    const keywords = key.split(/[-_]/)
    let score = 0
    for (const kw of keywords) {
      if (q.includes(kw)) score += kw.length
    }
    if (score > bestScore) {
      bestScore = score
      bestKey = key
    }
  }

  return bestKey ? `${platform.base}${platform.pages[bestKey]}` : platform.base
}

async function fetchFromWebsite(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,text/plain,*/*",
    },
    signal: AbortSignal.timeout(30_000),
  })

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }

  const contentType = response.headers.get("content-type") || ""
  let text = await response.text()

  if (contentType.includes("html")) {
    text = text.replace(/<script[\s\S]*?<\/script>/gi, "")
    text = text.replace(/<style[\s\S]*?<\/style>/gi, "")
    text = text.replace(/<nav[\s\S]*?<\/nav>/gi, "")
    text = text.replace(/<footer[\s\S]*?<\/footer>/gi, "")
    text = text.replace(/<header[\s\S]*?<\/header>/gi, "")
    text = text.replace(/<[^>]+>/g, " ")
    text = text.replace(/\s+/g, " ").trim()
    if (text.length > 15_000) {
      text = text.slice(0, 15_000) + "\n\n[... truncated, use webfetch with a more specific URL for full content]"
    }
  }

  return text
}

async function fetchFromCtx7(libraryId: string, query: string): Promise<string> {
  const { $ } = await import("bun")
  const result = await $`npx -y ctx7@latest docs ${libraryId} ${query}`
    .quiet()
    .timeout(30_000)
    .text()
  return result
}

export const DocsLookupTool = Tool.define("docs_lookup", {
  description: [
    "Look up version-specific documentation for data engineering tools and database platforms.",
    "Use this tool when you need accurate, current API references, SQL syntax, configuration options,",
    "or usage patterns for data engineering libraries and platforms.",
    "",
    "By default, fetches docs directly from official documentation sites (no third-party services).",
    "Set ALTIMATE_DOCS_PROVIDER=ctx7 to use Context7 for richer library/SDK docs (sends queries to context7.com).",
    "",
    "Known tools: " + [...new Set([...Object.keys(CTX7_LIBRARIES), ...Object.keys(PLATFORM_DOCS)])].join(", "),
  ].join("\n"),
  parameters: z.object({
    tool: z
      .string()
      .describe(
        "The tool or platform name (e.g., 'dbt-core', 'airflow', 'snowflake', 'duckdb', 'postgresql')",
      ),
    query: z.string().describe("Specific question or topic to look up (e.g., 'incremental models with merge strategy')"),
    url: z
      .string()
      .optional()
      .describe(
        "Optional: direct URL to a specific documentation page. Improves results for platform docs.",
      ),
  }),
  async execute(args, ctx) {
    const start = Date.now()
    const toolLower = args.tool.toLowerCase().replace(/\s+/g, "-")
    const provider = getProvider()

    const ctx7Id = CTX7_LIBRARIES[toolLower]
    const platform = PLATFORM_DOCS[toolLower]
    const platformFromLibrary = LIBRARY_TO_PLATFORM[toolLower] ? PLATFORM_DOCS[LIBRARY_TO_PLATFORM[toolLower]] : undefined
    const hasUrl = args.url && args.url.startsWith("http")

    // --- Provider: ctx7 (opt-in) ---
    if (provider === "ctx7" && ctx7Id) {
      try {
        const result = await fetchFromCtx7(ctx7Id, args.query)
        const duration = Date.now() - start

        if (result && result.trim().length > 50) {
          log.info("ctx7 docs fetched", { tool: toolLower, libraryId: ctx7Id, duration })
          Telemetry.track({
            type: "docs_lookup",
            timestamp: Date.now(),
            session_id: ctx.sessionID,
            tool_id: toolLower,
            method: "ctx7",
            status: "success",
            duration_ms: duration,
          })
          return {
            title: `Docs: ${args.tool}`,
            metadata: { tool: toolLower, method: "ctx7", libraryId: ctx7Id },
            output: [
              `# Documentation for ${args.tool} (via Context7)`,
              `Library ID: ${ctx7Id}`,
              `Query: ${args.query}`,
              "",
              result.trim(),
            ].join("\n"),
          }
        }

        log.warn("ctx7 returned insufficient content", { tool: toolLower, libraryId: ctx7Id, length: result?.length })
        Telemetry.track({
          type: "docs_lookup",
          timestamp: Date.now(),
          session_id: ctx.sessionID,
          tool_id: toolLower,
          method: "ctx7",
          status: "not_found",
          duration_ms: duration,
        })
        // Fall through to webfetch
      } catch (err: any) {
        const duration = Date.now() - start
        const errorMsg = err?.message?.slice(0, 500) || "unknown error"
        log.error("ctx7 docs lookup failed", { tool: toolLower, libraryId: ctx7Id, error: errorMsg })
        Telemetry.track({
          type: "docs_lookup",
          timestamp: Date.now(),
          session_id: ctx.sessionID,
          tool_id: toolLower,
          method: "ctx7",
          status: "error",
          duration_ms: duration,
          error: errorMsg,
        })
        // Fall through to webfetch
      }
    }

    // --- Provider: webfetch (default) — fetches directly from official docs ---
    const resolvedPlatform = platform || platformFromLibrary
    const fetchUrl = hasUrl
      ? args.url!
      : resolvedPlatform
        ? findBestPage(resolvedPlatform, args.query)
        : undefined

    if (fetchUrl) {
      try {
        const text = await fetchFromWebsite(fetchUrl)
        const duration = Date.now() - start

        log.info("webfetch docs fetched", { tool: toolLower, url: fetchUrl, duration, length: text.length })
        Telemetry.track({
          type: "docs_lookup",
          timestamp: Date.now(),
          session_id: ctx.sessionID,
          tool_id: toolLower,
          method: "webfetch",
          status: "success",
          duration_ms: duration,
          source_url: fetchUrl,
        })

        return {
          title: `Docs: ${args.tool}`,
          metadata: { tool: toolLower, method: "webfetch", url: fetchUrl },
          output: [
            `# Documentation for ${args.tool} (from official docs)`,
            `Source: ${fetchUrl}`,
            `Query: ${args.query}`,
            "",
            text,
          ].join("\n"),
        }
      } catch (err: any) {
        const duration = Date.now() - start
        const errorMsg = err?.message?.slice(0, 500) || "unknown error"
        log.error("webfetch docs lookup failed", { tool: toolLower, url: fetchUrl, error: errorMsg })
        Telemetry.track({
          type: "docs_lookup",
          timestamp: Date.now(),
          session_id: ctx.sessionID,
          tool_id: toolLower,
          method: "webfetch",
          status: "error",
          duration_ms: duration,
          error: errorMsg,
          source_url: fetchUrl,
        })
      }
    }

    // --- Nothing worked ---
    const duration = Date.now() - start
    const notFound = !ctx7Id && !resolvedPlatform && !hasUrl
    if (notFound) {
      log.warn("docs lookup: unknown tool", { tool: toolLower })
      Telemetry.track({
        type: "docs_lookup",
        timestamp: Date.now(),
        session_id: ctx.sessionID,
        tool_id: toolLower,
        method: "webfetch",
        status: "not_found",
        duration_ms: duration,
        error: "unknown_tool",
      })
    }

    return {
      title: `Docs lookup failed: ${args.tool}`,
      metadata: { tool: toolLower, method: "none", error: notFound ? "unknown_tool" : "all_methods_failed" },
      output: [
        `Could not fetch documentation for "${args.tool}".`,
        "",
        notFound
          ? [
              "This tool is not in the known library list.",
              "",
              "You can try:",
              "1. Use the `webfetch` tool with a direct URL to the official documentation",
              "2. Fall back to training data (note: may be outdated)",
            ].join("\n")
          : [
              "Documentation fetch failed (network error or rate limit).",
              "",
              "Falling back to training data. Note: the response may use outdated API patterns.",
              "The user can retry later when network is available.",
            ].join("\n"),
      ].join("\n"),
    }
  },
})
