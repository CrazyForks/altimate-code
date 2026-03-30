// altimate_change start — skill discovery tool for on-demand external skill scanning
import z from "zod"
import path from "path"
import { Tool } from "../../tool/tool"
import { discoverExternalSkills } from "../../skill/discover-external"
import { Instance } from "../../project/instance"
import { Skill } from "../../skill/skill"

export const SkillDiscoverTool = Tool.define("skill_discover", {
  description:
    "Discover skills and commands from external AI tool configs (Claude Code, Codex CLI, Gemini CLI). Lists what's available and which are already loaded.",
  parameters: z.object({
    action: z
      .enum(["list", "add"])
      .describe('"list" to show discovered skills, "add" to load them into the current session'),
    skills: z
      .array(z.string())
      .optional()
      .describe('When action is "add", which skills to load. Omit to add all discovered skills.'),
  }),
  async execute(args) {
    const { skills: discovered, sources } = await discoverExternalSkills(Instance.worktree)

    if (discovered.length === 0) {
      return {
        title: "Skill Discovery",
        metadata: { action: args.action, found: 0 },
        output:
          "No external skills or commands found.\n\n" +
          "Searched for:\n" +
          "- .claude/commands/**/*.md (Claude Code commands)\n" +
          "- .codex/skills/**/SKILL.md (Codex CLI skills)\n" +
          "- .gemini/skills/**/SKILL.md (Gemini CLI skills)\n" +
          "- .gemini/commands/**/*.toml (Gemini CLI commands)\n\n" +
          "These are searched in both the project directory and home directory.",
      }
    }

    // Get currently loaded skills to show which are new
    const existing = await Skill.all()
    const existingNames = new Set(existing.map((s) => s.name))

    const newSkills = discovered.filter((s) => !existingNames.has(s.name))
    const alreadyLoaded = discovered.filter((s) => existingNames.has(s.name))

    if (args.action === "list") {
      const lines: string[] = [
        `Found ${discovered.length} external skill(s) from ${sources.join(", ")}:`,
        "",
      ]

      if (newSkills.length > 0) {
        lines.push(`**New** (${newSkills.length}):`)
        for (const s of newSkills) {
          lines.push(`- \`${s.name}\` — ${s.description || "(no description)"} (${s.location})`)
        }
        lines.push("")
      }

      if (alreadyLoaded.length > 0) {
        lines.push(`**Already loaded** (${alreadyLoaded.length}):`)
        for (const s of alreadyLoaded) {
          lines.push(`- \`${s.name}\``)
        }
        lines.push("")
      }

      if (newSkills.length > 0) {
        lines.push(
          'To add these skills to the current session, call this tool again with `action: "add"`.',
        )
      }

      return {
        title: `Skill Discovery: ${discovered.length} found (${newSkills.length} new)`,
        metadata: { action: "list", found: discovered.length, new: newSkills.length },
        output: lines.join("\n"),
      }
    }

    // action === "add"
    const toAdd = args.skills
      ? discovered.filter((s) => args.skills!.includes(s.name) && !existingNames.has(s.name))
      : newSkills

    if (toAdd.length === 0) {
      return {
        title: "Skill Discovery: nothing to add",
        metadata: { action: "add", added: 0 },
        output: "All discovered skills are already loaded in the current session.",
      }
    }

    // Directly register skills into the runtime state — works regardless of
    // auto_skill_discovery config setting. This is the on-demand path.
    const currentState = await Skill.state()
    for (const skill of toAdd) {
      if (!currentState.skills[skill.name]) {
        currentState.skills[skill.name] = skill
        currentState.dirs.push(path.dirname(skill.location))
      }
    }

    return {
      title: `Skill Discovery: ${toAdd.length} skill(s) added`,
      metadata: { action: "add", added: toAdd.length, names: toAdd.map((s) => s.name) },
      output:
        `Added ${toAdd.length} skill(s) to the current session:\n` +
        toAdd.map((s) => `- \`/${s.name}\` — ${s.description || "(no description)"}`).join("\n") +
        "\n\nTo enable auto-discovery at startup, set `experimental.auto_skill_discovery: true` in your config." +
        "\n\nYou can now use these skills by name (e.g., `/" + toAdd[0].name + "`).",
    }
  },
})
// altimate_change end
