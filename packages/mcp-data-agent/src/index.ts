import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { createServer } from "./server.js"

async function main(): Promise<void> {
  const server = await createServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((err) => {
  // The MCP client can't receive structured errors here — the transport has
  // not yet been negotiated. Write to stderr and exit non-zero so the parent
  // process (claude-code, cursor, etc.) shows the failure in its UI.
  const message = err instanceof Error ? err.stack ?? err.message : String(err)
  process.stderr.write(`altimate-mcp: fatal: ${message}\n`)
  process.exit(1)
})
