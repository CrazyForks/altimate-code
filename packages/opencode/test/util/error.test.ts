import { describe, expect, test } from "bun:test"
import { errorData, errorFormat, errorMessage } from "../../src/util/error"

describe("util.error", () => {
  test("formats native Error instances", () => {
    const err = new Error("boom")
    expect(errorMessage(err)).toBe("boom")
    expect(errorFormat(err)).toContain("boom")

    const data = errorData(err)
    expect(data.type).toBe("Error")
    expect(data.message).toBe("boom")
    expect(String(data.formatted)).toContain("boom")
  })

  test("extracts message from record-like values", () => {
    const err = { message: "bad input", code: "E_BAD" }
    expect(errorMessage(err)).toBe("bad input")

    const data = errorData(err)
    expect(data.message).toBe("bad input")
    expect(data.code).toBe("E_BAD")
  })

  test("handles opaque throwables with custom toString", () => {
    const err = {
      toString() {
        return "ResolveMessage: Cannot resolve module"
      },
    }

    expect(errorMessage(err)).toBe("ResolveMessage: Cannot resolve module")

    const data = errorData(err)
    expect(data.message).toBe("ResolveMessage: Cannot resolve module")
    expect(String(data.formatted)).toContain("ResolveMessage")
  })

  // Regression: bare-name messages like "Error" or matching error.name carry
  // no info — augment with the first stack frame so users don't see opaque
  // "Error" in the TUI for the idle-timeout class of bugs (PR #118/#133).
  test("augments bare 'Error' message with first stack frame", () => {
    const err = new Error("Error")
    const result = errorMessage(err)
    expect(result.startsWith("Error: ")).toBe(true)
    expect(result).toContain("at ")
  })

  test("augments message that matches error.name with first stack frame", () => {
    class APIError extends Error {
      override name = "APIError"
    }
    const err = new APIError("APIError")
    const result = errorMessage(err)
    expect(result.startsWith("APIError: ")).toBe(true)
    expect(result).toContain("at ")
  })

  test("preserves real message when error.message is informative", () => {
    const err = new Error("connection refused")
    expect(errorMessage(err)).toBe("connection refused")
  })

  test("returns informative fallback when 'Error' message has no stack", () => {
    const err = new Error("Error")
    err.stack = undefined
    // Without a stack we can't add context, but we still must not return the
    // bare useless "Error" — return our descriptive fallback instead.
    const result = errorMessage(err)
    expect(result).not.toBe("Error")
    expect(result.length).toBeGreaterThan("Error".length)
  })
})
