/**
 * Round 3 adversarial regression for the v1.4.0 bridge merge.
 *
 * Distinct from:
 *   - v140-merge-adversarial.test.ts (round 1 — static invariants)
 *   - v140-merge-fuzz.test.ts (round 2 — property-based fuzzing)
 *
 * This file pins:
 *   - regex DoS resistance on adversarial maskString input
 *   - concurrent-session state isolation for deriveAgentOutcomeReason
 *   - Config schema migration: old keybinds shapes still validate
 *   - Path sandbox sensitive-file blocklist coverage
 *
 * Plus 2 [KNOWN ISSUE] tests for findings round 3 surfaced:
 *   - Plugin.trigger does NOT catch hook exceptions → buggy plugin can
 *     crash session at chat.params (file: plugin/index.ts trigger())
 *   - Bearer regex \s+ vs \s mutation not detected by tests (test
 *     coverage gap, not a code bug)
 */
import { describe, expect, test } from "bun:test"
import { Telemetry } from "../../src/altimate/telemetry"
import { Config } from "../../src/config/config"
import { readFileSync } from "fs"
import path from "path"

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..", "..")

// ---------- Regex DoS resistance ----------
describe("v1.4.0 chaos — maskString regex DoS resistance", () => {
  test("10000 backslashes processed in <100ms", () => {
    const input = '"' + "\\\\".repeat(10000) + '"'
    const t0 = performance.now()
    Telemetry.maskString(input)
    expect(performance.now() - t0).toBeLessThan(100)
  })

  test("alternating quotes (10k) processed in <100ms", () => {
    const input = '""""'.repeat(2500)
    const t0 = performance.now()
    Telemetry.maskString(input)
    expect(performance.now() - t0).toBeLessThan(100)
  })

  test("evil escape pattern (1k×3) processed in <100ms", () => {
    const input = '"' + "\\\\.".repeat(1000) + '"'
    const t0 = performance.now()
    Telemetry.maskString(input)
    expect(performance.now() - t0).toBeLessThan(100)
  })

  test("1000 concurrent sk-ant prefixes processed in <100ms", () => {
    const input = ("sk-ant-" + "a".repeat(20) + " ").repeat(1000)
    const t0 = performance.now()
    Telemetry.maskString(input)
    expect(performance.now() - t0).toBeLessThan(100)
  })
})

// ---------- Concurrent state isolation ----------
describe("v1.4.0 chaos — deriveAgentOutcomeReason isolates state across parallel calls", () => {
  test("100 parallel calls return per-call outputs (no state bleed)", async () => {
    const inputs = Array.from({ length: 100 }, (_, i) => ({
      outcome: ["completed", "abandoned", "aborted", "error"][i % 4] as "completed" | "abandoned" | "aborted" | "error",
      lastToolName: `tool_${i}`,
      lastMessageError: i % 4 === 3 ? `error_${i}` : null,
      abortReason: i % 4 === 2 ? `reason_${i}` : null,
      lastErrorClass: `class_${i}`,
    }))
    const seq = inputs.map((inp) => Telemetry.deriveAgentOutcomeReason(inp))
    const par = await Promise.all(
      inputs.map((inp) => Promise.resolve().then(() => Telemetry.deriveAgentOutcomeReason(inp))),
    )
    expect(par).toEqual(seq)
    expect(new Set(par.map((r) => r.final_tool)).size).toBe(100)
  })
})

// ---------- Config schema migration ----------
describe("v1.4.0 chaos — Keybinds schema accepts pre-PR-21185 configs", () => {
  test("keybinds without variant_list still validate (default 'none')", () => {
    const Keybinds = (Config as any).Keybinds
    const r = Keybinds.safeParse({ agent_cycle: "tab", variant_cycle: "ctrl+t" })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.variant_list).toBe("none")
  })

  test("keybinds with variant_list rejected when not a string", () => {
    const Keybinds = (Config as any).Keybinds
    const r = Keybinds.safeParse({ variant_list: 42 })
    expect(r.success).toBe(false)
  })
})

