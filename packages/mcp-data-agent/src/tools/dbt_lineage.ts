import { z } from "zod"
import { defineTool, NotImplementedError } from "../server.js"

export const dbtLineage = defineTool({
  name: "dbt_lineage",
  description:
    "Return the model-level or column-level lineage for a dbt model: upstream sources, downstream consumers, and (optionally) the column-to-column edges parsed from compiled SQL. Read-only, local — uses the project manifest, no network egress.",
  mutating: false,
  input: {
    model: z.string().describe("dbt model name to compute lineage for."),
    direction: z
      .enum(["upstream", "downstream", "both"])
      .optional()
      .describe("Lineage direction. Defaults to 'both'."),
    columnLevel: z
      .boolean()
      .optional()
      .describe("When true, returns column-level lineage edges (requires SQL parsing — slower)."),
    depth: z
      .number()
      .int()
      .positive()
      .max(20)
      .optional()
      .describe("How many hops to traverse. Defaults to unlimited."),
    projectDir: z.string().optional().describe("Path to the dbt project root."),
  },
  handler: async () => {
    throw new NotImplementedError("dbt_lineage")
  },
})
