import { describe, expect, test } from "bun:test"
import { SessionPrompt } from "../../src/session/prompt"

// altimate_change - tests for headless-aware max-steps prompt selection.
// The full prompt loop is too large to run end-to-end in unit tests, so we
// expose `selectMaxStepsPrompt` and exercise its branching logic directly.

const HEADLESS_MARKER = "MAXIMUM STEPS REACHED (HEADLESS MODE)"
const HEADLESS_PREWARN_MARKER = "APPROACHING STEP BUDGET (HEADLESS MODE)"
// Use a marker that is unique to the *interactive* prompt — earlier we used
// "MAXIMUM STEPS REACHED" but that string is also a substring of the headless
// marker, so a copy-edit could silently flip prompt selection without the
// assertions catching it.
const INTERACTIVE_UNIQUE_MARKER = "Recommendations for what should be done next"
const INTERACTIVE_SUMMARY_MARKER = "Summary of what has been accomplished so far"

describe("SessionPrompt.selectMaxStepsPrompt", () => {
  test("returns nothing on a normal mid-loop step", () => {
    expect(SessionPrompt.selectMaxStepsPrompt({ step: 3, maxSteps: 10, headless: false })).toBeUndefined()
    expect(SessionPrompt.selectMaxStepsPrompt({ step: 3, maxSteps: 10, headless: true })).toBeUndefined()
  })

  test("interactive last step uses the original summarize-what-you-tried prompt", () => {
    const out = SessionPrompt.selectMaxStepsPrompt({ step: 10, maxSteps: 10, headless: false })
    expect(out).toBeDefined()
    expect(out).toContain(INTERACTIVE_UNIQUE_MARKER)
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
    expect(out).not.toContain(INTERACTIVE_UNIQUE_MARKER)
  })

  test("headless pre-warning fires one step before the limit", () => {
    const out = SessionPrompt.selectMaxStepsPrompt({ step: 9, maxSteps: 10, headless: true })
    expect(out).toBeDefined()
    expect(out).toContain(HEADLESS_PREWARN_MARKER)
  })

  test("interactive mode never fires a pre-warning", () => {
    expect(SessionPrompt.selectMaxStepsPrompt({ step: 9, maxSteps: 10, headless: false })).toBeUndefined()
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
    expect(interactive).toContain(INTERACTIVE_UNIQUE_MARKER)
    expect(headless).toContain(HEADLESS_MARKER)
    // Critically: the interactive over-limit prompt must NOT contain the
    // headless marker, otherwise prompt-selection has silently flipped.
    expect(interactive).not.toContain(HEADLESS_MARKER)
    expect(headless).not.toContain(INTERACTIVE_UNIQUE_MARKER)
  })

  test("headless prewarn does NOT fire when step is past maxSteps", () => {
    // Even though `headless && step === maxSteps - 1` is the prewarn trigger,
    // for an over-limit step we should land in the final branch, not prewarn.
    const out = SessionPrompt.selectMaxStepsPrompt({ step: 11, maxSteps: 10, headless: true })
    expect(out).toContain(HEADLESS_MARKER)
    expect(out).not.toContain(HEADLESS_PREWARN_MARKER)
  })

  test("infinite step budget never fires either prompt", () => {
    expect(SessionPrompt.selectMaxStepsPrompt({ step: 9999, maxSteps: Infinity, headless: false })).toBeUndefined()
    expect(SessionPrompt.selectMaxStepsPrompt({ step: 9999, maxSteps: Infinity, headless: true })).toBeUndefined()
  })

  // Edge cases the consensus reviewers flagged as missing -------------------

  test("maxSteps = 1: final fires immediately at step 1, prewarn never fires", () => {
    // step starts at 1 (incremented before the check), maxSteps=1 means one
    // shot only — the prewarn check `step === maxSteps - 1` would require
    // step=0 which is never reached, so prewarn must skip.
    const headlessFinal = SessionPrompt.selectMaxStepsPrompt({ step: 1, maxSteps: 1, headless: true })
    expect(headlessFinal).toContain(HEADLESS_MARKER)
    expect(headlessFinal).not.toContain(HEADLESS_PREWARN_MARKER)
    const interactiveFinal = SessionPrompt.selectMaxStepsPrompt({ step: 1, maxSteps: 1, headless: false })
    expect(interactiveFinal).toContain(INTERACTIVE_UNIQUE_MARKER)
  })

  test("maxSteps = 2: prewarn at step 1, final at step 2", () => {
    const prewarn = SessionPrompt.selectMaxStepsPrompt({ step: 1, maxSteps: 2, headless: true })
    expect(prewarn).toContain(HEADLESS_PREWARN_MARKER)
    expect(prewarn).not.toContain(HEADLESS_MARKER)

    const final = SessionPrompt.selectMaxStepsPrompt({ step: 2, maxSteps: 2, headless: true })
    expect(final).toContain(HEADLESS_MARKER)
    expect(final).not.toContain(HEADLESS_PREWARN_MARKER)
  })

  // M4 — prewarn copy must be internally consistent and dynamically computed
  test("prewarn copy substitutes turn count consistently", () => {
    const out = SessionPrompt.selectMaxStepsPrompt({ step: 9, maxSteps: 10, headless: true })
    expect(out).toBeDefined()
    // Template placeholder must have been replaced (no raw token left).
    expect(out).not.toContain("{TURNS_REMAINING}")
    // At step=maxSteps-1, exactly 1 tool-using turn remains. The copy must
    // reflect that, not say "2 turns".
    expect(out).toContain("1 tool-using turn left")
    expect(out).not.toContain("2 turns")
    // And the rest of the copy must agree: there is exactly one final
    // tools-disabled turn after this response.
    expect(out).toMatch(/one final turn/i)
  })

  test("prewarn copy explicitly mentions tools-disabled in final turn", () => {
    const out = SessionPrompt.selectMaxStepsPrompt({ step: 9, maxSteps: 10, headless: true })
    expect(out).toMatch(/tools will be disabled/i)
  })
})

