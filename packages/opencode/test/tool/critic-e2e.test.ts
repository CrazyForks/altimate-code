/**
 * End-to-end: the critic gate wrapped around the REAL BashTool, exercising the
 * exact orchestration prompt.ts uses (gate -> if allowed, execute). No mocked
 * tool calls — bash actually runs and really touches the filesystem. The only
 * thing never handed to the real shell is a catastrophic command: the gate must
 * block it BEFORE execution, which these tests assert.
 */
import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Critic } from "../../src/tool/critic"
import { BashTool } from "../../src/tool/bash"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import { SessionID, MessageID } from "../../src/session/schema"

const ctx = {
  sessionID: SessionID.make("ses_critic_e2e"),
  messageID: MessageID.make(""),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
  ask: async () => {},
}

/** Mirrors the prompt.ts wrapper: gate first; only execute the real tool if allowed. */
async function gatedRun(
  toolName: string,
  args: Record<string, any>,
  realExecute: () => Promise<{ output: string }>,
): Promise<{ blocked: boolean; output: string; executed: boolean }> {
  let executed = false
  if (Critic.enabled()) {
    const verdict = await Critic.gate(toolName, args, Critic.basicSafetyVerifier)
    if (!verdict.allow) {
      return { blocked: true, output: verdict.feedback ?? "", executed }
    }
  }
  const r = await realExecute()
  executed = true
  return { blocked: false, output: r.output, executed }
}

afterEach(() => delete process.env["ALTIMATE_CRITIC_GATE"])

describe("critic e2e — real BashTool through the gate", () => {
  test("enabled: safe command passes the gate AND actually executes", async () => {
    process.env["ALTIMATE_CRITIC_GATE"] = "1"
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const bash = await BashTool.init()
        const res = await gatedRun("bash", { command: "echo CRITIC_E2E_MARKER" }, async () => {
          const r = await bash.execute({ command: "echo CRITIC_E2E_MARKER", description: "echo" }, ctx)
          return { output: r.output }
        })
        expect(res.blocked).toBe(false)
        expect(res.executed).toBe(true)
        expect(res.output).toContain("CRITIC_E2E_MARKER")
      },
    })
  })

  test("enabled: a non-fatal rm passes the gate and really deletes the file", async () => {
    process.env["ALTIMATE_CRITIC_GATE"] = "1"
    await using tmp = await tmpdir({ git: true })
    const victim = path.join(tmp.path, "victim.txt")
    await fs.writeFile(victim, "delete me")
    expect(await Bun.file(victim).exists()).toBe(true)

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const bash = await BashTool.init()
        const res = await gatedRun("bash", { command: `rm -rf ${victim}` }, async () => {
          const r = await bash.execute({ command: `rm -rf ${victim}`, description: "rm victim" }, ctx)
          return { output: r.output }
        })
        expect(res.blocked).toBe(false)
        expect(res.executed).toBe(true)
      },
    })
    // Real filesystem side-effect: the file is gone.
    expect(await Bun.file(victim).exists()).toBe(false)
  })

  test("enabled: catastrophic command is blocked BEFORE the real shell runs", async () => {
    process.env["ALTIMATE_CRITIC_GATE"] = "1"
    await using tmp = await tmpdir({ git: true })
    const sentinel = path.join(tmp.path, "sentinel.txt")
    await fs.writeFile(sentinel, "must survive")

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const bash = await BashTool.init()
        // The closure references the real bash with a fatal command, but the gate
        // must short-circuit so it is NEVER invoked.
        const res = await gatedRun("bash", { command: "rm -rf /" }, async () => {
          const r = await bash.execute({ command: "rm -rf /", description: "DANGER" }, ctx)
          return { output: r.output }
        })
        expect(res.blocked).toBe(true)
        expect(res.executed).toBe(false)
        expect(res.output).toContain("Blocked by altimate verifier")
      },
    })
    // Nothing executed -> the sentinel (and the machine) is untouched.
    expect(await Bun.file(sentinel).exists()).toBe(true)
    expect(await fs.readFile(sentinel, "utf8")).toBe("must survive")
  })

  test("disabled (default): the gate is transparent — safe commands run unchanged", async () => {
    // Flag unset. gatedRun skips the gate entirely.
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const bash = await BashTool.init()
        const res = await gatedRun("bash", { command: "echo DISABLED_PATH" }, async () => {
          const r = await bash.execute({ command: "echo DISABLED_PATH", description: "echo" }, ctx)
          return { output: r.output }
        })
        expect(res.blocked).toBe(false)
        expect(res.executed).toBe(true)
        expect(res.output).toContain("DISABLED_PATH")
      },
    })
  })

  test("disabled (default): even a catastrophic command is NOT blocked by the gate", async () => {
    // Pure gate check — we never hand this to the real shell. Proves default-off
    // is a true no-op so the upstream run path is unchanged.
    const verdict = await Critic.gate("bash", { command: "rm -rf /" }, Critic.basicSafetyVerifier)
    expect(verdict.allow).toBe(true)
    expect(Critic.enabled()).toBe(false)
  })
})
