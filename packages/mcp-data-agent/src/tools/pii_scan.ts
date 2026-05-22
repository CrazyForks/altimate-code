import { z } from "zod"
import { defineTool, NotImplementedError } from "../server.js"

export const piiScan = defineTool({
  name: "pii_scan",
  description:
    "Scan one or more tables for columns that look like PII (email, phone, SSN, credit card, address, IP, names) using column-name heuristics and sample-value regexes. Returns per-column confidence and the rule that matched. Read-only — fetches a small sample of rows.",
  mutating: false,
  input: {
    database: z.string().optional().describe("Database to scan."),
    schema: z.string().optional().describe("Schema to scan."),
    table: z
      .string()
      .optional()
      .describe("Single table to scan. When omitted, scans every table in the schema."),
    sampleRows: z
      .number()
      .int()
      .positive()
      .max(10_000)
      .optional()
      .describe("Number of sample rows per table used for value-pattern checks. Defaults to 100."),
  },
  handler: async () => {
    throw new NotImplementedError("pii_scan")
  },
})
