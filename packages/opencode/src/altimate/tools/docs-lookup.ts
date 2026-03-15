import z from "zod"
import Bun from "bun"
import { Tool } from "../../tool/tool"
import { Telemetry } from "../telemetry"
import { Log } from "../../util/log"

const log = Log.create({ service: "docs-lookup" })

const PLATFORM_DOCS: Record<string, { name: string; base: string }> = {
  snowflake: { name: "Snowflake", base: "https://docs.snowflake.com/en" },
  databricks: { name: "Databricks", base: "https://docs.databricks.com/aws/en" },
  duckdb: { name: "DuckDB", base: "https://duckdb.org/docs" },
  postgresql: { name: "PostgreSQL", base: "https://www.postgresql.org/docs/current" },
  clickhouse: { name: "ClickHouse", base: "https://clickhouse.com/docs" },
  bigquery: { name: "BigQuery", base: "https://cloud.google.com/bigquery/docs/reference/standard-sql" },
}

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

export const DocsLookupTool = Tool.define("docs_lookup", {
  description: [
    "Look up version-specific documentation for data engineering tools and database platforms.",
    "Use this tool when you need accurate, current API references, SQL syntax, configuration options,",
    "or usage patterns for data engineering libraries and platforms.",
    "",
    "Supports two methods:",
    "- `ctx7`: Fetch library/SDK documentation via Context7 (dbt, Airflow, Spark, Snowpark, Polars, etc.)",
    "- `webfetch`: Fetch database platform SQL docs by URL (Snowflake, Databricks, DuckDB, PostgreSQL, ClickHouse, BigQuery)",
    "",
    "Known libraries (ctx7): " + Object.keys(CTX7_LIBRARIES).join(", "),
    "Known platforms (webfetch): " + Object.keys(PLATFORM_DOCS).join(", "),
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
        "Optional: direct URL to fetch docs from (for webfetch method). " +
          "If not provided, the tool will try ctx7 first, then fall back to webfetch with a default URL.",
      ),
  }),
  async execute(args, ctx) {
    const start = Date.now()
    const toolLower = args.tool.toLowerCase().replace(/\s+/g, "-")

    // Determine method
    const ctx7Id = CTX7_LIBRARIES[toolLower]
    const platform = PLATFORM_DOCS[toolLower]
    const hasUrl = args.url && args.url.startsWith("http")

    // Try ctx7 first if we have a library ID
    if (ctx7Id) {
      try {
        const result = await Bun.$`npx -y ctx7@latest docs ${ctx7Id} ${args.query}`
          .quiet()
          .timeout(30_000)
          .text()

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

        // Empty or too short result
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
        // Fall through to webfetch if we have a platform URL
      }
    }

    // Try webfetch if we have a URL or a known platform
    const fetchUrl = hasUrl ? args.url! : platform ? platform.base : undefined
    if (fetchUrl) {
      try {
        const response = await fetch(fetchUrl, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
            Accept: "text/html,application/xhtml+xml,text/plain,*/*",
          },
          signal: AbortSignal.timeout(30_000),
        })

        const duration = Date.now() - start

        if (!response.ok) {
          log.error("webfetch failed", { tool: toolLower, url: fetchUrl, status: response.status })
          Telemetry.track({
            type: "docs_lookup",
            timestamp: Date.now(),
            session_id: ctx.sessionID,
            tool_id: toolLower,
            method: "webfetch",
            status: "error",
            duration_ms: duration,
            error: `HTTP ${response.status}`,
            source_url: fetchUrl,
          })
          return {
            title: `Docs lookup failed: ${args.tool}`,
            metadata: { tool: toolLower, method: "webfetch", error: `HTTP ${response.status}` },
            output: `Failed to fetch documentation from ${fetchUrl} (HTTP ${response.status}).\n\nPlease try using the webfetch tool directly with a more specific URL, or fall back to training data.`,
          }
        }

        const contentType = response.headers.get("content-type") || ""
        let text = await response.text()

        // Basic HTML to text extraction if HTML content
        if (contentType.includes("html")) {
          // Strip script/style tags and their content
          text = text.replace(/<script[\s\S]*?<\/script>/gi, "")
          text = text.replace(/<style[\s\S]*?<\/style>/gi, "")
          text = text.replace(/<nav[\s\S]*?<\/nav>/gi, "")
          text = text.replace(/<footer[\s\S]*?<\/footer>/gi, "")
          text = text.replace(/<header[\s\S]*?<\/header>/gi, "")
          // Strip remaining tags
          text = text.replace(/<[^>]+>/g, " ")
          // Collapse whitespace
          text = text.replace(/\s+/g, " ").trim()
          // Truncate to reasonable size
          if (text.length > 15_000) {
            text = text.slice(0, 15_000) + "\n\n[... truncated, use webfetch with a more specific URL for full content]"
          }
        }

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
            `# Documentation for ${args.tool} (via web fetch)`,
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

    // Both methods failed or tool not found
    const duration = Date.now() - start
    const notFound = !ctx7Id && !platform && !hasUrl
    if (notFound) {
      log.warn("docs lookup: unknown tool", { tool: toolLower })
      Telemetry.track({
        type: "docs_lookup",
        timestamp: Date.now(),
        session_id: ctx.sessionID,
        tool_id: toolLower,
        method: "ctx7",
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
              "1. Run `npx -y ctx7@latest library " + args.tool + ' "' + args.query + '"` to search Context7',
              "2. Use the `webfetch` tool with a direct URL to the official documentation",
              "3. Fall back to training data (note: may be outdated)",
            ].join("\n")
          : [
              "All documentation sources failed (network error or rate limit).",
              "",
              "Falling back to training data. Note: the response may use outdated API patterns.",
              "The user can retry later when network is available.",
            ].join("\n"),
      ].join("\n"),
    }
  },
})
