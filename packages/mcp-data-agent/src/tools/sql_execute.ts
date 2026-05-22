import { z } from "zod"
import { defineTool, NotImplementedError } from "../server.js"

export const sqlExecute = defineTool({
  name: "sql_execute",
  description:
    "Execute a SQL query against the configured warehouse and return rows. Use for ad-hoc lookups, validation, and read paths. Mutating SQL (INSERT, UPDATE, DELETE, MERGE, CREATE, DROP, ALTER, TRUNCATE) is refused unless ALTIMATE_MCP_ALLOW_WRITE=true. Returns columns, rows, row count, and elapsed time.",
  mutating: true,
  input: {
    sql: z.string().describe("The SQL statement to execute."),
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
      .describe("Target SQL dialect. Defaults to the warehouse configured by environment variables."),
    limit: z
      .number()
      .int()
      .positive()
      .max(100_000)
      .optional()
      .describe("Optional row cap applied before returning results to the client. Defaults to 1000."),
  },
  handler: async () => {
    throw new NotImplementedError("sql_execute")
  },
})
