import { z } from "zod"
import { defineTool, NotImplementedError } from "../server.js"

export const sqlExplain = defineTool({
  name: "sql_explain",
  description:
    "Return the warehouse's EXPLAIN plan for a SQL query as structured JSON: estimated rows, bytes scanned, join order, pruning details, and the operators that dominate cost. Read-only — issues EXPLAIN, never executes the underlying query.",
  mutating: false,
  input: {
    sql: z.string().describe("The SQL query to explain."),
    dialect: z
      .enum([
        "snowflake",
        "bigquery",
        "databricks",
        "postgres",
        "redshift",
        "mysql",
        "sqlserver",
        "oracle",
        "duckdb",
        "sqlite",
      ])
      .optional()
      .describe("Target SQL dialect. Defaults to the configured warehouse."),
    format: z
      .enum(["text", "json"])
      .optional()
      .describe("Output format. Defaults to 'json' for downstream programmatic use."),
  },
  handler: async () => {
    throw new NotImplementedError("sql_explain")
  },
})
