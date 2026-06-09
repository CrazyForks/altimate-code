import { Server } from "../../server/server"
import { cmd } from "./cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "../../flag/flag"
import { Workspace } from "../../control-plane/workspace"
import { Project } from "../../project/project"
import { Installation } from "../../installation"
// altimate_change start — URL sync helpers
import { readFile } from "fs/promises"
import path from "path"
import { existsSync } from "fs"
import { resolveConfigPath, addMcpToConfig } from "../../mcp/config"
import { Filesystem } from "../../util/filesystem"
import { parseTree, findNodeAtLocation } from "jsonc-parser"
import { Log } from "../../util/log"
// altimate_change end
// altimate_change start — trace: session tracing in headless serve
import { subscribeTraceConsumer } from "../../altimate/observability/trace-consumer"
// altimate_change end

// altimate_change start
const log = Log.create({ service: "serve" })
// altimate_change end

// altimate_change start — sync datamate from .vscode/mcp.json
// Keeps altimate-code.json in sync with what the VS Code extension writes to
// .vscode/mcp.json. For the extension-managed "datamate" entry, uses the
// updatedAt field as the change signal — works for both stdio and HTTP transport.
// All other remote MCP entries fall back to URL comparison (original behaviour).
// Fire-and-forget: errors are logged but never thrown.
// Returns the list of MCP server names whose config was updated.
const DATAMATE_KEY = "datamate"

export async function syncDatamateUrlFromVscodeMcp(cwd: string): Promise<string[]> {
  const updated: string[] = []
  try {
    const mcpJsonPath = path.join(cwd, ".vscode", "mcp.json")
    if (!existsSync(mcpJsonPath)) return updated

    const text = await readFile(mcpJsonPath, "utf-8")
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(text) as Record<string, unknown>
    } catch {
      return updated
    }

    const serversMap =
      (parsed["servers"] as Record<string, Record<string, unknown>> | undefined) ??
      (parsed["mcpServers"] as Record<string, Record<string, unknown>> | undefined) ??
      {}

    // ── "datamate" entry: sync by updatedAt (works for stdio + HTTP) ────────
    const datamateVscode = serversMap[DATAMATE_KEY]
    const vscodeUpdatedAt =
      datamateVscode && typeof datamateVscode["updatedAt"] === "string"
        ? (datamateVscode["updatedAt"] as string)
        : undefined

    if (datamateVscode && vscodeUpdatedAt) {
      const configPath = await resolveConfigPath(cwd)
      if (await Filesystem.exists(configPath)) {
        const configText = await Filesystem.readText(configPath)
        const existingTree = parseTree(configText)
        const existingNode = existingTree
          ? findNodeAtLocation(existingTree, ["mcp", DATAMATE_KEY])
          : undefined

        if (existingNode) {
          // Extract current updatedAt + enabled from altimate-code.json
          let existingUpdatedAt: string | undefined
          let existingEnabled: boolean | undefined
          if (existingNode.type === "object" && existingNode.children) {
            for (const prop of existingNode.children) {
              if (prop.type !== "property" || !prop.children) continue
              const k = prop.children[0]!.value as string
              if (k === "updatedAt") existingUpdatedAt = prop.children[1]!.value as string
              if (k === "enabled") existingEnabled = prop.children[1]!.value as boolean
            }
          }

          if (vscodeUpdatedAt !== existingUpdatedAt) {
            // Build the new config entry in altimate-code.json format.
            // .vscode/mcp.json uses "stdio"/"http"/"streamable-http"/"sse";
            // altimate-code.json uses "local"/"remote".
            let newEntry: Record<string, unknown>
            if (datamateVscode["type"] === "stdio") {
              const env = datamateVscode["env"] as Record<string, string> | undefined
              const { ALTIMATE_EXTENSION_RPC: _rpc, ...restEnv } = env ?? {}
              newEntry = {
                type: "local",
                command: [
                  datamateVscode["command"] as string,
                  ...((datamateVscode["args"] as string[]) ?? []),
                ],
                ...(Object.keys(restEnv).length > 0 ? { environment: restEnv } : {}),
                updatedAt: vscodeUpdatedAt,
              }
            } else {
              // http / streamable-http / sse → remote
              newEntry = {
                type: "remote",
                url: datamateVscode["url"] as string,
                updatedAt: vscodeUpdatedAt,
              }
            }
            if (typeof existingEnabled === "boolean") newEntry["enabled"] = existingEnabled

            await addMcpToConfig(
              DATAMATE_KEY,
              newEntry as Parameters<typeof addMcpToConfig>[1],
              configPath,
            )
            log.info("syncDatamateUrl: datamate entry synced", {
              type: datamateVscode["type"],
              updatedAt: vscodeUpdatedAt,
            })
            updated.push(DATAMATE_KEY)
          }
        }
      }
    }

    // ── All other remote MCP entries: existing URL-comparison logic ──────────
    const httpEntries: Array<{ key: string; url: string }> = []
    for (const [key, entry] of Object.entries(serversMap)) {
      if (key === DATAMATE_KEY) continue // already handled above
      if (typeof entry["url"] === "string") {
        httpEntries.push({ key, url: entry["url"] })
      }
    }

    if (httpEntries.length > 0) {
      const configPath = await resolveConfigPath(cwd)
      if (await Filesystem.exists(configPath)) {
        const configText = await Filesystem.readText(configPath)
        const tree = parseTree(configText)
        const mcpNode = tree ? findNodeAtLocation(tree, ["mcp"]) : undefined

        if (tree && mcpNode && mcpNode.type === "object" && mcpNode.children) {
          const remoteMcpEntries: Array<{ name: string; url: string }> = []
          for (const child of mcpNode.children) {
            if (child.type !== "property" || !child.children) continue
            const nameNode = child.children[0]
            const valueNode = child.children[1]
            if (!nameNode || !valueNode || valueNode.type !== "object" || !valueNode.children) continue
            const typeNode = findNodeAtLocation(valueNode, ["type"])
            const urlNode = findNodeAtLocation(valueNode, ["url"])
            if (typeNode?.value === "remote" && typeof urlNode?.value === "string") {
              remoteMcpEntries.push({ name: nameNode.value as string, url: urlNode.value })
            }
          }

          for (const remote of remoteMcpEntries) {
            const match = httpEntries.find((e) => e.key === remote.name)
            if (match && match.url !== remote.url) {
              const entryNode = findNodeAtLocation(tree, ["mcp", remote.name])
              if (!entryNode || entryNode.type !== "object" || !entryNode.children) continue
              const entry: Record<string, unknown> = {}
              for (const prop of entryNode.children) {
                if (prop.type === "property" && prop.children) {
                  entry[prop.children[0]!.value as string] = prop.children[1]!.value
                }
              }
              entry["url"] = match.url
              entry["updatedAt"] = new Date().toISOString()
              await addMcpToConfig(
                remote.name,
                entry as Parameters<typeof addMcpToConfig>[1],
                configPath,
              )
              log.info("syncDatamateUrl: updating", {
                name: remote.name,
                oldUrl: remote.url,
                newUrl: match.url,
              })
              updated.push(remote.name)
            }
          }
        }
      }
    }

    if (updated.length === 0) log.info("syncDatamateUrl: no changes")
  } catch (err) {
    console.warn(`[altimate-code] syncDatamateUrlFromVscodeMcp failed (non-fatal):`, err)
  }
  return updated
}
// altimate_change end

