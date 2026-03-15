---
name: data-docs
description: >-
  Fetch up-to-date, version-aware documentation for data engineering tools.
  Use this skill when writing code that uses dbt, Airflow, Spark, Snowflake,
  BigQuery, Databricks, Kafka, SQLAlchemy, Polars, or Great Expectations.
  Activates for API lookups, configuration questions, code generation, or
  debugging involving these data tools.
---

# Data Engineering Documentation Lookup

When writing code or answering questions about data engineering tools,
use this skill to fetch current, version-specific documentation instead
of relying on training data.

## When to Use

Activate this skill when the user:

- Writes or modifies dbt models, macros, or configurations
- Develops Airflow DAGs, operators, or hooks
- Works with PySpark transformations or Spark SQL
- Uses Snowflake SQL, Snowpark, or the Snowflake Python connector
- Uses BigQuery SQL or the Python client library
- Works with Databricks SDK or notebook code
- Writes Kafka producer/consumer code
- Uses SQLAlchemy ORM or Core queries
- Works with Polars DataFrame operations
- Sets up Great Expectations data validation
- Asks "how do I" questions about any data engineering library
- Needs API references, method signatures, or configuration options

## How to Fetch Documentation

### Step 1: Identify the Library

Check the `references/library-ids.md` file for pre-mapped Context7 library IDs.
If you find a match, skip to Step 3.

If the library isn't in the reference file, resolve it:

```bash
npx -y ctx7@latest library <library-name> "<user's question>"
```

Pick the result with the closest name match and highest score.
Note the Library ID (format: `/org/project` or `/org/project/version`).

### Step 2: Check for Project Version

Look for version info in the user's project:

- `requirements.txt` or `pyproject.toml` — Python package versions
- `dbt_project.yml` — dbt version (`require-dbt-version`)
- `packages.yml` — dbt package versions
- `setup.py` or `setup.cfg` — Python package versions

If a specific version is found, prefer version-specific library IDs
(format: `/org/project/vX.Y.Z`) when available from the resolution step.

### Step 3: Query Documentation

```bash
npx -y ctx7@latest docs <libraryId> "<specific question>"
```

Write **specific, detailed queries** for better results:
- Good: `"How to create incremental models with merge strategy in dbt"`
- Bad: `"incremental"`

### Step 4: Use the Documentation

- Answer using the fetched documentation, not training data
- Include relevant code examples from the docs
- Cite the library version when relevant
- If docs mention deprecations or breaking changes, highlight them

## Guidelines

- Maximum 3 CLI calls per user question to avoid rate limits
- Works without authentication; set `CONTEXT7_API_KEY` env var for higher rate limits
- If a CLI call fails (network error, rate limit), fall back to training data
  and note that the docs could not be fetched
- For dbt: always check `dbt_project.yml` for version and `packages.yml` for packages
- For Python tools: check `requirements.txt` or `pyproject.toml` for pinned versions
- When multiple libraries are relevant (e.g., dbt-core + dbt-snowflake), fetch docs
  for the most specific one first

## Usage

- `/data-docs How do I create an incremental model in dbt?`
- `/data-docs What Airflow operators are available for BigQuery?`
- `/data-docs How to use window functions in PySpark?`
- `/data-docs Snowpark DataFrame API for joins`

Use the bash tool to run `ctx7` CLI commands. Reference `library-ids.md` for
pre-mapped library IDs to skip the resolution step.
