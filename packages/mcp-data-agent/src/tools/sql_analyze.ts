import { z } from "zod"
import { defineTool, NotImplementedError } from "../server.js"

export const sqlAnalyze = defineTool({
  name: "sql_analyze",
  description:
    "Analyze a SQL query for anti-patterns (SELECT *, missing predicates on partition keys, implicit casts, cartesian joins, unnecessary ORDER BY in subqueries, scalar UDFs in WHERE clauses). Returns severity-ranked findings with rewrite suggestions. Read-only and static — does not contact the warehouse.",
  mutating: false,
  input: {
    sql: z.string().describe("The SQL query to analyze."),
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
      .describe("Target SQL dialect for parser selection."),
  },
  handler: async () => {
    throw new NotImplementedError("sql_analyze")
  },
})
