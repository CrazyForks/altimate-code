---
name: dbt-develop
description: Create and modify dbt models — staging, intermediate, marts, incremental, medallion architecture. Use when building new SQL models, extending existing ones, scaffolding YAML configs, or reorganizing project structure. Powered by altimate-dbt.
---

# dbt Model Development

## Requirements
**Agent:** builder or migrator (requires file write access)
**Tools used:** bash (runs `altimate-dbt` commands), read, glob, write, edit

## When to Use This Skill

**Use when the user wants to:**
- Create a new dbt model (staging, intermediate, mart, OBT)
- Add or modify SQL logic in an existing model
- Generate sources.yml or schema.yml from warehouse metadata
- Reorganize models into layers (staging/intermediate/mart or bronze/silver/gold)
- Convert a model to incremental materialization
- Scaffold a new dbt project structure

**Do NOT use for:**
- Adding tests to models → use `dbt-test`
- Writing model/column descriptions → use `dbt-docs`
- Debugging build failures → use `dbt-troubleshoot`
- Analyzing change impact → use `dbt-analyze`

## Core Workflow: Plan → Discover → Write → Validate

### 1. Plan — Understand Before Writing

Before writing any SQL:
- Read the task requirements carefully
- Identify which layer this model belongs to (staging, intermediate, mart)
- Check existing models for naming conventions and patterns

```bash
altimate-dbt info                           # project name, adapter type
altimate-dbt parents --model <upstream>     # understand what feeds this model
altimate-dbt children --model <downstream>  # understand what consumes it
```

### 2. Discover — Know Your Data

Never write SQL without knowing the columns:

```bash
altimate-dbt columns --model <name>                         # existing model columns
altimate-dbt columns-source --source <src> --table <tbl>    # source table columns
altimate-dbt column-values --model <name> --column <col>    # sample values
altimate-dbt execute --query "SELECT * FROM {{ ref('model') }}" --limit 5
```

Read existing models in the same directory to match patterns:
```bash
glob models/**/*.sql     # find all model files
read <model_file>        # understand existing patterns
```

### 3. Write — Follow Layer Patterns

See [references/layer-patterns.md](references/layer-patterns.md) for staging/intermediate/mart templates.
See [references/medallion-architecture.md](references/medallion-architecture.md) for bronze/silver/gold patterns.
See [references/incremental-strategies.md](references/incremental-strategies.md) for incremental materialization.
See [references/yaml-generation.md](references/yaml-generation.md) for sources.yml and schema.yml.

### 4. Validate — Always Build After Writing

Never stop at writing the SQL. Always validate:

```bash
altimate-dbt compile --model <name>                        # catch Jinja errors
altimate-dbt build --model <name>                          # materialize + run tests
altimate-dbt execute --query "SELECT * FROM {{ ref('<name>') }}" --limit 10  # spot-check
```

If building downstream too:
```bash
altimate-dbt build --model <name> --downstream
```

## Iron Rules

1. **Never write SQL without reading the source columns first.** Use `altimate-dbt columns` or `altimate-dbt columns-source`.
2. **Never stop at compile.** Always `altimate-dbt build` to catch runtime errors.
3. **Match existing patterns.** Read 2-3 existing models in the same directory before writing.
4. **One model, one purpose.** A staging model should not contain business logic. An intermediate model should not be materialized as a table unless it has consumers.

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Writing SQL without checking column names | Run `altimate-dbt columns` or `altimate-dbt columns-source` first |
| Stopping at `compile` — "it compiled, ship it" | Always `altimate-dbt build` to materialize and run tests |
| Hardcoding table references instead of `{{ ref() }}` | Always use `{{ ref('model') }}` or `{{ source('src', 'table') }}` |
| Creating a staging model with JOINs | Staging = 1:1 with source. JOINs belong in intermediate or mart |
| Not checking existing naming conventions | Read existing models in the same directory first |
| Using `SELECT *` in final models | Explicitly list columns for clarity and contract stability |

## Reference Guides

| Guide | Use When |
|-------|----------|
| [references/altimate-dbt-commands.md](references/altimate-dbt-commands.md) | Need the full CLI reference |
| [references/layer-patterns.md](references/layer-patterns.md) | Creating staging, intermediate, or mart models |
| [references/medallion-architecture.md](references/medallion-architecture.md) | Organizing into bronze/silver/gold layers |
| [references/incremental-strategies.md](references/incremental-strategies.md) | Converting to incremental materialization |
| [references/yaml-generation.md](references/yaml-generation.md) | Generating sources.yml or schema.yml |
| [references/common-mistakes.md](references/common-mistakes.md) | Extended anti-patterns catalog |
