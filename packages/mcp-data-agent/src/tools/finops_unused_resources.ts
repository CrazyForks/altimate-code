import { z } from "zod"
import { defineTool, NotImplementedError } from "../server.js"

export const finopsUnusedResources = defineTool({
  name: "finops_unused_resources",
  description:
    "Find unused or low-utilization warehouse resources: dormant tables (not queried in N days), warehouses with no queries, materialized views with no downstream reads, and unused secondary clusters. Returns per-resource proposals (drop, transient conversion, suspend reclustering). Read-only.",
  mutating: false,
  input: {
    days: z
      .number()
      .int()
      .positive()
      .max(365)
      .optional()
      .describe("Dormancy threshold in days. Defaults to 90."),
    resourceType: z
      .enum(["all", "tables", "warehouses", "materialized_views", "clusters"])
      .optional()
      .describe("Restrict the scan to a single resource category. Defaults to 'all'."),
  },
  handler: async () => {
    throw new NotImplementedError("finops_unused_resources")
  },
})