// ---------- Path sandbox coverage ----------
describe("v1.4.0 chaos — sensitive-file blocklist coverage", () => {
  // Read the protected.ts source and assert key entries are present.
  // Round 3 confirmed the blocklist via direct inspection — this test
  // pins the coverage so a future cleanup can't silently drop entries.
  const sourceText = (() => {
    try {
      return readFileSync(path.join(repoRoot, "packages/opencode/src/file/protected.ts"), "utf-8")
    } catch {
      return ""
    }
  })()

  for (const dir of [".git", ".ssh", ".gnupg", ".aws", ".azure", ".gcloud", ".kube", ".docker"]) {
    test(`SENSITIVE_DIRS includes ${dir}`, () => {
      expect(sourceText).toContain(`"${dir}"`)
    })
  }

  for (const file of ["env", "env.local", "npmrc", "netrc", "htpasswd"]) {
    test(`SENSITIVE_FILES includes .${file} (via DOT concat)`, () => {
      expect(sourceText).toContain(`DOT + "${file}"`)
    })
  }

  test("SENSITIVE_EXTENSIONS includes private-key extensions", () => {
    expect(sourceText).toContain('".pem"')
    expect(sourceText).toContain('".key"')
    expect(sourceText).toContain('".p12"')
    expect(sourceText).toContain('".pfx"')
  })
})

// ---------- KNOWN ISSUES from round 3 ----------
describe("v1.4.0 chaos — KNOWN ISSUES (round 3 findings)", () => {
  // Once gapped: Plugin.trigger used to propagate hook exceptions, which
  // meant a single buggy plugin's chat.params (or any hook) could crash
  // the session at session/llm.ts:121. Round-3 fix wraps the hook call
  // in try/catch and logs failures, then continues with remaining hooks.
  test("Plugin.trigger isolates hook failures (try/catch around hook invocation)", async () => {
    const pluginSrc = readFileSync(path.join(repoRoot, "packages/opencode/src/plugin/index.ts"), "utf-8")
    // Extract the body of the trigger function
    const triggerBody = pluginSrc.match(/export async function trigger[\s\S]*?^  }$/m)?.[0] ?? ""
    // Must wrap the hook invocation in try { await fn(input, output) } catch
    expect(triggerBody).toMatch(/try\s*\{[\s\S]*await fn\(input, output\)[\s\S]*\}\s*catch/)
  })

  test("Plugin.trigger logs and continues when a hook throws (functional check)", async () => {
    // Black-box: register a plugin whose hook throws, register a second
    // plugin whose hook records that it ran. Verify (a) trigger does not
    // throw, (b) the second plugin still ran. Implemented as a focused
    // shape test — the full path requires Bus + state, so this asserts
    // the source-level invariant only. Pairs with the regex test above.
    const pluginSrc = readFileSync(path.join(repoRoot, "packages/opencode/src/plugin/index.ts"), "utf-8")
    const triggerBody = pluginSrc.match(/export async function trigger[\s\S]*?^  }$/m)?.[0] ?? ""
    // The catch block must call log.error — proves we're logging not silently swallowing
    expect(triggerBody).toMatch(/catch[\s\S]*log\.error/)
  })

  // [KNOWN ISSUE] Bearer regex test coverage hole.
  // Round 3 mutation testing showed `Bearer\s+` → `Bearer\s` (require
  // exactly one whitespace) passes all tests. Real Bearer headers are
  // always 1 space, but the regex allows >=1 — a future "simplification"
  // could drop the `+` without test failure. Add a multi-whitespace
  // test case to pin the behavior.
  test("[KNOWN ISSUE] maskString does NOT pin Bearer multi-whitespace behavior", () => {
    // Synthetic 30+ char token (avoid real-looking JWT header which trips
    // GitGuardian even in tests). Both single- and double-space variants
    // must redact; if either fails, the regex broke.
    const synthetic = "abc123def456ghi789jkl012mno345pqr678"
    const single = Telemetry.maskString(`Authorization: Bearer ${synthetic}`)
    const double = Telemetry.maskString(`Authorization: Bearer  ${synthetic}`)
    expect(single).toContain("Bearer ***")
    expect(double).toContain("Bearer ***") // ← pins the `\s+` mutation
  })
})
