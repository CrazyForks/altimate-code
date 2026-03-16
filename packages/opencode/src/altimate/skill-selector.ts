// altimate_change start - LLM-based dynamic skill selection
import { generateObject } from "ai"
import type { LanguageModelV2 } from "@openrouter/ai-sdk-provider"
import z from "zod"
import { Provider } from "../provider/provider"
import { Log } from "../util/log"
import type { Skill } from "../skill"
import type { Fingerprint } from "./fingerprint"

const log = Log.create({ service: "skill-selector" })

const TIMEOUT_MS = 3_000
const MAX_SKILLS = 15

export interface SkillSelectorDeps {
  resolveModel: () => Promise<LanguageModelV2 | undefined>
  generate: (params: {
    model: LanguageModelV2
    temperature: number
    schema: z.ZodType
    messages: Array<{ role: "system" | "user"; content: string }>
  }) => Promise<{ object: { selected: string[] } }>
}

async function defaultResolveModel(): Promise<LanguageModelV2 | undefined> {
  const defaultModel = await Provider.defaultModel()
  const smallModel = await Provider.getSmallModel(defaultModel.providerID)
  if (!smallModel) return undefined
  return Provider.getLanguage(smallModel)
}

const defaultDeps: SkillSelectorDeps = {
  resolveModel: defaultResolveModel,
  generate: generateObject as any,
}

/**
 * Use a small LLM to semantically select relevant skills
 * based on the user's message and project fingerprint.
 *
 * Graceful fallback: returns ALL skills on any failure (matches pre-feature behavior).
 */
export async function selectSkillsWithLLM(
  skills: Skill.Info[],
  messageText: string | undefined,
  fingerprint: Fingerprint.Result | undefined,
  deps?: SkillSelectorDeps,
): Promise<Skill.Info[]> {
  // No message (first turn) → return all skills
  if (!messageText || messageText.trim().length === 0) {
    return skills
  }

  const { resolveModel, generate } = deps ?? defaultDeps

  try {
    const model = await resolveModel()
    if (!model) {
      log.info("no small model available, returning all skills")
      return skills
    }

    // Build compact skill list for the prompt
    const skillList = skills.map((s) => ({
      name: s.name,
      description: s.description,
    }))

    const envContext =
      fingerprint && fingerprint.tags.length > 0
        ? fingerprint.tags.join(", ")
        : "none detected"

    const params = {
      model,
      temperature: 0,
      schema: z.object({ selected: z.array(z.string()) }),
      messages: [
        {
          role: "system" as const,
          content: [
            "You are a skill selector for a coding assistant.",
            "Given a user's message and available skills, select relevant ones.",
            "Return ONLY skill names the user likely needs. Select 0-15 skills.",
            "Prefer fewer, more relevant skills over many loosely related ones.",
            `Project environment: ${envContext}`,
          ].join("\n"),
        },
        {
          role: "user" as const,
          content: [
            `User message: ${messageText}`,
            "",
            `Available skills: ${JSON.stringify(skillList)}`,
          ].join("\n"),
        },
      ],
    }

    const result = await Promise.race([
      generate(params),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("skill selection timeout")), TIMEOUT_MS),
      ),
    ])

    const selected = result.object.selected.slice(0, MAX_SKILLS)

    // Zero-selection guard
    if (selected.length === 0) {
      log.info("LLM returned zero skills, returning all")
      return skills
    }

    // Filter skills by returned names
    const selectedSet = new Set(selected)
    const matched = skills.filter((s) => selectedSet.has(s.name))

    // If no valid matches (LLM returned non-existent names), return all
    if (matched.length === 0) {
      log.info("LLM returned no valid skill names, returning all")
      return skills
    }

    log.info("selected skills", {
      count: matched.length,
      names: matched.map((s) => s.name),
    })
    return matched
  } catch (e) {
    log.info("skill selection failed, returning all skills", {
      error: e instanceof Error ? e.message : String(e),
    })
    return skills
  }
}
// altimate_change end
