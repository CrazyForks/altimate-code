# @altimateai/mcp-data-agent

A local-first [MCP](https://modelcontextprotocol.io) server that exposes 20 curated data-engineering tools — SQL analysis, dbt workflow, FinOps cost intelligence, lineage, and PII detection — to any MCP-compatible client (Claude Code, Claude Desktop, Cursor, Windsurf, Goose, Cline). The server runs on your machine and talks to your warehouse directly.

## Install

The package is `npx`-installable and runs over stdio. To wire it into Claude Code, add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "altimate-data": {
      "command": "npx",
      "args": ["-y", "@altimateai/mcp-data-agent@latest"]
    }
  }
}
```

Cursor, Windsurf, and Claude Desktop use the same shape — see each client's MCP docs for the exact config file location.

## Configuration

All configuration is via environment variables. There is no file-based config in v1.

| Variable | Purpose |
| --- | --- |
| `SNOWFLAKE_ACCOUNT`, `SNOWFLAKE_USER`, `SNOWFLAKE_PASSWORD` | Snowflake credentials (or use OAuth). |
| `ALTIMATE_API_KEY` | Optional, only required for hosted services. |
| `ALTIMATE_MCP_ALLOW_WRITE` | Set to `true` to enable mutating tools (`sql_execute` with mutating SQL, `dbt_run`). Defaults to `false`. |

## Security

The server runs locally. No query text, schema metadata, or warehouse data leaves your machine. Your warehouse credentials are read from your environment, your LLM endpoint is whatever the client is already configured to use. Write tools are gated behind an explicit opt-in env var.

## Available tools

| Tool | Purpose |
| --- | --- |
| `sql_execute` | Run a SQL query and return rows (mutating SQL gated by `ALTIMATE_MCP_ALLOW_WRITE`). |
| `sql_analyze` | Static SQL anti-pattern detection with severity-ranked findings. |
| `sql_explain` | Return the warehouse EXPLAIN plan as JSON. |
| `schema_introspect` | Inspect tables, views, and schemas. |
| `dbt_compile` | Compile a dbt model or arbitrary Jinja SQL. |
| `dbt_run` | Materialize models (write-gated). |
| `dbt_test` | Run dbt tests and return failing-row samples. |
| `dbt_lineage` | Model- and column-level lineage from the dbt manifest. |
| `dbt_impact_analyze` | Classify downstream impact of a model change as BREAKING / SAFE / UNKNOWN. |
| `dbt_diff` | Row-level diff between two materializations of a model. |
| `finops_credits_summary` | Credit consumption grouped by warehouse / role / user. |
| `finops_expensive_queries` | Top-N most expensive queries by credits / bytes / elapsed. |
| `finops_warehouse_advice` | Auto-suspend, cluster count, and size recommendations for one warehouse. |
| `finops_unused_resources` | Dormant tables, idle warehouses, unused materialized views. |
| `finops_anomaly_scan` | Day-over-day and week-over-week cost spike detection. |
| `finops_clustering_roi` | Reclustering credits vs query-time savings per table. |
| `query_history_search` | Query history filtered by user, role, table reference, regex, or time range. |
| `pii_scan` | Heuristic PII detection on columns by name and sample values. |
| `data_parity_check` | Row-level parity check between two tables. |
| `account_usage_query` | Parameterized access to warehouse observability views. |

## Status

Alpha. The 20 tools are scaffolded with the schemas they will eventually expose, but every handler currently throws "not yet wired to altimate-engine". Wiring is in progress — see the [altimate-code repo](https://github.com/AltimateAI/altimate-code) for status.
