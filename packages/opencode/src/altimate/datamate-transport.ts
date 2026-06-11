import { readFile } from "fs/promises"
import path from "path"
import { existsSync } from "fs"
import { parseTree, findNodeAtLocation } from "jsonc-parser"
import { resolveConfigPath, addMcpToConfig } from "../mcp/config"
import { Filesystem } from "../util/filesystem"
import { Log } from "../util/log"
import type { Config } from "../config/config"

const log = Log.create({ service: "datamate-transport" })

// altimate_change start — shared constant used in datamate.ts, serve.ts, and server.ts
export const DATAMATE_KEY = "datamate"
// altimate_change end

/** IDE config sources where the extension may write a "datamate" MCP entry. */
const IDE_MCP_SOURCES = [
  // VS Code (1.99+: "servers", older: "mcpServers")
  { file: ".vscode/mcp.json", keys: ["servers", "mcpServers"] },
  // Cursor
  { file: ".cursor/mcp.json", keys: ["mcpServers", "servers"] },
  // GitHub Copilot
  { file: ".github/copilot/mcp.json", keys: ["mcpServers", "servers"] },
]

export type DatamateTransport =
  | { type: "remote"; url: string }
  | { type: "local"; command: string[] }

/**
 * Scan across all IDE MCP config files in projectRootDir and return the
 * transport type for the "datamate" server entry.
 *
 * Returns null if no IDE config has a "datamate" entry — the caller should
 * fall back to the cloud config.
 *
 * Reuses the exact command from the IDE config so altimate-code spawns the
 * same process the extension already started, rather than a second one.
 */
export async function readDatamateTransportFromIde(
  projectRootDir: string,
): Promise<DatamateTransport | null> {
  for (const source of IDE_MCP_SOURCES) {
    const mcpJsonPath = path.join(projectRootDir, source.file)
    if (!existsSync(mcpJsonPath)) continue

    try {
      const text = await readFile(mcpJsonPath, "utf-8")
      const parsed = JSON.parse(text) as Record<string, unknown>

      let serversMap: Record<string, Record<string, unknown>> = {}
      for (const key of source.keys) {
        const candidate = parsed[key]
        if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
          serversMap = candidate as Record<string, Record<string, unknown>>
          break
        }
      }

      const entry = serversMap[DATAMATE_KEY]
      if (!entry) continue

      log.info("readDatamateTransportFromIde: found entry", {
        source: source.file,
        type: entry["type"] ?? "(no type)",
      })

      if (typeof entry["url"] === "string") {
        return { type: "remote", url: entry["url"] }
      }

      // stdio entry — extract command + args so we reuse the same process
      // the extension already manages, rather than spawning a second one.
      const cmd = typeof entry["command"] === "string" ? entry["command"] : undefined
      const args = Array.isArray(entry["args"]) ? (entry["args"] as string[]) : []
      if (cmd) {
        return { type: "local", command: [cmd, ...args] }
      }

      // Entry exists but has no usable command — treat as local marker
      return { type: "local", command: [DATAMATE_KEY, "start-stdio"] }
    } catch {
      log.warn("readDatamateTransportFromIde: failed to parse", { source: source.file })
      // File missing or unparseable — try next source
    }
  }

  log.info("readDatamateTransportFromIde: no IDE entry found, falling back to cloud config")
  return null
}

/**
 * Sync the "datamate" entry (and other remote MCP entries) from IDE MCP config
 * files to altimate-code.json. Uses `updatedAt` as the change signal for the
 * datamate entry (covers both stdio and HTTP transport), and URL comparison for
 * all other remote entries.
 *
 * Fire-and-forget friendly: errors are logged but never thrown.
 * Returns the list of MCP server names whose config was updated on disk.
 */
export async function syncDatamateUrlFromVscodeMcp(cwd: string): Promise<string[]> {
  const updated: string[] = []
  try {
    log.info("syncDatamateUrlFromVscodeMcp: start", { cwd })

    // Try each IDE source in priority order; use the first one that exists.
    let mcpJsonPath: string | undefined
    let ideSource: (typeof IDE_MCP_SOURCES)[number] | undefined
    for (const source of IDE_MCP_SOURCES) {
      const candidate = path.join(cwd, source.file)
      if (existsSync(candidate)) {
        mcpJsonPath = candidate
        ideSource = source
        break
      }
    }

    if (!mcpJsonPath || !ideSource) {
      log.info("syncDatamateUrlFromVscodeMcp: no IDE MCP config found, skipping sync")
      return updated
    }

    const text = await readFile(mcpJsonPath, "utf-8")
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(text) as Record<string, unknown>
    } catch {
      return updated
    }

    let serversMap: Record<string, Record<string, unknown>> = {}
    for (const key of ideSource.keys) {
      const candidate = parsed[key]
      if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
        serversMap = candidate as Record<string, Record<string, unknown>>
        break
      }
    }

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

          if (vscodeUpdatedAt === existingUpdatedAt) {
            log.info("syncDatamateUrlFromVscodeMcp: datamate entry already up to date, skipping", {
              updatedAt: vscodeUpdatedAt,
            })
          } else {
            // Build the new config entry in altimate-code.json format.
            // IDE config uses "stdio"/"http"/"streamable-http"/"sse";
            // altimate-code.json uses "local"/"remote".
            let newEntry: Record<string, unknown>
            if (datamateVscode["type"] === "stdio") {
              const env = datamateVscode["env"] as Record<string, string> | undefined
              const { ALTIMATE_EXTENSION_RPC: _rpc, ...restEnv } = env ?? {}
              const cmd = typeof datamateVscode["command"] === "string" ? datamateVscode["command"] as string : DATAMATE_KEY
              newEntry = {
                type: "local",
                command: [
                  cmd,
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
            log.info("syncDatamateUrlFromVscodeMcp: datamate entry synced", {
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
              log.info("syncDatamateUrlFromVscodeMcp: remote entry updated", {
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

    if (updated.length === 0) log.info("syncDatamateUrlFromVscodeMcp: no changes detected")
  } catch (err) {
    log.warn("syncDatamateUrlFromVscodeMcp: failed (non-fatal)", {
      error: err instanceof Error ? err.message : String(err),
    })
  }
  return updated
}

/**
 * Read a single MCP entry directly from disk (bypasses the in-memory Config
 * singleton) so callers can get the freshly-written config without busting the
 * whole cache. Returns undefined if the entry is not found in any config file.
 */
export async function readMcpEntryFromDisk(
  name: string,
  configPath: string,
): Promise<Config.Mcp | undefined> {
  if (!(await Filesystem.exists(configPath))) return undefined

  const text = await Filesystem.readText(configPath)
  const tree = parseTree(text)
  if (!tree) return undefined

  const node = findNodeAtLocation(tree, ["mcp", name])
  if (!node || node.type !== "object" || !node.children) return undefined

  const entry: Record<string, unknown> = {}
  for (const prop of node.children) {
    if (prop.type === "property" && prop.children) {
      entry[prop.children[0]!.value as string] = prop.children[1]!.value
    }
  }

  return entry as Config.Mcp
}
