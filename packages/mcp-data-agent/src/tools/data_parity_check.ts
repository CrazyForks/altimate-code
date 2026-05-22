import { z } from "zod"
import { defineTool, NotImplementedError } from "../server.js"

export const dataParityCheck = defineTool({
  name: "data_parity_check",
  description:
    "Compare two tables across warehouses or schemas for parity: row count, column-level checksums, and sampled-value drift. Use to validate migrations, replication, and dual-writes. Read-only — issues SELECTs only.",
  mutating: false,
  input: {
    leftRelation: z.string().describe("Fully-qualified left relation (e.g. 'prod_db.analytics.fct_orders')."),
    rightRelation: z.string().describe("Fully-qualified right relation."),
    primaryKey: z
      .array(z.string())
      .min(1)
      .describe("Primary key columns used to align rows."),
    columns: z
      .array(z.string())
      .optional()
      .describe("Specific columns to check. When omitted, compares every column present on both sides."),
    sampleLimit: z
      .number()
      .int()
      .positive()
      .max(10_000)
      .optional()
      .describe("Max differing rows to surface in the response. Defaults to 100."),
  },
  handler: async () => {
    throw new NotImplementedError("data_parity_check")
  },
})
