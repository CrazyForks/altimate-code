import { z } from "zod"
import { defineTool, NotImplementedError } from "../server.js"

export const dbtTest = defineTool({
  name: "dbt_test",
  description:
    "Run dbt tests for a selected model or selector and return pass/fail counts plus failing-row samples. Issues SELECT statements only — does not modify warehouse data and so does not require the write gate.",
  mutating: false,
  input: {
    select: z.string().optional().describe("dbt selector. Defaults to all tests in the project."),
    projectDir: z.string().optional().describe("Path to the dbt project root."),
    target: z.string().optional().describe("dbt target profile name."),
    storeFailures: z
      .boolean()
      .optional()
      .describe("When true, persist failing rows to the failures table. Ignored unless ALTIMATE_MCP_ALLOW_WRITE=true."),
  },
  handler: async () => {
    throw new NotImplementedError("dbt_test")
  },
})
