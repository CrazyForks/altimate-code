import { afterEach, describe, expect, test } from "bun:test"
import { Critic } from "../../src/tool/critic"

afterEach(() => delete process.env["ALTIMATE_CRITIC_GATE"])

describe("Critic.gate", () => {
  test("disabled by default -> allow even a gated+denying call", async () => {
    const deny: Critic.Verifier = { verify: () => ({ ok: false, reason: "x" }) }
    expect((await Critic.gate("bash", {}, deny)).allow).toBe(true)
  })

  test("enabled: non-gated tool always allowed", async () => {
    process.env["ALTIMATE_CRITIC_GATE"] = "1"
    expect((await Critic.gate("read", {}, Critic.ALLOW_ALL)).allow).toBe(true)
  })

  test("enabled: gated + allow-all verifier -> allow", async () => {
    process.env["ALTIMATE_CRITIC_GATE"] = "1"
    expect((await Critic.gate("bash", { command: "ls" }, Critic.ALLOW_ALL)).allow).toBe(true)
  })

  test("enabled: gated + failing verifier -> block with feedback", async () => {
    process.env["ALTIMATE_CRITIC_GATE"] = "1"
    const deny: Critic.Verifier = { verify: () => ({ ok: false, reason: "unsafe SQL" }) }
    const g = await Critic.gate("sql_execute", { q: "drop" }, deny)
    expect(g.allow).toBe(false)
    expect(g.feedback).toContain("unsafe SQL")
  })

  test("enabled: verifier throws -> fail-open (allow)", async () => {
    process.env["ALTIMATE_CRITIC_GATE"] = "1"
    const boom: Critic.Verifier = { verify: () => { throw new Error("down") } }
    expect((await Critic.gate("bash", {}, boom)).allow).toBe(true)
  })

  test("isGated: side-effecting yes, reads no", () => {
    expect(Critic.isGated("bash")).toBe(true)
    expect(Critic.isGated("read")).toBe(false)
  })
})