// M3 — when the headless final-step prompt fires, the API request must actually
// strip tools, otherwise the prompt's "Tools are disabled" claim is a lie.
describe("SessionPrompt.shouldDisableToolsForHeadlessFinalStep", () => {
  test("disables tools at headless final step (text format)", () => {
    expect(
      SessionPrompt.shouldDisableToolsForHeadlessFinalStep({
        step: 10,
        maxSteps: 10,
        headless: true,
        formatType: "text",
      }),
    ).toBe(true)
  })

  test("does NOT disable tools when not headless", () => {
    expect(
      SessionPrompt.shouldDisableToolsForHeadlessFinalStep({
        step: 10,
        maxSteps: 10,
        headless: false,
        formatType: "text",
      }),
    ).toBe(false)
  })

  test("does NOT disable tools below the final step", () => {
    expect(
      SessionPrompt.shouldDisableToolsForHeadlessFinalStep({
        step: 9,
        maxSteps: 10,
        headless: true,
        formatType: "text",
      }),
    ).toBe(false)
  })

  test("does NOT disable tools when there is no step budget (Infinity)", () => {
    expect(
      SessionPrompt.shouldDisableToolsForHeadlessFinalStep({
        step: 9999,
        maxSteps: Infinity,
        headless: true,
        formatType: "text",
      }),
    ).toBe(false)
  })

  test("exempts json_schema mode (StructuredOutput tool must remain)", () => {
    expect(
      SessionPrompt.shouldDisableToolsForHeadlessFinalStep({
        step: 10,
        maxSteps: 10,
        headless: true,
        formatType: "json_schema",
      }),
    ).toBe(false)
  })

  test("disables tools also when step exceeds maxSteps (overshoot)", () => {
    expect(
      SessionPrompt.shouldDisableToolsForHeadlessFinalStep({
        step: 12,
        maxSteps: 10,
        headless: true,
        formatType: "text",
      }),
    ).toBe(true)
  })

  test("disables tools at maxSteps = 1 (one-shot headless)", () => {
    expect(
      SessionPrompt.shouldDisableToolsForHeadlessFinalStep({
        step: 1,
        maxSteps: 1,
        headless: true,
        formatType: "text",
      }),
    ).toBe(true)
  })
})
