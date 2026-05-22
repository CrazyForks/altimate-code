import { z } from "zod"
import { defineTool, NotImplementedError } from "../server.js"

export const finopsAnomalyScan = defineTool({
  name: "finops_anomaly_scan",
  description:
    "Detect day-over-day and week-over-week cost anomalies at warehouse and user level. Flags cost spikes, new expensive query patterns, and unusual usage surges. Returns an anomaly digest ranked by dollar impact. Read-only.",
  mutating: false,
  input: {
    days: z
      .number()
      .int()
      .positive()
      .max(180)
      .optional()
      .describe("Window analyzed for anomalies. Defaults to 30."),
    sensitivity: z
      .enum(["low", "medium", "high"])
      .optional()
      .describe("Detection sensitivity. Higher means more flags. Defaults to 'medium'."),
  },
  handler: async () => {
    throw new NotImplementedError("finops_anomaly_scan")
  },
})
