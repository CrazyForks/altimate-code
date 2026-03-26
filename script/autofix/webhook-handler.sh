#!/bin/bash
# webhook-handler.sh — Handles a single GitHub webhook HTTP request via socat
# Called by socat for each incoming connection

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/lib/common.sh" 2>/dev/null
source "$SCRIPT_DIR/lib/budget.sh" 2>/dev/null

# Read HTTP request headers
read -r REQUEST_LINE
METHOD=$(echo "$REQUEST_LINE" | awk '{print $1}')
PATH_INFO=$(echo "$REQUEST_LINE" | awk '{print $2}')

CONTENT_LENGTH=0
EVENT_TYPE=""
while IFS= read -r header; do
  header=$(echo "$header" | tr -d '\r')
  [ -z "$header" ] && break
  case "$header" in
    Content-Length:*|content-length:*) CONTENT_LENGTH=$(echo "$header" | awk '{print $2}') ;;
    X-GitHub-Event:*|x-github-event:*) EVENT_TYPE=$(echo "$header" | awk '{print $2}') ;;
  esac
done

# Read body
BODY=""
if [ "$CONTENT_LENGTH" -gt 0 ] 2>/dev/null; then
  BODY=$(head -c "$CONTENT_LENGTH")
fi

# Health check
if [ "$PATH_INFO" = "/health" ]; then
  BUDGET=$(cat "$BUDGET_FILE" 2>/dev/null || echo '{}')
  RESPONSE="{\"status\":\"ok\",\"budget\":$BUDGET}"
  echo -en "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${#RESPONSE}\r\n\r\n$RESPONSE"
  exit 0
fi

# Only handle POST /webhook
if [ "$METHOD" != "POST" ] || [ "$PATH_INFO" != "/webhook" ]; then
  RESPONSE='{"error":"not found"}'
  echo -en "HTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\nContent-Length: ${#RESPONSE}\r\n\r\n$RESPONSE"
  exit 0
fi

# Only handle issues events
if [ "$EVENT_TYPE" != "issues" ]; then
  RESPONSE='{"status":"ignored","reason":"not an issues event"}'
  echo -en "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${#RESPONSE}\r\n\r\n$RESPONSE"
  exit 0
fi

# Parse the payload
ACTION=$(echo "$BODY" | jq -r '.action // ""' 2>/dev/null)
ISSUE_NUMBER=$(echo "$BODY" | jq -r '.issue.number // ""' 2>/dev/null)
ISSUE_TITLE=$(echo "$BODY" | jq -r '.issue.title // ""' 2>/dev/null)
LABELS=$(echo "$BODY" | jq -r '[.issue.labels[].name] | join(",")' 2>/dev/null)
LABEL_ADDED=$(echo "$BODY" | jq -r '.label.name // ""' 2>/dev/null)

# Only trigger on: labeled with altimate-code, or opened with altimate-code label
SHOULD_FIX=false
if [ "$ACTION" = "labeled" ] && [ "$LABEL_ADDED" = "altimate-code" ]; then
  SHOULD_FIX=true
elif [ "$ACTION" = "opened" ] && echo "$LABELS" | grep -q "altimate-code"; then
  SHOULD_FIX=true
fi

if [ "$SHOULD_FIX" = false ]; then
  RESPONSE="{\"status\":\"ignored\",\"action\":\"$ACTION\",\"label\":\"$LABEL_ADDED\"}"
  echo -en "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${#RESPONSE}\r\n\r\n$RESPONSE"
  exit 0
fi

# Check if already in progress or failed
if echo "$LABELS" | grep -qE "autofix-in-progress|autofix-failed"; then
  RESPONSE="{\"status\":\"skipped\",\"reason\":\"already processed\"}"
  echo -en "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${#RESPONSE}\r\n\r\n$RESPONSE"
  exit 0
fi

# Check budget
if ! check_budget 2>/dev/null; then
  RESPONSE='{"status":"skipped","reason":"budget exhausted"}'
  echo -en "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${#RESPONSE}\r\n\r\n$RESPONSE"
  exit 0
fi

# Respond immediately, fix in background
RESPONSE="{\"status\":\"accepted\",\"issue\":$ISSUE_NUMBER,\"title\":\"$ISSUE_TITLE\"}"
echo -en "HTTP/1.1 202 Accepted\r\nContent-Type: application/json\r\nContent-Length: ${#RESPONSE}\r\n\r\n$RESPONSE"

# Dispatch fix in background
log_info "Webhook: dispatching fix for #$ISSUE_NUMBER: $ISSUE_TITLE"
nohup bash "$SCRIPT_DIR/fix-issue.sh" "$ISSUE_NUMBER" >> "$LOG_DIR/daemon.log" 2>&1 &
