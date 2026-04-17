// altimate_change start — pack: top-level `pack` command for managing pack bundles
import { EOL } from "os"
import path from "path"
import fs from "fs/promises"
import { Pack } from "../../pack"
import { Skill } from "../../skill"
import { bootstrap } from "../bootstrap"
import { cmd } from "./cmd"
import { Instance } from "../../project/instance"
import { Global } from "@/global"
import { Telemetry } from "@/altimate/telemetry"
// altimate_change start — pack: jsonc-parser for comment-preserving config writes
import { modify, applyEdits } from "jsonc-parser"
// altimate_change end

// ---------------------------------------------------------------------------
// PACK.yaml template
// ---------------------------------------------------------------------------

function packTemplate(name: string): string {
  return `name: ${name}
description: TODO — describe what this pack configures
version: 1.0.0

# Skills to install (from external repos or already-installed names)
skills:
  # - source: "owner/repo"
  #   select: ["skill-a", "skill-b"]

# MCP servers to configure
mcp:
  # my-server:
  #   command: ["uvx", "my-mcp-server"]
  #   env_keys: ["MY_API_KEY"]

# Auto-detection rules
detect:
  # - files: ["config.yaml"]
  #   message: "Detected my-tool — activate pack?"

# Instructions added to every conversation
instructions: |
  TODO — add project-specific instructions here.
`
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function findConfigFile(rootDir: string): Promise<{ filePath: string; config: Record<string, unknown> }> {
  const candidates = [
    path.join(rootDir, ".opencode", "opencode.json"),
    path.join(rootDir, ".opencode", "opencode.jsonc"),
    path.join(rootDir, ".altimate-code", "altimate-code.json"),
    path.join(rootDir, ".altimate-code", "altimate-code.jsonc"),
    path.join(rootDir, "opencode.json"),
    path.join(rootDir, "opencode.jsonc"),
    path.join(rootDir, "altimate-code.json"),
    path.join(rootDir, "altimate-code.jsonc"),
  ]

  for (const candidate of candidates) {
    try {
      const raw = await fs.readFile(candidate, "utf-8")
      // Strip single-line comments for JSONC files
      const cleaned = candidate.endsWith(".jsonc")
        ? raw.replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1")
        : raw
      return { filePath: candidate, config: JSON.parse(cleaned) }
    } catch {
      // try next
    }
  }

  // No config found — create one in .opencode/
  const defaultPath = path.join(rootDir, ".opencode", "opencode.json")
  await fs.mkdir(path.dirname(defaultPath), { recursive: true })
  const defaultConfig: Record<string, unknown> = {}
  await fs.writeFile(defaultPath, JSON.stringify(defaultConfig, null, 2) + EOL, "utf-8")
  return { filePath: defaultPath, config: defaultConfig }
}

// altimate_change start — pack: JSONC-aware config writes that preserve comments
async function writeConfigField(filePath: string, fieldPath: string[], value: unknown): Promise<void> {
  let text = "{}"
  try { text = await fs.readFile(filePath, "utf-8") } catch {}
  const edits = modify(text, fieldPath, value, {
    formattingOptions: { tabSize: 2, insertSpaces: true },
  })
  const result = applyEdits(text, edits)
  await fs.writeFile(filePath, result, "utf-8")
}

async function removeConfigField(filePath: string, fieldPath: string[]): Promise<boolean> {
  let text: string
  try { text = await fs.readFile(filePath, "utf-8") } catch { return false }
  const edits = modify(text, fieldPath, undefined, {
    formattingOptions: { tabSize: 2, insertSpaces: true },
  })
  if (edits.length === 0) return false
  const result = applyEdits(text, edits)
  await fs.writeFile(filePath, result, "utf-8")
  return true
}
// altimate_change end

async function cloneSource(source: string): Promise<{ dir: string; cloned: boolean }> {
  let url: string | undefined
  let normalized = source.trim().replace(/\.git$/, "")

  // Normalize GitHub web URLs (e.g. /tree/main/path)
  const ghWebMatch = normalized.match(/^https?:\/\/github\.com\/([^/]+\/[^/]+?)(?:\/(?:tree|blob)\/.*)?$/)
  if (ghWebMatch) {
    url = `https://github.com/${ghWebMatch[1]}.git`
  } else if (normalized.startsWith("http://") || normalized.startsWith("https://")) {
    url = normalized
  } else if (normalized.match(/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9._-]+$/)) {
    // Check if it's a local path first (e.g., "examples/packs" looks like "owner/repo")
    const resolvedLocal = path.isAbsolute(normalized) ? normalized : path.resolve(normalized)
    try {
      await fs.access(resolvedLocal)
      // It exists on disk — treat as local path, not GitHub shorthand
      return { dir: resolvedLocal, cloned: false }
    } catch {
      // Not a local path — treat as GitHub shorthand
      url = `https://github.com/${normalized}.git`
    }
  }

  if (url) {
    const tmpDir = path.join(Global.Path.cache, "pack-install-" + Date.now())
    const proc = Bun.spawnSync(["git", "clone", "--depth", "1", "--", url, tmpDir], {
      stdout: "pipe",
      stderr: "pipe",
    })
    if (proc.exitCode !== 0) {
      throw new Error(`Failed to clone ${url}: ${proc.stderr.toString()}`)
    }
    return { dir: tmpDir, cloned: true }
  }

  // Local path
  const resolved = path.isAbsolute(normalized) ? normalized : path.resolve(normalized)
  try {
    await fs.access(resolved)
  } catch {
    throw new Error(`Path not found: ${resolved}`)
  }
  return { dir: resolved, cloned: false }
}

