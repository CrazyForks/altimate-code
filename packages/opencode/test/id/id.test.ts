import { describe, test, expect } from "bun:test"
import { Identifier } from "../../src/id/id"

describe("Identifier: ascending ID generation", () => {
  test("returns ID with correct prefix for each type", () => {
    const prefixes: Record<string, string> = {
      session: "ses_",
      message: "msg_",
      permission: "per_",
      question: "que_",
      user: "usr_",
      part: "prt_",
      pty: "pty_",
      tool: "tool_",
      workspace: "wrk_",
    }
    for (const [key, expected] of Object.entries(prefixes)) {
      const id = Identifier.ascending(key as any)
      expect(id.startsWith(expected)).toBe(true)
    }
  })

  test("ascending IDs at distinct timestamps sort lexicographically", () => {
    const t1 = 1700000000000
    const t2 = 1700000001000
    const t3 = 1700000002000
    const id1 = Identifier.create("message", false, t1)
    const id2 = Identifier.create("message", false, t2)
    const id3 = Identifier.create("message", false, t3)
    // Lexicographic sort should match chronological order
    const sorted = [id3, id1, id2].sort()
    expect(sorted).toEqual([id1, id2, id3])
  })

  test("ascending IDs at same timestamp still sort via monotonic counter", () => {
    const ts = 1700000050000
    // Reset counter by using a fresh timestamp
    Identifier.create("session", false, ts - 1)
    const id1 = Identifier.create("session", false, ts)
    const id2 = Identifier.create("session", false, ts)
    const id3 = Identifier.create("session", false, ts)
    expect(id1).not.toBe(id2)
    expect(id2).not.toBe(id3)
    // Counter increments should maintain ascending order in the time portion
    const hex1 = id1.slice(4, 16)
    const hex2 = id2.slice(4, 16)
    const hex3 = id3.slice(4, 16)
    expect(hex1 < hex2).toBe(true)
    expect(hex2 < hex3).toBe(true)
  })
})

describe("Identifier: descending ID generation", () => {
  test("descending IDs at distinct timestamps sort in reverse chronological order", () => {
    const t1 = 1700000000000
    const t2 = 1700000001000
    const t3 = 1700000002000
    // Reset counter between timestamps
    const id1 = Identifier.create("session", true, t1)
    const id2 = Identifier.create("session", true, t2)
    const id3 = Identifier.create("session", true, t3)
    // Lexicographic sort of descending IDs should give newest first
    const sorted = [id1, id2, id3].sort()
    expect(sorted).toEqual([id3, id2, id1])
  })
})

describe("Identifier: timestamp extraction preserves ordering", () => {
  test("earlier timestamp produces smaller extracted value", () => {
    const t1 = 1700000000000
    const t2 = 1700000001000
    // Reset counter
    Identifier.create("message", false, t1 - 1)
    const id1 = Identifier.create("message", false, t1)
    Identifier.create("message", false, t2 - 1)
    const id2 = Identifier.create("message", false, t2)
    // Ordering must be preserved even though absolute values may be truncated
    expect(Identifier.timestamp(id1)).toBeLessThan(Identifier.timestamp(id2))
  })

  test("works correctly for tool prefix (4-char prefix)", () => {
    const t1 = 1700000000000
    const t2 = 1700000005000
    Identifier.create("tool", false, t1 - 1)
    const id1 = Identifier.create("tool", false, t1)
    Identifier.create("tool", false, t2 - 1)
    const id2 = Identifier.create("tool", false, t2)
    expect(Identifier.timestamp(id1)).toBeLessThan(Identifier.timestamp(id2))
  })
})

describe("Identifier: given ID validation", () => {
  test("ascending with valid given ID returns it unchanged", () => {
    const given = "ses_abc123"
    expect(Identifier.ascending("session", given)).toBe(given)
  })

  test("ascending with wrong prefix throws", () => {
    expect(() => Identifier.ascending("session", "msg_abc123")).toThrow(
      "ID msg_abc123 does not start with ses",
    )
  })

  test("descending with wrong prefix throws", () => {
    expect(() => Identifier.descending("message", "ses_abc123")).toThrow(
      "ID ses_abc123 does not start with msg",
    )
  })
})
