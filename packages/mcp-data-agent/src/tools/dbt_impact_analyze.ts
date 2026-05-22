import { z } from "zod"
import { defineTool, NotImplementedError } from "../server.js"

export const dbtImpactAnalyze = defineTool({
  name: "dbt_impact_analyze",
  description:
    "Given a proposed change to a dbt model (added/removed/renamed columns, materialization change, filter change), classify the downstream impact across the dbt DAG into BREAKING, SAFE, and UNKNOWN buckets. Use before opening a PR that modifies a high-traffic model.",
  mutating: false,
  input: {
    model: z.string().describe("dbt model name being changed."),
    diffSql: z
      .string()
      .optional()
      .describe("Optional new SQL for the model. When omitted, compares HEAD against the working tree."),
    projectDir: z.string().optional().describe("Path to the dbt project root."),
  },
  handler: async () => {
    throw new NotImplementedError("dbt_impact_analyze")
  },
})
