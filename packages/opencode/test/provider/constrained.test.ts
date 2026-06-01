import { describe, expect, test } from "bun:test"
import { Constrained } from "../../src/provider/constrained"

const TOOLS: Constrained.ToolSchema[] = [
  {
    name: "bash",
    description: "run a shell command",
    parameters: {
      type: "object",
      properties: { command: { type: "string" }, timeout: { type: "number" } },
      required: ["command"],
    },
  },
  { name: "list_databases", description: "no-arg tool", parameters: { type: "object", properties: {} } },
]

describe("Constrained.toolCallEnvelope", () => {
  test("builds a oneOf discriminated union, name pinned per tool", () => {
    const env = Constrained.toolCallEnvelope(TOOLS)
    expect(Array.isArray(env.oneOf)).toBe(true)
    expect(env.oneOf).toHaveLength(2)
    const bash = env.oneOf[0]
    expect(bash.properties.name.const).toBe("bash")
    expect(bash.properties.arguments.required).toEqual(["command"])
    expect(bash.properties.arguments.additionalProperties).toBe(false)
    expect(bash.additionalProperties).toBe(false)
  })

  test("no-arg tool constrains arguments to an empty object", () => {
    const env = Constrained.toolCallEnvelope(TOOLS)
    const noarg = env.oneOf[1]
    expect(noarg.properties.name.const).toBe("list_databases")
    expect(noarg.properties.arguments.properties).toEqual({})
    expect(noarg.properties.arguments.type).toBe("object")
  })

  test("throws on empty tool set", () => {
    expect(() => Constrained.toolCallEnvelope([])).toThrow()
  })
})

describe("Constrained.guidedOptions", () => {
  test("response_format json_schema (default)", () => {
    const o = Constrained.guidedOptions(TOOLS)
    expect(o.response_format.type).toBe("json_schema")
    expect(o.response_format.json_schema.name).toBe("tool_call")
    expect(o.response_format.json_schema.strict).toBe(true)
    expect(o.response_format.json_schema.schema.oneOf).toHaveLength(2)
  })

  test("guided_json fallback for older vLLM", () => {
    const o = Constrained.guidedOptions(TOOLS, "guided_json")
    expect(o.guided_json.oneOf).toHaveLength(2)
  })
})

describe("Constrained gating", () => {
  test("enabled() reads the env flag", () => {
    const prev = process.env["ALTIMATE_CONSTRAINED_TOOLCALLS"]
    process.env["ALTIMATE_CONSTRAINED_TOOLCALLS"] = "1"
    expect(Constrained.enabled()).toBe(true)
    delete process.env["ALTIMATE_CONSTRAINED_TOOLCALLS"]
    expect(Constrained.enabled()).toBe(false)
    if (prev !== undefined) process.env["ALTIMATE_CONSTRAINED_TOOLCALLS"] = prev
  })

  test("isLocalProvider: openai-compatible + known local ids, not hosted", () => {
    expect(Constrained.isLocalProvider("@ai-sdk/openai-compatible", "vllm")).toBe(true)
    expect(Constrained.isLocalProvider(undefined, "lmstudio")).toBe(true)
    expect(Constrained.isLocalProvider("@ai-sdk/anthropic", "anthropic")).toBe(false)
    expect(Constrained.isLocalProvider("@ai-sdk/openai", "openai")).toBe(false)
  })
})
