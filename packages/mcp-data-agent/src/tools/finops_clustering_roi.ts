import { z } from "zod"
import { defineTool, NotImplementedError } from "../server.js"

export const finopsClusteringRoi = defineTool({
  name: "finops_clustering_roi",
  description:
    "For each automatically-clustered table, compute the ratio of reclustering credits to query-time credits saved by clustering. Identifies tables where clustering cost exceeds query benefit and recommends suspend, drop, or new clustering key. Read-only.",
  mutating: false,
  input: {
    days: z
      .number()
      .int()
      .positive()
      .max(180)
      .optional()
      .describe("History window for the ROI calculation. Defaults to 30."),
    minCredits: z
      .number()
      .positive()
      .optional()
      .describe("Only return tables that burned at least this many reclustering credits. Defaults to 1."),
  },
  handler: async () => {
    throw new NotImplementedError("finops_clustering_roi")
  },
})
