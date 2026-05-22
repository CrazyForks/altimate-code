import { z } from "zod"
import { defineTool, NotImplementedError } from "../server.js"

export const dbtDiff = defineTool({
  name: "dbt_diff",
  description:
    "Compare two materializations of the same dbt model (e.g. prod vs a dev branch build) row-by-row and column-by-column. Returns row count delta, value mismatches per column, and a small sample of differing rows. Read-only.",
  mutating: false,
  input: {
    model: z.string().describe("dbt model name to diff."),
    baseRelation: z
      .string()
      .describe("Fully-qualified baseline relation (e.g. 'analytics_prod.fct_orders')."),
    targetRelation: z
      .string()
      .describe("Fully-qualified target relation (e.g. 'analytics_dev_pr123.fct_orders')."),
    primaryKey: z
      .array(z.string())
      .min(1)
      .describe("Primary key columns used to align rows for comparison."),
    sampleLimit: z.number().int().positive().max(1000).optional().describe("Max differing rows to return."),
  },
  handler: async () => {
    throw new NotImplementedError("dbt_diff")
  },
})
