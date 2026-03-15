---
name: data-docs
description: >-
  Fetch up-to-date, version-aware documentation for data engineering tools
  and database platforms. Use this skill when writing code or SQL that uses
  dbt, Airflow, Spark, Snowflake, BigQuery, Databricks, DuckDB, PostgreSQL,
  ClickHouse, Kafka, SQLAlchemy, Polars, or Great Expectations. Activates
  for API lookups, SQL syntax, configuration questions, code generation, or
  debugging involving these data tools and platforms.
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
- Works with Databricks SQL or the Python SDK
- Writes DuckDB SQL or uses the DuckDB Python API
- Writes PostgreSQL SQL, functions, or extensions
- Works with ClickHouse SQL, engines, or functions
- Writes Kafka producer/consumer code
- Uses SQLAlchemy ORM or Core queries
- Works with Polars DataFrame operations
- Sets up Great Expectations data validation
- Asks "how do I" questions about any data engineering library or platform
- Needs SQL syntax, API references, method signatures, or configuration options

## Documentation Sources

This skill uses **two methods** depending on the type of documentation:

1. **Context7 CLI** (`ctx7`) — For Python libraries and SDKs (dbt-core, Airflow,
   PySpark, Snowpark, etc.). These have indexed documentation in Context7.
2. **Web Fetch** (`webfetch`) — For database platform SQL documentation (Snowflake SQL,
   BigQuery SQL, Databricks SQL, DuckDB, PostgreSQL, ClickHouse). These platforms
   maintain official docs sites that can be fetched directly.

Check `references/library-ids.md` for the full mapping of which method to use.

## Method 1: Context7 CLI (for Python libraries/SDKs)

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

## Method 2: Web Fetch (for database platform SQL docs)

For Snowflake, BigQuery, Databricks, DuckDB, PostgreSQL, and ClickHouse
platform documentation (SQL syntax, functions, DDL, configuration), use
the `webfetch` tool to fetch specific documentation pages.

### Step 1: Find the Right URL

Check `references/library-ids.md` for the **Platform Documentation URLs**
section. Each platform has a base URL and common page paths listed.

### Step 2: Fetch the Documentation

Use the `webfetch` tool with the specific documentation URL and a prompt
describing what information to extract:

```
webfetch(url="https://docs.snowflake.com/en/sql-reference/sql/merge",
         prompt="Extract the full MERGE syntax, parameters, and examples")
```

### Step 3: Use the Documentation

- Answer using the fetched documentation, not training data
- Include relevant code examples from the docs
- Cite the documentation URL for reference
- If docs mention deprecations or breaking changes, highlight them

## Guidelines

- Maximum 3 CLI/webfetch calls per user question to avoid rate limits
- Context7 works without authentication; set `CONTEXT7_API_KEY` for higher limits
- If a call fails (network error, rate limit), fall back to training data
  and note that the docs could not be fetched
- For dbt: always check `dbt_project.yml` for version and `packages.yml` for packages
- For Python tools: check `requirements.txt` or `pyproject.toml` for pinned versions
- When multiple libraries are relevant (e.g., dbt-core + dbt-snowflake), fetch docs
  for the most specific one first
- For SQL platform docs, prefer the most specific page URL (e.g., the MERGE
  statement page, not the general SQL reference index)

## Usage

- `/data-docs How do I create an incremental model in dbt?`
- `/data-docs What Airflow operators are available for BigQuery?`
- `/data-docs How to use window functions in PySpark?`
- `/data-docs Snowpark DataFrame API for joins`
- `/data-docs Snowflake MERGE statement syntax`
- `/data-docs DuckDB window functions`
- `/data-docs PostgreSQL JSONB operators`
- `/data-docs ClickHouse MergeTree engine settings`

Use the bash tool to run `ctx7` CLI commands for libraries, and the `webfetch`
tool for platform SQL documentation. Reference `library-ids.md` for the full
mapping of tools, IDs, and URLs.
