---
name: validate
description: Run the validation framework against one or more trace IDs, traces in a date range, or all traces in a session
argument-hint: <trace_id(s) | --from <datetime> --to <datetime> | --session-id <id>>
allowed-tools: Bash, Read, Write
---

## Instructions

Run the validation framework using the provided input. The skill supports:
- **Single trace**: `/validate <trace_id>`
- **Date range**: `/validate --from <datetime> --to <datetime> --user-id <user_id>`
- **Session ID**: `/validate --session-id <session_id>`

---

### Step 1: Determine Input Mode and Run batch_validate.py

**If `$ARGUMENTS` is empty or blank**, read the latest trace ID from the persistent state file before proceeding:

```bash
python3 -c "
import json, pathlib
# Walk up from CWD to find the .claude directory
d = pathlib.Path.cwd()
while d != d.parent:
    candidate = d / '.claude' / 'state' / 'current_trace.json'
    if candidate.exists():
        print(json.loads(candidate.read_text())['trace_id'])
        break
    d = d.parent
"
```

Use the printed trace ID as `$ARGUMENTS` for the rest of this step.

First, resolve the project root directory and the script path:

```bash
# PROJECT_ROOT is the current working directory (the repo root containing .altimate-code/ or .claude/)
PROJECT_ROOT="$(pwd)"
VALIDATE_SCRIPT="$(find "$PROJECT_ROOT/.altimate-code/skills/validate" "$HOME/.altimate-code/skills/validate" "$PROJECT_ROOT/.claude/skills/validate" "$HOME/.claude/skills/validate" -name "batch_validate.py" 2>/dev/null | head -1)"
```

Parse `$ARGUMENTS` to determine the mode and construct the command:
- If it contains `--session-id` → session mode: `uv run --with requests python "$VALIDATE_SCRIPT" --project-root "$PROJECT_ROOT" --session-id "<session_id>"`
- If it contains `--from` → date range mode: `uv run --with requests python "$VALIDATE_SCRIPT" --project-root "$PROJECT_ROOT" --from-time "<from>" --to-time "<to>" --user-id "<user_id>"`
- Otherwise → single trace ID: `uv run --with requests python "$VALIDATE_SCRIPT" --project-root "$PROJECT_ROOT" --trace-ids "$ARGUMENTS"`

Run the command using the Bash tool with `timeout: 3600000` (milliseconds) to allow up to ~60 minutes for long-running validations:

```bash
uv run --with requests python "$VALIDATE_SCRIPT" --project-root "$PROJECT_ROOT" <appropriate_args>
```

**IMPORTANT**: Always pass `timeout: 3600000` to the Bash tool when running this command. The default 2-minute bash timeout is too short for validation jobs.

The script will:
- Call the Altimate backend directly
- Stream results via SSE as each trace completes
- Write raw JSON results to `logs/batch_validation_<timestamp>.json`
- Create a report folder `logs/batch_validation_<timestamp>/`
- Output JSON to stdout

**IMPORTANT**: The stdout output may be very large. Read the output carefully. The JSON structure is:
```json
{
  "total_traces": N,
  "results": [
    {
      "trace_id": "...",
      "status_code": 200,
      "result": {
        "trace_id": "...",
        "status": "success",
        "error_count": 0,
        "observation_count": N,
        "elapsed_seconds": N,
        "criteria_results": {
          "Groundedness": {"text_response": "...", "input_tokens": ..., "output_tokens": ..., "total_tokens": ..., "model_name": "..."},
          "Validity": {"text_response": "...", ...},
          "Coherence": {"text_response": "...", ...},
          "Utility": {"text_response": "...", ...},
          "Tool Validation": {"text_response": "...", ...}
        }
      }
    }
  ],
  "log_file": "logs/batch_validation_...",
  "report_dir": "logs/batch_validation_<timestamp>"
}
```

---

### Step 2: For Each Trace - Semantic Matching (Groundedness Post-Processing)

For EACH trace in the results array, apply semantic matching to Groundedness:

1. Parse the `criteria_results.Groundedness.text_response` and identify all **failed claims**.
2. If there are claims identified:
    2.1. **For each claim , check whether `claim_text` and `source_data` are semantically the same.
        - 2 statements are considered **semantically same** if they talk about the same topics.
           - If the comparison involves numbers then **make sure you compare those numbers properly using tools if needed.**
        - 2 statements are considered **semantically different** if they talk about different topics.
        - If semantically same → update claim status to `SUCCESS`.
    2.2. Re-count the number of failing claims whose status is `FAILURE`.
    2.3. Update `failed_count` with the re-counted number.
    2.4. Re-calculate OverallScore as `round(((total length of claims - failed_count)/total length of claims) * 5, 2)`
3. If no claims identified, do nothing.

