/**
 * Regression guard for issue #881.
 *
 * The native altimate-core engine (column lineage, track lineage, equivalence,
 * grade, PII, …) runs fully offline via the bundled `@altimateai/altimate-core`
 * napi binary — there is no `altimate_core.init` and no API-key gate in that
 * path. Two tool descriptions used to falsely claim "Requires altimate_core.init()
 * with API key", a stale leftover from the old Python bridge. The reviewer agent
 * read those descriptions, concluded it needed an altimate API key, and degraded
 * `dbt_pr_review` to lint-only mode.
 *
 * This test pins the descriptions so the false claim can never silently return.
 */
import { describe, test, expect } from "bun:test"
import { AltimateCoreColumnLineageTool } from "../../src/altimate/tools/altimate-core-column-lineage"
import { AltimateCoreTrackLineageTool } from "../../src/altimate/tools/altimate-core-track-lineage"

describe("altimate-core tool descriptions (issue #881)", () => {
  const tools = [
    { name: "altimate_core_column_lineage", tool: AltimateCoreColumnLineageTool },
    { name: "altimate_core_track_lineage", tool: AltimateCoreTrackLineageTool },
  ]

  for (const { name, tool } of tools) {
    test(`${name} must not claim it requires an API key / altimate_core.init()`, async () => {
      const { description } = await tool.init()
      expect(description).toBeTruthy()
      const lower = description.toLowerCase()
      // These deterministic engine tools run offline — no auth in their call path.
      // Guard the *false claim* (that a key/init is required), not the word
      // "api key" itself: the corrected copy legitimately says "no API key required".
      expect(lower).not.toContain("altimate_core.init")
      expect(lower).not.toMatch(/requires?\b[^.]{0,40}\bapi key\b/)
      // And it should positively state the offline / no-key reality.
      expect(lower).toContain("no api key")
    })
  }
})
