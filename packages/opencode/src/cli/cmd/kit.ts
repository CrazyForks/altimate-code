// altimate_change start — kit: top-level `kit` command for managing kit bundles
import { EOL } from "os"
import path from "path"
import fs from "fs/promises"
import { Kit } from "../../kit"
import { Skill } from "../../skill"
import { bootstrap } from "../bootstrap"
import { cmd } from "./cmd"
import { Instance } from "../../project/instance"
import { Global } from "@/global"
import { Telemetry } from "@/altimate/telemetry"
// altimate_change start — kit: jsonc-parser for comment-preserving config writes
import { modify, applyEdits } from "jsonc-parser"
// altimate_change end

// ---------------------------------------------------------------------------
// KIT.yaml template
// ---------------------------------------------------------------------------

function kitTemplate(name: string): string {
  return `name: ${name}
description: TODO — describe what this kit configures
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
  #   message: "Detected my-tool — activate kit?"

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

// altimate_change start — kit: JSONC-aware config writes that preserve comments
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
    // Check if it's a local path first (e.g., "examples/kits" looks like "owner/repo")
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
    const tmpDir = path.join(Global.Path.cache, "kit-install-" + Date.now())
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

const KitListCommand = cmd({
  command: "list",
  describe: "list all available kits",
  builder: (yargs) =>
    yargs
      .option("json", {
        type: "boolean",
        describe: "output as JSON",
        default: false,
      })
      .option("detect", {
        type: "boolean",
        describe: "show only kits matching the current project",
        default: false,
      }),
  async handler(args) {
    await bootstrap(process.cwd(), async () => {
      let kits = await Kit.all()

      if (args.detect) {
        const detected = await Kit.detect()
        const detectedNames = new Set(detected.map((d) => d.kit.name))
        kits = kits.filter((r) => detectedNames.has(r.name))
      }

      // Sort alphabetically
      kits.sort((a, b) => a.name.localeCompare(b.name))

      if (args.json) {
        // altimate_change start — kit: add tier + skill_packs to JSON output
        const enriched = kits.map((kit) => {
          const hasPacks = kit.skill_packs && Object.keys(kit.skill_packs).length > 0
          return {
            name: kit.name,
            tier: kit.tier || "community",
            version: kit.version,
            author: kit.author,
            description: kit.description,
            components: {
              skills: hasPacks
                ? Object.values(kit.skill_packs!).reduce((sum, pack) => sum + (pack.skills?.length || 0), 0)
                : (Array.isArray(kit.skills) ? kit.skills.length : 0),
              skill_packs: hasPacks ? Object.keys(kit.skill_packs!).length : 0,
              mcp: kit.mcp ? Object.keys(kit.mcp).length : 0,
              plugins: Array.isArray(kit.plugins) ? kit.plugins.length : 0,
            },
            location: kit.location,
          }
        })
        // altimate_change end
        process.stdout.write(JSON.stringify(enriched, null, 2) + EOL)
        return
      }

      // Human-readable table output
      if (kits.length === 0) {
        if (args.detect) {
          process.stdout.write("No kits matched detection rules for this project." + EOL)
          process.stdout.write(EOL + `See all kits: altimate-code kit list` + EOL)
        } else {
          process.stdout.write("No kits found." + EOL)
          process.stdout.write(EOL + `Create one with: altimate-code kit create <name>` + EOL)
        }
        return
      }

      // altimate_change start — kit: add tier column to table output
      // Calculate column widths
      const nameWidth = Math.max(6, ...kits.map((r) => r.name.length))
      const tierWidth = 12
      const versionWidth = Math.max(7, ...kits.map((r) => (r.version || "").length))

      const header = `${"KIT".padEnd(nameWidth)}  ${"TIER".padEnd(tierWidth)}  ${"VERSION".padEnd(versionWidth)}  ${"COMPONENTS".padEnd(20)}  DESCRIPTION`
      const separator = "─".repeat(header.length)

      process.stdout.write(EOL)
      process.stdout.write(header + EOL)
      process.stdout.write(separator + EOL)

      for (const kit of kits) {
        // Count skills from skill_packs if present, otherwise flat skills array
        const hasPacks = kit.skill_packs && Object.keys(kit.skill_packs).length > 0
        const skillCount = hasPacks
          ? Object.values(kit.skill_packs!).reduce((sum, pack) => sum + (pack.skills?.length || 0), 0)
          : (Array.isArray(kit.skills) ? kit.skills.length : 0)
        const mcpCount = kit.mcp ? Object.keys(kit.mcp).length : 0
        const pluginCount = Array.isArray(kit.plugins) ? kit.plugins.length : 0
        const packCount = hasPacks ? Object.keys(kit.skill_packs!).length : 0
        const components = hasPacks
          ? `${skillCount}sk ${packCount}pk ${mcpCount}mcp`
          : `${skillCount}sk ${mcpCount}mcp ${pluginCount}pl`

        const tier = kit.tier || "community"
        const tierBadge = tier !== "community" ? `[${tier}]` : ""

        let desc = kit.description || ""
        if (desc.length > 50) {
          desc = desc.slice(0, 50)
          const lastSpace = desc.lastIndexOf(" ")
          if (lastSpace > 30) desc = desc.slice(0, lastSpace)
          desc += "..."
        }

        process.stdout.write(
          `${kit.name.padEnd(nameWidth)}  ${tierBadge.padEnd(tierWidth)}  ${(kit.version || "—").padEnd(versionWidth)}  ${components.padEnd(20)}  ${desc}` + EOL,
        )
      }
      // altimate_change end

      process.stdout.write(EOL)
      process.stdout.write(`${kits.length} kit(s) found.` + EOL)
      process.stdout.write(`Create a new kit: altimate-code kit create <name>` + EOL)
    })
  },
})

const KitCreateCommand = cmd({
  command: "create <name>",
  describe: "scaffold a new kit",
  builder: (yargs) =>
    yargs.positional("name", {
      type: "string",
      describe: "name of the kit to create",
      demandOption: true,
    }),
  async handler(args) {
    const name = args.name as string

    // Validate name before bootstrap (fast fail)
    if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(name) || name.length < 2) {
      process.stderr.write(
        `Error: Kit name must be lowercase alphanumeric with hyphens, at least 2 chars (e.g., "dbt-snowflake")` + EOL,
      )
      process.exit(1)
    }
    if (name.length > 64) {
      process.stderr.write(`Error: Kit name must be 64 characters or fewer` + EOL)
      process.exit(1)
    }

    await bootstrap(process.cwd(), async () => {
      const rootDir = Instance.worktree !== "/" ? Instance.worktree : Instance.directory

      const kitDir = path.join(rootDir, ".opencode", "kits", name)
      const kitFile = path.join(kitDir, "KIT.yaml")

      try {
        await fs.access(kitFile)
        process.stderr.write(`Error: Kit already exists at ${kitFile}` + EOL)
        process.exit(1)
      } catch {
        // File doesn't exist, good
      }

      await fs.mkdir(kitDir, { recursive: true })
      await fs.writeFile(kitFile, kitTemplate(name), "utf-8")
      process.stdout.write(`✓ Created kit: ${path.relative(rootDir, kitFile)}` + EOL)

      // altimate_change start — telemetry
      try {
        Telemetry.track({
          type: "kit_created",
          timestamp: Date.now(),
          session_id: Telemetry.getContext().sessionId || "",
          kit_name: name,
          source: "cli",
        })
      } catch {}
      // altimate_change end

      process.stdout.write(EOL)
      process.stdout.write(`Next steps:` + EOL)
      process.stdout.write(`  1. Edit .opencode/kits/${name}/KIT.yaml — configure skills, MCP servers, and instructions` + EOL)
      process.stdout.write(`  2. Activate it: altimate-code kit activate ${name}` + EOL)
    })
  },
})

const KitShowCommand = cmd({
  command: "show <name>",
  describe: "display kit details",
  builder: (yargs) =>
    yargs.positional("name", {
      type: "string",
      describe: "name of the kit to show",
      demandOption: true,
    }),
  async handler(args) {
    const name = args.name as string
    await bootstrap(process.cwd(), async () => {
      const kit = await Kit.get(name)
      if (!kit) {
        process.stderr.write(`Error: Kit "${name}" not found.` + EOL)
        process.exit(1)
      }

      const hasPacks = kit.skill_packs && Object.keys(kit.skill_packs).length > 0
      const skillCount = hasPacks
        ? Object.values(kit.skill_packs!).reduce((sum, pack) => sum + (pack.skills?.length || 0), 0)
        : (Array.isArray(kit.skills) ? kit.skills.length : 0)
      const mcpCount = kit.mcp ? Object.keys(kit.mcp).length : 0
      const pluginCount = Array.isArray(kit.plugins) ? kit.plugins.length : 0

      process.stdout.write(EOL)
      process.stdout.write(`  Name:         ${kit.name}` + EOL)
      process.stdout.write(`  Description:  ${kit.description || "—"}` + EOL)
      process.stdout.write(`  Version:      ${kit.version || "—"}` + EOL)
      process.stdout.write(`  Author:       ${kit.author || "—"}` + EOL)
      process.stdout.write(`  Tier:         ${kit.tier || "community"}` + EOL)
      process.stdout.write(`  Location:     ${kit.location}` + EOL)
      process.stdout.write(EOL)

      // Skill packs (if present, takes precedence over flat skills)
      if (hasPacks) {
        const packs = Object.entries(kit.skill_packs!)
        process.stdout.write(`  Skill Packs (${packs.length}):` + EOL)
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
          for (const skill of kit.skills!) {
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
        for (const [serverName, serverConfig] of Object.entries(kit.mcp!)) {
          const desc = (serverConfig as Record<string, unknown>).description || ""
          process.stdout.write(`    - ${serverName}${desc ? `: ${desc}` : ""}` + EOL)
        }
      } else {
        process.stdout.write(`    (none)` + EOL)
      }

      // Plugins
      process.stdout.write(`  Plugins (${pluginCount}):` + EOL)
      if (pluginCount > 0) {
        for (const plugin of kit.plugins!) {
          process.stdout.write(`    - ${plugin}` + EOL)
        }
      } else {
        process.stdout.write(`    (none)` + EOL)
      }

      // Detection rules
      const detectCount = Array.isArray(kit.detect) ? kit.detect.length : 0
      if (detectCount > 0) {
        process.stdout.write(EOL)
        process.stdout.write(`  Detection Rules (${detectCount}):` + EOL)
        for (const rule of kit.detect!) {
          const files = Array.isArray(rule.files) ? rule.files.join(", ") : "—"
          process.stdout.write(`    - files: [${files}]` + EOL)
          if (rule.message) {
            process.stdout.write(`      message: ${rule.message}` + EOL)
          }
        }
      }

      // Instructions
      if (kit.instructions) {
        process.stdout.write(EOL + "─".repeat(60) + EOL + EOL)
        process.stdout.write(`Instructions:` + EOL + EOL)
        process.stdout.write(kit.instructions + EOL)
      }
    })
  },
})

const KitInstallCommand = cmd({
  command: "install <source>",
  describe: "install a kit from GitHub or a local path",
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
        ? path.join(Global.Path.config, "kits")
        : path.join(rootDir, ".opencode", "kits")

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

      // Find all KIT.yaml / KIT.yml / KIT.md files
      const { Glob: BunGlob } = globalThis.Bun
      const patterns = ["**/KIT.yaml", "**/KIT.yml", "**/KIT.md"]
      const matches: string[] = []
      for (const pattern of patterns) {
        const glob = new BunGlob(pattern)
        for await (const match of glob.scan({ cwd: fetchDir, absolute: true })) {
          if (!match.includes("/.git/")) matches.push(match)
        }
      }

      if (matches.length === 0) {
        process.stderr.write(`Error: No KIT.yaml/KIT.yml/KIT.md files found in ${source}` + EOL)
        await cleanupTmp(fetchDir, cloned)
        process.exit(1)
      }

      let installed = 0
      const installedNames: string[] = []

      for (const kitFile of matches) {
        const kitParent = path.dirname(kitFile)

        // Parse the YAML to get the kit name (don't rely on directory name)
        let kitName: string
        try {
          const matter = (await import("gray-matter")).default
          const raw = await fs.readFile(kitFile, "utf-8")
          const ext = path.extname(kitFile).toLowerCase()
          const parsed = ext === ".md" ? matter(raw) : matter("---\n" + raw + "\n---")
          kitName = (parsed.data.name as string) || path.basename(kitParent)
        } catch {
          kitName = path.basename(kitParent)
        }

        // Avoid using temp dir names as kit names
        if (kitName.startsWith("kit-install-")) {
          process.stdout.write(`  ⚠ Skipping "${kitFile}" — could not determine kit name` + EOL)
          continue
        }

        const dest = path.join(targetDir, kitName)

        // Check if already installed
        try {
          await fs.access(dest)
          process.stdout.write(`  ⚠ Skipping "${kitName}" — already exists` + EOL)
          continue
        } catch {
          // Not installed, proceed
        }

        // Copy only the kit directory (not repo root — skip .git, node_modules, etc.)
        await fs.mkdir(dest, { recursive: true })
        const files = await fs.readdir(kitParent)
        for (const file of files) {
          // Skip common non-kit files when copying from repo root
          if ([".git", "node_modules", ".github", "LICENSE", "README.md"].includes(file)) continue
          const src = path.join(kitParent, file)
          const dst = path.join(dest, file)
          const stat = await fs.lstat(src)
          if (stat.isSymbolicLink()) continue
          if (stat.isFile()) {
            await fs.copyFile(src, dst)
          } else if (stat.isDirectory()) {
            await fs.cp(src, dst, { recursive: true, dereference: false })
          }
        }
        process.stdout.write(`  ✓ Installed "${kitName}" → ${path.relative(rootDir, dest)}` + EOL)
        installedNames.push(kitName)
        installed++
      }

      await cleanupTmp(fetchDir, cloned)

      process.stdout.write(EOL)
      if (installed > 0) {
        process.stdout.write(`${installed} kit(s) installed${isGlobal ? " globally" : ""}.` + EOL)
        // altimate_change start — telemetry
        try {
          Telemetry.track({
            type: "kit_installed",
            timestamp: Date.now(),
            session_id: Telemetry.getContext().sessionId || "",
            install_source: source,
            kit_count: installed,
            kit_names: installedNames,
            source: "cli",
          })
        } catch {}
        // altimate_change end
      } else {
        process.stdout.write(`No new kits installed.` + EOL)
      }
    })
  },
})

// altimate_change start — kit: KitApplyCommand removed, functionality merged into KitActivateCommand
// altimate_change end

const KitRemoveCommand = cmd({
  command: "remove <name>",
  describe: "remove an installed kit",
  builder: (yargs) =>
    yargs.positional("name", {
      type: "string",
      describe: "name of the kit to remove",
      demandOption: true,
    }),
  async handler(args) {
    const name = args.name as string
    await bootstrap(process.cwd(), async () => {
      const kit = await Kit.get(name)
      if (!kit) {
        process.stderr.write(`Error: Kit "${name}" not found.` + EOL)
        process.exit(1)
      }

      // Check if kit is tracked by git (part of the repo, not user-installed)
      const kitDir = path.dirname(kit.location)
      const gitCheck = Bun.spawnSync(["git", "ls-files", "--error-unmatch", kit.location], {
        cwd: path.dirname(kitDir),
        stdout: "pipe",
        stderr: "pipe",
      })
      if (gitCheck.exitCode === 0) {
        process.stderr.write(`Error: Cannot remove "${name}" — it is tracked by git.` + EOL)
        process.stderr.write(`This kit is part of the repository, not user-installed.` + EOL)
        process.exit(1)
      }

      // Safety: only remove if the directory looks like a kit directory
      // (contains the KIT file and is not a top-level scan directory)
      const kitBasename = path.basename(kitDir)
      if (kitBasename === "kits" || kitBasename === "kit" || kitDir === Instance.directory) {
        // The KIT.yaml is at a scan root — only remove the file, not the directory
        await fs.rm(kit.location, { force: true })
        process.stdout.write(`  ✓ Removed kit file: ${kit.location}` + EOL)
      } else {
        await fs.rm(kitDir, { recursive: true, force: true })
        process.stdout.write(`  ✓ Removed kit: ${kitDir}` + EOL)
      }

      // Deactivate if active, then invalidate cache
      await Kit.deactivate(name)
      Kit.invalidate()

      // altimate_change start — kit: clean up instruction file on remove
      const rootDir = Instance.worktree !== "/" ? Instance.worktree : Instance.directory
      const instructionsFile = path.join(rootDir, ".opencode", "instructions", `kit-${name}.md`)
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
          type: "kit_removed",
          timestamp: Date.now(),
          session_id: Telemetry.getContext().sessionId || "",
          kit_name: name,
          source: "cli",
        })
      } catch {}
      // altimate_change end

      process.stdout.write(EOL + `Kit "${name}" removed.` + EOL)
    })
  },
})

const KitDetectCommand = cmd({
  command: "detect",
  describe: "auto-detect which kits match the current project",
  builder: (yargs) => yargs,
  async handler() {
    await bootstrap(process.cwd(), async () => {
      const detected = await Kit.detect()

      if (detected.length === 0) {
        process.stdout.write("No matching kits detected for this project." + EOL)
        process.stdout.write(EOL + `Browse available kits: altimate-code kit list` + EOL)
        return
      }

      process.stdout.write(EOL)
      process.stdout.write(`Detected ${detected.length} matching kit(s):` + EOL + EOL)

      for (const match of detected) {
        process.stdout.write(`  ${match.kit.name}` + EOL)
        if (match.kit.description) {
          process.stdout.write(`    ${match.kit.description}` + EOL)
        }
        if (match.matched && match.matched.length > 0) {
          process.stdout.write(`    Matched files: ${match.matched.join(", ")}` + EOL)
        }
        // Show the first detection rule that has a message
        const firstRuleWithMessage = match.kit.detect?.find((d) => d.message)
        if (firstRuleWithMessage?.message) {
          process.stdout.write(`    ${firstRuleWithMessage.message}` + EOL)
        }
        process.stdout.write(EOL)
      }

      process.stdout.write(`Activate a kit: altimate-code kit activate <name>` + EOL)
    })
  },
})

// altimate_change start — kit: activate subcommand (merged apply + activate into one command)
const KitActivateCommand = cmd({
  command: "activate <name>",
  describe: "activate a kit — install skills, configure MCP, and enable for this project",
  builder: (yargs) =>
    yargs
      .positional("name", {
        type: "string",
        describe: "name of the kit to activate",
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
      const kit = await Kit.get(name)
      if (!kit) {
        process.stderr.write(`Error: Kit "${name}" not found. Install it first with: altimate-code kit install <source>` + EOL)
        process.exit(1)
      }

      const rootDir = Instance.worktree !== "/" ? Instance.worktree : Instance.directory
      const tier = kit.tier || "community"
      const tierBadge = tier !== "community" ? ` [${tier}]` : ""

      // Get all skills — from skill_packs if present, otherwise flat skills
      const allSkills = (kit.skill_packs && Object.keys(kit.skill_packs).length > 0)
        ? Kit.allSkillsFromPacks(kit)
        : (kit.skills || [])
      const skillCount = allSkills.length
      const mcpCount = kit.mcp ? Object.keys(kit.mcp).length : 0
      const pluginCount = Array.isArray(kit.plugins) ? kit.plugins.length : 0
      const hasInstructions = !!kit.instructions && !kit.instructions.startsWith("TODO")

      // --- Preview ---
      process.stdout.write(EOL)
      process.stdout.write(`Kit: ${kit.name}${tierBadge} (v${kit.version || "0.0.0"})` + EOL)
      process.stdout.write(`${kit.description || ""}` + EOL)
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
        for (const [serverName, serverConfig] of Object.entries(kit.mcp!)) {
          const desc = (serverConfig as Record<string, unknown>).description || ""
          process.stdout.write(`    + ${serverName}${desc ? ` — ${desc}` : ""}` + EOL)
        }
        process.stdout.write(EOL)
      }

      if (hasInstructions) {
        process.stdout.write(`  Instructions:` + EOL)
        process.stdout.write(`    + .opencode/instructions/kit-${name}.md` + EOL)
        process.stdout.write(EOL)
      }

      if (skillCount === 0 && mcpCount === 0 && pluginCount === 0 && !hasInstructions) {
        // Still activate (add to active-kits) even if empty — user explicitly asked
        await Kit.activate(name)
        Kit.invalidate()
        process.stdout.write(`Kit "${name}" activated (no changes to apply — kit is empty).` + EOL)
        return
      }

      // --- Confirmation ---
      if (!args.yes) {
        process.stdout.write(`Activate this kit? [y/N] `)
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

      // altimate_change start — kit: track skill install failures for accurate status message
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
          for (const [serverName, serverDef] of Object.entries(kit.mcp!)) {
            const def = serverDef as Record<string, unknown>
            const kitType = (def.type as string) || "stdio"
            let configEntry: Record<string, unknown>

            if (kitType === "sse" || kitType === "streamable-http" || kitType === "remote") {
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
          for (const plugin of kit.plugins!) {
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
        const instructionsFile = path.join(instructionsDir, `kit-${name}.md`)
        await fs.mkdir(instructionsDir, { recursive: true })
        await fs.writeFile(instructionsFile, kit.instructions!, "utf-8")
        process.stdout.write(`  ✓ Created instructions: ${path.relative(rootDir, instructionsFile)}` + EOL)
      }

      // --- 4. Activate (add to active-kits) ---
      await Kit.activate(name)
      Kit.invalidate()

      process.stdout.write(EOL)
      // altimate_change start — kit: report partial failures in activation message
      if (skillFailures > 0) {
        process.stdout.write(`Kit "${name}" activated with ${skillFailures} skill source(s) unavailable.` + EOL)
        process.stdout.write(`Run 'altimate-code kit show ${name}' to see expected skills.` + EOL)
      } else {
        process.stdout.write(`Kit "${name}" activated successfully.` + EOL)
      }
      // altimate_change end

      try {
        Telemetry.track({
          type: "kit_applied",
          timestamp: Date.now(),
          session_id: Telemetry.getContext().sessionId || "",
          kit_name: name,
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

// altimate_change start — kit: deactivate subcommand
const KitDeactivateCommand = cmd({
  command: "deactivate <name>",
  describe: "deactivate a kit for the current project",
  builder: (yargs) =>
    yargs.positional("name", {
      type: "string",
      describe: "name of the kit to deactivate",
      demandOption: true,
    }),
  async handler(args) {
    const name = args.name as string
    await bootstrap(process.cwd(), async () => {
      // Read kit BEFORE deactivating so we know what MCP servers to clean
      const kit = await Kit.get(name)

      await Kit.deactivate(name)
      process.stdout.write(`✓ Deactivated kit: ${name}` + EOL)

      const rootDir = Instance.worktree !== "/" ? Instance.worktree : Instance.directory

      // altimate_change start — kit: clean up instruction file on deactivate
      const instructionsFile = path.join(rootDir, ".opencode", "instructions", `kit-${name}.md`)
      try {
        await fs.access(instructionsFile)
        await fs.rm(instructionsFile, { force: true })
        process.stdout.write(`  ✓ Removed instructions: ${path.relative(rootDir, instructionsFile)}` + EOL)
      } catch {}
      // altimate_change end

      // altimate_change start — kit: clean up MCP config entries added by this kit (JSONC-preserving)
      if (kit?.mcp && Object.keys(kit.mcp).length > 0) {
        try {
          const { filePath } = await findConfigFile(rootDir)
          let removed = 0
          for (const serverName of Object.keys(kit.mcp)) {
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

// altimate_change start — kit: search subcommand
const REGISTRY_URL = "https://raw.githubusercontent.com/AltimateAI/data-engineering-skills/main/registry.json"

const KitSearchCommand = cmd({
  command: "search [query]",
  describe: "search the kit registry",
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
      process.stdout.write(`Searching kit registry...` + EOL)

      // altimate_change start — kit: graceful 404 + timeout for registry fetch
      let registry: any
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 5000)
      try {
        const response = await fetch(REGISTRY_URL, { signal: controller.signal })
        clearTimeout(timeout)
        if (!response.ok) {
          if (response.status === 404) {
            process.stdout.write(`Kit registry not available yet.` + EOL)
            process.stdout.write(EOL + `Browse local kits: altimate-code kit list` + EOL)
            process.stdout.write(`Create your own: altimate-code kit create <name>` + EOL)
            return
          }
          process.stderr.write(`Error: Failed to fetch registry (${response.status})` + EOL)
          process.exit(1)
        }
        registry = await response.json()
      } catch (err) {
        clearTimeout(timeout)
        if ((err as Error).name === "AbortError") {
          process.stdout.write(`Kit registry unavailable (timeout).` + EOL)
        } else {
          process.stderr.write(`Error: Failed to fetch registry: ${(err as Error).message}` + EOL)
        }
        process.stdout.write(EOL + `Browse local kits: altimate-code kit list` + EOL)
        process.exit(1)
      }
      // altimate_change end

      const kits = (registry.kits || []) as Array<{
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
        ? kits.filter((r) => {
            const searchable = [r.name, r.description, ...(r.tags || []), r.author || ""].join(" ").toLowerCase()
            return searchable.includes(query)
          })
        : kits

      if (args.json) {
        process.stdout.write(JSON.stringify(results, null, 2) + EOL)
        return
      }

      if (results.length === 0) {
        process.stdout.write(`No kits found${query ? ` matching "${query}"` : ""}.` + EOL)
        return
      }

      // Table output
      const nameWidth = Math.max(6, ...results.map((r) => r.name.length))
      const tierWidth = 10

      const header = `${"KIT".padEnd(nameWidth)}  ${"TIER".padEnd(tierWidth)}  DESCRIPTION`
      const separator = "─".repeat(header.length)

      process.stdout.write(EOL)
      process.stdout.write(header + EOL)
      process.stdout.write(separator + EOL)

      for (const kit of results) {
        let desc = kit.description || ""
        if (desc.length > 50) {
          desc = desc.slice(0, 50)
          const lastSpace = desc.lastIndexOf(" ")
          if (lastSpace > 30) desc = desc.slice(0, lastSpace)
          desc += "..."
        }

        const tier = kit.tier || "community"
        process.stdout.write(`${kit.name.padEnd(nameWidth)}  ${tier.padEnd(tierWidth)}  ${desc}` + EOL)
      }

      process.stdout.write(EOL)
      process.stdout.write(`${results.length} kit(s) found in registry.` + EOL)
      process.stdout.write(`Install with: altimate-code kit install <repo>` + EOL)
    })
  },
})
// altimate_change end

// altimate_change start — kit: status subcommand
const KitStatusCommand = cmd({
  command: "status",
  describe: "show active kits for the current project",
  builder: (yargs) => yargs,
  async handler() {
    await bootstrap(process.cwd(), async () => {
      const activeKits = await Kit.active()

      if (activeKits.length === 0) {
        process.stdout.write("No active kits for this project." + EOL)
        process.stdout.write(EOL + `Activate one: altimate-code kit activate <name>` + EOL)
        process.stdout.write(`Auto-detect: altimate-code kit detect` + EOL)
        return
      }

      process.stdout.write(EOL)
      process.stdout.write(`Active kits (${activeKits.length}):` + EOL + EOL)

      for (const kit of activeKits) {
        const tier = kit.tier || "community"
        const tierBadge = tier !== "community" ? ` [${tier}]` : ""
        process.stdout.write(`  ${kit.name}${tierBadge}` + EOL)
        if (kit.description) {
          process.stdout.write(`    ${kit.description}` + EOL)
        }

        // Show skill packs if any
        if (kit.skill_packs && Object.keys(kit.skill_packs).length > 0) {
          for (const [packName, pack] of Object.entries(kit.skill_packs)) {
            const badge = pack.activation === "always" ? "●" : pack.activation === "detect" ? "◐" : "○"
            process.stdout.write(`    ${badge} ${packName} (${pack.activation}, ${pack.skills.length} skills)` + EOL)
          }
        }

        process.stdout.write(EOL)
      }
    })
  },
})
// altimate_change end

// altimate_change start — kit: validate subcommand
const KitValidateCommand = cmd({
  command: "validate [name]",
  describe: "validate a kit's YAML format and references",
  builder: (yargs) =>
    yargs.positional("name", {
      type: "string",
      describe: "name of the kit to validate (defaults to all)",
    }),
  async handler(args) {
    const targetName = args.name as string | undefined
    await bootstrap(process.cwd(), async () => {
      const kits = targetName ? [await Kit.get(targetName)].filter(Boolean) : await Kit.all()

      if (kits.length === 0) {
        if (targetName) {
          process.stderr.write(`Error: Kit "${targetName}" not found.` + EOL)
          process.exit(1)
        }
        process.stdout.write("No kits to validate." + EOL)
        return
      }

      let hasErrors = false
      const pass = (msg: string) => process.stdout.write(`  ✓ ${msg}` + EOL)
      const fail = (msg: string) => { process.stdout.write(`  ✗ ${msg}` + EOL); hasErrors = true }
      const warn = (msg: string) => process.stdout.write(`  ⚠ ${msg}` + EOL)

      for (const kit of kits as Kit.Info[]) {
        process.stdout.write(EOL + `Validating: ${kit.name}` + EOL + EOL)

        // 1. Name format
        if (/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(kit.name)) {
          pass(`Name "${kit.name}" is valid`)
        } else {
          fail(`Name "${kit.name}" has invalid format (must be lowercase, hyphens, 2+ chars)`)
        }

        // 2. Description
        if (kit.description && !kit.description.startsWith("TODO")) {
          pass(`Description present`)
        } else {
          warn(`Description is missing or starts with TODO`)
        }

        // 3. Version
        if (kit.version && /^\d+\.\d+\.\d+/.test(kit.version)) {
          pass(`Version "${kit.version}" is valid semver`)
        } else {
          warn(`Version "${kit.version || "(none)"}" may not be valid semver`)
        }

        // 4. Skills references
        const allSkills = (kit.skill_packs && Object.keys(kit.skill_packs).length > 0)
          ? Kit.allSkillsFromPacks(kit)
          : (kit.skills || [])
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
        if (kit.mcp && Object.keys(kit.mcp).length > 0) {
          for (const [name, config] of Object.entries(kit.mcp)) {
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
        if (kit.detect && kit.detect.length > 0) {
          pass(`${kit.detect.length} detection rule(s) defined`)
        } else {
          warn(`No detection rules — kit won't appear in 'kit detect'`)
        }

        // 7. Instructions
        if (kit.instructions && !kit.instructions.startsWith("TODO")) {
          pass(`Instructions present (${kit.instructions.split("\n").length} lines)`)
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
// Top-level kit command
// ---------------------------------------------------------------------------

export const KitCommand = cmd({
  command: "kit",
  describe: "manage kits — bundles of skills, MCP servers, and plugins",
  builder: (yargs) =>
    yargs
      .command(KitListCommand)
      .command(KitCreateCommand)
      .command(KitShowCommand)
      .command(KitInstallCommand)
      .command(KitRemoveCommand)
      .command(KitDetectCommand)
      // altimate_change start — kit: register new subcommands
      .command(KitActivateCommand)
      .command(KitDeactivateCommand)
      .command(KitSearchCommand)
      .command(KitStatusCommand)
      .command(KitValidateCommand)
      // altimate_change end
      .demandCommand(),
  async handler() {},
})
// altimate_change end
