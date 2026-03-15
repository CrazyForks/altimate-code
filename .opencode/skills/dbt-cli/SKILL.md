---
name: dbt-cli
description: Compile, build, test, and introspect dbt projects by running dbt operations against a real project. Use when the user needs to compile Jinja, materialize models, run tests, execute SQL against the warehouse, inspect columns, or navigate the DAG.
---

# dbt Project Operations

## Requirements
**Agent:** builder or migrator (build/run/test modify warehouse state), any (compile/info/columns/children/parents are read-only)
**Tools used:** bash (runs `altimate-dbt` commands), read, glob, write, edit

> **When to use this vs other skills:**
> - Use `/dbt-cli` when you need to **execute dbt operations** — compile Jinja, materialize models, run tests, query the warehouse, or navigate the DAG
> - Use `/model-scaffold` when **creating new model files** from scratch
> - Use `/generate-tests` when **adding schema.yml test definitions**
> - Use `/impact-analysis` when analyzing **downstream impact of SQL changes** via lineage
> - Use `/dbt-docs` when **documenting models** in schema.yml

## How to Run Commands

The CLI command is `altimate-dbt`. All commands output JSON to stdout; logs go to stderr.

```bash
altimate-dbt <command> [args...]
altimate-dbt <command> [args...] --format text    # Human-readable output
```

## First-Time Setup

Before any command works, initialize the dbt project:

```bash
altimate-dbt init                          # Auto-detect: walks up from cwd looking for dbt_project.yml
altimate-dbt init --project-root /path     # Explicit project root
altimate-dbt init --python-path /path      # Override Python interpreter
```

This writes `~/.altimate-code/dbt.json`. Run `altimate-dbt doctor` to verify everything is healthy.

## Commands

### Health & Info
```bash
altimate-dbt doctor    # → { passed: true, checks: [{check: "python", status: "ok"}, ...] }
altimate-dbt info      # → { projectRoot, projectName, adapterType }
```

### Compile (Jinja → SQL)
```bash
altimate-dbt compile --model <model_name>
altimate-dbt compile-query --query "SELECT * FROM {{ ref('stg_orders') }}" [--model <context>]
```

### Build, Run & Test
```bash
altimate-dbt build --model <name> [--downstream]   # compile + run + test
altimate-dbt run --model <name> [--downstream]      # materialize only
altimate-dbt test --model <name>                     # run tests only
altimate-dbt build-project                           # full project build
```

### Execute SQL Against Warehouse
```bash
altimate-dbt execute --query "SELECT count(*) FROM {{ ref('orders') }}" --limit 100
```

### Schema & DAG Introspection
```bash
altimate-dbt columns --model <name>                         # column names and types
altimate-dbt columns-source --source <src> --table <tbl>    # source table columns
altimate-dbt column-values --model <name> --column <col>    # sample values for a column
altimate-dbt children --model <name>                        # downstream models
altimate-dbt parents --model <name>                         # upstream models
```

### Package Management
```bash
altimate-dbt deps                                           # install packages.yml
altimate-dbt add-packages --packages dbt-utils,dbt-expectations
```

## When to Invoke This Skill

**Invoke when the user:**
- Says "compile", "build", "run", "test" in the context of a dbt project
- Asks "what columns does this model have?"
- Wants to see the rendered SQL behind a Jinja model
- Asks about upstream/downstream dependencies
- Wants to run a SQL query that uses `{{ ref() }}` or `{{ source() }}`
- Needs to check if their dbt project is set up correctly
- Asks to install dbt packages

**Do NOT invoke when the user:**
- Wants to create a new model file from scratch (use `/model-scaffold`)
- Wants to add tests to schema.yml (use `/generate-tests`)
- Wants to analyze lineage impact of SQL changes (use `/impact-analysis`)
- Is writing raw SQL without Jinja (use `/query-optimize` instead)

## Workflow Patterns

### Write → Validate → Ship
1. **Write** the model SQL with `write` or `edit`
2. **Compile** to catch Jinja errors: `altimate-dbt compile --model <name>`
3. **Check lineage**: `altimate-dbt parents --model <name>` and `altimate-dbt children --model <name>`
4. **Build** to materialize: `altimate-dbt build --model <name> --downstream`
5. **Spot-check**: `altimate-dbt execute --query "SELECT * FROM {{ ref('<name>') }}" --limit 10`

### Explore a Project
1. `altimate-dbt info` — project name, adapter, root path
2. `glob` for `models/**/*.sql` — list all models
3. `altimate-dbt columns --model <name>` — what does it produce?
4. `altimate-dbt parents --model <name>` / `altimate-dbt children --model <name>` — walk the DAG
5. `altimate-dbt compile --model <name>` — see the rendered SQL

### Debug a Failing Model
1. `altimate-dbt doctor` — check prerequisites
2. `altimate-dbt compile --model <name>` — isolate Jinja vs SQL errors
3. Read the model file to understand the logic
4. `altimate-dbt execute --query "<diagnostic_sql>" --limit 5` — probe the data
5. Fix, then `altimate-dbt build --model <name>` to verify

### Column Discovery
1. `altimate-dbt columns --model <name>` — get column list
2. `altimate-dbt column-values --model <name> --column status` — discover real values
3. Use column info to generate schema.yml tests or docs

## Error Handling

All errors return JSON with `error` and `fix` fields:
```json
{ "error": "dbt-core is not installed", "fix": "Install it: python3 -m pip install dbt-core" }
```

Run `altimate-dbt doctor` as the first diagnostic step for any failure.
