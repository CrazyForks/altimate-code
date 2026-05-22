import { z } from "zod"
import { defineTool, NotImplementedError } from "../server.js"

export const dbtRun = defineTool({
  name: "dbt_run",
  description:
    "Execute `dbt run` for a selected model or selector. Materializes data in the warehouse. Refused unless ALTIMATE_MCP_ALLOW_WRITE=true is set. Returns per-model status, row counts, and elapsed time.",
  mutating: true,
  input: {
    select: z
      .string()
      .optional()
      .describe("dbt selector (model name, +downstream, tag:..., etc.). Defaults to running the full project."),
    fullRefresh: z.boolean().optional().describe("Pass --full-refresh to dbt."),
    projectDir: z.string().optional().describe("Path to the dbt project root."),
    target: z.string().optional().describe("dbt target profile name."),
    vars: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("Vars passed to dbt as --vars. Use sparingly — values appear in dbt logs."),
  },
  handler: async () => {
    throw new NotImplementedError("dbt_run")
  },
})
