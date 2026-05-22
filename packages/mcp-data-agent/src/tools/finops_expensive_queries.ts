import { z } from "zod"
import { defineTool, NotImplementedError } from "../server.js"

export const finopsExpensiveQueries = defineTool({
  name: "finops_expensive_queries",
  description:
    "Identify the top-N most expensive queries in a time window, ranked by credits, bytes scanned, or elapsed time. Returns query text, user, role, warehouse, and a parameterized hash to detect duplicates. Read-only.",
  mutating: false,
  input: {
    days: z.number().int().positive().max(365).optional().describe("Trailing window in days. Defaults to 7."),
    limit: z.number().int().positive().max(500).optional().describe("Number of queries to return. Defaults to 25."),
    rankBy: z
      .enum(["credits", "bytes_scanned", "elapsed", "rows_produced"])
      .optional()
      .describe("Ranking metric. Defaults to 'credits'."),
    warehouse: z.string().optional().describe("Restrict to a single warehouse."),
  },
  handler: async () => {
    throw new NotImplementedError("finops_expensive_queries")
  },
})
