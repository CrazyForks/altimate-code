import { describe, expect, test, afterEach } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createServer } from "../src/server.js"
import { tools } from "../src/tools/index.js"

const EXPECTED_TOOL_COUNT = 20

describe("mcp-data-agent server", () => {
  let client: Client | undefined

  afterEach(async () => {
    if (client) {
      await client.close()
      client = undefined
    }
  })

  test("registry exports exactly 20 tools", () => {
    expect(tools.length).toBe(EXPECTED_TOOL_COUNT)
  })

  test("tool names are unique", () => {
    const names = tools.map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
  })

  test("tools/list returns 20 tools over MCP", async () => {
    const server = await createServer()
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} })
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    const listed = await client.listTools()
    expect(listed.tools.length).toBe(EXPECTED_TOOL_COUNT)

    const names = new Set(listed.tools.map((t) => t.name))
    for (const tool of tools) expect(names.has(tool.name)).toBe(true)
  })

  test("tools/call returns a not-implemented error for a read-only stub", async () => {
    const server = await createServer()
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} })
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    const result = await client.callTool({ name: "sql_analyze", arguments: { sql: "SELECT 1" } })
    expect(result.isError).toBe(true)
    const content = result.content as Array<{ type: string; text: string }>
    expect(content[0]?.text).toContain("not yet wired to altimate-engine")
  })

  test("mutating tool refuses when ALTIMATE_MCP_ALLOW_WRITE is unset", async () => {
    const prior = process.env.ALTIMATE_MCP_ALLOW_WRITE
    delete process.env.ALTIMATE_MCP_ALLOW_WRITE
    try {
      const server = await createServer()
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
      client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} })
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

      const result = await client.callTool({ name: "dbt_run", arguments: { select: "fct_orders" } })
      expect(result.isError).toBe(true)
      const content = result.content as Array<{ type: string; text: string }>
      expect(content[0]?.text).toContain("write operations are disabled")
    } finally {
      if (prior !== undefined) process.env.ALTIMATE_MCP_ALLOW_WRITE = prior
    }
  })
})
