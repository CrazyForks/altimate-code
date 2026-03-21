---
name: telemetry-report
description: "Query Azure App Insights, surface errors, create Jira tickets"
---

You are running the telemetry-report pipeline. Follow every step below in order. Do not skip steps.

Arguments: $ARGUMENTS
- If arguments contain `dry-run`: report only, do not create Jira tickets.
- If arguments contain `lookback=Xh`: replace `2h` in all KQL queries with the specified value (e.g., `lookback=4h` → `ago(4h)`). Default: `2h`.

Parse the lookback value now. If not provided, use `2h`.

---

## Step 1: Preflight

Run this smoke query to verify Azure auth AND App Insights resource access:

```bash
az monitor app-insights query --app altimate-code-os --resource-group altimate-code \
  --analytics-query "customEvents | take 1" --output json
```

If this command fails, report the exact error to the user and **STOP** — do not proceed to Step 2.

---

## Step 2: Query App Insights (6 queries)

Run all 6 queries using `az monitor app-insights query --app altimate-code-os --resource-group altimate-code --analytics-query "..." --output json`.

Replace `2h` with the lookback value from arguments parsing.

**Q1: Core Failures (threshold: >10)**
```kql
customEvents
| where timestamp > ago(2h) and name == "core_failure"
| extend err = tostring(customDimensions.error_message),
         tool = tostring(customDimensions.tool_name),
         err_class = tostring(customDimensions.error_class)
| summarize count() by err, tool, err_class
| where count_ > 10
| order by count_ desc
```

**Q2: Provider Errors (threshold: >5)**
```kql
customEvents
| where timestamp > ago(2h) and name == "provider_error"
| extend provider = tostring(customDimensions.provider_id),
         model = tostring(customDimensions.model_id),
         err_type = tostring(customDimensions.error_type)
| summarize count() by provider, model, err_type
| where count_ > 5
```

**Q3: Application Errors (threshold: >5)**
```kql
customEvents
| where timestamp > ago(2h) and name == "error"
| extend err_name = tostring(customDimensions.error_name),
         context = tostring(customDimensions.context)
| summarize count() by err_name, context
| where count_ > 5
```

**Q4: Agent Failure Rate (threshold: >15% or >10 errors, min 5 sessions)**
```kql
customEvents
| where timestamp > ago(2h) and name == "agent_outcome"
| extend outcome = tostring(customDimensions.outcome),
         agent = tostring(customDimensions.agent)
| summarize total = count(),
            errors = countif(outcome in ("error", "abandoned", "aborted"))
            by agent
| where total >= 5
| extend error_rate = round(100.0 * errors / total, 1)
| where error_rate > 15 or errors > 10
```

**Q5: Engine Errors (threshold: >2)**
```kql
customEvents
| where timestamp > ago(2h) and name == "engine_error"
| extend phase = tostring(customDimensions.phase),
         err = tostring(customDimensions.error_message)
| summarize count() by phase, err
| where count_ > 2
```

**Q6: SQL Failures (threshold: >5)**
```kql
customEvents
| where timestamp > ago(2h) and name == "sql_execute_failure"
| extend err = tostring(customDimensions.error_message),
         wh_type = tostring(customDimensions.warehouse_type)
| summarize count() by err, wh_type
| where count_ > 5
```

**IMPORTANT:** Empty results are normal and expected — they mean no issues above threshold. Report "No signals" for empty queries, not failure. Only treat non-zero exit codes as failures.

---

## Step 3: Read Dedup Store & Classify

Read `data/telemetry/seen-issues.json`. If the file is missing or contains invalid JSON, start with an empty object `{}`.

For each row returned above threshold from any query:

### 3a. Normalize the error message

Apply these transformations in order to produce a normalized error string:
1. Replace file paths (anything matching `/path/to/something.ext` patterns) with `<path>`
2. Replace UUIDs (8-4-4-4-12 hex pattern) with `<uuid>`
3. Replace large numbers (>6 digits) with `<num>`
4. Collapse consecutive whitespace to a single space
5. Lowercase the entire string
6. Truncate to 80 characters

### 3b. Generate dedup key

Format: `{event_type}::{dimension}::{normalized_error}`

- Q1 rows: `core_failure::{tool}::{normalized_err}`
- Q2 rows: `provider_error::{provider}::{err_type}`
- Q3 rows: `error::{err_name}::{context}`
- Q4 rows: `agent_failure::{agent}::{error_rate}%` (use the agent name + rate bucket: "high" for >30%, "moderate" for >15%)
- Q5 rows: `engine_error::{phase}::{normalized_err}`
- Q6 rows: `sql_failure::{wh_type}::{normalized_err}`

