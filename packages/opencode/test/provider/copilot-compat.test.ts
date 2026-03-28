import { describe, test, expect } from "bun:test"
import { mapOpenAICompatibleFinishReason } from "../../src/provider/sdk/copilot/chat/map-openai-compatible-finish-reason"
import { getResponseMetadata } from "../../src/provider/sdk/copilot/chat/get-response-metadata"

describe("mapOpenAICompatibleFinishReason", () => {
  test("maps 'stop' to 'stop'", () => {
    expect(mapOpenAICompatibleFinishReason("stop")).toBe("stop")
  })

  test("maps 'length' to 'length'", () => {
    expect(mapOpenAICompatibleFinishReason("length")).toBe("length")
  })

  test("maps 'content_filter' to 'content-filter'", () => {
    expect(mapOpenAICompatibleFinishReason("content_filter")).toBe("content-filter")
  })

  test("maps 'function_call' to 'tool-calls'", () => {
    expect(mapOpenAICompatibleFinishReason("function_call")).toBe("tool-calls")
  })

  test("maps 'tool_calls' to 'tool-calls'", () => {
    expect(mapOpenAICompatibleFinishReason("tool_calls")).toBe("tool-calls")
  })

  test("maps null to 'unknown'", () => {
    expect(mapOpenAICompatibleFinishReason(null)).toBe("unknown")
  })

  test("maps undefined to 'unknown'", () => {
    expect(mapOpenAICompatibleFinishReason(undefined)).toBe("unknown")
  })

  test("maps unrecognized string to 'unknown'", () => {
    expect(mapOpenAICompatibleFinishReason("cancelled")).toBe("unknown")
    expect(mapOpenAICompatibleFinishReason("error")).toBe("unknown")
    expect(mapOpenAICompatibleFinishReason("")).toBe("unknown")
  })
})

describe("getResponseMetadata", () => {
  test("converts all fields when present", () => {
    const result = getResponseMetadata({
      id: "chatcmpl-abc123",
      model: "gpt-4",
      created: 1700000000,
    })

    expect(result.id).toBe("chatcmpl-abc123")
    expect(result.modelId).toBe("gpt-4")
    expect(result.timestamp).toEqual(new Date(1700000000 * 1000))
  })

  test("returns undefined fields when inputs are null", () => {
    const result = getResponseMetadata({
      id: null,
      model: null,
      created: null,
    })

    expect(result.id).toBeUndefined()
    expect(result.modelId).toBeUndefined()
    expect(result.timestamp).toBeUndefined()
  })

  test("returns undefined fields when inputs are undefined", () => {
    const result = getResponseMetadata({
      id: undefined,
      model: undefined,
      created: undefined,
    })

    expect(result.id).toBeUndefined()
    expect(result.modelId).toBeUndefined()
    expect(result.timestamp).toBeUndefined()
  })

  test("handles empty input object", () => {
    const result = getResponseMetadata({})

    expect(result.id).toBeUndefined()
    expect(result.modelId).toBeUndefined()
    expect(result.timestamp).toBeUndefined()
  })

  test("converts created=0 to epoch Date (not undefined)", () => {
    // created=0 is falsy but not null/undefined, so it should produce a Date
    const result = getResponseMetadata({ created: 0 })
    expect(result.timestamp).toEqual(new Date(0))
  })

  test("converts created timestamp correctly for recent dates", () => {
    // 2026-01-15 12:00:00 UTC
    const epoch = 1768478400
    const result = getResponseMetadata({ created: epoch })
    expect(result.timestamp?.getFullYear()).toBe(2026)
  })
})