**This is being done for semantic matching as the deterministic tool did not do semantic matching.**

When doing this task, first generate a sequence of steps as a plan and execute step by step for consistency.

---

### Step 3: For Each Trace - Semantic Reason Generation (Groundedness Post-Processing)

For EACH trace in the results array, apply semantic reason generation to Groundedness:

1. Parse the `criteria_results.Groundedness.text_response` and identify all **claims**.
2. If there are claims identified, then **for each claim**:
    2.1. If claim status is `SUCCESS` → generate a brief and complete reason explaining **why it succeeded** (e.g. the claim matches the source data, the value is within acceptable error, etc.) and update the claim's `reason` field with the generated reason.
        - REMEMBER to provide full proof details in the reason with tool calculated claims as well as actual claim.
    2.2. If claim status is `FAILURE` → generate a brief and complete reason explaining **why it failed** (e.g. the claimed value differs from source data, the error exceeds the threshold, etc.) and update the claim's `reason` field with the generated reason.
        - REMEMBER to provide full proof details in the reason with tool calculated claims as well as actual claim.
3. If no claims identified, do nothing.

**This ensures every claim has a human-readable, semantically generated reason regardless of its outcome.**

When doing this task, first generate a sequence of steps as a plan and execute step by step for consistency.

---

### Step 4: Write Per-Trace Results to File

For EACH trace, write the results **directly to a markdown file** inside the report directory. Do NOT print the full trace details to the terminal. Read `report_dir` from the batch_validate.py JSON output. Use the trace index (1-based) and first 12 characters of the trace ID for the filename.

The file content must follow this format:

```
## Trace: `<trace_id>`

### Criteria Summary Table

| Criteria | Status | Score |
|---|---|---|
| **Groundedness** | <status> | <score>/5 |
| **Validity** | <status> | <score>/5 |
| **Coherence** | <status> | <score>/5 |
| **Utility** | <status> | <score>/5 |
| **Tool Validation** | <status> | <score>/5 |

P.S. **Consider 'RIGHT NODE' as 'SUCCESS' and 'WRONG NODE' as 'FAILURE' IF PRESENT.**

### Per-Criteria Node Results

For **Validity**, **Coherence**, and **Utility**, show a node-level breakdown table:

| Node | Score | Status |
|---|---|---|
| <node_name> | <score> | <status> |

### Individual Criteria Results

#### Groundedness

<summary of groundedness response detailing strengths and weaknesses>

ALL claims table:

| # | Source Tool | Source Data | Input Data | Claim Text | Claimed | Input | Conversion Statement | Calculated | Error | Status | Reason |
|---|---|---|---|---|---|---|---|---|---|---|---|
| <claim_id> | <source tool id> | <claim_text> | <source_data> | <input_data> | <claimed_value> <claim_unit> | <input data> | <input to claim conversion statement> | <Calculated claim> <claim_unit> | <Error in claim as %> | SUCCESS/FAILURE | <reason> |

Failed Claims Summary (only failed claims):

| # | Claim | Claimed | Source Tool ID | Actual Text | Actual Data | Error | Root Cause |
|---|---|---|---|---|---|---|---|
| <claim_id> | <claim_text> | <claimed_value> | <source_tool_id> | <source_data> | <Input data> | <error %> | <reasoning> |

REMEMBER to generate each value COMPLETELY. DO NOT TRUNCATE.

#### Validity
<summary detailing strengths and weaknesses>

#### Coherence
<summary detailing strengths and weaknesses>

#### Utility
<summary detailing strengths and weaknesses>

#### Tool Validation
<summary detailing strengths and weaknesses>

All tool details:

| # | Tool Name | Tool Status |
|---|---|---|
| <id> | <tool name> | <tool status> |
```

Write the content using the Write tool to `<report_dir>/trace_<N>_<first_12_chars_of_id>.md`.

After writing each file, tell the user:
> Trace `<trace_id>` result written to `<report_dir>/trace_<N>_<first_12_chars_of_id>.md`

---

### Step 5: Write Cross-Trace Comprehensive Summary to File

After processing all individual traces, write a comprehensive summary **directly to `<report_dir>/SUMMARY.md`** using the Write tool. Do NOT print the full summary to the terminal.

The file content must follow this format:

