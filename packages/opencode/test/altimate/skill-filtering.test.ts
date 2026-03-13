import { describe, expect, test } from "bun:test"
import { selectSkillsWithLLM, type SkillSelectorDeps } from "../../src/altimate/skill-selector"
import type { Skill } from "../../src/skill"
import type { Fingerprint } from "../../src/altimate/fingerprint"
import type { LanguageModelV2 } from "@openrouter/ai-sdk-provider"

function mockSkill(name: string, description?: string): Skill.Info {
  return {
    name,
    description: description ?? `Test skill: ${name}`,
    location: `/test/${name}/SKILL.md`,
    content: `# ${name}`,
  } as Skill.Info
}

function mockFingerprint(tags: string[]): Fingerprint.Result {
  return { tags, detectedAt: Date.now(), cwd: "/test" } as Fingerprint.Result
}

const FAKE_MODEL = { modelId: "claude-haiku-4-5-20251001", provider: "anthropic" } as unknown as LanguageModelV2

const ALL_SKILLS = [
  mockSkill("dbt-modeling", "Build and manage dbt models"),
  mockSkill("react-components", "Create React UI components"),
  mockSkill("python-testing", "Write Python unit tests"),
  mockSkill("kubernetes-deploy", "Deploy apps to Kubernetes"),
  mockSkill("sql-optimization", "Optimize SQL queries"),
]

/** Create deps that resolve a model and return selected skill names */
function makeDeps(selected: string[], model: LanguageModelV2 = FAKE_MODEL): SkillSelectorDeps & { calls: any[] } {
  const calls: any[] = []
  return {
    calls,
    resolveModel: async () => model,
    generate: async (params) => {
      calls.push(params)
      return { object: { selected } }
    },
  }
}

/** Create deps where resolveModel returns undefined (no small model available) */
function makeDepsNoModel(): SkillSelectorDeps {
  return {
    resolveModel: async () => undefined,
    generate: async () => { throw new Error("should not be called") },
  }
}

/** Create deps where generate throws */
function makeDepsError(error: string): SkillSelectorDeps {
  return {
    resolveModel: async () => FAKE_MODEL,
    generate: async () => { throw new Error(error) },
  }
}

/** Create deps where generate never resolves (timeout test) */
function makeDepsHang(): SkillSelectorDeps {
  return {
    resolveModel: async () => FAKE_MODEL,
    generate: () => new Promise<never>(() => {}),
  }
}

