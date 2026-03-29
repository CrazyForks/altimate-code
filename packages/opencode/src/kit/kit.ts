// altimate_change start — kit: core kit module for bundling skills + MCP + plugins + instructions
import z from "zod"
import path from "path"
import { mkdir, writeFile, unlink } from "fs/promises"
import matter from "gray-matter"
import { Config } from "../config/config"
import { Instance } from "../project/instance"
import { State } from "../project/state"
import { Log } from "../util/log"
import { Global } from "@/global"
import { Filesystem } from "@/util/filesystem"
import { Glob } from "../util/glob"

export namespace Kit {
  const log = Log.create({ service: "kit" })

  // Kit YAML schema - this is what goes in KIT.yaml frontmatter or body
  export const McpConfig = z.object({
    // Kit uses user-friendly names: "stdio" → mapped to "local", "sse"/"streamable-http" → mapped to "remote"
    type: z.enum(["stdio", "sse", "streamable-http", "local", "remote"]).default("stdio"),
    command: z.array(z.string()).optional(),
    args: z.array(z.string()).optional(),
    url: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
    env_keys: z
      .array(z.string())
      .optional()
      .describe("Env var names that must be set by the user"),
    description: z.string().optional(),
  })

  // altimate_change start — kit: trust tier enum for kit provenance
  export const Tier = z
    .string()
    .transform((v) => v?.toLowerCase())
    .pipe(z.enum(["built-in", "verified", "community", "archived"]))
    .default("community")
  export type Tier = z.infer<typeof Tier>
  // altimate_change end

  // altimate_change start — kit: skill pack schema for grouped skill activation
  export const SkillPack = z.object({
    description: z.string().optional(),
    skills: z
      .array(
        z.union([
          z.string(),
          z.object({
            source: z.string(),
            select: z.array(z.string()).optional(),
          }),
        ]),
      )
      .default([]),
    activation: z.enum(["always", "detect", "manual", "deferred"]).default("always"),
    detect: z
      .array(
        z.object({
          files: z.array(z.string()),
        }),
      )
      .nullable()
      .optional()
      .transform((v) => v ?? [])
      .default([]),
  })
  export type SkillPack = z.infer<typeof SkillPack>
  // altimate_change end

  export const Info = z.object({
    name: z.string(),
    description: z.string(),
    version: z.string().optional().default("1.0.0"),
    author: z.string().optional(),
    location: z.string(), // filesystem path where the kit was loaded from

    // altimate_change start — kit: trust tier field
    // Trust tier
    tier: Tier.nullable().optional().transform((v) => v ?? "community").default("community"),
    // altimate_change end

    // altimate_change start — kit: skill packs with activation modes
    // Skill packs — organized groups of skills with activation modes
    // When present, takes precedence over flat `skills` array
    skill_packs: z
      .record(z.string(), SkillPack)
      .nullable()
      .optional()
      .transform((v) => v ?? {})
      .default({}),
    // altimate_change end

    // What the kit bundles
    // Note: YAML parses `key: []` with trailing comments as null, so we accept nullable
    skills: z
      .array(
        z.union([
          z.string(), // skill name (already installed)
          z.object({
            source: z
              .string()
              .describe("GitHub repo (owner/repo) or URL to fetch skills from"),
            select: z
              .array(z.string())
              .optional()
              .describe("Specific skill names to install from source"),
          }),
        ]),
      )
      .nullable()
      .optional()
      .transform((v) => v ?? [])
      .default([]),

    mcp: z
      .record(z.string(), McpConfig)
      .nullable()
      .optional()
      .transform((v) => v ?? {})
      .default({}),

    plugins: z
      .array(z.string())
      .nullable()
      .optional()
      .transform((v) => v ?? [])
      .default([])
      .describe("npm package specs, e.g. @dagster/altimate-plugin@^1.0"),

    instructions: z
      .string()
      .nullable()
      .optional()
      .transform((v) => v ?? undefined)
      .describe("Additional system instructions added to every conversation"),

    // Auto-detection: when to suggest this kit
    detect: z
      .array(
        z.object({
          files: z
            .array(z.string())
            .describe("Glob patterns that indicate this kit is relevant"),
          message: z
            .string()
            .optional()
            .describe("Custom suggestion message"),
        }),
      )
      .nullable()
      .optional()
      .transform((v) => v ?? [])
      .default([]),

    // The full markdown content (instructions, docs, etc.)
    content: z.string().nullable().optional().transform((v) => v ?? "").default(""),
  })
  export type Info = z.infer<typeof Info>

