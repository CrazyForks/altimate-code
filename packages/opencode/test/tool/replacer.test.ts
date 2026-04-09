import { describe, test, expect } from "bun:test"
import {
  LineTrimmedReplacer,
  BlockAnchorReplacer,
  WhitespaceNormalizedReplacer,
  IndentationFlexibleReplacer,
  EscapeNormalizedReplacer,
  replace,
  trimDiff,
} from "../../src/tool/edit"

/** Collect all values yielded by a Replacer generator. */
function collect(gen: Generator<string, void, unknown>): string[] {
  return [...gen]
}

// ---------------------------------------------------------------------------
// LineTrimmedReplacer
// ---------------------------------------------------------------------------

describe("LineTrimmedReplacer", () => {
  test("matches lines with different leading whitespace", () => {
    const content = "function foo() {\n    const x = 1\n    return x\n}"
    const find = "const x = 1\nreturn x"

    const results = collect(LineTrimmedReplacer(content, find))

    // Should yield the original indented lines (joined)
    expect(results.length).toBe(1)
    expect(results[0]).toBe("    const x = 1\n    return x")
  })

  test("yields nothing when trimmed content differs", () => {
    const content = "    const x = 1\n    return x"
    const find = "const x = 2\nreturn x"

    const results = collect(LineTrimmedReplacer(content, find))

    expect(results).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// BlockAnchorReplacer
// ---------------------------------------------------------------------------

describe("BlockAnchorReplacer", () => {
  test("returns nothing for fewer than 3 lines", () => {
    const content = "line one\nline two\nline three"
    const find = "line one\nline two"

    const results = collect(BlockAnchorReplacer(content, find))

    expect(results).toHaveLength(0)
  })

  test("picks best match among multiple anchor-matching blocks", () => {
    // Two blocks share the same first/last anchors, different middles.
    const content = [
      "function foo() {",
      "  return x * 100",
      "}",
      "",
      "function foo() {",
      "  return x + 1",
      "}",
    ].join("\n")

    const find = [
      "function foo() {",
      "  return x + 1",
      "}",
    ].join("\n")

    const results = collect(BlockAnchorReplacer(content, find))

    expect(results.length).toBe(1)
    // Should pick the second block (higher similarity in middle lines)
    expect(results[0]).toContain("return x + 1")
  })
})

// ---------------------------------------------------------------------------
// WhitespaceNormalizedReplacer
// ---------------------------------------------------------------------------

describe("WhitespaceNormalizedReplacer", () => {
  test("matches line with extra internal spaces", () => {
    const content = "const  x  =  1"
    const find = "const x = 1"

    const results = collect(WhitespaceNormalizedReplacer(content, find))

    expect(results.length).toBeGreaterThanOrEqual(1)
    // Should yield the original line with its extra spaces
    expect(results[0]).toBe("const  x  =  1")
  })
})

// ---------------------------------------------------------------------------
// IndentationFlexibleReplacer
// ---------------------------------------------------------------------------

describe("IndentationFlexibleReplacer", () => {
  test("matches block at different absolute indentation level", () => {
    // File has the block at 8-space indent, LLM sends it at 2-space indent.
    // Relative structure is the same — removeIndentation strips the minimum
    // indent from both sides, so they should match.
    const content = [
      "class Foo {",
      "        const x = 1",
      "        const y = 2",
      "        const z = 3",
      "}",
    ].join("\n")

    const find = [
      "  const x = 1",
      "  const y = 2",
      "  const z = 3",
    ].join("\n")

    const results = collect(IndentationFlexibleReplacer(content, find))

    expect(results.length).toBe(1)
    // Should yield the original 8-space indented block
    expect(results[0]).toBe("        const x = 1\n        const y = 2\n        const z = 3")
  })
})

// ---------------------------------------------------------------------------
// EscapeNormalizedReplacer
// ---------------------------------------------------------------------------

describe("EscapeNormalizedReplacer", () => {
  test("matches content when find contains escaped characters", () => {
    // Content has an actual newline; find has literal \\n (two chars representing \n)
    const content = 'const msg = "hello\nworld"'
    const find = 'const msg = "hello\\nworld"'

    const results = collect(EscapeNormalizedReplacer(content, find))

    expect(results.length).toBeGreaterThanOrEqual(1)
    // Should yield the actual content with real newline
    expect(results[0]).toContain("hello\nworld")
  })
})

// ---------------------------------------------------------------------------
// replace() chain behavior
// ---------------------------------------------------------------------------

describe("replace() chain fallthrough", () => {
  test("falls through to LineTrimmedReplacer when exact match fails due to indentation", () => {
    const content = "function foo() {\n    const x = 1\n    return x\n}"
    // Find has no indentation — SimpleReplacer won't match, LineTrimmedReplacer should
    const result = replace(content, "const x = 1\nreturn x", "const y = 2\nreturn y")

    expect(result).toContain("const y = 2")
    expect(result).toContain("return y")
    // Surrounding code should be preserved
    expect(result).toContain("function foo()")
  })

  test("throws when no replacer can match", () => {
    const content = "function foo() {\n  return 42\n}"

    expect(() => {
      replace(content, "completely unrelated text that exists nowhere", "replacement")
    }).toThrow("Could not find oldString")
  })
})

// ---------------------------------------------------------------------------
// trimDiff()
// ---------------------------------------------------------------------------

describe("trimDiff", () => {
  test("trims common leading whitespace from diff content lines", () => {
    const diff = [
      "--- a/file.ts",
      "+++ b/file.ts",
      "@@ -1,3 +1,3 @@",
      "         const a = 1",
      "-        const b = 2",
      "+        const b = 3",
      "         const c = 4",
    ].join("\n")

    const result = trimDiff(diff)

    // The 8 common spaces should be stripped from content lines
    expect(result).toContain(" const a = 1")
    expect(result).toContain("-const b = 2")
    expect(result).toContain("+const b = 3")
    // Header lines should be preserved unchanged
    expect(result).toContain("--- a/file.ts")
    expect(result).toContain("+++ b/file.ts")
  })
})