```
## Validation Summary

Use the scores AFTER semantic matching corrections from Step 2, and reasons AFTER semantic reason generation from Step 3.

### Overall Score Summary

| Criteria | Average Score | Min | Max | Traces Evaluated |
|---|---|---|---|---|
| **Groundedness** | <avg>/5 | <min>/5 | <max>/5 | <count> |
| **Validity** | <avg>/5 | <min>/5 | <max>/5 | <count> |
| **Coherence** | <avg>/5 | <min>/5 | <max>/5 | <count> |
| **Utility** | <avg>/5 | <min>/5 | <max>/5 | <count> |
| **Tool Validation** | <avg>/5 | <min>/5 | <max>/5 | <count> |

### Per-Trace Score Breakdown

| Trace ID | Groundedness | Validity | Coherence | Utility | Tool Validation |
|---|---|---|---|---|---|
| <id> | <score>/5 | <score>/5 | <score>/5 | <score>/5 | <score>/5 |

### Category-Wise Analysis

For EACH category:
- **Common Strengths**: Patterns of success observed across traces
- **Common Weaknesses**: Recurring issues found across traces
- **Recommendations**: Actionable improvements based on the analysis

Finally generate all the failed claims in the below markdown format from all the traces

| # | Trace ID |Claim | Claimed | Source Tool ID | Actual Text | Actual Data | Error | Root Cause |
|---|---|---|---|---|---|---|---|---|
| <claim_id> | <trace_id>| <claim_text> | <claimed_value> | <source_tool_id> | <source_data> | <Input data> | <error %> | <reasoning> |

REMEMBER that no claim should be truncated. ALL THE VALUES MUST BE COMPLETE.

```



After writing the file, tell the user:
> Summary written to `<report_dir>/SUMMARY.md`

---

### Step 6: Write Dashboard to File

After writing the summary, generate a dashboard and write it **directly to `<report_dir>/DASHBOARD.html`** as a self-contained HTML file using the Write tool.

The dashboard provides an at-a-glance health view across all traces. Use the scores AFTER semantic matching corrections from Step 2.

