import { describe, expect, test } from "bun:test"
import path from "path"
import { Agent } from "../../src/agent/agent"
import { Instance } from "../../src/project/instance"
import { SystemPrompt } from "../../src/session/system"
import type { Provider } from "../../src/provider/provider"
import { tmpdir } from "../fixture/fixture"

function makeModel(overrides: Partial<Provider.Model> & { apiId: string; family?: string; providerID?: string }): Provider.Model {
  return {
    id: overrides.apiId as any,
    providerID: (overrides.providerID ?? "test") as any,
    api: { id: overrides.apiId, url: "", npm: "@ai-sdk/openai-compatible" },
    name: overrides.apiId,
    family: overrides.family,
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 0, output: 0 },
    status: "active",
    options: {},
    headers: {},
    release_date: "2025-01-01",
  } as Provider.Model
}

describe("session.system.provider routing", () => {
  // Regression guard for the altimate-default routing bug (GH #887 / AI-6957).
  // Before this fix, `altimate-default` (api.id literal, kept stable for backward
  // compatibility) matched none of the string-based conditions and fell through
  // to PROMPT_ANTHROPIC_WITHOUT_TODO (qwen.txt), whose Claude-style "MUST refuse
  // if borderline/malicious" directives caused the upstream GPT-5.x gateway
  // model to refuse benign requests in plan mode.
  // `codex_header.txt` (GPT-5 prompt) is the only base prompt with `## Editing
  // constraints` / `apply_patch` — codex-specific. The Claude-style fallback
  // (`qwen.txt`) is the only base prompt that begins with "Refuse to write code
  // or explain code that may be used maliciously".

  test("altimate-default routes to GPT-5 prompt via provider+family, not the Anthropic fallback", () => {
    const prompts = SystemPrompt.provider(
      makeModel({ apiId: "altimate-default", providerID: "altimate-backend", family: "openai" }),
    )
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toMatch(/## Editing constraints/)
    expect(prompts[0]).toMatch(/apply_patch/)
    expect(prompts[0]).not.toMatch(/Refuse to write code or explain code that may be used maliciously/)
  })

  test("altimate-backend anthropic-family routes to Claude prompt, not GPT-5 codex", () => {
    const prompts = SystemPrompt.provider(
      makeModel({ apiId: "altimate-something", providerID: "altimate-backend", family: "anthropic" }),
    )
    expect(prompts[0]).not.toMatch(/## Editing constraints/)
    expect(prompts[0]).not.toMatch(/Refuse to write code or explain code that may be used maliciously/)
  })

  test("non-altimate openai models still use the existing api.id matching", () => {
    const gpt5 = SystemPrompt.provider(makeModel({ apiId: "gpt-5", providerID: "openai" }))
    expect(gpt5[0]).toMatch(/## Editing constraints/)
    const gpt4 = SystemPrompt.provider(makeModel({ apiId: "gpt-4o", providerID: "openai" }))
    expect(gpt4[0]).not.toMatch(/## Editing constraints/)
  })
})

describe("session.system", () => {
  test("skills output is sorted by name and stable across calls", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        for (const [name, description] of [
          ["zeta-skill", "Zeta skill."],
          ["alpha-skill", "Alpha skill."],
          ["middle-skill", "Middle skill."],
        ]) {
          const skillDir = path.join(dir, ".opencode", "skill", name)
          await Bun.write(
            path.join(skillDir, "SKILL.md"),
            `---
name: ${name}
description: ${description}
---

# ${name}
`,
          )
        }
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const build = await Agent.get("build")
          const first = await SystemPrompt.skills(build!)
          const second = await SystemPrompt.skills(build!)

          expect(first).toBe(second)

          const alpha = first!.indexOf("<name>alpha-skill</name>")
          const middle = first!.indexOf("<name>middle-skill</name>")
          const zeta = first!.indexOf("<name>zeta-skill</name>")

          expect(alpha).toBeGreaterThan(-1)
          expect(middle).toBeGreaterThan(alpha)
          expect(zeta).toBeGreaterThan(middle)
        },
      })
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })
})
