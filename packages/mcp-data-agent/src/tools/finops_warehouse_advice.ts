import { z } from "zod"
import { defineTool, NotImplementedError } from "../server.js"

export const finopsWarehouseAdvice = defineTool({
  name: "finops_warehouse_advice",
  description:
    "For one warehouse, recommend auto-suspend, cluster count, size, and query acceleration changes based on the last 30 days of usage. Returns up to 3 plain-text recommendations or an explicit 'no change' with the numbers that ruled out each option. Read-only.",
  mutating: false,
  input: {
    warehouse: z.string().describe("Warehouse name to advise on."),
    days: z
      .number()
      .int()
      .positive()
      .max(90)
      .optional()
      .describe("History window used for the recommendation. Defaults to 30."),
  },
  handler: async () => {
    throw new NotImplementedError("finops_warehouse_advice")
  },
})