async function cleanupTmp(dir: string, cloned: boolean) {
  if (cloned && dir.startsWith(Global.Path.cache)) {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

const PackListCommand = cmd({
  command: "list",
  describe: "list all available packs",
  builder: (yargs) =>
    yargs
      .option("json", {
        type: "boolean",
        describe: "output as JSON",
        default: false,
      })
      .option("detect", {
        type: "boolean",
        describe: "show only packs matching the current project",
        default: false,
      }),
  async handler(args) {
    await bootstrap(process.cwd(), async () => {
      let packs = await Pack.all()

      if (args.detect) {
        const detected = await Pack.detect()
        const detectedNames = new Set(detected.map((d) => d.pack.name))
        packs = packs.filter((r) => detectedNames.has(r.name))
      }

      // Sort alphabetically
      packs.sort((a, b) => a.name.localeCompare(b.name))

      if (args.json) {
        // altimate_change start — pack: add tier + skill_groups to JSON output
        const enriched = packs.map((pack) => {
          const hasPacks = pack.skill_groups && Object.keys(pack.skill_groups).length > 0
          return {
            name: pack.name,
            tier: pack.tier || "community",
            version: pack.version,
            author: pack.author,
            description: pack.description,
            components: {
              skills: hasPacks
                ? Object.values(pack.skill_groups!).reduce((sum, pack) => sum + (pack.skills?.length || 0), 0)
                : (Array.isArray(pack.skills) ? pack.skills.length : 0),
              skill_groups: hasPacks ? Object.keys(pack.skill_groups!).length : 0,
              mcp: pack.mcp ? Object.keys(pack.mcp).length : 0,
              plugins: Array.isArray(pack.plugins) ? pack.plugins.length : 0,
            },
            location: pack.location,
          }
        })
        // altimate_change end
        process.stdout.write(JSON.stringify(enriched, null, 2) + EOL)
        return
      }

      // Human-readable table output
      if (packs.length === 0) {
        if (args.detect) {
          process.stdout.write("No packs matched detection rules for this project." + EOL)
          process.stdout.write(EOL + `See all packs: altimate-code pack list` + EOL)
        } else {
          process.stdout.write("No packs found." + EOL)
          process.stdout.write(EOL + `Create one with: altimate-code pack create <name>` + EOL)
        }
        return
      }

      // altimate_change start — pack: add tier column to table output
      // Calculate column widths
      const nameWidth = Math.max(6, ...packs.map((r) => r.name.length))
      const tierWidth = 12
      const versionWidth = Math.max(7, ...packs.map((r) => (r.version || "").length))

      const header = `${"PACK".padEnd(nameWidth)}  ${"TIER".padEnd(tierWidth)}  ${"VERSION".padEnd(versionWidth)}  ${"COMPONENTS".padEnd(20)}  DESCRIPTION`
      const separator = "─".repeat(header.length)

      process.stdout.write(EOL)
      process.stdout.write(header + EOL)
      process.stdout.write(separator + EOL)

      for (const pack of packs) {
        // Count skills from skill_groups if present, otherwise flat skills array
        const hasPacks = pack.skill_groups && Object.keys(pack.skill_groups).length > 0
        const skillCount = hasPacks
          ? Object.values(pack.skill_groups!).reduce((sum, pack) => sum + (pack.skills?.length || 0), 0)
          : (Array.isArray(pack.skills) ? pack.skills.length : 0)
        const mcpCount = pack.mcp ? Object.keys(pack.mcp).length : 0
        const pluginCount = Array.isArray(pack.plugins) ? pack.plugins.length : 0
        const packCount = hasPacks ? Object.keys(pack.skill_groups!).length : 0
        const components = hasPacks
          ? `${skillCount}sk ${packCount}pk ${mcpCount}mcp`
          : `${skillCount}sk ${mcpCount}mcp ${pluginCount}pl`

        const tier = pack.tier || "community"
        const tierBadge = tier !== "community" ? `[${tier}]` : ""

        let desc = pack.description || ""
        if (desc.length > 50) {
          desc = desc.slice(0, 50)
          const lastSpace = desc.lastIndexOf(" ")
          if (lastSpace > 30) desc = desc.slice(0, lastSpace)
          desc += "..."
        }

        process.stdout.write(
          `${pack.name.padEnd(nameWidth)}  ${tierBadge.padEnd(tierWidth)}  ${(pack.version || "—").padEnd(versionWidth)}  ${components.padEnd(20)}  ${desc}` + EOL,
        )
      }
      // altimate_change end

      process.stdout.write(EOL)
      process.stdout.write(`${packs.length} pack(s) found.` + EOL)
      process.stdout.write(`Create a new pack: altimate-code pack create <name>` + EOL)
    })
  },
})

const PackCreateCommand = cmd({
  command: "create <name>",
  describe: "scaffold a new pack",
  builder: (yargs) =>
    yargs.positional("name", {
      type: "string",
      describe: "name of the pack to create",
      demandOption: true,
    }),
  async handler(args) {
    const name = args.name as string

    // Validate name before bootstrap (fast fail)
    if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(name) || name.length < 2) {
      process.stderr.write(
        `Error: Pack name must be lowercase alphanumeric with hyphens, at least 2 chars (e.g., "dbt-snowflake")` + EOL,
      )
      process.exit(1)
    }
    if (name.length > 64) {
      process.stderr.write(`Error: Pack name must be 64 characters or fewer` + EOL)
      process.exit(1)
    }

    await bootstrap(process.cwd(), async () => {
      const rootDir = Instance.worktree !== "/" ? Instance.worktree : Instance.directory

      const packDir = path.join(rootDir, ".opencode", "packs", name)
      const packFile = path.join(packDir, "PACK.yaml")

      try {
        await fs.access(packFile)
        process.stderr.write(`Error: Pack already exists at ${packFile}` + EOL)
        process.exit(1)
      } catch {
        // File doesn't exist, good
      }

      await fs.mkdir(packDir, { recursive: true })
      await fs.writeFile(packFile, packTemplate(name), "utf-8")
      process.stdout.write(`✓ Created pack: ${path.relative(rootDir, packFile)}` + EOL)

      // altimate_change start — telemetry
      try {
        Telemetry.track({
          type: "pack_created",
          timestamp: Date.now(),
          session_id: Telemetry.getContext().sessionId || "",
          pack_name: name,
          source: "cli",
        })
      } catch {}
      // altimate_change end

      process.stdout.write(EOL)
      process.stdout.write(`Next steps:` + EOL)
      process.stdout.write(`  1. Edit .opencode/packs/${name}/PACK.yaml — configure skills, MCP servers, and instructions` + EOL)
      process.stdout.write(`  2. Activate it: altimate-code pack activate ${name}` + EOL)
    })
  },
})

const PackShowCommand = cmd({
  command: "show <name>",
  describe: "display pack details",
  builder: (yargs) =>
    yargs.positional("name", {
      type: "string",
      describe: "name of the pack to show",
      demandOption: true,
    }),
  async handler(args) {
    const name = args.name as string
    await bootstrap(process.cwd(), async () => {
      const pack = await Pack.get(name)
      if (!pack) {
        process.stderr.write(`Error: Pack "${name}" not found.` + EOL)
        process.exit(1)
      }

      const hasPacks = pack.skill_groups && Object.keys(pack.skill_groups).length > 0
      const skillCount = hasPacks
        ? Object.values(pack.skill_groups!).reduce((sum, pack) => sum + (pack.skills?.length || 0), 0)
        : (Array.isArray(pack.skills) ? pack.skills.length : 0)
      const mcpCount = pack.mcp ? Object.keys(pack.mcp).length : 0
      const pluginCount = Array.isArray(pack.plugins) ? pack.plugins.length : 0

      process.stdout.write(EOL)
      process.stdout.write(`  Name:         ${pack.name}` + EOL)
      process.stdout.write(`  Description:  ${pack.description || "—"}` + EOL)
      process.stdout.write(`  Version:      ${pack.version || "—"}` + EOL)
      process.stdout.write(`  Author:       ${pack.author || "—"}` + EOL)
      process.stdout.write(`  Tier:         ${pack.tier || "community"}` + EOL)
      process.stdout.write(`  Location:     ${pack.location}` + EOL)
      process.stdout.write(EOL)

      // Skill groups (if present, takes precedence over flat skills)
      if (hasPacks) {
        const packs = Object.entries(pack.skill_groups!)
        process.stdout.write(`  Skill Groups (${packs.length}):` + EOL)
        for (const [packName, pack] of packs) {
          const badge = pack.activation === "always" ? "●" : pack.activation === "detect" ? "◐" : "○"
          process.stdout.write(`    ${badge} ${packName} (${pack.activation}, ${pack.skills.length} skills)` + EOL)
          if (pack.description) {
            process.stdout.write(`      ${pack.description}` + EOL)
          }
          for (const skill of pack.skills) {
            if (typeof skill === "string") {
              process.stdout.write(`      - ${skill}` + EOL)
            } else {
              const selected = skill.select ? ` [${skill.select.join(", ")}]` : ""
              process.stdout.write(`      - ${skill.source}${selected}` + EOL)
            }
          }
        }
      } else {
        // Flat skills
        process.stdout.write(`  Skills (${skillCount}):` + EOL)
        if (skillCount > 0) {
          for (const skill of pack.skills!) {
            if (typeof skill === "string") {
              process.stdout.write(`    - ${skill}` + EOL)
            } else {
              const selected = skill.select ? ` [${skill.select.join(", ")}]` : ""
              process.stdout.write(`    - ${skill.source}${selected}` + EOL)
            }
          }
        } else {
          process.stdout.write(`    (none)` + EOL)
        }
      }

      // MCP servers
      process.stdout.write(`  MCP Servers (${mcpCount}):` + EOL)
      if (mcpCount > 0) {
        for (const [serverName, serverConfig] of Object.entries(pack.mcp!)) {
          const desc = (serverConfig as Record<string, unknown>).description || ""
          process.stdout.write(`    - ${serverName}${desc ? `: ${desc}` : ""}` + EOL)
        }
      } else {
        process.stdout.write(`    (none)` + EOL)
      }

      // Plugins
      process.stdout.write(`  Plugins (${pluginCount}):` + EOL)
      if (pluginCount > 0) {
        for (const plugin of pack.plugins!) {
          process.stdout.write(`    - ${plugin}` + EOL)
        }
      } else {
        process.stdout.write(`    (none)` + EOL)
      }

      // Detection rules
      const detectCount = Array.isArray(pack.detect) ? pack.detect.length : 0
      if (detectCount > 0) {
        process.stdout.write(EOL)
        process.stdout.write(`  Detection Rules (${detectCount}):` + EOL)
        for (const rule of pack.detect!) {
          const files = Array.isArray(rule.files) ? rule.files.join(", ") : "—"
          process.stdout.write(`    - files: [${files}]` + EOL)
          if (rule.message) {
            process.stdout.write(`      message: ${rule.message}` + EOL)
          }
        }
      }

      // Instructions
      if (pack.instructions) {
        process.stdout.write(EOL + "─".repeat(60) + EOL + EOL)
        process.stdout.write(`Instructions:` + EOL + EOL)
        process.stdout.write(pack.instructions + EOL)
      }
    })
  },
})

const PackInstallCommand = cmd({
  command: "install <source>",
  describe: "install a pack from GitHub or a local path",
  builder: (yargs) =>
    yargs
      .positional("source", {
        type: "string",
        describe: "GitHub repo (owner/repo), URL, or local path",
        demandOption: true,
      })
      .option("global", {
        alias: "g",
        type: "boolean",
        describe: "install globally instead of per-project",
        default: false,
      }),
  async handler(args) {
    const source = (args.source as string).trim().replace(/\.git$/, "")
    const isGlobal = args.global as boolean

    if (!source) {
      process.stderr.write(`Error: Source is required. Use owner/repo, URL, or local path.` + EOL)
      process.exit(1)
    }

    await bootstrap(process.cwd(), async () => {
      const rootDir = Instance.worktree !== "/" ? Instance.worktree : Instance.directory
      const targetDir = isGlobal
        ? path.join(Global.Path.config, "packs")
        : path.join(rootDir, ".opencode", "packs")

      let fetchDir: string
      let cloned = false

      try {
        const result = await cloneSource(source)
        fetchDir = result.dir
        cloned = result.cloned
        if (cloned) {
          process.stdout.write(`Fetching from ${source}...` + EOL)
        }
      } catch (err) {
        process.stderr.write(`Error: ${(err as Error).message}` + EOL)
        process.exit(1)
        return // unreachable but satisfies TS
      }

      // Find all PACK.yaml / PACK.yml / PACK.md files
      const { Glob: BunGlob } = globalThis.Bun
      const patterns = ["**/PACK.yaml", "**/PACK.yml", "**/PACK.md"]
      const matches: string[] = []
      for (const pattern of patterns) {
        const glob = new BunGlob(pattern)
        for await (const match of glob.scan({ cwd: fetchDir, absolute: true })) {
          if (!match.includes("/.git/")) matches.push(match)
        }
      }

      if (matches.length === 0) {
        process.stderr.write(`Error: No PACK.yaml/PACK.yml/PACK.md files found in ${source}` + EOL)
        await cleanupTmp(fetchDir, cloned)
        process.exit(1)
      }

      let installed = 0
      const installedNames: string[] = []

      for (const packFile of matches) {
        const packParent = path.dirname(packFile)

        // Parse the YAML to get the pack name (don't rely on directory name)
        let packName: string
        try {
          const matter = (await import("gray-matter")).default
          const raw = await fs.readFile(packFile, "utf-8")
          const ext = path.extname(packFile).toLowerCase()
          const parsed = ext === ".md" ? matter(raw) : matter("---\n" + raw + "\n---")
          packName = (parsed.data.name as string) || path.basename(packParent)
        } catch {
          packName = path.basename(packParent)
        }

        // Avoid using temp dir names as pack names
        if (packName.startsWith("pack-install-")) {
          process.stdout.write(`  ⚠ Skipping "${packFile}" — could not determine pack name` + EOL)
          continue
        }

        const dest = path.join(targetDir, packName)

        // Check if already installed
        try {
          await fs.access(dest)
          process.stdout.write(`  ⚠ Skipping "${packName}" — already exists` + EOL)
          continue
        } catch {
          // Not installed, proceed
        }

        // Copy only the pack directory (not repo root — skip .git, node_modules, etc.)
        await fs.mkdir(dest, { recursive: true })
        const files = await fs.readdir(packParent)
        for (const file of files) {
          // Skip common non-pack files when copying from repo root
          if ([".git", "node_modules", ".github", "LICENSE", "README.md"].includes(file)) continue
          const src = path.join(packParent, file)
          const dst = path.join(dest, file)
          const stat = await fs.lstat(src)
          if (stat.isSymbolicLink()) continue
          if (stat.isFile()) {
            await fs.copyFile(src, dst)
          } else if (stat.isDirectory()) {
            await fs.cp(src, dst, { recursive: true, dereference: false })
          }
        }
        process.stdout.write(`  ✓ Installed "${packName}" → ${path.relative(rootDir, dest)}` + EOL)
        installedNames.push(packName)
        installed++
      }

      await cleanupTmp(fetchDir, cloned)

      process.stdout.write(EOL)
      if (installed > 0) {
        process.stdout.write(`${installed} pack(s) installed${isGlobal ? " globally" : ""}.` + EOL)
        // altimate_change start — telemetry
        try {
          Telemetry.track({
            type: "pack_installed",
            timestamp: Date.now(),
            session_id: Telemetry.getContext().sessionId || "",
            install_source: source,
            pack_count: installed,
            pack_names: installedNames,
            source: "cli",
          })
        } catch {}
        // altimate_change end
      } else {
        process.stdout.write(`No new packs installed.` + EOL)
      }
    })
  },
})

// altimate_change start — pack: PackApplyCommand removed, functionality merged into PackActivateCommand
// altimate_change end

const PackRemoveCommand = cmd({
  command: "remove <name>",
  describe: "remove an installed pack",
  builder: (yargs) =>
    yargs.positional("name", {
      type: "string",
      describe: "name of the pack to remove",
      demandOption: true,
    }),
  async handler(args) {
    const name = args.name as string
    await bootstrap(process.cwd(), async () => {
      const pack = await Pack.get(name)
      if (!pack) {
        process.stderr.write(`Error: Pack "${name}" not found.` + EOL)
        process.exit(1)
      }

      // Check if pack is tracked by git (part of the repo, not user-installed)
      const packDir = path.dirname(pack.location)
      const gitCheck = Bun.spawnSync(["git", "ls-files", "--error-unmatch", pack.location], {
        cwd: path.dirname(packDir),
        stdout: "pipe",
        stderr: "pipe",
      })
      if (gitCheck.exitCode === 0) {
        process.stderr.write(`Error: Cannot remove "${name}" — it is tracked by git.` + EOL)
        process.stderr.write(`This pack is part of the repository, not user-installed.` + EOL)
        process.exit(1)
      }

      // Safety: only remove if the directory looks like a pack directory
      // (contains the PACK file and is not a top-level scan directory)
      const packBasename = path.basename(packDir)
      if (packBasename === "packs" || packBasename === "pack" || packDir === Instance.directory) {
        // The PACK.yaml is at a scan root — only remove the file, not the directory
        await fs.rm(pack.location, { force: true })
        process.stdout.write(`  ✓ Removed pack file: ${pack.location}` + EOL)
      } else {
        await fs.rm(packDir, { recursive: true, force: true })
        process.stdout.write(`  ✓ Removed pack: ${packDir}` + EOL)
      }

      // Deactivate if active, then invalidate cache
      await Pack.deactivate(name)
      Pack.invalidate()

      // altimate_change start — pack: clean up instruction file on remove
      const rootDir = Instance.worktree !== "/" ? Instance.worktree : Instance.directory
      const instructionsFile = path.join(rootDir, ".opencode", "instructions", `pack-${name}.md`)
      try {
        await fs.access(instructionsFile)
        await fs.rm(instructionsFile, { force: true })
        process.stdout.write(`  ✓ Removed instructions: ${path.relative(rootDir, instructionsFile)}` + EOL)
      } catch {
        // No instructions file, that's fine
      }
      // altimate_change end

      // altimate_change start — telemetry
      try {
        Telemetry.track({
          type: "pack_removed",
          timestamp: Date.now(),
          session_id: Telemetry.getContext().sessionId || "",
          pack_name: name,
          source: "cli",
        })
      } catch {}
      // altimate_change end

      process.stdout.write(EOL + `Pack "${name}" removed.` + EOL)
    })
  },
})

const PackDetectCommand = cmd({
  command: "detect",
  describe: "auto-detect which packs match the current project",
  builder: (yargs) => yargs,
  async handler() {
    await bootstrap(process.cwd(), async () => {
      const detected = await Pack.detect()

      if (detected.length === 0) {
        process.stdout.write("No matching packs detected for this project." + EOL)
        process.stdout.write(EOL + `Browse available packs: altimate-code pack list` + EOL)
        return
      }

      process.stdout.write(EOL)
      process.stdout.write(`Detected ${detected.length} matching pack(s):` + EOL + EOL)

      for (const match of detected) {
        process.stdout.write(`  ${match.pack.name}` + EOL)
        if (match.pack.description) {
          process.stdout.write(`    ${match.pack.description}` + EOL)
        }
        if (match.matched && match.matched.length > 0) {
          process.stdout.write(`    Matched files: ${match.matched.join(", ")}` + EOL)
        }
        // Show the first detection rule that has a message
        const firstRuleWithMessage = match.pack.detect?.find((d) => d.message)
        if (firstRuleWithMessage?.message) {
          process.stdout.write(`    ${firstRuleWithMessage.message}` + EOL)
        }
        process.stdout.write(EOL)
      }

      process.stdout.write(`Activate a pack: altimate-code pack activate <name>` + EOL)
    })
  },
})

// altimate_change start — pack: activate subcommand (merged apply + activate into one command)
const PackActivateCommand = cmd({
  command: "activate <name>",
  describe: "activate a pack — install skills, configure MCP, and enable for this project",
  builder: (yargs) =>
    yargs
      .positional("name", {
        type: "string",
        describe: "name of the pack to activate",
        demandOption: true,
      })
      .option("yes", {
        alias: "y",
        type: "boolean",
        describe: "skip confirmation prompt",
        default: false,
      }),
  async handler(args) {
    const name = args.name as string
    await bootstrap(process.cwd(), async () => {
      const pack = await Pack.get(name)
      if (!pack) {
        process.stderr.write(`Error: Pack "${name}" not found. Install it first with: altimate-code pack install <source>` + EOL)
        process.exit(1)
      }

      const rootDir = Instance.worktree !== "/" ? Instance.worktree : Instance.directory
      const tier = pack.tier || "community"
      const tierBadge = tier !== "community" ? ` [${tier}]` : ""

      // Get all skills — from skill_groups if present, otherwise flat skills
      const allSkills = (pack.skill_groups && Object.keys(pack.skill_groups).length > 0)
        ? Pack.allSkillsFromGroups(pack)
        : (pack.skills || [])
      const skillCount = allSkills.length
      const mcpCount = pack.mcp ? Object.keys(pack.mcp).length : 0
      const pluginCount = Array.isArray(pack.plugins) ? pack.plugins.length : 0
      const hasInstructions = !!pack.instructions && !pack.instructions.startsWith("TODO")

      // --- Preview ---
      process.stdout.write(EOL)
      process.stdout.write(`Pack: ${pack.name}${tierBadge} (v${pack.version || "0.0.0"})` + EOL)
      process.stdout.write(`${pack.description || ""}` + EOL)
      process.stdout.write(EOL + "The following changes will be applied:" + EOL + EOL)

      if (skillCount > 0) {
        process.stdout.write(`  Skills (${skillCount}):` + EOL)
        for (const skill of allSkills) {
          if (typeof skill === "string") {
            process.stdout.write(`    + ${skill} (reference existing)` + EOL)
          } else {
            const selected = skill.select ? skill.select.join(", ") : "all"
            process.stdout.write(`    + ${skill.source} [${selected}]` + EOL)
          }
        }
        process.stdout.write(EOL)
      }

      if (mcpCount > 0) {
        process.stdout.write(`  MCP Servers (${mcpCount}):` + EOL)
        for (const [serverName, serverConfig] of Object.entries(pack.mcp!)) {
          const desc = (serverConfig as Record<string, unknown>).description || ""
          process.stdout.write(`    + ${serverName}${desc ? ` — ${desc}` : ""}` + EOL)
        }
        process.stdout.write(EOL)
      }

      if (hasInstructions) {
        process.stdout.write(`  Instructions:` + EOL)
        process.stdout.write(`    + .opencode/instructions/pack-${name}.md` + EOL)
        process.stdout.write(EOL)
      }

      if (skillCount === 0 && mcpCount === 0 && pluginCount === 0 && !hasInstructions) {
        // Still activate (add to active-packs) even if empty — user explicitly asked
        await Pack.activate(name)
        Pack.invalidate()
        process.stdout.write(`Pack "${name}" activated (no changes to apply — pack is empty).` + EOL)
        return
      }

      // --- Confirmation ---
      if (!args.yes) {
        process.stdout.write(`Activate this pack? [y/N] `)
        const response = await new Promise<string>((resolve) => {
          let data = ""
          const onData = (chunk: Buffer) => {
            data += chunk.toString()
            if (data.includes("\n")) {
              process.stdin.removeListener("data", onData)
              process.stdin.pause()
              resolve(data.trim().toLowerCase())
            }
          }
          const onEnd = () => {
            process.stdin.removeListener("data", onData)
            resolve(data.trim().toLowerCase())
          }
          process.stdin.resume()
          process.stdin.on("data", onData)
          process.stdin.on("end", onEnd)
        })

        if (response !== "y" && response !== "yes") {
          process.stdout.write(`Cancelled.` + EOL)
          return
        }
      }

      process.stdout.write(EOL)

      // altimate_change start — pack: track skill install failures for accurate status message
      let skillFailures = 0
      // altimate_change end

      // --- 1. Install skills ---
      if (skillCount > 0) {
        for (const skill of allSkills) {
          if (typeof skill === "string") {
            const existing = await Skill.get(skill)
            if (!existing) {
              process.stdout.write(`  ⚠ Skill "${skill}" not found — install it separately` + EOL)
            } else {
              process.stdout.write(`  ✓ Skill "${skill}" already available` + EOL)
            }
          } else {
            let fetchDir: string
            let cloned = false
            try {
              const result = await cloneSource(skill.source)
              fetchDir = result.dir
              cloned = result.cloned
            } catch (err) {
              process.stdout.write(`  ✗ Failed to fetch ${skill.source}: ${(err as Error).message}` + EOL)
              skillFailures++
              continue
            }

            const { Glob: BunGlob } = globalThis.Bun
            const glob = new BunGlob("**/SKILL.md")
            const skillMatches: string[] = []
            for await (const match of glob.scan({ cwd: fetchDir, absolute: true })) {
              if (!match.includes("/.git/")) skillMatches.push(match)
            }

            const targetSkillsDir = path.join(rootDir, ".opencode", "skills")

            for (const skillFile of skillMatches) {
              const skillParent = path.dirname(skillFile)
              const skillName = path.basename(skillParent)

              if (skill.select && !skill.select.includes(skillName)) continue

              const dest = path.join(targetSkillsDir, skillName)
              try {
                await fs.access(dest)
                process.stdout.write(`  ⚠ Skill "${skillName}" already exists, skipping` + EOL)
                continue
              } catch { /* good */ }

              await fs.mkdir(dest, { recursive: true })
              const files = await fs.readdir(skillParent)
              for (const file of files) {
                const src = path.join(skillParent, file)
                const dst = path.join(dest, file)
                const stat = await fs.lstat(src)
                if (stat.isSymbolicLink()) continue
                if (stat.isFile()) {
                  await fs.copyFile(src, dst)
                } else if (stat.isDirectory()) {
                  await fs.cp(src, dst, { recursive: true, dereference: false })
                }
              }
              process.stdout.write(`  ✓ Installed skill "${skillName}"` + EOL)
            }

            await cleanupTmp(fetchDir, cloned)
          }
        }
      }

      // --- 2. Configure MCP servers and plugins (JSONC-aware, preserves comments) ---
      if (mcpCount > 0 || pluginCount > 0) {
        const { filePath } = await findConfigFile(rootDir)
        const missingEnvKeys: string[] = []

        if (mcpCount > 0) {
          for (const [serverName, serverDef] of Object.entries(pack.mcp!)) {
            const def = serverDef as Record<string, unknown>
            const packType = (def.type as string) || "stdio"
            let configEntry: Record<string, unknown>

            if (packType === "sse" || packType === "streamable-http" || packType === "remote") {
              configEntry = { type: "remote", url: def.url as string, ...(def.headers ? { headers: def.headers } : {}) }
            } else {
              const command = [...((def.command as string[]) || []), ...((def.args as string[]) || [])]
              configEntry = { type: "local", command, ...(def.env ? { environment: def.env } : {}) }
            }

            // Write each MCP server using JSONC-preserving modify
            await writeConfigField(filePath, ["mcp", serverName], configEntry)
            process.stdout.write(`  ✓ Configured MCP server "${serverName}"` + EOL)

            const envKeys = def.env_keys
            if (Array.isArray(envKeys)) {
              for (const key of envKeys as string[]) {
                if (!process.env[key]) missingEnvKeys.push(key)
              }
            }
          }
        }

        if (pluginCount > 0) {
          // Read current plugins, add new ones, write back
          const { config } = await findConfigFile(rootDir)
          const plugins = (config.plugin ?? []) as string[]
          let changed = false
          for (const plugin of pack.plugins!) {
            if (!plugins.includes(plugin)) {
              plugins.push(plugin)
              changed = true
              process.stdout.write(`  ✓ Added plugin "${plugin}"` + EOL)
            }
          }
          if (changed) {
            await writeConfigField(filePath, ["plugin"], plugins)
          }
        }

        process.stdout.write(`  ✓ Updated config: ${path.relative(rootDir, filePath)}` + EOL)

        if (missingEnvKeys.length > 0) {
          process.stdout.write(EOL)
          process.stdout.write(`  ⚠ Missing environment variables:` + EOL)
          for (const key of missingEnvKeys) {
            process.stdout.write(`    - ${key}` + EOL)
          }
          process.stdout.write(`    Set them in your shell profile or .env file.` + EOL)
        }
      }

      // --- 3. Add instructions ---
      if (hasInstructions) {
        const instructionsDir = path.join(rootDir, ".opencode", "instructions")
        const instructionsFile = path.join(instructionsDir, `pack-${name}.md`)
        await fs.mkdir(instructionsDir, { recursive: true })
        await fs.writeFile(instructionsFile, pack.instructions!, "utf-8")
        process.stdout.write(`  ✓ Created instructions: ${path.relative(rootDir, instructionsFile)}` + EOL)
      }

      // --- 4. Activate (add to active-packs) ---
      await Pack.activate(name)
      Pack.invalidate()

      process.stdout.write(EOL)
      // altimate_change start — pack: report partial failures in activation message
      if (skillFailures > 0) {
        process.stdout.write(`Pack "${name}" activated with ${skillFailures} skill source(s) unavailable.` + EOL)
        process.stdout.write(`Run 'altimate-code pack show ${name}' to see expected skills.` + EOL)
      } else {
        process.stdout.write(`Pack "${name}" activated successfully.` + EOL)
      }
      // altimate_change end

      try {
        Telemetry.track({
          type: "pack_applied",
          timestamp: Date.now(),
          session_id: Telemetry.getContext().sessionId || "",
          pack_name: name,
          skill_count: skillCount,
          mcp_count: mcpCount,
          plugin_count: pluginCount,
          has_instructions: hasInstructions,
          source: "cli",
        })
      } catch {}
    })
  },
})
// altimate_change end

// altimate_change start — pack: deactivate subcommand
const PackDeactivateCommand = cmd({
  command: "deactivate <name>",
  describe: "deactivate a pack for the current project",
  builder: (yargs) =>
    yargs.positional("name", {
      type: "string",
      describe: "name of the pack to deactivate",
      demandOption: true,
    }),
  async handler(args) {
    const name = args.name as string
    await bootstrap(process.cwd(), async () => {
      // Read pack BEFORE deactivating so we know what MCP servers to clean
      const pack = await Pack.get(name)

      await Pack.deactivate(name)
      process.stdout.write(`✓ Deactivated pack: ${name}` + EOL)

      const rootDir = Instance.worktree !== "/" ? Instance.worktree : Instance.directory

      // altimate_change start — pack: clean up instruction file on deactivate
      const instructionsFile = path.join(rootDir, ".opencode", "instructions", `pack-${name}.md`)
      try {
        await fs.access(instructionsFile)
        await fs.rm(instructionsFile, { force: true })
        process.stdout.write(`  ✓ Removed instructions: ${path.relative(rootDir, instructionsFile)}` + EOL)
      } catch {}
      // altimate_change end

      // altimate_change start — pack: clean up MCP config entries added by this pack (JSONC-preserving)
      if (pack?.mcp && Object.keys(pack.mcp).length > 0) {
        try {
          const { filePath } = await findConfigFile(rootDir)
          let removed = 0
          for (const serverName of Object.keys(pack.mcp)) {
            if (await removeConfigField(filePath, ["mcp", serverName])) {
              removed++
            }
          }
          if (removed > 0) {
            process.stdout.write(`  ✓ Removed ${removed} MCP server(s) from config` + EOL)
          }
        } catch {}
      }
      // altimate_change end
    })
  },
})
// altimate_change end

// altimate_change start — pack: search subcommand
const REGISTRY_URL = "https://raw.githubusercontent.com/AltimateAI/data-engineering-skills/main/registry.json"

const PackSearchCommand = cmd({
  command: "search [query]",
  describe: "search the pack registry",
  builder: (yargs) =>
    yargs
      .positional("query", {
        type: "string",
        describe: "search query (matches name, description, tags)",
      })
      .option("json", {
        type: "boolean",
        describe: "output as JSON",
        default: false,
      }),
  async handler(args) {
    const query = ((args.query as string) || "").toLowerCase().trim()

    await bootstrap(process.cwd(), async () => {
      process.stdout.write(`Searching pack registry...` + EOL)

      // altimate_change start — pack: graceful 404 + timeout for registry fetch
      let registry: any
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 5000)
      try {
        const response = await fetch(REGISTRY_URL, { signal: controller.signal })
        clearTimeout(timeout)
        if (!response.ok) {
          if (response.status === 404) {
            process.stdout.write(`Pack registry not available yet.` + EOL)
            process.stdout.write(EOL + `Browse local packs: altimate-code pack list` + EOL)
            process.stdout.write(`Create your own: altimate-code pack create <name>` + EOL)
            return
          }
          process.stderr.write(`Error: Failed to fetch registry (${response.status})` + EOL)
          process.exit(1)
        }
        registry = await response.json()
      } catch (err) {
        clearTimeout(timeout)
        if ((err as Error).name === "AbortError") {
          process.stdout.write(`Pack registry unavailable (timeout).` + EOL)
        } else {
          process.stderr.write(`Error: Failed to fetch registry: ${(err as Error).message}` + EOL)
        }
        process.stdout.write(EOL + `Browse local packs: altimate-code pack list` + EOL)
        process.exit(1)
      }
      // altimate_change end

      const packs = (registry.packs || []) as Array<{
        name: string
        description: string
        version: string
        author: string
        tier: string
        repo: string
        path: string
        tags: string[]
        detect: string[]
        stats?: { installs?: number; last_updated?: string }
      }>

      // Filter by query
      const results = query
        ? packs.filter((r) => {
            const searchable = [r.name, r.description, ...(r.tags || []), r.author || ""].join(" ").toLowerCase()
            return searchable.includes(query)
          })
        : packs

      if (args.json) {
        process.stdout.write(JSON.stringify(results, null, 2) + EOL)
        return
      }

      if (results.length === 0) {
        process.stdout.write(`No packs found${query ? ` matching "${query}"` : ""}.` + EOL)
        return
      }

      // Table output
      const nameWidth = Math.max(6, ...results.map((r) => r.name.length))
      const tierWidth = 10

      const header = `${"PACK".padEnd(nameWidth)}  ${"TIER".padEnd(tierWidth)}  DESCRIPTION`
      const separator = "─".repeat(header.length)

      process.stdout.write(EOL)
      process.stdout.write(header + EOL)
      process.stdout.write(separator + EOL)

      for (const pack of results) {
        let desc = pack.description || ""
        if (desc.length > 50) {
          desc = desc.slice(0, 50)
          const lastSpace = desc.lastIndexOf(" ")
          if (lastSpace > 30) desc = desc.slice(0, lastSpace)
          desc += "..."
        }

        const tier = pack.tier || "community"
        process.stdout.write(`${pack.name.padEnd(nameWidth)}  ${tier.padEnd(tierWidth)}  ${desc}` + EOL)
      }

      process.stdout.write(EOL)
      process.stdout.write(`${results.length} pack(s) found in registry.` + EOL)
      process.stdout.write(`Install with: altimate-code pack install <repo>` + EOL)
    })
  },
})
// altimate_change end

