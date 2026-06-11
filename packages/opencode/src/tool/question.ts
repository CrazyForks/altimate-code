import z from "zod"
import { Tool } from "./tool"
import { Question } from "../question"
import DESCRIPTION from "./question.txt"

// altimate_change start — non-interactive auto-answer support.
// When running under `claude --print`, CI, or any other context without a TTY,
// there is nobody to click an option in the TUI. The default Question.ask()
// behaviour is to await a Deferred indefinitely, which causes the parent
// process to TaskStop the subprocess after a long wait — looking exactly like
// a hang. See deliverable 02 (Run F first sub-session) for the trace.
//
// Resolution policy: in non-interactive mode, pick the option whose label
// contains a "safe" keyword (skip / cancel / profile only / no / abort).
// If no such option exists, pick the LAST option (UX convention: safer/cancel
// usually sits at the end). The agent then sees a concrete answer in the
// tool result and can continue without blocking. Override via env var:
//   ALTIMATE_AUTO_ANSWER=first    — always pick first option
//   ALTIMATE_AUTO_ANSWER=last     — always pick last option (default)
//   ALTIMATE_AUTO_ANSWER=skip     — return Unanswered for all questions
const SAFE_KEYWORDS = [
  "skip",
  "cancel",
  "no",
  "abort",
  "profile only",
  "profile-only",
  "decline",
  "deny",
  "stop",
]

function isNonInteractive(): boolean {
  if (process.env["ALTIMATE_FORCE_INTERACTIVE"] === "1") return false
  if (process.env["ALTIMATE_NON_INTERACTIVE"] === "1") return true
  return !process.stdin.isTTY
}

function autoAnswer(questions: Question.Info[]): Question.Answer[] {
  const mode = (process.env["ALTIMATE_AUTO_ANSWER"] ?? "last").toLowerCase()
  return questions.map((q) => {
    if (mode === "skip") return []
    if (mode === "first") return q.options[0] ? [q.options[0].label] : []
    if (mode === "last") {
      const safe = q.options.find((o) => {
        const text = `${o.label} ${o.description}`.toLowerCase()
        return SAFE_KEYWORDS.some((k) => text.includes(k))
      })
      if (safe) return [safe.label]
      const last = q.options[q.options.length - 1]
      return last ? [last.label] : []
    }
    // exact label match for explicit answers, e.g. ALTIMATE_AUTO_ANSWER="Profile only"
    const match = q.options.find((o) => o.label.toLowerCase() === mode)
    return match ? [match.label] : []
  })
}
// altimate_change end

export const QuestionTool = Tool.define("question", {
  description: DESCRIPTION,
  parameters: z.object({
    questions: z.array(Question.Info.omit({ custom: true })).describe("Questions to ask"),
  }),
  async execute(params, ctx) {
    // altimate_change start — short-circuit when no human is listening.
    let answers: Question.Answer[]
    if (isNonInteractive()) {
      answers = autoAnswer(params.questions)
    } else {
      answers = await Question.ask({
        sessionID: ctx.sessionID,
        questions: params.questions,
        tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
      })
    }
    // altimate_change end

    function format(answer: Question.Answer | undefined) {
      if (!answer?.length) return "Unanswered"
      return answer.join(", ")
    }

    const formatted = params.questions.map((q, i) => `"${q.question}"="${format(answers[i])}"`).join(", ")

    // altimate_change start — flag auto-answers explicitly so the agent
    // knows the user didn't actually answer and can decide whether to
    // proceed with that choice or fail back gracefully.
    const prefix = isNonInteractive()
      ? `Running in non-interactive mode (no TTY). Auto-answered with safe defaults: `
      : `User has answered your questions: `
    // altimate_change end

    return {
      title: `Asked ${params.questions.length} question${params.questions.length > 1 ? "s" : ""}`,
      output: `${prefix}${formatted}. You can now continue with the user's answers in mind.`,
      metadata: {
        answers,
      },
    }
  },
})
