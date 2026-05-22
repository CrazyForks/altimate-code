import { z } from "zod"
import { defineTool, NotImplementedError } from "../server.js"

export const dbtCompile = defineTool({
  name: "dbt_compile",
  description:
    "Compile a dbt model (or arbitrary Jinja SQL) into the final SQL the warehouse would receive. Resolves refs, sources, and macros. Read-only — does not execute the model.",
  mutating: false,
  input: {
    model: z
      .string()
      .optional()
      .describe("dbt model name to compile (e.g. 'fct_orders'). Mutually exclusive with `sql`."),
    sql: z
      .string()
      .optional()
      .describe("Raw Jinja SQL to compile against the dbt project context. Mutually exclusive with `model`."),
    projectDir: z
      .string()
      .optional()
      .describe("Path to the dbt project root. Defaults to the current working directory."),
    target: z.string().optional().describe("dbt target profile name to compile against."),
  },
  handler: async () => {
    throw new NotImplementedError("dbt_compile")
  },
})
