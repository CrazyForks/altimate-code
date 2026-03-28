import { test, expect } from "bun:test"
import { Skill } from "../../src/skill"
import { SkillFollowups } from "../../src/skill/followups"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import path from "path"

test("skill tool output includes follow-up suggestions for skills with followups", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const skillDir = path.join(dir, ".opencode", "skill", "dbt-develop")
      await Bun.write(
        path.join(skillDir, "SKILL.md"),
        `---
name: dbt-develop
description: Create dbt models.
---

# dbt Model Development

Instructions here.
`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const skill = await Skill.get("dbt-develop")
      expect(skill).toBeDefined()

      // Verify followups exist for this skill
      const followups = SkillFollowups.format("dbt-develop")
      expect(followups).toContain("## What's Next?")
      expect(followups).toContain("dbt-test")
      expect(followups).toContain("dbt-docs")
    },
  })
})

test("skill tool output has no follow-ups for skills without followups defined", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const skillDir = path.join(dir, ".opencode", "skill", "custom-skill")
      await Bun.write(
        path.join(skillDir, "SKILL.md"),
        `---
name: custom-skill
description: A custom skill.
---

# Custom Skill

Do custom things.
`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const skill = await Skill.get("custom-skill")
      expect(skill).toBeDefined()

      // No followups for unknown skills
      const followups = SkillFollowups.format("custom-skill")
      expect(followups).toBe("")
    },
  })
})
