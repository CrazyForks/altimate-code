/**
 * Adversarial probes for the critic gate's default safety heuristic.
 *
 * Two purposes:
 *  1. Confirm the heuristic catches the obfuscations it CLAIMS to catch
 *     (whitespace, quote-wrapping, flag reordering, sudo/compound prefixes).
 *  2. Honestly DOCUMENT the obfuscations it does NOT catch. The default verifier
 *     is a best-effort safety net, not a security boundary — a determined caller
 *     can always evade literal pattern matching. These "known bypass" tests are
 *     guardrails against over-claiming: if one ever starts being caught, great,
 *     but we never depend on it. Real isolation is the OS sandbox + permission
 *     system + a richer pluggable verifier.
 */
import { describe, expect, test } from "bun:test"
import { Critic } from "../../src/tool/critic"

describe("critic adversarial — obfuscations that ARE caught", () => {
  const caught = [
    "rm     -rf      /", // arbitrary whitespace
    "\trm -rf /\n", // surrounding control whitespace
    "RM -RF /", // case (heuristic lowercases; harmless over-match)
    'bash -c "rm -rf /"', // shell wrapper, quotes stripped
    "sh -c 'rm -rf /'", // single-quote wrapper
    'r""m -rf /', // quote splicing inside the command name
    "sudo rm -rf /", // privilege prefix
    "nohup rm -rf / &", // backgrounded
    "true; rm -rf /", // statement separator
    "ls && rm -rf ~", // conjunction, home target
    "rm -rf /var", // system path
    "/bin/rm -rf /", // fully-qualified rm path
    "/usr/bin/rm -rf /", // fully-qualified rm in /usr/bin
    "sudo -E rm -rf /", // privilege prefix with a flag
    "rm -rf ${HOME}", // brace-expanded $HOME
  ]
  for (const cmd of caught) {
    test(`caught: ${JSON.stringify(cmd)}`, () => {
      expect(Critic.detectDangerousBash(cmd)).not.toBeNull()
    })
  }
})

describe("critic adversarial — KNOWN bypasses (documented, not depended upon)", () => {
  // These evade literal matching. We assert current behavior so the limitation is
  // explicit and reviewed, NOT because allowing them is desirable.
  const knownBypasses = [
    "$(echo rm) -rf /", // command substitution splits the rm token
    "`echo rm` -rf /", // backtick substitution — `echo` is not a transparent prefix, so rm isn't in command position
    "echo cm0gLXJmIC8K | base64 -d | sh", // base64-encoded `rm -rf /`
    "find / -delete", // destructive without rm
    "rm -rf $TARGET", // target hidden behind a variable
    "alias x='rm -rf /'; x", // aliased
    "xargs rm -rf < /tmp/list", // target via stdin (no literal fatal target token)
  ]
  for (const cmd of knownBypasses) {
    test(`known bypass (returns null today): ${JSON.stringify(cmd)}`, () => {
      expect(Critic.detectDangerousBash(cmd)).toBeNull()
    })
  }
})

describe("critic adversarial — gate never throws, regardless of input", () => {
  test("malformed/pathological args do not crash the gate (fail-open)", async () => {
    process.env["ALTIMATE_CRITIC_GATE"] = "1"
    const inputs: any[] = [
      undefined,
      null,
      {},
      { command: 123 },
      { command: { nested: true } },
      { command: "x".repeat(100_000) },
      { command: Array(1000).fill("rm -rf /").join(" && ") },
    ]
    for (const args of inputs) {
      const g = await Critic.gate("bash", args ?? {}, Critic.basicSafetyVerifier)
      expect(typeof g.allow).toBe("boolean")
    }
    delete process.env["ALTIMATE_CRITIC_GATE"]
  })

  test("a verifier that returns a malformed verdict is tolerated", async () => {
    process.env["ALTIMATE_CRITIC_GATE"] = "1"
    const weird: Critic.Verifier = { verify: () => ({}) as any }
    // ok is undefined -> falsy -> treated as a block (safe direction), never throws.
    const g = await Critic.gate("bash", { command: "ls" }, weird)
    expect(typeof g.allow).toBe("boolean")
    delete process.env["ALTIMATE_CRITIC_GATE"]
  })

  test("ReDoS guard: a huge whitespace-heavy command returns quickly", () => {
    const big = "rm" + " ".repeat(200_000) + "-rf /"
    const start = performance.now()
    const r = Critic.detectDangerousBash(big)
    const ms = performance.now() - start
    expect(r).not.toBeNull() // collapsed whitespace still matches
    expect(ms).toBeLessThan(250) // no catastrophic backtracking
  })
})