Generate a complete, self-contained HTML file with inline CSS and no external dependencies. The design should be clean and professional — dark header, card-based layout, color-coded status indicators. Use the following structure as the template, substituting all placeholder values with real computed data:

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Validation Dashboard</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f4f6f9; color: #1a1a2e; }
  header { background: #1a1a2e; color: #fff; padding: 24px 32px; display: flex; align-items: center; gap: 16px; }
  header h1 { font-size: 1.5rem; font-weight: 600; }
  header .meta { font-size: 0.85rem; color: #a0aec0; margin-top: 4px; }
  .container { max-width: 1200px; margin: 0 auto; padding: 32px; }
  .section-title { font-size: 1.1rem; font-weight: 600; color: #2d3748; margin-bottom: 16px; border-left: 4px solid #4299e1; padding-left: 12px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; margin-bottom: 32px; }
  .card { background: #fff; border-radius: 10px; padding: 20px; box-shadow: 0 1px 4px rgba(0,0,0,0.08); }
  .card .label { font-size: 0.78rem; color: #718096; text-transform: uppercase; letter-spacing: 0.05em; }
  .card .value { font-size: 1.8rem; font-weight: 700; margin: 6px 0 2px; }
  .card .sub { font-size: 0.8rem; color: #a0aec0; }
  .green { color: #38a169; } .yellow { color: #d69e2e; } .red { color: #e53e3e; }
  .badge { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 0.75rem; font-weight: 600; }
  .badge.green { background: #c6f6d5; color: #276749; }
  .badge.yellow { background: #fefcbf; color: #7b341e; }
  .badge.red { background: #fed7d7; color: #9b2c2c; }
  table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 10px; overflow: hidden; box-shadow: 0 1px 4px rgba(0,0,0,0.08); margin-bottom: 32px; }
  th { background: #edf2f7; text-align: left; padding: 12px 16px; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em; color: #4a5568; }
  td { padding: 12px 16px; font-size: 0.875rem; border-top: 1px solid #edf2f7; }
  tr:hover td { background: #f7fafc; }
  .score-bar { display: flex; align-items: center; gap: 8px; }
  .bar-track { flex: 1; height: 6px; background: #edf2f7; border-radius: 3px; }
  .bar-fill { height: 6px; border-radius: 3px; }
  .issue-tag { background: #ebf8ff; color: #2b6cb0; padding: 2px 8px; border-radius: 4px; font-size: 0.75rem; margin-right: 4px; }
</style>
</head>
<body>
<header>
  <div>
    <h1>Validation Dashboard</h1>
    <div class="meta">Generated: <TIMESTAMP> &nbsp;·&nbsp; Traces evaluated: <TOTAL_TRACES></div>
  </div>
</header>
<div class="container">

  <!-- Overall Health Cards -->
  <div class="section-title">Overall Health</div>
  <div class="cards">
    <div class="card">
      <div class="label">Overall Avg Score</div>
      <div class="value <GREEN_YELLOW_RED>"><OVERALL_AVG>/5</div>
      <div class="sub">across all criteria</div>
    </div>
    <div class="card">
      <div class="label">Traces Evaluated</div>
      <div class="value"><TOTAL_TRACES></div>
      <div class="sub">&nbsp;</div>
    </div>
    <div class="card">
      <div class="label">Fully Passing</div>
      <div class="value green"><PASSING_COUNT></div>
      <div class="sub"><PASSING_PCT>% of traces</div>
    </div>
    <div class="card">
      <div class="label">Has Failures</div>
      <div class="value red"><FAILING_COUNT></div>
      <div class="sub"><FAILING_PCT>% of traces</div>
    </div>
    <div class="card">
      <div class="label">Failed Claims</div>
      <div class="value red"><TOTAL_FAILED_CLAIMS></div>
      <div class="sub">Groundedness</div>
    </div>
  </div>

  <!-- Criteria Scorecard -->
  <div class="section-title">Criteria Scorecard</div>
  <table>
    <thead><tr><th>Criteria</th><th>Avg Score</th><th>Score Bar</th><th>Pass Rate</th><th>Status</th></tr></thead>
    <tbody>
      <!-- Repeat one <tr> per criteria. bar-fill width = (avg/5)*100 %. Color class on bar-fill and badge matches status. -->
      <tr>
        <td><strong>Groundedness</strong></td>
        <td><GROUND_AVG>/5</td>
        <td><div class="score-bar"><div class="bar-track"><div class="bar-fill <COLOR>" style="width:<GROUND_PCT>%"></div></div></div></td>
        <td><GROUND_PASS_RATE>%</td>
        <td><span class="badge <COLOR>"><STATUS></span></td>
      </tr>
      <!-- ... Validity, Coherence, Utility, Tool Validation rows ... -->
    </tbody>
  </table>

  <!-- Top Issues -->
  <div class="section-title">Top Issues</div>
  <table>
    <thead><tr><th>#</th><th>Issue</th><th>Criteria</th><th>Affected Traces</th></tr></thead>
    <tbody>
      <!-- One row per top issue, up to 5 -->
      <tr>
        <td>1</td>
        <td><ISSUE_DESCRIPTION></td>
        <td><span class="issue-tag"><CRITERIA></span></td>
        <td><TRACE_IDS></td>
      </tr>
    </tbody>
  </table>

  <!-- Per-Trace Health -->
  <div class="section-title">Per-Trace Health</div>
  <table>
    <thead><tr><th>Trace ID</th><th>Overall</th><th>Groundedness</th><th>Validity</th><th>Coherence</th><th>Utility</th><th>Tool Validation</th></tr></thead>
    <tbody>
      <!-- One row per trace -->
      <tr>
        <td style="font-family:monospace;font-size:0.8rem"><TRACE_ID></td>
        <td><span class="badge <COLOR>"><AVG>/5</span></td>
        <td><GROUND>/5</td>
        <td><VALID>/5</td>
        <td><COHER>/5</td>
        <td><UTIL>/5</td>
        <td><TOOLVAL>/5</td>
      </tr>
    </tbody>
  </table>

</div>
</body>
</html>
```

**Color rules:**
- Score ≥ 4.0 → class `green`
- Score 2.5–3.9 → class `yellow`
- Score < 2.5 → class `red`

Pass rate = % of traces scoring ≥ 3.0 for that criteria. Fully passing = all criteria ≥ 3.0.

After writing the file, tell the user:
> Dashboard written to `<report_dir>/DASHBOARD.html`

---

### Step 7: Write Groundedness Failure Categories to File

After writing the dashboard, analyse all failed Groundedness claims across every trace and group them into failure categories. Write the result **directly to `<report_dir>/GROUNDEDNESS_FAILURES.md`** using the Write tool.

To derive categories, read the `Root Cause` / `reason` fields from every failed claim across all traces and group semantically similar failures under a single category label (e.g. "Unit Conversion Error", "Wrong Metric Used", "Rounding Error", "Missing Data", "Calculation Error", etc.).

The file content must follow this format:

```
## Groundedness Failure Categories

### Category Summary

| # | Category | Failure Count | Trace IDs |
|---|---|---|---|
| 1 | <category_name> | <count> | <trace_id_1>, <trace_id_2>, ... |
| 2 | <category_name> | <count> | <trace_id_1>, ... |
| ... | | | |
| **Total** | | <total_count> | |

### Category Details

For each category, list every failed claim that belongs to it:

#### <Category Name>

**Description:** <one-sentence explanation of what this category of failure represents>

| # | Trace ID | Claim | Claimed | Actual | Error | Reason |
|---|---|---|---|---|---|---|
| <claim_id> | <trace_id> | <claim_text> | <claimed_value> | <actual_value> | <error_%> | <reason> |
```

REMEMBER: every failed claim from every trace must appear in exactly one category. No claim should be omitted or truncated.

After writing the file, tell the user:
> Groundedness failure categories written to `<report_dir>/GROUNDEDNESS_FAILURES.md`
