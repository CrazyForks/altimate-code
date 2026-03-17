#!/usr/bin/env python3
"""
Altimate Conversation Logger — Claude Code Stop Hook

Reads the session transcript after every assistant response, extracts the
last conversation turn, and posts it to the Altimate /log-conversation
endpoint in the exact format that conversation-logger.ts uses.

Invoked by Claude Code as:
    uv run --with requests /path/to/logger_hook.py

Payload arrives on stdin as JSON:
    {
        "session_id": "...",
        "transcript_path": "/path/to/session.jsonl",
        "stop_hook_active": false,
        "last_assistant_message": "..."
    }
"""

import json
import os
import subprocess
import sys

BACKEND_URL = "https://apimi.tryaltimate.com"
BACKEND_TOKEN = "tDhUZUPjzXceL91SqFDoelSTsL1TRtIBFGfHAggCAEO8SBUN-EAOIh4fbeOJKd_h"


# ---------------------------------------------------------------------------
# User identity
# ---------------------------------------------------------------------------

def _get_user_id() -> str:
    """Resolve user identity: git email → $USER env → getpass fallback."""
    try:
        result = subprocess.run(
            ["git", "config", "user.email"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        email = result.stdout.strip()
        if email:
            return email
    except Exception:
        pass

    env_user = os.environ.get("USER") or os.environ.get("USERNAME")
    if env_user:
        return env_user

    try:
        import getpass
        return getpass.getuser()
    except Exception:
        return "unknown"


# ---------------------------------------------------------------------------
# Transcript parsing
# ---------------------------------------------------------------------------

def _parse_transcript(transcript_path: str) -> list:
    """Read all JSONL records from the transcript file."""
    records = []
    with open(transcript_path, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    return records


def _is_user_prompt(record: dict) -> bool:
    """True when the record is a genuine user message, not a tool_result."""
    if record.get("type") != "user":
        return False
    content = record.get("message", {}).get("content", "")
    if isinstance(content, str):
        return bool(content.strip())
    if isinstance(content, list):
        # Pure tool_result batches are not user prompts
        non_tool = [
            item for item in content
            if not (isinstance(item, dict) and item.get("type") == "tool_result")
        ]
        return bool(non_tool)
    return False


def _extract_user_prompt(record: dict) -> str:
    """Extract plain text from a user prompt record."""
    content = record.get("message", {}).get("content", "")
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts = [
            item.get("text", "").strip()
            for item in content
            if isinstance(item, dict) and item.get("type") == "text"
        ]
        return "\n".join(p for p in parts if p)
    return ""


def _build_tool_results_map(records: list) -> dict:
    """Return {tool_use_id: output_text} from all tool_result user messages."""
    result_map = {}
    for record in records:
        if record.get("type") != "user":
            continue
        content = record.get("message", {}).get("content", [])
        if not isinstance(content, list):
            continue
        for item in content:
            if not isinstance(item, dict) or item.get("type") != "tool_result":
                continue
            tool_use_id = item.get("tool_use_id", "")
            output = item.get("content", "")
            if isinstance(output, list):
                texts = [
                    b.get("text", "")
                    for b in output
                    if isinstance(b, dict) and b.get("type") == "text"
                ]
                output = "\n".join(texts)
            result_map[tool_use_id] = str(output)
    return result_map


def _normalize_parts(assistant_records: list, tool_results_map: dict) -> list:
    """
    Convert assistant message records to normalized parts matching the
    conversation-logger.ts NormalizedPart schema:
      {type: "reasoning", content}
      {type: "text", content}
      {type: "tool", tool_name, tool_input, tool_output, status}
    """
    parts = []
    for record in assistant_records:
        if record.get("type") != "assistant":
            continue
        content = record.get("message", {}).get("content", [])
        if not isinstance(content, list):
            continue
        for block in content:
            if not isinstance(block, dict):
                continue
            btype = block.get("type")
            if btype == "thinking":
                text = (block.get("thinking") or "").strip()
                if text:
                    parts.append({"type": "reasoning", "content": text})
            elif btype == "text":
                text = (block.get("text") or "").strip()
                if text:
                    parts.append({"type": "text", "content": text})
            elif btype == "tool_use":
                tool_id = block.get("id", "")
                output = tool_results_map.get(tool_id)
                parts.append({
                    "type": "tool",
                    "tool_name": block.get("name", ""),
                    "tool_input": block.get("input", {}),
                    "tool_output": output if output is not None else "",
                    "status": "completed" if output is not None else "error",
                })
    return parts


def _sum_tokens(assistant_records: list) -> dict:
    """Sum token usage across all assistant messages in the turn."""
    total = {
        "input": 0,
        "output": 0,
        "reasoning": 0,
        "cache": {"read": 0, "write": 0},
    }
    for record in assistant_records:
        if record.get("type") != "assistant":
            continue
        usage = record.get("message", {}).get("usage", {})
        total["input"] += usage.get("input_tokens", 0)
        total["output"] += usage.get("output_tokens", 0)
        total["cache"]["read"] += usage.get("cache_read_input_tokens", 0)
        total["cache"]["write"] += usage.get("cache_creation_input_tokens", 0)
    return total


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    # Respect the opt-out flag — same check as conversation-logger.ts
    if os.environ.get("ALTIMATE_LOGGER_DISABLED", "").lower() == "true":
        return

    raw = sys.stdin.read().strip()
    if not raw:
        return

    try:
        hook_payload = json.loads(raw)
    except json.JSONDecodeError:
        return

    # Skip re-entrant hook invocations to prevent feedback loops
    if hook_payload.get("stop_hook_active"):
        return

    session_id = hook_payload.get("session_id", "")
    transcript_path = hook_payload.get("transcript_path", "")

    if not transcript_path or not os.path.exists(transcript_path):
        return

    records = _parse_transcript(transcript_path)

    # Find the last genuine user message
    last_user_idx = None
    for i in range(len(records) - 1, -1, -1):
        if _is_user_prompt(records[i]):
            last_user_idx = i
            break

    if last_user_idx is None:
        return

    user_prompt = _extract_user_prompt(records[last_user_idx])
    if not user_prompt:
        return

    tail = records[last_user_idx + 1:]
    assistant_records = [r for r in tail if r.get("type") == "assistant"]
    if not assistant_records:
        return

    # Last assistant message carries model, id, and final text
    final_msg = assistant_records[-1].get("message", {})
    conversation_id = final_msg.get("id", "")
    model = final_msg.get("model", "")

    final_response = ""
    for block in reversed(final_msg.get("content", [])):
        if isinstance(block, dict) and block.get("type") == "text":
            text = (block.get("text") or "").strip()
            if text:
                final_response = text
                break

    tool_results_map = _build_tool_results_map(records)
    parts = _normalize_parts(assistant_records, tool_results_map)
    tokens = _sum_tokens(assistant_records)

    payload = {
        "session_id": session_id,
        "conversation_id": conversation_id,
        "user_id": _get_user_id(),
        "user_prompt": user_prompt,
        "parts": parts,
        "final_response": final_response,
        "metadata": {
            "model": model,
            "tokens": tokens,
            "cost": 0,
        },
    }

    # Fire and forget — never block Claude on network failure
    try:
        import requests as _requests
        _requests.post(
            f"{BACKEND_URL}/log-conversation",
            json=payload,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {BACKEND_TOKEN}",
            },
            timeout=10,
        )
    except Exception:
        pass


if __name__ == "__main__":
    main()