// altimate_change start — pack: status subcommand
const PackStatusCommand = cmd({
  command: "status",
  describe: "show active packs for the current project",
  builder: (yargs) => yargs,
  async handler() {
    await bootstrap(process.cwd(), async () => {
      const activePacks = await Pack.active()

      if (activePacks.length === 0) {
        process.stdout.write("No active packs for this project." + EOL)
        process.stdout.write(EOL + `Activate one: altimate-code pack activate <name>` + EOL)
        process.stdout.write(`Auto-detect: altimate-code pack detect` + EOL)
        return
      }

      process.stdout.write(EOL)
      process.stdout.write(`Active packs (${activePacks.length}):` + EOL + EOL)

      for (const pack of activePacks) {
        const tier = pack.tier || "community"
        const tierBadge = tier !== "community" ? ` [${tier}]` : ""
        process.stdout.write(`  ${pack.name}${tierBadge}` + EOL)
        if (pack.description) {
          process.stdout.write(`    ${pack.description}` + EOL)
        }

        // Show skill groups if any
        if (pack.skill_groups && Object.keys(pack.skill_groups).length > 0) {
          for (const [groupName, group] of Object.entries(pack.skill_groups)) {
            const badge = group.activation === "always" ? "●" : group.activation === "detect" ? "◐" : "○"
            process.stdout.write(`    ${badge} ${groupName} (${group.activation}, ${group.skills.length} skills)` + EOL)
          }
        }

        process.stdout.write(EOL)
      }
    })
  },
})
// altimate_change end

