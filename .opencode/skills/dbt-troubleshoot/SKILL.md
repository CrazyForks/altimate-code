---
name: dbt-troubleshoot
description: Debug dbt errors — compilation failures, runtime database errors, test failures, wrong data, and performance issues. Use when something is broken, producing wrong results, or failing to build. Powered by altimate-dbt.
---

# dbt Troubleshooting

## Requirements
**Agent:** any (read-only diagnosis), builder (if applying fixes)
**Tools used:** bash (runs `altimate-dbt` commands), read, glob, edit

## When to Use This Skill

**Use when:**
- A dbt model fails to compile or build
- Tests are failing
- Model produces wrong or unexpected data
- Builds are slow or timing out
- User shares an error message from dbt

**Do NOT use for:**
- Creating new models → use `dbt-develop`
- Adding tests → use `dbt-test`
- Analyzing change impact → use `dbt-analyze`

## The Iron Rule

**Never modify a test to make it pass without understanding why it's failing.**

## Diagnostic Workflow

### Step 1: Health Check

```bash
altimate-dbt doctor
altimate-dbt info
```

If `doctor` fails, fix the environment first. Common issues:
- Python not found → reinstall or set `--python-path`
- dbt-core not installed → `pip install dbt-core`
- No `dbt_project.yml` → wrong directory

### Step 2: Classify the Error

| Error Type | Symptom | Jump To |
|-----------|---------|---------|
| Compilation Error | Jinja/YAML parse failure | [references/compilation-errors.md](references/compilation-errors.md) |
| Runtime/Database Error | SQL execution failure | [references/runtime-errors.md](references/runtime-errors.md) |
| Test Failure | Tests return failing rows | [references/test-failures.md](references/test-failures.md) |
| Wrong Data | Model builds but data is incorrect | Step 3 below |

### Step 3: Isolate the Problem

```bash
# Compile only — catches Jinja errors without hitting the database
altimate-dbt compile --model <name>

# If compile succeeds, try building
altimate-dbt build --model <name>

# Probe the data directly
altimate-dbt execute --query "SELECT count(*) FROM {{ ref('<name>') }}" --limit 1
altimate-dbt execute --query "SELECT * FROM {{ ref('<name>') }} LIMIT 5" --limit 5
```

### Step 4: Check Upstream

Most errors cascade from upstream models:

```bash
altimate-dbt parents --model <name>
```

Read the parent models. Build them individually to isolate which one is broken.

### Step 5: Fix and Verify

After applying a fix:

```bash
altimate-dbt build --model <name> --downstream
```

Always build with `--downstream` to catch cascading impacts.

## Rationalizations to Resist

| You're Thinking... | Reality |
|--------------------|---------|
| "Just make the test pass" | The test is telling you something. Investigate first. |
| "Let me delete this test" | Ask WHY it exists before removing it. |
| "It works on my machine" | Check the adapter, Python version, and profile config. |
| "I'll fix it later" | Later never comes. Fix it now. |

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Changing tests before understanding failures | Read the error. Query the data. Understand the root cause. |
| Fixing symptoms instead of root cause | Trace the problem upstream. The bug is often 2 models back. |
| Not checking upstream models | Run `altimate-dbt parents` and build parents individually |
| Ignoring warnings | Warnings often become errors. Fix them proactively. |

## Reference Guides

| Guide | Use When |
|-------|----------|
| [references/altimate-dbt-commands.md](references/altimate-dbt-commands.md) | Need the full CLI reference |
| [references/compilation-errors.md](references/compilation-errors.md) | Jinja, YAML, or parse errors |
| [references/runtime-errors.md](references/runtime-errors.md) | Database execution errors |
| [references/test-failures.md](references/test-failures.md) | Understanding and fixing test failures |
