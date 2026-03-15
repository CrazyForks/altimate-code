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

## Requirements
**Tools used:** docs_lookup, glob, read

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

## How to Fetch Documentation

### Step 1: Identify the Tool

Determine which data engineering tool or platform the user is asking about.
Check `references/library-ids.md` for the full list of supported tools.

### Step 2: Check for Project Version (optional)

Look for version info in the user's project:

- `requirements.txt` or `pyproject.toml` — Python package versions
- `dbt_project.yml` — dbt version (`require-dbt-version`)
- `packages.yml` — dbt package versions

### Step 3: Use the `docs_lookup` Tool

Call the `docs_lookup` tool with the tool name and a specific query:

```
docs_lookup(tool="dbt-core", query="how to create incremental models with merge strategy")
docs_lookup(tool="snowflake", query="MERGE statement syntax and examples")
docs_lookup(tool="duckdb", query="window functions syntax")
docs_lookup(tool="postgresql", query="JSONB operators and functions")
docs_lookup(tool="clickhouse", query="MergeTree engine settings")
```

The tool automatically selects the best method:
- **Context7 (ctx7)** for Python libraries/SDKs — indexed, searchable docs
- **Web fetch** for database platforms — fetches from official documentation sites

For platform docs with a **specific page URL** (see `references/library-ids.md`),
pass it via the `url` parameter for better results:

```
docs_lookup(tool="snowflake", query="MERGE syntax", url="https://docs.snowflake.com/en/sql-reference/sql/merge")
docs_lookup(tool="postgresql", query="JSON functions", url="https://www.postgresql.org/docs/current/functions-json.html")
```

### Step 4: Use the Documentation

- Answer using the fetched documentation, not training data
- Include relevant code examples from the docs
- Cite the library version or documentation URL when relevant
- If docs mention deprecations or breaking changes, highlight them

## Supported Tools

**Libraries/SDKs (via Context7):** dbt-core, airflow, pyspark, snowflake-connector-python,
snowpark-python, google-cloud-bigquery, databricks-sdk, duckdb, psycopg2, psycopg,
clickhouse-connect, confluent-kafka, sqlalchemy, polars, pandas, great-expectations,
dbt-utils, dbt-expectations, dbt-snowflake, dbt-bigquery, dbt-databricks, dbt-postgres,
dbt-redshift, dbt-spark, dbt-duckdb, dbt-clickhouse, elementary

**Platforms (via web fetch):** snowflake, databricks, duckdb, postgresql, clickhouse, bigquery

## Guidelines

- Maximum 3 `docs_lookup` calls per user question to avoid rate limits
- If a call fails, the tool logs the failure automatically for improvement tracking
- On failure, fall back to training data and note that docs could not be fetched
- For dbt: always check `dbt_project.yml` for version and `packages.yml` for packages
- For Python tools: check `requirements.txt` or `pyproject.toml` for pinned versions
- When multiple libraries are relevant (e.g., dbt-core + dbt-snowflake), fetch docs
  for the most specific one first
- For SQL platform docs, pass a specific page URL via the `url` parameter for best results

## Usage

- `/data-docs How do I create an incremental model in dbt?`
- `/data-docs What Airflow operators are available for BigQuery?`
- `/data-docs How to use window functions in PySpark?`
- `/data-docs Snowflake MERGE statement syntax`
- `/data-docs DuckDB window functions`
- `/data-docs PostgreSQL JSONB operators`
- `/data-docs ClickHouse MergeTree engine settings`

Use the `docs_lookup` tool for all documentation lookups. It handles method selection,
telemetry, and failure logging automatically. Reference `library-ids.md` for the full
mapping of tools, IDs, and documentation URLs.
