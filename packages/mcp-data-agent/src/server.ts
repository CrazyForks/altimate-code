import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { z, ZodRawShape } from "zod"
import { assertWriteAllowed } from "./auth.js"

/**
 * Shape used by every tool file. We keep the input schema as a Zod raw shape
 * (a `{ key: ZodType }` map) because that is what `McpServer.registerTool`
 * consumes directly — it builds the JSON Schema sent to clients from it.
 */
export interface ToolDefinition<Shape extends ZodRawShape = ZodRawShape> {
  name: string
  description: string
  mutating: boolean
  input: Shape
  handler: (input: InferShape<Shape>) => Promise<ToolResult>
}

export type InferShape<Shape extends ZodRawShape> = {
  [K in keyof Shape]: z.infer<Shape[K]>
}

export interface ToolResult {
  /** Human-readable text the model can read. */
  text: string
  /** Optional structured payload returned alongside the text. */
  data?: Record<string, unknown>
  /** When true, the call surfaces as an error to the client. */
  isError?: boolean
}

/**
 * Helper used by each tool file to declare itself. Keeping this trivial — it
 * is essentially an identity function that pins down types per-tool. The
 * registration with the McpServer happens in `register()` below, which
 * widens the shape because the tools registry holds a heterogeneous list.
 */
export function defineTool<Shape extends ZodRawShape>(def: ToolDefinition<Shape>): ToolDefinition<Shape> {
  return def
}

/**
 * Tracking issue placeholder used by every stub. Replaced with the real issue
 * URL once wiring lands.
 */
export const NOT_IMPLEMENTED_ISSUE = "https://github.com/AltimateAI/altimate-code/issues/TBD"

export class NotImplementedError extends Error {
  constructor(toolName: string) {
    super(`${toolName}: not yet wired to altimate-engine. Track at ${NOT_IMPLEMENTED_ISSUE}`)
    this.name = "NotImplementedError"
  }
}

/**
 * Register one tool with an `McpServer`. Mutating tools are wrapped so they
 * refuse to run unless `ALTIMATE_MCP_ALLOW_WRITE=true` — the refusal happens
 * before the handler executes, so a stub that throws "not implemented" never
 * runs in write-disallowed mode either.
 *
 * The function is intentionally typed loosely (`ToolDefinition` without a
 * shape parameter) so we can iterate over a heterogeneous list of tools
 * without TypeScript collapsing them into one shape.
 */
export function register(server: McpServer, tool: ToolDefinition): void {
  // The SDK callback type is generic over the shape; we lose precision here
  // on purpose because the registry holds tools with different shapes.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handler = async (args: any) => {
    try {
      if (tool.mutating) assertWriteAllowed(tool.name)
      const result = await tool.handler(args)
      return {
        content: [{ type: "text" as const, text: result.text }],
        ...(result.data !== undefined ? { structuredContent: result.data } : {}),
        isError: result.isError === true,
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        content: [{ type: "text" as const, text: message }],
        isError: true,
      }
    }
  }

  server.registerTool(
    tool.name,
    {
      description: tool.description,
      inputSchema: tool.input,
      annotations: {
        readOnlyHint: !tool.mutating,
        destructiveHint: tool.mutating,
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler as any,
  )
}

/**
 * Build a fresh `McpServer` and register every tool from the registry. Kept
 * separate from `index.ts` so tests can spin up a server without taking over
 * stdio.
 */
export async function createServer(): Promise<McpServer> {
  const server = new McpServer(
    {
      name: "io.github.altimateai/altimate-code-data-agent",
      version: "0.1.0",
    },
    {
      capabilities: { tools: {} },
    },
  )
  const { tools } = await import("./tools/index.js")
  for (const tool of tools) register(server, tool as unknown as ToolDefinition)
  return server
}
