import { describe, expect, test } from "bun:test"
import { SessionPrompt } from "../../src/session/prompt"

// altimate_change - tests for headless-aware max-steps prompt selection.
// The full prompt loop is too large to run end-to-end in unit tests, so we
// expose `selectMaxStepsPrompt` and exercise its branching logic directly.

const HEADLESS_MARKER = "MAXIMUM STEPS REACHED (HEADLESS MODE)"
const HEADLESS_PREWARN_MARKER = "APPROACHING STEP BUDGET (HEADLESS MODE)"
const INTERACTIVE_MARKER = "MAXIMUM STEPS REACHED"
const INTERACTIVE_SUMMARY_MARKER = "Summary of what has been accomplished so far"

describe("SessionPrompt.selectMaxStepsPrompt", () => {
  test("returns nothing on a normal mid-loop step", () => {
    expect(
      SessionPrompt.selectMaxStepsPrompt({ step: 3, maxSteps: 10, headless: false }),
    ).toBeUndefined()
    expect(
      SessionPrompt.selectMaxStepsPrompt({ step: 3, maxSteps: 10, headless: true }),
    ).toBeUndefined()
  })

  test("interactive last step uses the original summarize-what-you-tried prompt", () => {
    const out = SessionPrompt.selectMaxStepsPrompt({ step: 10, maxSteps: 10, headless: false })
    expect(out).toBeDefined()
    expect(out).toContain(INTERACTIVE_MARKER)
    expect(out).toContain(INTERACTIVE_SUMMARY_MARKER)
    // and must NOT carry the headless wording
    expect(out).not.toContain(HEADLESS_MARKER)
  })

  test("headless last step asks for a best-guess answer, not a meta-summary", () => {
    const out = SessionPrompt.selectMaxStepsPrompt({ step: 10, maxSteps: 10, headless: true })
    expect(out).toBeDefined()
    expect(out).toContain(HEADLESS_MARKER)
    // Must explicitly tell the model to commit an answer rather than summarize.
    expect(out).toMatch(/best guess/i)
    expect(out).toMatch(/Do NOT summarize/i)
    // And must NOT be the interactive summary text.
    expect(out).not.toContain(INTERACTIVE_SUMMARY_MARKER)
  })

  test("headless pre-warning fires one step before the limit", () => {
    const out = SessionPrompt.selectMaxStepsPrompt({ step: 9, maxSteps: 10, headless: true })
    expect(out).toBeDefined()
    expect(out).toContain(HEADLESS_PREWARN_MARKER)
  })

  test("interactive mode never fires a pre-warning", () => {
    expect(
      SessionPrompt.selectMaxStepsPrompt({ step: 9, maxSteps: 10, headless: false }),
    ).toBeUndefined()
  })

  test("over-limit step still uses the final-step prompt", () => {
    const interactive = SessionPrompt.selectMaxStepsPrompt({
      step: 15,
      maxSteps: 10,
      headless: false,
    })
    const headless = SessionPrompt.selectMaxStepsPrompt({
      step: 15,
      maxSteps: 10,
      headless: true,
    })
    expect(interactive).toContain(INTERACTIVE_MARKER)
    expect(headless).toContain(HEADLESS_MARKER)
  })

  test("infinite step budget never fires either prompt", () => {
    expect(
      SessionPrompt.selectMaxStepsPrompt({ step: 9999, maxSteps: Infinity, headless: false }),
    ).toBeUndefined()
    expect(
      SessionPrompt.selectMaxStepsPrompt({ step: 9999, maxSteps: Infinity, headless: true }),
    ).toBeUndefined()
  })
})