### 3c. Classify each issue

- Key **exists** in the dedup store → **KNOWN** (will update `last_count` and `last_checked` in Step 6)
- Key **does not exist** → **NEW** (will create a Jira ticket in Step 5)

---

## Step 4: Report

Output a markdown report to the user in this format:

```
# Telemetry Report — {current ISO timestamp}

## Summary
- Lookback: {lookback_value} | Queries run: 6 | Above threshold: {N} | New: {M} | Known: {K}

| Sev | Issue | Count | Trend | Status | Jira |
|-----|-------|-------|-------|--------|------|
```

For each issue above threshold, add a row.

**Severity assignment:**
- **P0**: count > 100, or failure rate > 30%
- **P1**: count 20–100, or failure rate 15–30%
- **P2**: all other threshold violations

**Trend calculation** (compare current `count_` to `last_count` in dedup store):
- `↑` = current > 1.2 × last_count
- `↓` = current < 0.8 × last_count
- `→` = within 20%
- `(new)` = no previous data (key not in store)

**Status column**: NEW or KNOWN
**Jira column**: ticket ID if known, "Creating..." if new, "—" if dry-run

If ALL 6 queries returned empty results, output:

```
# Telemetry Report — {timestamp}

All clear — no issues above threshold in the last {lookback_value}.
```

---

## Step 5: Create Jira Tickets (NEW issues only)

**If `dry-run` was specified in arguments, skip this entire step.** Output: "Dry-run mode — skipping ticket creation."

**Cap: maximum 5 tickets per run.** Prioritize by severity (P0 first), then by count descending.

For each NEW issue (up to 5):

### 5a. JQL backstop search

Before creating, search for an existing ticket:

Use `mcp__atlassian__searchJiraIssuesUsingJql` with:
- `cloudId`: `ae6de7ce-ca58-46e8-b583-1468bf597470`
- `jql`: `project = AI AND labels = "altimate-code" AND summary ~ "{event_type}: {short_desc}" AND status != Done AND created >= -30d`
- `maxResults`: `1`

Where `{short_desc}` is the first 40 chars of the normalized error.

If a matching ticket is found: treat as KNOWN, record the ticket ID, do NOT create a new ticket. Update the report table accordingly.

### 5b. Create ticket

If no existing ticket found, create one using `mcp__atlassian__createJiraIssue` with:
- `cloudId`: `ae6de7ce-ca58-46e8-b583-1468bf597470`
- `projectKey`: `AI`
- `issueTypeName`: `Bug` (use `Task` for Q4 agent_outcome issues)
- `summary`: `[altimate-code] {event_type}: {short_error_description}` (max 100 chars)
- `description`: see template below
- `contentFormat`: `markdown`
- `additional_fields`: `{ "labels": ["altimate-code", "telemetry-auto"] }`

**Description template:**
```
## Telemetry Alert

**Event Type:** {event_type}
**Severity:** {P0/P1/P2}
**Count (last {lookback}h):** {count}
**Error Details:** {full_error_message}
**Affected:** {tool/provider/agent name}

## KQL Query
\`\`\`kql
{the exact query used to detect this issue}
\`\`\`

---
Auto-generated by /telemetry-report
```

Record the created ticket ID (e.g., `AI-6000`) for the dedup store update.

**If the Atlassian MCP tools are not available**, output the full report but add a warning: "Jira MCP not connected — ticket creation skipped. Connect Atlassian MCP and re-run."

---

## Step 6: Update Dedup Store

Write the updated dedup store to `data/telemetry/seen-issues.json`.

For each issue processed:
- **NEW entries**: add with `jira_ticket` (the ticket ID or `null` if dry-run/backstop), `first_seen` (current ISO timestamp), `last_count` (current count), `last_checked` (current ISO timestamp)
- **KNOWN entries**: update `last_count` and `last_checked`

**30-day cleanup**: Remove any entries where `last_checked` is more than 30 days ago.

The JSON schema for each entry:
```json
{
  "dedup_key_here": {
    "jira_ticket": "AI-6000",
    "first_seen": "2026-03-20T00:00:00Z",
    "last_count": 512,
    "last_checked": "2026-03-20T02:00:00Z"
  }
}
```

Write the file with 2-space indented JSON for readability.

---

## Done

After completing all steps, output:
- Total issues found / tickets created / known issues updated
- Reminder: use `/loop 2h /telemetry-report` for continuous monitoring
