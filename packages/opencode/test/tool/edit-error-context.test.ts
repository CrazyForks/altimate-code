/**
 * Adversarial tests for edit tool error messages with context snippets.
 *
 * When oldString isn't found, the error should include a snippet of the
 * closest-matching region so the model can self-correct. Issue #470.
 */

import { describe, test, expect } from "bun:test"
import { buildNotFoundMessage } from "../../src/tool/edit"

const FILE_CONTENT = `import { useState } from "react"

function Counter() {
  const [count, setCount] = useState(0)

  return (
    <div>
      <p>Count: {count}</p>
      <button onClick={() => setCount(count + 1)}>Increment</button>
    </div>
  )
}

export default Counter
`

// ---------------------------------------------------------------------------
// buildNotFoundMessage — direct tests (fast, no replacer pipeline)
// ---------------------------------------------------------------------------
describe("buildNotFoundMessage — closest match detection", () => {
  test("finds similar line when model has stale content", () => {
    // Model thinks useState(1) but file has useState(0)
    const msg = buildNotFoundMessage(FILE_CONTENT, "  const [count, setCount] = useState(1)")
    expect(msg).toContain("similar line was found")
    expect(msg).toContain("useState")
    expect(msg).toContain("Re-read the file")
  })

  test("finds similar line for slightly different tag", () => {
    // Model has <p>Score: but file has <p>Count:
    const msg = buildNotFoundMessage(FILE_CONTENT, "      <p>Score: {count}</p>")
    expect(msg).toContain("similar line was found")
    expect(msg).toContain("Nearest match:")
  })

  test("reports 'not found anywhere' for completely different content", () => {
    const msg = buildNotFoundMessage(FILE_CONTENT, "class DatabaseConnection {")
    expect(msg).toContain("not found anywhere")
    expect(msg).toContain("Re-read")
  })

  test("handles empty oldString", () => {
    const msg = buildNotFoundMessage(FILE_CONTENT, "")
    expect(msg).toContain("empty")
  })

  test("handles whitespace-only oldString", () => {
    const msg = buildNotFoundMessage(FILE_CONTENT, "   \n  \n  ")
    expect(msg).toContain("empty")
  })

  test("snippet shows line numbers", () => {
    const msg = buildNotFoundMessage(FILE_CONTENT, "  const [count, setCount] = useState(1)")
    // Should contain line number markers like "4 |"
    expect(msg).toMatch(/\d+ \|/)
  })

  test("snippet window is bounded (not dumping entire file)", () => {
    const largeFile = Array.from({ length: 500 }, (_, i) => `line ${i}: content here`).join("\n")
    const msg = buildNotFoundMessage(largeFile, "line 250: different content here")
    // Should show ~5 lines, not 500
    const snippetLines = msg.split("\n").filter(l => /^\s+\d+ \|/.test(l))
    expect(snippetLines.length).toBeLessThanOrEqual(5)
    expect(snippetLines.length).toBeGreaterThanOrEqual(1)
  })

  test("truncates long search term in error message", () => {
    const longSearch = "x".repeat(200) + " not in file"
    const msg = buildNotFoundMessage(FILE_CONTENT, longSearch)
    // The quoted first line should be truncated to 80 chars
    expect(msg.length).toBeLessThan(500)
  })

  test("finds exact substring match", () => {
    const msg = buildNotFoundMessage(FILE_CONTENT, "const [count, setCount] = useState(0)\n  // extra line not in file")
    // First line matches exactly as substring
    expect(msg).toContain("similar line was found")
    expect(msg).toContain("useState(0)")
  })

  test("skips very short lines to avoid false matches", () => {
    const fileWithShortLines = "a\nb\nc\nfunction realContent() {\n  return true\n}\n"
    const msg = buildNotFoundMessage(fileWithShortLines, "function differentFunction() {")
    // Should match "function realContent()" not "a", "b", or "c"
    if (msg.includes("similar line")) {
      expect(msg).toContain("realContent")
    }
  })

  test("skips lines with wildly different lengths", () => {
    const file = "ab\n" + "a very long line that is completely different from the search ".repeat(5) + "\ncd\n"
    const msg = buildNotFoundMessage(file, "xy")
    // "xy" is too short (< 4 chars) to match against anything
    expect(msg).toContain("not found anywhere")
  })
})

// ---------------------------------------------------------------------------
// Integration: replace() error messages (small files only — replacers are slow)
// ---------------------------------------------------------------------------
describe("replace() error messages — integration", () => {
  test("error includes context when oldString not found", () => {
    const file = "const x = 1\nconst y = 2\nconst z = 3\n"
    try {
      // Need to import replace since buildNotFoundMessage is called from it
      const { replace } = require("../../src/tool/edit")
      replace(file, "const x = 99", "const x = 42")
      expect.unreachable("should have thrown")
    } catch (e: any) {
      expect(e.message).toContain("Could not find oldString")
      // Should have context about the similar line
      expect(e.message).toContain("const x")
    }
  })

  test("identical oldString and newString gives specific error", () => {
    try {
      const { replace } = require("../../src/tool/edit")
      replace("content", "same", "same")
      expect.unreachable("should have thrown")
    } catch (e: any) {
      expect(e.message).toContain("identical")
    }
  })

  test("multiple occurrences still detected", () => {
    const file = "a = 1\nb = 2\na = 1\nc = 3\n"
    try {
      const { replace } = require("../../src/tool/edit")
      replace(file, "a = 1", "a = 99")
      expect.unreachable("should have thrown")
    } catch (e: any) {
      expect(e.message).toContain("multiple matches")
    }
  })
})
