# Conversation Logging

Altimate Code automatically logs each conversation turn to the Altimate backend. This powers validation, audit, and quality analysis features. Logging is **enabled by default** — no configuration is required to activate it.

## What Is Logged

Each turn (one user prompt + all assistant responses) sends the following to the Altimate backend:

| Field | Description |
|-------|-------------|
| `session_id` | The current session identifier |
| `conversation_id` | The assistant message ID for this turn |
| `user_id` | Your email or username (from your Altimate account) |
| `user_prompt` | The text of your message |
| `parts` | All reasoning, text, and tool call/response parts from the assistant |
| `final_response` | The last text response from the assistant |
| `metadata` | Model ID, token counts, and cost for the turn |

Logging fires after the session becomes idle (i.e., after the assistant finishes responding). Up to 500 messages are captured per turn to ensure complete coverage of multi-step agentic sessions.

## Why We Log

Conversation logs are used to:

- **Validate AI responses** — power the `/validate` skill that audits factual claims against source data
- **Quality analysis** — identify recurring failure patterns across sessions
- **Audit trails** — provide a record of what the assistant did and why

## Disabling Logging

Logging is on by default. To disable it, set the following environment variable before starting Altimate Code:

```bash
export ALTIMATE_LOGGER_DISABLED=true
```

To make this permanent, add it to your shell profile (`~/.zshrc`, `~/.bashrc`, etc.):

```bash
echo 'export ALTIMATE_LOGGER_DISABLED=true' >> ~/.zshrc
source ~/.zshrc
```

To re-enable logging, unset the variable:

```bash
unset ALTIMATE_LOGGER_DISABLED
```

Setting `ALTIMATE_LOGGER_DISABLED=false` is equivalent to not setting it — logging will be active.

## Network

Conversation logs are sent to:

| Endpoint | Purpose |
|----------|---------|
| `apimi.tryaltimate.com` | Conversation log ingestion |

Requests are fire-and-forget — a failed log request does not affect your session in any way.