export const ServeCommand = cmd({
  command: "serve",
  builder: (yargs) => withNetworkOptions(yargs),
  // altimate_change start — upstream_fix: branding regression in describe + log line
  describe: "starts a headless altimate-code server",
  handler: async (args) => {
    if (!Flag.OPENCODE_SERVER_PASSWORD) {
      console.log("Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.")
    }
    const opts = await resolveNetworkOptions(args)
    // altimate_change start — sync datamate URL from .vscode/mcp.json on serve startup
    // When a VS Code window restarts, the extension picks a new local port and rewrites
    // .vscode/mcp.json. Re-reading it here keeps altimate-code.json in sync without
    // requiring any user action.
    await syncDatamateUrlFromVscodeMcp(process.cwd())
    // altimate_change end
    const server = await Server.listen(opts)
    console.log(`altimate-code server listening on http://${server.hostname}:${server.port}`)
    // altimate_change end

    // altimate_change start — trace: session tracing in headless serve
    // Sessions driven over HTTP (e.g. the VS Code chat panel) have no TUI
    // worker observing the event stream, so traces were never written in
    // serve mode. Subscribe the shared trace consumer to the in-process
    // event stream so serve sessions produce the same trace files as the
    // terminal entrypoints.
    //
    // `directory` is the SDK workspace/routing context, NOT the trace output
    // location — trace files always go to the configured tracing dir
    // (`tracing.dir`, default ~/.local/share/altimate-code/traces/).
    const traceSub = subscribeTraceConsumer({ directory: process.cwd() })

    // Finalize traces on shutdown. `serve` blocks forever on the promise below
    // and otherwise dies abruptly on signal, so without these handlers the
    // consumer's stop()/flush()/endTrace() never runs and serve traces are
    // left un-finalized (status never "completed", no summary/narrative).
    // Mirrors the SIGINT/SIGTERM/beforeExit pattern in cli/cmd/run.ts.
    let isShuttingDown = false
    const shutdown = async (code: number) => {
      if (isShuttingDown) return
      isShuttingDown = true
      await traceSub.stop()
      await server.stop()
      process.exit(code)
    }
    // Exit with signal-conventional codes (128 + signal number) so a
    // SIGINT/SIGTERM isn't masked as a successful (0) run. beforeExit is a
    // normal drain, so it exits 0. Matches cli/cmd/run.ts.
    process.once("SIGINT", () => void shutdown(130))
    process.once("SIGTERM", () => void shutdown(143))
    process.once("beforeExit", () => void shutdown(0))
    // altimate_change end

    await new Promise(() => {})
  },
})