// altimate_change start — pack: validate subcommand
const PackValidateCommand = cmd({
  command: "validate [name]",
  describe: "validate a pack's YAML format and references",
  builder: (yargs) =>
    yargs.positional("name", {
      type: "string",
      describe: "name of the pack to validate (defaults to all)",
    }),
  async handler(args) {
    const targetName = args.name as string | undefined
    await bootstrap(process.cwd(), async () => {
      const packs = targetName ? [await Pack.get(targetName)].filter(Boolean) : await Pack.all()

      if (packs.length === 0) {
        if (targetName) {
          process.stderr.write(`Error: Pack "${targetName}" not found.` + EOL)
          process.exit(1)
        }
        process.stdout.write("No packs to validate." + EOL)
        return
      }

      let hasErrors = false
      const pass = (msg: string) => process.stdout.write(`  ✓ ${msg}` + EOL)
      const fail = (msg: string) => { process.stdout.write(`  ✗ ${msg}` + EOL); hasErrors = true }
      const warn = (msg: string) => process.stdout.write(`  ⚠ ${msg}` + EOL)

      for (const pack of packs as Pack.Info[]) {
        process.stdout.write(EOL + `Validating: ${pack.name}` + EOL + EOL)

        // 1. Name format
        if (/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(pack.name)) {
          pass(`Name "${pack.name}" is valid`)
        } else {
          fail(`Name "${pack.name}" has invalid format (must be lowercase, hyphens, 2+ chars)`)
        }

        // 2. Description
        if (pack.description && !pack.description.startsWith("TODO")) {
          pass(`Description present`)
        } else {
          warn(`Description is missing or starts with TODO`)
        }

        // 3. Version
        if (pack.version && /^\d+\.\d+\.\d+/.test(pack.version)) {
          pass(`Version "${pack.version}" is valid semver`)
        } else {
          warn(`Version "${pack.version || "(none)"}" may not be valid semver`)
        }

        // 4. Skills references
        const allSkills = (pack.skill_groups && Object.keys(pack.skill_groups).length > 0)
          ? Pack.allSkillsFromGroups(pack)
          : (pack.skills || [])
        if (allSkills.length > 0) {
          pass(`${allSkills.length} skill source(s) defined`)
          for (const skill of allSkills) {
            if (typeof skill === "string") {
              pass(`  Skill reference: "${skill}"`)
            } else {
              if (!skill.source) {
                fail(`  Skill source is empty`)
              } else {
                pass(`  Skill source: "${skill.source}"${skill.select ? ` [${skill.select.join(", ")}]` : ""}`)
              }
            }
          }
        } else {
          warn(`No skills defined`)
        }

        // 5. MCP servers
        if (pack.mcp && Object.keys(pack.mcp).length > 0) {
          for (const [name, config] of Object.entries(pack.mcp)) {
            const cfg = config as Record<string, unknown>
            const type = (cfg.type as string) || "stdio"
            if (type === "stdio" || type === "local") {
              if (cfg.command && Array.isArray(cfg.command) && (cfg.command as string[]).length > 0) {
                pass(`MCP "${name}": command defined`)
              } else {
                fail(`MCP "${name}": missing command for stdio server`)
              }
            } else if (type === "sse" || type === "streamable-http" || type === "remote") {
              if (cfg.url) {
                pass(`MCP "${name}": URL defined`)
              } else {
                fail(`MCP "${name}": missing url for remote server`)
              }
            }

            // Check env_keys
            if (Array.isArray(cfg.env_keys)) {
              for (const key of cfg.env_keys as string[]) {
                if (process.env[key]) {
                  pass(`MCP "${name}": env var ${key} is set`)
                } else {
                  warn(`MCP "${name}": env var ${key} is NOT set`)
                }
              }
            }
          }
        }

        // 6. Detection rules
        if (pack.detect && pack.detect.length > 0) {
          pass(`${pack.detect.length} detection rule(s) defined`)
        } else {
          warn(`No detection rules — pack won't appear in 'pack detect'`)
        }

        // 7. Instructions
        if (pack.instructions && !pack.instructions.startsWith("TODO")) {
          pass(`Instructions present (${pack.instructions.split("\n").length} lines)`)
        } else {
          warn(`Instructions missing or placeholder`)
        }
      }

      process.stdout.write(EOL)
      if (hasErrors) {
        process.stdout.write(`Validation: FAIL — fix the issues above` + EOL)
        process.exitCode = 1
      } else {
        process.stdout.write(`Validation: PASS` + EOL)
      }
    })
  },
})
// altimate_change end

// ---------------------------------------------------------------------------
// Top-level pack command
// ---------------------------------------------------------------------------

export const PackCommand = cmd({
  command: "pack",
  describe: "manage packs — bundles of skills, MCP servers, and plugins",
  builder: (yargs) =>
    yargs
      .command(PackListCommand)
      .command(PackCreateCommand)
      .command(PackShowCommand)
      .command(PackInstallCommand)
      .command(PackRemoveCommand)
      .command(PackDetectCommand)
      // altimate_change start — pack: register new subcommands
      .command(PackActivateCommand)
      .command(PackDeactivateCommand)
      .command(PackSearchCommand)
      .command(PackStatusCommand)
      .command(PackValidateCommand)
      // altimate_change end
      .demandCommand(),
  async handler() {},
})
// altimate_change end
