import { z } from "zod"
import { defineTool, NotImplementedError } from "../server.js"

export const accountUsageQuery = defineTool({
  name: "account_usage_query",
  description:
    "Run a parameterized query against the warehouse observability layer (Snowflake ACCOUNT_USAGE, BigQuery INFORMATION_SCHEMA.JOBS, Databricks system tables, etc.) using a curated set of named views. Use when the canned FinOps tools do not cover the question and you need raw access to billing / metadata data. Read-only.",
  mutating: false,
  input: {
    view: z
      .enum([
        "query_history",
        "warehouse_metering_history",
        "warehouse_load_history",
        "automatic_clustering_history",
        "materialized_view_refresh_history",
        "pipe_usage_history",
        "search_optimization_history",
        "serverless_task_history",
        "storage_usage",
        "table_storage_metrics",
      ])
      .describe("Named observability view to query."),
    filters: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
      .optional()
      .describe("Column-equality filters applied as a WHERE clause. Values are bound as parameters."),
    days: z
      .number()
      .int()
      .positive()
      .max(365)
      .optional()
      .describe("Trailing window applied to the view's primary timestamp column. Defaults to 7."),
    limit: z
      .number()
      .int()
      .positive()
      .max(10_000)
      .optional()
      .describe("Row cap. Defaults to 500."),
  },
  handler: async () => {
    throw new NotImplementedError("account_usage_query")
  },
})
