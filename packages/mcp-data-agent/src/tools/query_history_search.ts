import { z } from "zod"
import { defineTool, NotImplementedError } from "../server.js"

export const queryHistorySearch = defineTool({
  name: "query_history_search",
  description:
    "Search query history by user, role, warehouse, table reference, regex over query text, or time range. Returns matching queries with elapsed time, credits, rows produced, and execution status. Read-only — issues SELECTs against ACCOUNT_USAGE / INFORMATION_SCHEMA.",
  mutating: false,
  input: {
    user: z.string().optional().describe("Filter to a single user."),
    role: z.string().optional().describe("Filter to a single role."),
    warehouse: z.string().optional().describe("Filter to a single warehouse."),
    referencesTable: z
      .string()
      .optional()
      .describe("Return only queries that reference this fully-qualified table name."),
    textRegex: z.string().optional().describe("Regex matched against the query text (case-insensitive)."),
    days: z
      .number()
      .int()
      .positive()
      .max(90)
      .optional()
      .describe("Trailing window in days. Defaults to 7."),
    limit: z
      .number()
      .int()
      .positive()
      .max(500)
      .optional()
      .describe("Maximum number of rows to return. Defaults to 50."),
  },
  handler: async () => {
    throw new NotImplementedError("query_history_search")
  },
})
