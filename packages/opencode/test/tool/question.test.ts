import { describe, expect, test, spyOn, beforeEach, afterEach } from "bun:test"
import { z } from "zod"
import { QuestionTool } from "../../src/tool/question"
import * as QuestionModule from "../../src/question"
import { SessionID, MessageID } from "../../src/session/schema"

const ctx = {
  sessionID: SessionID.make("ses_test-session"),
  messageID: MessageID.make("test-message"),
  callID: "test-call",
  agent: "test-agent",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
  ask: async () => {},
}

describe("tool.question", () => {
  let askSpy: any

  beforeEach(() => {
    // Force the original interactive path for the legacy tests below — the
    // test environment is non-TTY (bun:test runs without a terminal), so
    // without this override the non-interactive auto-answer branch would
    // short-circuit `Question.ask` and the existing spies would never fire.
    process.env["ALTIMATE_FORCE_INTERACTIVE"] = "1"
    askSpy = spyOn(QuestionModule.Question, "ask").mockImplementation(async () => {
      return []
    })
  })

  afterEach(() => {
    delete process.env["ALTIMATE_FORCE_INTERACTIVE"]
    askSpy.mockRestore()
  })

  test("should successfully execute with valid question parameters", async () => {
    const tool = await QuestionTool.init()
    const questions = [
      {
        question: "What is your favorite color?",
        header: "Color",
        options: [
          { label: "Red", description: "The color of passion" },
          { label: "Blue", description: "The color of sky" },
        ],
        multiple: false,
      },
    ]

    askSpy.mockResolvedValueOnce([["Red"]])

    const result = await tool.execute({ questions }, ctx)
    expect(askSpy).toHaveBeenCalledTimes(1)
    expect(result.title).toBe("Asked 1 question")
  })

  test("should now pass with a header longer than 12 but less than 30 chars", async () => {
    const tool = await QuestionTool.init()
    const questions = [
      {
        question: "What is your favorite animal?",
        header: "This Header is Over 12",
        options: [{ label: "Dog", description: "Man's best friend" }],
      },
    ]

    askSpy.mockResolvedValueOnce([["Dog"]])

    const result = await tool.execute({ questions }, ctx)
    expect(result.output).toContain(`"What is your favorite animal?"="Dog"`)
  })

  // intentionally removed the zod validation due to tool call errors, hoping prompting is gonna be good enough
  //   test("should throw an Error for header exceeding 30 characters", async () => {
  //     const tool = await QuestionTool.init()
  //     const questions = [
  //       {
  //         question: "What is your favorite animal?",
  //         header: "This Header is Definitely More Than Thirty Characters Long",
  //         options: [{ label: "Dog", description: "Man's best friend" }],
  //       },
  //     ]
  //     try {
  //       await tool.execute({ questions }, ctx)
  //       // If it reaches here, the test should fail
  //       expect(true).toBe(false)
  //     } catch (e: any) {
  //       expect(e).toBeInstanceOf(Error)
  //       expect(e.cause).toBeInstanceOf(z.ZodError)
  //     }
  //   })

  //   test("should throw an Error for label exceeding 30 characters", async () => {
  //     const tool = await QuestionTool.init()
  //     const questions = [
  //       {
  //         question: "A question with a very long label",
  //         header: "Long Label",
  //         options: [
  //           { label: "This is a very, very, very long label that will exceed the limit", description: "A description" },
  //         ],
  //       },
  //     ]
  //     try {
  //       await tool.execute({ questions }, ctx)
  //       // If it reaches here, the test should fail
  //       expect(true).toBe(false)
  //     } catch (e: any) {
  //       expect(e).toBeInstanceOf(Error)
  //       expect(e.cause).toBeInstanceOf(z.ZodError)
  //     }
  //   })
})

describe("tool.question non-interactive auto-answer", () => {
  let askSpy: any

  beforeEach(() => {
    process.env["ALTIMATE_NON_INTERACTIVE"] = "1"
    askSpy = spyOn(QuestionModule.Question, "ask").mockImplementation(async () => [])
  })

  afterEach(() => {
    delete process.env["ALTIMATE_NON_INTERACTIVE"]
    delete process.env["ALTIMATE_AUTO_ANSWER"]
    askSpy.mockRestore()
  })

  test("picks safe-keyword option when present and does not invoke Question.ask", async () => {
    const tool = await QuestionTool.init()
    const questions = [
      {
        question: "May I run row-level hashdiff comparisons?",
        header: "PII consent",
        options: [
          { label: "Approve row diff", description: "Sample rows may appear" },
          { label: "Profile only", description: "Safer; no row content surfaced" },
        ],
      },
    ]

    const result = await tool.execute({ questions }, ctx)
    expect(askSpy).not.toHaveBeenCalled()
    expect(result.output).toContain("Profile only")
    expect(result.output).toContain("non-interactive mode")
  })

  test("falls back to last option when no safe keyword matches", async () => {
    const tool = await QuestionTool.init()
    const questions = [
      {
        question: "Pick a color",
        header: "Color",
        options: [
          { label: "Red", description: "The color of passion" },
          { label: "Blue", description: "The color of sky" },
        ],
      },
    ]

    const result = await tool.execute({ questions }, ctx)
    expect(askSpy).not.toHaveBeenCalled()
    expect(result.output).toContain("Blue")
  })

  test("ALTIMATE_AUTO_ANSWER=first picks first option", async () => {
    process.env["ALTIMATE_AUTO_ANSWER"] = "first"
    const tool = await QuestionTool.init()
    const questions = [
      {
        question: "Pick a color",
        header: "Color",
        options: [
          { label: "Red", description: "" },
          { label: "Blue", description: "" },
        ],
      },
    ]

    const result = await tool.execute({ questions }, ctx)
    expect(result.output).toContain("Red")
  })

  test("ALTIMATE_AUTO_ANSWER=skip returns Unanswered for each question", async () => {
    process.env["ALTIMATE_AUTO_ANSWER"] = "skip"
    const tool = await QuestionTool.init()
    const questions = [
      {
        question: "Pick a color",
        header: "Color",
        options: [{ label: "Red", description: "" }],
      },
    ]

    const result = await tool.execute({ questions }, ctx)
    expect(result.output).toContain("Unanswered")
  })

  test("ALTIMATE_AUTO_ANSWER=<exact label> picks matching option", async () => {
    process.env["ALTIMATE_AUTO_ANSWER"] = "blue"
    const tool = await QuestionTool.init()
    const questions = [
      {
        question: "Pick a color",
        header: "Color",
        options: [
          { label: "Red", description: "" },
          { label: "Blue", description: "" },
        ],
      },
    ]

    const result = await tool.execute({ questions }, ctx)
    expect(result.output).toContain("Blue")
  })

  test("non-interactive prefix is set when Question.ask is bypassed", async () => {
    const tool = await QuestionTool.init()
    const questions = [
      {
        question: "OK to proceed?",
        header: "Proceed",
        options: [{ label: "Cancel", description: "Stop" }],
      },
    ]

    const result = await tool.execute({ questions }, ctx)
    expect(result.output.startsWith("Running in non-interactive mode")).toBe(true)
  })
})
