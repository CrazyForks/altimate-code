import { z } from "zod"
import { defineTool, NotImplementedError } from "../server.js"

export const finopsCreditsSummary = defineTool({
  name: "finops_credits_summary",
  description:
    "Summarize warehouse credit consumption over a time window, grouped by warehouse, role, or user. Returns total credits, dollar-equivalent, day-over-day trend, and top contributors. Read-only — queries ACCOUNT_USAGE / INFORMATION_SCHEMA views.",
  mutating: false,
  input: {
    days: z
      .number()
      .int()
      .positive()
      .max(365)
      .optional()
      .describe("Trailing window in days. Defaults to 30."),
    groupBy: z
      .enum(["warehouse", "role", "user", "database"])
      .optional()
      .describe("Grouping dimension. Defaults to 'warehouse'."),
    creditRate: z
      .number()
      .positive()
      .optional()
      .describe("Override the contract credit rate ($/credit) used to compute dollar equivalents."),
  },
  handler: async () => {
    throw new NotImplementedError("finops_credits_summary")
  },
})
