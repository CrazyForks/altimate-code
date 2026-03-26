#!/bin/bash
# webhook-server.sh — Lightweight HTTP server that listens for GitHub webhooks
# Triggers fix-issue.sh immediately when an issue gets the altimate-code label
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/lib/common.sh"
source "$SCRIPT_DIR/lib/budget.sh"

PORT="${WEBHOOK_PORT:-9876}"
WEBHOOK_SECRET="${WEBHOOK_SECRET:-}"

log_info "=== Webhook server starting on port $PORT ==="

# Use socat to handle HTTP — lightweight, no extra deps
while true; do
  # Listen for one connection at a time
  socat TCP-LISTEN:"$PORT",reuseaddr,fork EXEC:"$SCRIPT_DIR/webhook-handler.sh" 2>/dev/null || {
    log_error "socat failed, restarting in 5s"
    sleep 5
  }
done