  // --- State management (mirrors Skill.state pattern) ---

  const KIT_FILE_PATTERN = "KIT.{yaml,yml,md}"

  const stateInit: () => Promise<{
    kits: Record<string, Info>
    dirs: string[]
  }> = async () => {
    const kits: Record<string, Info> = {}
    const dirs = new Set<string>()
    const config = await Config.get()

    // 1. Scan .opencode/kits/ and .altimate-code/kits/ directories
    for (const dir of await Config.directories()) {
      const matches = await Glob.scan(`{kit,kits}/**/${KIT_FILE_PATTERN}`, {
        cwd: dir,
        absolute: true,
        dot: true,
        symlink: true,
      })
      for (const item of matches) {
        const kit = await loadKit(item)
        if (kit) {
          kits[kit.name] = kit
          dirs.add(path.dirname(item))
        }
      }
    }

    // 2. Load from config paths
    if (config.kits?.paths) {
      for (let p of config.kits.paths) {
        if (p.startsWith("~/")) p = path.join(Global.Path.home, p.slice(2))
        if (!path.isAbsolute(p)) p = path.resolve(Instance.directory, p)

        const stat = Filesystem.stat(p)
        if (!stat) continue

        if (stat.isDirectory()) {
          const matches = await Glob.scan(KIT_FILE_PATTERN, {
            cwd: p,
            absolute: true,
            dot: true,
            symlink: true,
          })
          for (const item of matches) {
            const kit = await loadKit(item)
            if (kit) {
              kits[kit.name] = kit
              dirs.add(p)
            }
          }
        } else {
          const kit = await loadKit(p)
          if (kit) {
            kits[kit.name] = kit
            dirs.add(path.dirname(p))
          }
        }
      }
    }

    // 3. Load from installed kits directory
    const installedDir = path.join(Global.Path.data, "kits")
    if (await Filesystem.exists(installedDir)) {
      const matches = await Glob.scan(KIT_FILE_PATTERN, {
        cwd: installedDir,
        absolute: true,
        dot: true,
        symlink: true,
      })
      for (const item of matches) {
        const kit = await loadKit(item)
        if (kit) {
          kits[kit.name] = kit
          dirs.add(installedDir)
        }
      }
    }

    return { kits, dirs: Array.from(dirs) }
  }

  export const state = Instance.state(stateInit)

  export function invalidate() {
    State.invalidate(Instance.directory, stateInit)
  }

  // --- Loading ---

  async function loadKit(filePath: string): Promise<Info | undefined> {
    try {
      const raw = await Filesystem.readText(filePath)
      if (!raw) return undefined

      const ext = path.extname(filePath).toLowerCase()
      let data: Record<string, any> = {}
      let content = ""

      if (ext === ".md") {
        // Markdown with YAML frontmatter
        const parsed = matter(raw)
        data = parsed.data
        content = parsed.content.trim()
      } else {
        // YAML file - parse the whole thing via gray-matter
        const parsed = matter("---\n" + raw + "\n---")
        data = parsed.data
        content = (data.content as string) || ""
        delete data.content
      }

      const result = Info.safeParse({
        ...data,
        location: filePath,
        content,
      })

      if (!result.success) {
        log.warn("invalid kit", {
          path: filePath,
          issues: result.error.issues,
        })
        return undefined
      }

      // Validate name to prevent path traversal
      if (result.data.name && !/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(result.data.name)) {
        log.warn("invalid kit name", { path: filePath, name: result.data.name })
        return undefined
      }

      return result.data
    } catch (err) {
      log.error("failed to load kit", { path: filePath, err })
      return undefined
    }
  }

