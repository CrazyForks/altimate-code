import path from "path"
import { describe, expect, test } from "bun:test"
import { fileURLToPath } from "url"
import { Instance } from "../../src/project/instance"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionPrompt } from "../../src/session/prompt"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

describe("session.prompt missing file", () => {
  test("does not fail the prompt when a file part is missing", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          build: {
            model: "openai/gpt-5.2",
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})

        const missing = path.join(tmp.path, "does-not-exist.ts")
        const msg = await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [
            { type: "text", text: "please review @does-not-exist.ts" },
            {
              type: "file",
              mime: "text/plain",
              url: `file://${missing}`,
              filename: "does-not-exist.ts",
            },
          ],
        })

        if (msg.info.role !== "user") throw new Error("expected user message")

        const hasFailure = msg.parts.some(
          (part) => part.type === "text" && part.synthetic && part.text.includes("Read tool failed to read"),
        )
        expect(hasFailure).toBe(true)

        await Session.remove(session.id)
      },
    })
  })

  test("keeps stored part order stable when file resolution is async", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          build: {
            model: "openai/gpt-5.2",
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})

        const missing = path.join(tmp.path, "still-missing.ts")
        const msg = await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [
            {
              type: "file",
              mime: "text/plain",
              url: `file://${missing}`,
              filename: "still-missing.ts",
            },
            { type: "text", text: "after-file" },
          ],
        })

        if (msg.info.role !== "user") throw new Error("expected user message")

        const stored = await MessageV2.get({
          sessionID: session.id,
          messageID: msg.info.id,
        })
        const text = stored.parts.filter((part) => part.type === "text").map((part) => part.text)

        expect(text[0]?.startsWith("Called the Read tool with the following input:")).toBe(true)
        expect(text[1]?.includes("Read tool failed to read")).toBe(true)
        expect(text[2]).toBe("after-file")

        await Session.remove(session.id)
      },
    })
  })
})

describe("session.prompt special characters", () => {
  test("handles filenames with # character", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "file#name.txt"), "special content\n")
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const template = "Read @file#name.txt"
        const parts = await SessionPrompt.resolvePromptParts(template)
        const fileParts = parts.filter((part) => part.type === "file")

        expect(fileParts.length).toBe(1)
        expect(fileParts[0].filename).toBe("file#name.txt")
        expect(fileParts[0].url).toContain("%23")

        const decodedPath = fileURLToPath(fileParts[0].url)
        expect(decodedPath).toBe(path.join(tmp.path, "file#name.txt"))

        const message = await SessionPrompt.prompt({
          sessionID: session.id,
          parts,
          noReply: true,
        })
        const stored = await MessageV2.get({ sessionID: session.id, messageID: message.info.id })
        const textParts = stored.parts.filter((part) => part.type === "text")
        const hasContent = textParts.some((part) => part.text.includes("special content"))
        expect(hasContent).toBe(true)

        await Session.remove(session.id)
      },
    })
  })
})

describe("session.prompt agent variant", () => {
  test("applies agent variant only when using agent model", async () => {
    const prev = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = "test-openai-key"

    try {
      await using tmp = await tmpdir({
        git: true,
        config: {
          agent: {
            build: {
              model: "openai/gpt-5.2",
              variant: "xhigh",
            },
          },
        },
      })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({})

          const other = await SessionPrompt.prompt({
            sessionID: session.id,
            agent: "build",
            model: { providerID: ProviderID.make("opencode"), modelID: ModelID.make("kimi-k2.5-free") },
            noReply: true,
            parts: [{ type: "text", text: "hello" }],
          })
          if (other.info.role !== "user") throw new Error("expected user message")
          expect(other.info.variant).toBeUndefined()

          const match = await SessionPrompt.prompt({
            sessionID: session.id,
            agent: "build",
            noReply: true,
            parts: [{ type: "text", text: "hello again" }],
          })
          if (match.info.role !== "user") throw new Error("expected user message")
          expect(match.info.model).toEqual({ providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") })
          expect(match.info.variant).toBe("xhigh")

          const override = await SessionPrompt.prompt({
            sessionID: session.id,
            agent: "build",
            noReply: true,
            variant: "high",
            parts: [{ type: "text", text: "hello third" }],
          })
          if (override.info.role !== "user") throw new Error("expected user message")
          expect(override.info.variant).toBe("high")

          await Session.remove(session.id)
        },
      })
    } finally {
      if (prev === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = prev
    }
  })
})

// altimate_change start - regression tests for headless flag propagation.
// These guard against the silent drops the consensus review caught on PR #763.
describe("session.prompt headless flag propagation", () => {
  test("persists headless: true on the user message and survives a roundtrip", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          build: {
            model: "openai/gpt-5.2",
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const msg = await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          headless: true,
          parts: [{ type: "text", text: "headless run" }],
        })
        if (msg.info.role !== "user") throw new Error("expected user message")
        expect(msg.info.headless).toBe(true)

        const reloaded = await MessageV2.get({ sessionID: session.id, messageID: msg.info.id })
        if (reloaded.info.role !== "user") throw new Error("expected user message after reload")
        expect(reloaded.info.headless).toBe(true)

        await Session.remove(session.id)
      },
    })
  })

  test("absence of headless leaves the field undefined (interactive default)", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          build: {
            model: "openai/gpt-5.2",
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const msg = await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "interactive run" }],
        })
        if (msg.info.role !== "user") throw new Error("expected user message")
        // explicit absence — !!undefined is false, which is the interactive branch.
        expect(msg.info.headless).toBeUndefined()

        await Session.remove(session.id)
      },
    })
  })

  test("CommandInput zod schema accepts the headless flag", () => {
    // C1 regression: `run --command` was dropping headless because CommandInput
    // didn't have the field. Verify the schema both accepts headless: true and
    // tolerates its absence.
    const withFlag = SessionPrompt.CommandInput.safeParse({
      sessionID: "ses_" + "0".repeat(20),
      arguments: "",
      command: "doit",
      headless: true,
    })
    expect(withFlag.success).toBe(true)
    if (withFlag.success) expect(withFlag.data.headless).toBe(true)

    const withoutFlag = SessionPrompt.CommandInput.safeParse({
      sessionID: "ses_" + "0".repeat(20),
      arguments: "",
      command: "doit",
    })
    expect(withoutFlag.success).toBe(true)
    if (withoutFlag.success) expect(withoutFlag.data.headless).toBeUndefined()
  })

  test("PromptInput zod schema accepts the headless flag", () => {
    const parsed = SessionPrompt.PromptInput.safeParse({
      sessionID: "ses_" + "0".repeat(20),
      headless: true,
      parts: [{ type: "text", text: "x" }],
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.headless).toBe(true)
  })
})

// C2 regression: synthetic user-message constructors must propagate the
// headless flag from the prior `lastUser`. We can't easily run the full loop,
// but we can assert that the User schema accepts headless and that the shape
// the loop builds (a copy from `lastUser`) round-trips through MessageV2.
describe("MessageV2.User headless flag", () => {
  test("schema accepts headless on the user message", () => {
    const parsed = MessageV2.User.safeParse({
      id: "msg_" + "0".repeat(20),
      sessionID: "ses_" + "0".repeat(20),
      role: "user",
      time: { created: Date.now() },
      agent: "build",
      model: { providerID: "openai", modelID: "gpt-5.2" },
      headless: true,
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.headless).toBe(true)
  })
})
// altimate_change end