describe("selectSkillsWithLLM", () => {
  // --- Fallback cases: return all skills ---

  test("no message text → returns all skills", async () => {
    const result = await selectSkillsWithLLM(ALL_SKILLS, undefined, mockFingerprint(["dbt"]))
    expect(result).toHaveLength(ALL_SKILLS.length)
  })

  test("empty message → returns all skills", async () => {
    const result = await selectSkillsWithLLM(ALL_SKILLS, "", mockFingerprint(["dbt"]))
    expect(result).toHaveLength(ALL_SKILLS.length)
  })

  test("whitespace-only message → returns all skills", async () => {
    const result = await selectSkillsWithLLM(ALL_SKILLS, "   ", mockFingerprint(["dbt"]))
    expect(result).toHaveLength(ALL_SKILLS.length)
  })

  test("no small model available → returns all skills", async () => {
    const deps = makeDepsNoModel()
    const result = await selectSkillsWithLLM(ALL_SKILLS, "help me", undefined, deps)
    expect(result).toHaveLength(ALL_SKILLS.length)
  })

  test("LLM error → returns all skills (graceful fallback)", async () => {
    const deps = makeDepsError("API key invalid")
    const result = await selectSkillsWithLLM(ALL_SKILLS, "help me write code", undefined, deps)
    expect(result).toHaveLength(ALL_SKILLS.length)
  })

  test("LLM timeout → returns all skills", async () => {
    const deps = makeDepsHang()
    const result = await selectSkillsWithLLM(ALL_SKILLS, "help me write code", mockFingerprint(["python"]), deps)
    expect(result).toHaveLength(ALL_SKILLS.length)
  }, 10_000)

  test("LLM returns zero skills → returns all skills", async () => {
    const deps = makeDeps([])
    const result = await selectSkillsWithLLM(ALL_SKILLS, "help me", mockFingerprint([]), deps)
    expect(result).toHaveLength(ALL_SKILLS.length)
  })

  test("LLM returns all non-existent names → returns all skills (fallback)", async () => {
    const deps = makeDeps(["fake-skill-1", "fake-skill-2"])
    const result = await selectSkillsWithLLM(ALL_SKILLS, "do something", mockFingerprint([]), deps)
    expect(result).toHaveLength(ALL_SKILLS.length)
  })

  // --- Successful selection ---

  test("LLM returns valid names → filters correctly", async () => {
    const deps = makeDeps(["dbt-modeling", "sql-optimization"])
    const result = await selectSkillsWithLLM(
      ALL_SKILLS,
      "help me write a dbt model with optimized SQL",
      mockFingerprint(["dbt"]),
      deps,
    )
    expect(result).toHaveLength(2)
    expect(result.map((s) => s.name)).toEqual(["dbt-modeling", "sql-optimization"])
  })

  test("LLM returns non-existent names → ignored, returns only matching", async () => {
    const deps = makeDeps(["dbt-modeling", "nonexistent-skill"])
    const result = await selectSkillsWithLLM(
      ALL_SKILLS,
      "help me with dbt",
      mockFingerprint(["dbt"]),
      deps,
    )
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe("dbt-modeling")
  })

  test("single skill selected → returns just that one", async () => {
    const deps = makeDeps(["python-testing"])
    const result = await selectSkillsWithLLM(
      ALL_SKILLS,
      "write a pytest test",
      mockFingerprint(["python"]),
      deps,
    )
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe("python-testing")
  })

  // --- Limits ---

  test("max 15 skills cap enforced", async () => {
    const manySkills = Array.from({ length: 20 }, (_, i) => mockSkill(`skill-${i}`, `Skill ${i}`))
    const deps = makeDeps(manySkills.map((s) => s.name))
    const result = await selectSkillsWithLLM(manySkills, "I need everything", undefined, deps)
    expect(result.length).toBeLessThanOrEqual(15)
  })

  // --- Model verification ---

  test("resolved model is passed to generate", async () => {
    const customModel = { modelId: "claude-haiku-4-5-20251001", provider: "test-anthropic" } as unknown as LanguageModelV2
    const deps = makeDeps(["dbt-modeling"], customModel)
    await selectSkillsWithLLM(ALL_SKILLS, "dbt help", undefined, deps)
    expect(deps.calls).toHaveLength(1)
    expect(deps.calls[0].model).toBe(customModel)
  })

  test("temperature is always 0", async () => {
    const deps = makeDeps(["dbt-modeling"])
    await selectSkillsWithLLM(ALL_SKILLS, "dbt help", undefined, deps)
    expect(deps.calls[0].temperature).toBe(0)
  })

  // --- Prompt content ---

  test("fingerprint tags included in prompt context", async () => {
    const deps = makeDeps(["dbt-modeling"])
    await selectSkillsWithLLM(ALL_SKILLS, "help me", mockFingerprint(["python", "dbt"]), deps)
    const systemMsg = deps.calls[0].messages.find((m: any) => m.role === "system")
    expect(systemMsg.content).toContain("python, dbt")
  })

  test("no fingerprint → prompt says 'none detected'", async () => {
    const deps = makeDeps(["dbt-modeling"])
    await selectSkillsWithLLM(ALL_SKILLS, "help me", undefined, deps)
    const systemMsg = deps.calls[0].messages.find((m: any) => m.role === "system")
    expect(systemMsg.content).toContain("none detected")
  })

  test("skill names and descriptions sent in user message", async () => {
    const deps = makeDeps(["dbt-modeling"])
    await selectSkillsWithLLM(ALL_SKILLS, "help me", undefined, deps)
    const userMsg = deps.calls[0].messages.find((m: any) => m.role === "user")
    expect(userMsg.content).toContain("dbt-modeling")
    expect(userMsg.content).toContain("Build and manage dbt models")
    expect(userMsg.content).toContain("react-components")
  })

  test("user message text is included in prompt", async () => {
    const deps = makeDeps(["dbt-modeling"])
    await selectSkillsWithLLM(ALL_SKILLS, "build a dbt model for orders", undefined, deps)
    const userMsg = deps.calls[0].messages.find((m: any) => m.role === "user")
    expect(userMsg.content).toContain("build a dbt model for orders")
  })
})
