import { describe, expect, test } from "bun:test"
import { Decimal } from "decimal.js"
import { z } from "zod"

// ---------------------------------------------------------------------------
// Test 1-3: Tool injection logic
// ---------------------------------------------------------------------------

describe("advisor.toolInjection", () => {
  function injectAdvisor(opts: {
    enabled?: boolean
    npm: string
    small?: boolean
    model?: string
    max_uses?: number
    caching?: boolean
  }) {
    const tools: Record<string, unknown> = {}
    const warnings: string[] = []

    const advisorCfg = opts.enabled
      ? {
          enabled: true as const,
          model: opts.model ?? "claude-opus-4-6",
          max_uses: opts.max_uses ?? 3,
          caching: opts.caching ?? true,
        }
      : undefined

    if (advisorCfg?.enabled && opts.npm === "@ai-sdk/anthropic" && !opts.small) {
      tools["advisor"] = {
        type: "provider-defined",
        id: "anthropic.advisor_20260301",
        args: {
          model: advisorCfg.model ?? "claude-opus-4-6",
          maxUses: advisorCfg.max_uses ?? 3,
          caching: advisorCfg.caching ?? true,
        },
      }
    } else if (advisorCfg?.enabled && opts.npm !== "@ai-sdk/anthropic") {
      warnings.push(`advisor enabled but model is not Anthropic — advisor inactive (npm=${opts.npm})`)
    }

    return { tools, warnings }
  }

  test("injects advisor tool when enabled + Anthropic model", () => {
    const { tools, warnings } = injectAdvisor({ enabled: true, npm: "@ai-sdk/anthropic" })

    expect(tools["advisor"]).toBeDefined()
    const advisor = tools["advisor"] as any
    expect(advisor.type).toBe("provider-defined")
    expect(advisor.id).toBe("anthropic.advisor_20260301")
    expect(advisor.args.model).toBe("claude-opus-4-6")
    expect(advisor.args.maxUses).toBe(3)
    expect(advisor.args.caching).toBe(true)
    expect(warnings).toHaveLength(0)
  })

  test("does NOT inject advisor tool when disabled", () => {
    const { tools, warnings } = injectAdvisor({ enabled: false, npm: "@ai-sdk/anthropic" })

    expect(tools["advisor"]).toBeUndefined()
    expect(warnings).toHaveLength(0)
  })

  test("does NOT inject advisor for non-Anthropic models + logs warning", () => {
    const { tools, warnings } = injectAdvisor({ enabled: true, npm: "@ai-sdk/openai" })

    expect(tools["advisor"]).toBeUndefined()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("advisor enabled but model is not Anthropic")
  })

  test("does NOT inject advisor when small=true", () => {
    const { tools, warnings } = injectAdvisor({
      enabled: true,
      npm: "@ai-sdk/anthropic",
      small: true,
    })

    expect(tools["advisor"]).toBeUndefined()
    expect(warnings).toHaveLength(0)
  })

  test("respects custom model and max_uses", () => {
    const { tools } = injectAdvisor({
      enabled: true,
      npm: "@ai-sdk/anthropic",
      model: "claude-sonnet-4-6",
      max_uses: 5,
      caching: false,
    })

    const advisor = tools["advisor"] as any
    expect(advisor.args.model).toBe("claude-sonnet-4-6")
    expect(advisor.args.maxUses).toBe(5)
    expect(advisor.args.caching).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Test 4: Config schema validation
// ---------------------------------------------------------------------------

describe("advisor.configSchema", () => {
  const advisorSchema = z
    .object({
      enabled: z.boolean().default(false),
      model: z.string().default("claude-opus-4-6"),
      max_uses: z.number().int().positive().max(10).default(3),
      caching: z.boolean().default(true),
    })
    .optional()

  test("applies defaults when minimal config provided", () => {
    const result = advisorSchema.parse({ enabled: true })

    expect(result).toEqual({
      enabled: true,
      model: "claude-opus-4-6",
      max_uses: 3,
      caching: true,
    })
  })

  test("accepts undefined (feature disabled)", () => {
    const result = advisorSchema.parse(undefined)
    expect(result).toBeUndefined()
  })

  test("rejects max_uses > 10", () => {
    expect(() => advisorSchema.parse({ enabled: true, max_uses: 11 })).toThrow()
  })

  test("rejects max_uses = 0 (must be positive)", () => {
    expect(() => advisorSchema.parse({ enabled: true, max_uses: 0 })).toThrow()
  })

  test("rejects non-integer max_uses", () => {
    expect(() => advisorSchema.parse({ enabled: true, max_uses: 2.5 })).toThrow()
  })

  test("overrides all defaults when fully specified", () => {
    const result = advisorSchema.parse({
      enabled: true,
      model: "claude-haiku-4-5-20251001",
      max_uses: 7,
      caching: false,
    })

    expect(result).toEqual({
      enabled: true,
      model: "claude-haiku-4-5-20251001",
      max_uses: 7,
      caching: false,
    })
  })
})

// ---------------------------------------------------------------------------
// Test 5-7: advisor_tool_result parsing (non-streaming path)
// ---------------------------------------------------------------------------

describe("advisor.resultParsing", () => {
  // Simulates the non-streaming content block handler from the SDK patch
  function parseAdvisorResult(part: {
    type: string
    tool_use_id: string
    content: { type: string; text?: string; encrypted_content?: string; error_code?: string }
  }) {
    if (part.type !== "advisor_tool_result") return null

    const toolUseId = part.tool_use_id
    if (part.content.type === "advisor_result") {
      return {
        type: "tool-result",
        toolCallId: toolUseId,
        toolName: "advisor",
        result: JSON.stringify({ type: "advisor_result", text: part.content.text }),
        providerExecuted: true,
      }
    } else if (part.content.type === "advisor_redacted_result") {
      return {
        type: "tool-result",
        toolCallId: toolUseId,
        toolName: "advisor",
        result: JSON.stringify({
          type: "advisor_redacted_result",
          encrypted_content: part.content.encrypted_content,
        }),
        providerExecuted: true,
      }
    } else if (part.content.type === "advisor_tool_result_error") {
      return {
        type: "tool-result",
        toolCallId: toolUseId,
        toolName: "advisor",
        isError: true,
        result: JSON.stringify({
          type: "advisor_tool_result_error",
          error_code: part.content.error_code,
        }),
        providerExecuted: true,
      }
    }
    return null
  }

  test("parses advisor_result (success) variant", () => {
    const result = parseAdvisorResult({
      type: "advisor_tool_result",
      tool_use_id: "toolu_abc123",
      content: {
        type: "advisor_result",
        text: "1. Read the config file first\n2. Extract the validation logic\n3. Write unit tests",
      },
    })

    expect(result).not.toBeNull()
    expect(result!.type).toBe("tool-result")
    expect(result!.toolCallId).toBe("toolu_abc123")
    expect(result!.toolName).toBe("advisor")
    expect(result!.providerExecuted).toBe(true)
    expect(result!).not.toHaveProperty("isError")

    const parsed = JSON.parse(result!.result)
    expect(parsed.type).toBe("advisor_result")
    expect(parsed.text).toContain("Read the config file first")
  })

  test("parses advisor_tool_result_error variant", () => {
    const result = parseAdvisorResult({
      type: "advisor_tool_result",
      tool_use_id: "toolu_err456",
      content: {
        type: "advisor_tool_result_error",
        error_code: "max_uses_exceeded",
      },
    })

    expect(result).not.toBeNull()
    expect(result!.type).toBe("tool-result")
    expect(result!.toolCallId).toBe("toolu_err456")
    expect(result!.toolName).toBe("advisor")
    expect(result!.isError).toBe(true)
    expect(result!.providerExecuted).toBe(true)

    const parsed = JSON.parse(result!.result)
    expect(parsed.type).toBe("advisor_tool_result_error")
    expect(parsed.error_code).toBe("max_uses_exceeded")
  })

  test("parses advisor_redacted_result variant", () => {
    const result = parseAdvisorResult({
      type: "advisor_tool_result",
      tool_use_id: "toolu_red789",
      content: {
        type: "advisor_redacted_result",
        encrypted_content: "base64encrypteddata==",
      },
    })

    expect(result).not.toBeNull()
    expect(result!.type).toBe("tool-result")
    expect(result!.toolCallId).toBe("toolu_red789")
    expect(result!.toolName).toBe("advisor")
    expect(result!.providerExecuted).toBe(true)
    expect(result!).not.toHaveProperty("isError")

    const parsed = JSON.parse(result!.result)
    expect(parsed.type).toBe("advisor_redacted_result")
    expect(parsed.encrypted_content).toBe("base64encrypteddata==")
  })

  test("returns null for non-advisor content blocks", () => {
    const result = parseAdvisorResult({
      type: "text",
      tool_use_id: "toolu_nope",
      content: { type: "text" },
    })
    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Test 8: Multi-turn tool-result reconstruction
// ---------------------------------------------------------------------------

describe("advisor.multiTurnReconstruction", () => {
  function reconstructAdvisorResult(part: {
    toolName: string
    toolCallId: string
    output: { type: string; value?: string | Record<string, unknown> }
  }) {
    if (part.toolName !== "advisor") return null

    const output = part.output
    if (output.type === "json" && output.value != null) {
      const parsed = typeof output.value === "string" ? JSON.parse(output.value) : output.value
      if (
        parsed.type &&
        ["advisor_result", "advisor_redacted_result", "advisor_tool_result_error"].includes(parsed.type)
      ) {
        return {
          type: "advisor_tool_result",
          tool_use_id: part.toolCallId,
          content: parsed,
        }
      }
    }
    return null
  }

  test("reconstructs advisor_result from string value", () => {
    const result = reconstructAdvisorResult({
      toolName: "advisor",
      toolCallId: "toolu_mt1",
      output: {
        type: "json",
        value: JSON.stringify({ type: "advisor_result", text: "Do X then Y" }),
      },
    })

    expect(result).not.toBeNull()
    expect(result!.type).toBe("advisor_tool_result")
    expect(result!.tool_use_id).toBe("toolu_mt1")
    expect(result!.content.type).toBe("advisor_result")
    expect(result!.content.text).toBe("Do X then Y")
  })

  test("reconstructs advisor_result from object value", () => {
    const result = reconstructAdvisorResult({
      toolName: "advisor",
      toolCallId: "toolu_mt2",
      output: {
        type: "json",
        value: { type: "advisor_result", text: "Step 1: check" },
      },
    })

    expect(result).not.toBeNull()
    expect(result!.content.type).toBe("advisor_result")
  })

  test("rejects unknown result types", () => {
    const result = reconstructAdvisorResult({
      toolName: "advisor",
      toolCallId: "toolu_mt3",
      output: {
        type: "json",
        value: JSON.stringify({ type: "unknown_type", data: "foo" }),
      },
    })

    expect(result).toBeNull()
  })

  test("ignores non-advisor tools", () => {
    const result = reconstructAdvisorResult({
      toolName: "bash",
      toolCallId: "toolu_mt4",
      output: {
        type: "json",
        value: JSON.stringify({ type: "advisor_result", text: "injected" }),
      },
    })

    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Test 9: Cost tracking with advisor iterations
// ---------------------------------------------------------------------------

describe("advisor.costTracking", () => {
  function safe(n: number): number {
    return Number.isFinite(n) ? n : 0
  }

  function calculateAdvisorCost(
    metadata: Record<string, unknown> | undefined,
  ): number {
    let cost = 0
    const iterations = (metadata as any)?.["anthropic"]?.["iterations"] as
      | Array<{ type: string; model?: string; input_tokens?: number; output_tokens?: number }>
      | undefined

    if (iterations && Array.isArray(iterations)) {
      for (const iter of iterations) {
        if (iter.type === "advisor_message" && iter.model) {
          const inputRate = 15 // Opus: $15/M input
          const outputRate = 75 // Opus: $75/M output
          const advisorCost = new Decimal(safe(iter.input_tokens ?? 0))
            .mul(inputRate)
            .div(1_000_000)
            .add(new Decimal(safe(iter.output_tokens ?? 0)).mul(outputRate).div(1_000_000))
            .toNumber()
          cost = safe(cost + advisorCost)
        }
      }
    }
    return cost
  }

  test("calculates cost for single advisor iteration", () => {
    const cost = calculateAdvisorCost({
      anthropic: {
        iterations: [
          {
            type: "advisor_message",
            model: "claude-opus-4-6",
            input_tokens: 1000,
            output_tokens: 200,
          },
        ],
      },
    })

    // 1000 * 15/1M + 200 * 75/1M = 0.015 + 0.015 = 0.03
    expect(cost).toBeCloseTo(0.03, 6)
  })

  test("calculates cost for multiple advisor iterations", () => {
    const cost = calculateAdvisorCost({
      anthropic: {
        iterations: [
          {
            type: "advisor_message",
            model: "claude-opus-4-6",
            input_tokens: 10000,
            output_tokens: 500,
          },
          {
            type: "advisor_message",
            model: "claude-opus-4-6",
            input_tokens: 12000,
            output_tokens: 300,
          },
        ],
      },
    })

    // iter1: 10000*15/1M + 500*75/1M = 0.15 + 0.0375 = 0.1875
    // iter2: 12000*15/1M + 300*75/1M = 0.18 + 0.0225 = 0.2025
    // total: 0.39
    expect(cost).toBeCloseTo(0.39, 6)
  })

  test("returns zero when no iterations present", () => {
    expect(calculateAdvisorCost(undefined)).toBe(0)
    expect(calculateAdvisorCost({})).toBe(0)
    expect(calculateAdvisorCost({ anthropic: {} })).toBe(0)
  })

  test("ignores non-advisor iterations", () => {
    const cost = calculateAdvisorCost({
      anthropic: {
        iterations: [
          {
            type: "executor_message",
            model: "claude-haiku-4-5-20251001",
            input_tokens: 50000,
            output_tokens: 5000,
          },
        ],
      },
    })

    expect(cost).toBe(0)
  })

  test("handles missing token fields gracefully", () => {
    const cost = calculateAdvisorCost({
      anthropic: {
        iterations: [
          {
            type: "advisor_message",
            model: "claude-opus-4-6",
            // input_tokens missing
            output_tokens: 100,
          },
        ],
      },
    })

    // 0 * 15/1M + 100 * 75/1M = 0 + 0.0075 = 0.0075
    expect(cost).toBeCloseTo(0.0075, 6)
  })

  test("handles advisor iteration without model (skipped)", () => {
    const cost = calculateAdvisorCost({
      anthropic: {
        iterations: [
          {
            type: "advisor_message",
            // model missing — guard: `iter.model` is falsy
            input_tokens: 1000,
            output_tokens: 200,
          },
        ],
      },
    })

    expect(cost).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Test 10: prepareTools advisor case (SDK patch logic)
// ---------------------------------------------------------------------------

describe("advisor.prepareTools", () => {
  function prepareAdvisorTool(tool: {
    type: string
    id: string
    args: { model: string; maxUses: number; caching?: boolean }
  }) {
    const betas = new Set<string>()
    const anthropicTools: unknown[] = []

    if (tool.id === "anthropic.advisor_20260301") {
      betas.add("advisor-tool-2026-03-01")
      anthropicTools.push({
        type: "advisor_20260301",
        name: "advisor",
        model: tool.args.model,
        max_uses: tool.args.maxUses,
        ...(tool.args.caching ? { caching: { type: "ephemeral", ttl: "5m" } } : {}),
      })
    }

    return { betas, anthropicTools }
  }

  test("adds beta header and tool definition with caching", () => {
    const { betas, anthropicTools } = prepareAdvisorTool({
      type: "provider-defined",
      id: "anthropic.advisor_20260301",
      args: { model: "claude-opus-4-6", maxUses: 3, caching: true },
    })

    expect(betas.has("advisor-tool-2026-03-01")).toBe(true)
    expect(anthropicTools).toHaveLength(1)

    const def = anthropicTools[0] as any
    expect(def.type).toBe("advisor_20260301")
    expect(def.name).toBe("advisor")
    expect(def.model).toBe("claude-opus-4-6")
    expect(def.max_uses).toBe(3)
    expect(def.caching).toEqual({ type: "ephemeral", ttl: "5m" })
  })

  test("omits caching field when caching=false", () => {
    const { anthropicTools } = prepareAdvisorTool({
      type: "provider-defined",
      id: "anthropic.advisor_20260301",
      args: { model: "claude-opus-4-6", maxUses: 5, caching: false },
    })

    const def = anthropicTools[0] as any
    expect(def.caching).toBeUndefined()
    expect(def.max_uses).toBe(5)
  })
})