  // --- Public API ---

  export async function get(name: string): Promise<Info | undefined> {
    return state().then((s) => s.kits[name])
  }

  export async function all(): Promise<Info[]> {
    return state().then((s) => Object.values(s.kits))
  }

  export async function dirs(): Promise<string[]> {
    return state().then((s) => s.dirs)
  }

  // --- Detection ---

  /** Check which installed kits match the current project */
  export async function detect(): Promise<
    Array<{ kit: Info; matched: string[] }>
  > {
    const kits = await all()
    const results: Array<{ kit: Info; matched: string[] }> = []

    for (const kit of kits) {
      if (!kit.detect || kit.detect.length === 0) continue

      const matchedFiles: string[] = []
      for (const rule of kit.detect) {
        for (const pattern of rule.files) {
          const matches = await Glob.scan(pattern, {
            cwd: Instance.directory,
            absolute: false,
            dot: true,
            symlink: true,
          })
          if (matches.length > 0) {
            matchedFiles.push(...matches.slice(0, 3)) // limit to 3 examples
          }
        }
      }

      if (matchedFiles.length > 0) {
        results.push({ kit, matched: [...new Set(matchedFiles)] })
      }
    }

    return results
  }

  // altimate_change start — kit: active kit management and context scoping
  /** Get active kits for the current project (reads .opencode/active-kits) */
  export async function active(): Promise<Info[]> {
    const activeFile = await findActiveKitsFile()
    if (!activeFile) return []

    try {
      const raw = await Filesystem.readText(activeFile)
      if (!raw) return []
      const names = raw.split("\n").map((l) => l.trim()).filter(Boolean)
      const all = await state().then((s) => s.kits)
      return names.map((n) => all[n]).filter((r): r is Info => !!r)
    } catch {
      return []
    }
  }

  /** Activate a kit for the current project */
  export async function activate(name: string): Promise<void> {
    const rootDir = Instance.worktree !== "/" ? Instance.worktree : Instance.directory
    const activeFile = path.join(rootDir, ".opencode", "active-kits")

    let names: string[] = []
    try {
      const raw = await Filesystem.readText(activeFile)
      if (raw) names = raw.split("\n").map((l) => l.trim()).filter(Boolean)
    } catch {}

    if (!names.includes(name)) {
      names.push(name)
    }

    await mkdir(path.dirname(activeFile), { recursive: true })
    await writeFile(activeFile, names.join("\n") + "\n", "utf-8")
  }

  /** Deactivate a kit for the current project */
  export async function deactivate(name: string): Promise<void> {
    const rootDir = Instance.worktree !== "/" ? Instance.worktree : Instance.directory
    const activeFile = path.join(rootDir, ".opencode", "active-kits")

    let names: string[] = []
    try {
      const raw = await Filesystem.readText(activeFile)
      if (raw) names = raw.split("\n").map((l) => l.trim()).filter(Boolean)
    } catch { return }

    names = names.filter((n) => n !== name)

    if (names.length === 0) {
      try { await unlink(activeFile) } catch {}
    } else {
      await writeFile(activeFile, names.join("\n") + "\n", "utf-8")
    }
  }

  async function findActiveKitsFile(): Promise<string | undefined> {
    const rootDir = Instance.worktree !== "/" ? Instance.worktree : Instance.directory
    const candidates = [
      path.join(rootDir, ".opencode", "active-kits"),
      path.join(rootDir, ".altimate-code", "active-kits"),
    ]
    for (const f of candidates) {
      if (await Filesystem.exists(f)) return f
    }
    return undefined
  }

  /** Get all skills referenced by a kit's skill_packs */
  export function allSkillsFromPacks(kit: Info): Array<string | { source: string; select?: string[] }> {
    if (!kit.skill_packs || Object.keys(kit.skill_packs).length === 0) {
      return kit.skills
    }
    const result: Array<string | { source: string; select?: string[] }> = []
    for (const [, pack] of Object.entries(kit.skill_packs)) {
      result.push(...pack.skills)
    }
    return result
  }
  // altimate_change end
}
// altimate_change end
