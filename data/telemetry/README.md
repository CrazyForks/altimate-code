# Telemetry-to-Jira Pipeline

`/telemetry-report` is a Claude Code skill that queries Azure Application Insights for altimate-code errors and auto-creates Jira tickets for new issues.

## Usage

```
/telemetry-report              # full run — query + report + Jira tickets
/telemetry-report dry-run      # report only, no tickets
/telemetry-report lookback=4h  # custom lookback window (default: 2h)
/loop 2h /telemetry-report     # continuous monitoring every 2 hours
```

## What it queries

| # | Event | Threshold | Description |
|---|-------|-----------|-------------|
| Q1 | `core_failure` | >10 | Tool-level failures (read, edit, sql_analyze, etc.) |
| Q2 | `provider_error` | >5 | LLM provider errors (auth, rate limits, model errors) |
| Q3 | `error` | >5 | Application-level errors |
| Q4 | `agent_outcome` | >15% or >10 | Agent failure/abandon/abort rates |
| Q5 | `engine_error` | >2 | Python engine sidecar errors |
| Q6 | `sql_execute_failure` | >5 | SQL execution failures by warehouse type |

## How it works

1. **Preflight** — smoke query to verify Azure CLI auth + App Insights access
2. **Query** — runs 6 KQL queries against `altimate-code-os` App Insights
3. **Dedup** — checks `seen-issues.json` + JQL backstop to avoid duplicate tickets
4. **Report** — outputs markdown table with severity (P0/P1/P2), trend arrows, status
5. **Jira tickets** — creates up to 5 tickets per run in the AI project, labeled `altimate-code` + `telemetry-auto`
6. **Update store** — writes back to `seen-issues.json`, cleans entries older than 30 days

## Severity levels

- **P0**: count > 100 or failure rate > 30%
- **P1**: count 20–100 or failure rate 15–30%
- **P2**: all other threshold violations

## Files

| File | Purpose |
|------|---------|
| `.claude/commands/telemetry-report.md` | The skill definition |
| `data/telemetry/seen-issues.json` | Dedup store (git-ignored) |
| `data/telemetry/.gitignore` | Excludes the dedup store |
| `data/telemetry/README.md` | This file |

## Prerequisites

- Azure CLI installed and authenticated (`az login`)
- Access to the `altimate-code-os` App Insights resource in resource group `altimate-code`
- Atlassian MCP connected (for Jira ticket creation; reports still work without it)
