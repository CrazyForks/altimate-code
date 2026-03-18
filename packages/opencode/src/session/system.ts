import { Ripgrep } from "../file/ripgrep"

import { Instance } from "../project/instance"

import PROMPT_ANTHROPIC from "./prompt/anthropic.txt"
import PROMPT_ANTHROPIC_WITHOUT_TODO from "./prompt/qwen.txt"
import PROMPT_BEAST from "./prompt/beast.txt"
import PROMPT_GEMINI from "./prompt/gemini.txt"

import PROMPT_CODEX from "./prompt/codex_header.txt"
import PROMPT_TRINITY from "./prompt/trinity.txt"
import type { Provider } from "@/provider/provider"
import type { Agent } from "@/agent/agent"
import { PermissionNext } from "@/permission/next"
import { Skill } from "@/skill"
// altimate_change start - import for env-based skill selection
import { Fingerprint, ADAPTER_TAGS } from "../altimate/fingerprint"
import { Config } from "../config/config"
import { selectSkillsWithLLM } from "../altimate/skill-selector"
// altimate_change end

export namespace SystemPrompt {
  export function instructions() {
    return PROMPT_CODEX.trim()
  }

  export function provider(model: Provider.Model) {
    if (model.api.id.includes("gpt-5")) return [PROMPT_CODEX]
    if (model.api.id.includes("gpt-") || model.api.id.includes("o1") || model.api.id.includes("o3"))
      return [PROMPT_BEAST]
    if (model.api.id.includes("gemini-")) return [PROMPT_GEMINI]
    if (model.api.id.includes("claude")) return [PROMPT_ANTHROPIC]
    if (model.api.id.toLowerCase().includes("trinity")) return [PROMPT_TRINITY]
    return [PROMPT_ANTHROPIC_WITHOUT_TODO]
  }

  export async function environment(model: Provider.Model) {
    const project = Instance.project
    const parts: string[] = [
      [
        `You are powered by the model named ${model.api.id}. The exact model ID is ${model.providerID}/${model.api.id}`,
        `Here is some useful information about the environment you are running in:`,
        `<env>`,
        `  Working directory: ${Instance.directory}`,
        `  Workspace root folder: ${Instance.worktree}`,
        `  Is directory a git repo: ${project.vcs === "git" ? "yes" : "no"}`,
        `  Platform: ${process.platform}`,
        `  Today's date: ${new Date().toDateString()}`,
        `</env>`,
        `<directories>`,
        `  ${
          project.vcs === "git" && false
            ? await Ripgrep.tree({
                cwd: Instance.directory,
                limit: 50,
              })
            : ""
        }`,
        `</directories>`,
      ].join("\n"),
    ]

    // altimate_change start - inject project context to guide connection discovery
    try {
      // detect() caches per-cwd, so calling it directly is both correct and cheap
      const fingerprint = await Fingerprint.detect(Instance.directory, Instance.worktree)
      if (fingerprint.tags.length > 0) {
        const isDbt = fingerprint.tags.includes("dbt")
        const detectedAdapter = fingerprint.tags.find(t => (ADAPTER_TAGS as readonly string[]).includes(t))

        parts.push(
          [
            `<project-context>`,
            `  Detected project tags: ${fingerprint.tags.join(", ")}`,
            ...(isDbt ? [
              ``,
              `  This workspace contains a dbt project. When executing SQL queries:`,
              `  1. Attempt to use the dbt connection first (configured via profiles.yml${detectedAdapter ? `, adapter: ${detectedAdapter}` : ""}).`,
              `  2. If the dbt connection is unavailable or fails, fall back to a configured warehouse connection.`,
              `  3. If neither works, ask the user for the credentials needed to connect${detectedAdapter ? ` to ${detectedAdapter}` : ""}.`,
              `  Do not assume the dbt connection will always succeed — be prepared to ask for credentials.`,
            ] : [
              ``,
              `  No dbt project detected. When SQL execution is needed:`,
              `  1. Check if a warehouse connection is already configured.`,
              `  2. If not, ask the user for the connection credentials appropriate to this project${detectedAdapter ? ` (detected: ${detectedAdapter})` : ""}.`,
            ]),
            `</project-context>`,
          ].join("\n"),
        )
      }
    } catch {
      // fingerprint detection is best-effort — never block session startup
    }
    // altimate_change end

    return parts
  }

  export async function skills(agent: Agent.Info) {
    if (PermissionNext.disabled(["skill"], agent.permission).has("skill")) return

    const list = await Skill.available(agent)

    // altimate_change start - apply env-based skill selection
    const cfg = await Config.get()
    let filtered: Skill.Info[]
    if (cfg.experimental?.env_fingerprint_skill_selection === true) {
      filtered = await selectSkillsWithLLM(list, Fingerprint.get())
    } else {
      filtered = list
    }
    // altimate_change end

    return [
      "Skills provide specialized instructions and workflows for specific tasks.",
      "Use the skill tool to load a skill when a task matches its description.",
      // the agents seem to ingest the information about skills a bit better if we present a more verbose
      // version of them here and a less verbose version in tool description, rather than vice versa.
      // altimate_change start - use filtered skill list
      Skill.fmt(filtered, { verbose: true }),
      // altimate_change end
    ].join("\n")
  }
}
