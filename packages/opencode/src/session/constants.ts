// altimate_change start — shared constant for Anthropic server-side tool names
// These tools are executed server-side by the Anthropic API (not locally).
// They use `server_tool_use` type (not `tool_use`) and results stay in the
// assistant message (not in a separate `tool_result` user message).
// Must be kept in sync with the SDK patch's `convertToAnthropicMessagesPrompt`.
export const ANTHROPIC_SERVER_SIDE_TOOLS = ["advisor", "web_search", "web_fetch", "code_execution"] as const
export type AnthropicServerSideTool = (typeof ANTHROPIC_SERVER_SIDE_TOOLS)[number]
// altimate_change end
