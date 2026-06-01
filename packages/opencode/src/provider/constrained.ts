/**
 * Constrained (grammar) decoding for tool calls.
 *
 * Builds a JSON-Schema "envelope" describing a VALID tool call for the current
 * resolved tool set, so a local model (vLLM / LM Studio / llama.cpp) can be
 * forced — at the token level — to emit a parseable, schema-correct call. A
 * deterministic fix for the "model emits unparseable tool calls" failure;
 * base-model-agnostic.
 *
 * This module is pure (JSON-Schema in → payload out); wiring into the request
 * happens in ProviderTransform.providerOptions (a separate, marker-wrapped edit).
 */

export namespace Constrained {
  /** Minimal tool shape this module needs (parameters already converted to JSON Schema). */
  export interface ToolSchema {
    name: string
    description?: string
    parameters: Record<string, any> // JSON Schema for the tool's arguments
  }

  /** Only constrain when explicitly enabled AND the provider is a self-served / local
   *  OpenAI-compatible endpoint. Never constrain hosted models (Anthropic/OpenAI):
   *  we don't control their decoding and their tool-calls are already valid. */
  export function enabled(): boolean {
    return process.env["ALTIMATE_CONSTRAINED_TOOLCALLS"] === "1"
  }

  /** True for providers where WE control the inference engine and can pass guided
   *  decoding (vLLM, LM Studio, Ollama, llama.cpp via openai-compatible). */
  export function isLocalProvider(npm?: string, providerID?: string): boolean {
    if (npm === "@ai-sdk/openai-compatible") return true
    const local = new Set(["vllm", "lmstudio", "llamacpp", "ollama", "local"])
    return !!providerID && local.has(providerID)
  }

  /** A normalized arguments schema: ensure it's an object schema (empty-arg tools
   *  constrain to `{}`), and forbid extra properties so the grammar is tight. */
  function argsSchema(t: ToolSchema): Record<string, any> {
    const p = t.parameters && typeof t.parameters === "object" ? t.parameters : {}
    const props = (p as any).properties ?? {}
    return {
      type: "object",
      properties: props,
      required: (p as any).required ?? [],
      additionalProperties: (p as any).additionalProperties ?? false,
    }
  }

  /**
   * Discriminated-union envelope: a single tool call must be exactly one of the
   * tools, with `name` pinned to that tool and `arguments` matching its schema.
   * vLLM/XGrammar guided_json and llama.cpp GBNF both support oneOf.
   */
  export function toolCallEnvelope(tools: ToolSchema[]): Record<string, any> {
    if (!tools.length) throw new Error("constrained: no tools to build envelope from")
    return {
      $schema: "http://json-schema.org/draft-07/schema#",
      title: "tool_call",
      oneOf: tools.map((t) => ({
        type: "object",
        properties: {
          name: { const: t.name },
          arguments: argsSchema(t),
        },
        required: ["name", "arguments"],
        additionalProperties: false,
      })),
    }
  }

  /**
   * Provider options payload to attach (under the provider's SDK key) for guided
   * decoding. Two styles cover the engines we serve:
   *  - "response_format": OpenAI-style json_schema (vLLM ≥0.6, LM Studio) — preferred.
   *  - "guided_json":     vLLM extra_body fallback for older servers.
   * Caller picks based on the endpoint; default response_format.
   */
  export function guidedOptions(
    tools: ToolSchema[],
    style: "response_format" | "guided_json" = "response_format",
  ): Record<string, any> {
    const schema = toolCallEnvelope(tools)
    if (style === "guided_json") {
      // vLLM reads this from extra_body; the openai-compatible SDK forwards
      // unknown providerOptions as request body fields.
      return { guided_json: schema }
    }
    return {
      response_format: {
        type: "json_schema",
        json_schema: { name: "tool_call", schema, strict: true },
      },
    }
  }
}
