import { z } from "zod"
import { defineTool, NotImplementedError } from "../server.js"

export const schemaIntrospect = defineTool({
  name: "schema_introspect",
  description:
    "Inspect a warehouse object (table, view, or schema) and return its columns, data types, nullability, primary/foreign keys, partition/cluster keys, and row count estimate. Use to ground answers about column names and types before writing SQL.",
  mutating: false,
  input: {
    database: z.string().optional().describe("Database name. Defaults to the configured database."),
    schema: z.string().optional().describe("Schema name. Defaults to the configured schema."),
    table: z
      .string()
      .optional()
      .describe("Optional table or view name. When omitted, returns the list of objects in the schema."),
  },
  handler: async () => {
    throw new NotImplementedError("schema_introspect")
  },
})
