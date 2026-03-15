# Data Engineering Documentation Reference

This file maps data engineering tools to their documentation sources.
Two methods are available:

- **Context7 CLI** — for Python libraries/SDKs: `npx -y ctx7@latest docs <libraryId> "<query>"`
- **Web Fetch** — for database platform docs: `webfetch(url, prompt)`

---

## Context7: Python Libraries & SDKs

Use these Context7 library IDs directly with `npx -y ctx7@latest docs <libraryId> "<query>"`
to skip the library resolution step.

If a library isn't listed here, resolve it first with:
`npx -y ctx7@latest library <name> "<query>"`

### Transformation & Modeling

| Tool | Library ID | Python Package |
|------|-----------|----------------|
| dbt Core | `/dbt-labs/dbt-core` | dbt-core |
| SQLAlchemy | `/sqlalchemy/sqlalchemy` | SQLAlchemy |
| Polars | `/pola-rs/polars` | polars |
| Pandas | `/pandas-dev/pandas` | pandas |

### Orchestration

| Tool | Library ID | Python Package |
|------|-----------|----------------|
| Apache Airflow | `/apache/airflow` | apache-airflow |

### Processing

| Tool | Library ID | Python Package |
|------|-----------|----------------|
| Apache Spark / PySpark | `/apache/spark` | pyspark |

### Python Connectors & SDKs

| Tool | Library ID | Python Package |
|------|-----------|----------------|
| Snowflake Connector | `/snowflakedb/snowflake-connector-python` | snowflake-connector-python |
| Snowpark Python | `/snowflakedb/snowpark-python` | snowpark-python |
| BigQuery Python Client | `/googleapis/python-bigquery` | google-cloud-bigquery |
| Databricks SDK | `/databricks/databricks-sdk-py` | databricks-sdk |
| DuckDB Python | `/duckdb/duckdb` | duckdb |
| psycopg2 | `/psycopg/psycopg2` | psycopg2 |
| psycopg3 | `/psycopg/psycopg` | psycopg |
| clickhouse-connect | `/clickhouse/clickhouse-connect` | clickhouse-connect |

### Streaming

| Tool | Library ID | Python Package |
|------|-----------|----------------|
| Confluent Kafka | `/confluentinc/confluent-kafka-python` | confluent-kafka |

### Data Quality

| Tool | Library ID | Python Package |
|------|-----------|----------------|
| Great Expectations | `/great-expectations/great_expectations` | great-expectations |

### dbt Packages

| Package | Library ID |
|---------|-----------|
| dbt-utils | `/dbt-labs/dbt-utils` |
| dbt-expectations | `/calogica/dbt-expectations` |
| dbt-date | `/calogica/dbt-date` |
| dbt-codegen | `/dbt-labs/dbt-codegen` |
| elementary | `/elementary-data/elementary` |

### dbt Adapters

| Adapter | Library ID |
|---------|-----------|
| dbt-snowflake | `/dbt-labs/dbt-snowflake` |
| dbt-bigquery | `/dbt-labs/dbt-bigquery` |
| dbt-databricks | `/databricks/dbt-databricks` |
| dbt-postgres | `/dbt-labs/dbt-postgres` |
| dbt-redshift | `/dbt-labs/dbt-redshift` |
| dbt-spark | `/dbt-labs/dbt-spark` |
| dbt-duckdb | `/duckdb/dbt-duckdb` |
| dbt-clickhouse | `/clickhouse/dbt-clickhouse` |

---

## Web Fetch: Database Platform Documentation

For SQL syntax, DDL/DML reference, built-in functions, and platform-specific
features, use the `webfetch` tool with these official documentation URLs.

### Snowflake

| Topic | URL |
|-------|-----|
| SQL Reference (index) | `https://docs.snowflake.com/en/sql-reference` |
| SQL Commands | `https://docs.snowflake.com/en/sql-reference/sql-all` |
| Functions | `https://docs.snowflake.com/en/sql-reference/functions-reference` |
| Data Types | `https://docs.snowflake.com/en/sql-reference/data-types` |
| MERGE | `https://docs.snowflake.com/en/sql-reference/sql/merge` |
| CREATE TABLE | `https://docs.snowflake.com/en/sql-reference/sql/create-table` |
| COPY INTO | `https://docs.snowflake.com/en/sql-reference/sql/copy-into-table` |
| Streams | `https://docs.snowflake.com/en/user-guide/streams` |
| Tasks | `https://docs.snowflake.com/en/user-guide/tasks-intro` |
| Dynamic Tables | `https://docs.snowflake.com/en/user-guide/dynamic-tables-about` |
| Stored Procedures | `https://docs.snowflake.com/en/sql-reference/stored-procedures` |
| UDFs | `https://docs.snowflake.com/en/developer-guide/udf/udf-overview` |
| Stages | `https://docs.snowflake.com/en/user-guide/data-load-overview` |
| Window Functions | `https://docs.snowflake.com/en/sql-reference/functions-analytic` |

**URL pattern:** `https://docs.snowflake.com/en/sql-reference/sql/<command>`
or `https://docs.snowflake.com/en/sql-reference/functions/<function-name>`

### Databricks

| Topic | URL |
|-------|-----|
| SQL Reference | `https://docs.databricks.com/aws/en/sql/language-manual/index` |
| SQL Functions | `https://docs.databricks.com/aws/en/sql/language-manual/sql-ref-functions-builtin` |
| Delta Lake | `https://docs.databricks.com/aws/en/delta/index` |
| Unity Catalog | `https://docs.databricks.com/aws/en/data-governance/unity-catalog/index` |
| SQL Warehouse | `https://docs.databricks.com/aws/en/compute/sql-warehouse/index` |
| MERGE INTO | `https://docs.databricks.com/aws/en/sql/language-manual/delta-merge-into` |
| CREATE TABLE | `https://docs.databricks.com/aws/en/sql/language-manual/sql-ref-syntax-ddl-create-table` |
| Volumes | `https://docs.databricks.com/aws/en/volumes/index` |
| Workflows | `https://docs.databricks.com/aws/en/workflows/index` |
| Structured Streaming | `https://docs.databricks.com/aws/en/structured-streaming/index` |

**URL pattern:** `https://docs.databricks.com/aws/en/sql/language-manual/<topic>`

### DuckDB

| Topic | URL |
|-------|-----|
| SQL Reference | `https://duckdb.org/docs/sql/introduction` |
| Data Types | `https://duckdb.org/docs/sql/data_types/overview` |
| Functions | `https://duckdb.org/docs/sql/functions/overview` |
| Aggregate Functions | `https://duckdb.org/docs/sql/functions/aggregates` |
| Window Functions | `https://duckdb.org/docs/sql/functions/window_functions` |
| JSON | `https://duckdb.org/docs/data/json/overview` |
| Parquet | `https://duckdb.org/docs/data/parquet/overview` |
| CSV Import | `https://duckdb.org/docs/data/csv/overview` |
| Python API | `https://duckdb.org/docs/api/python/overview` |
| Extensions | `https://duckdb.org/docs/extensions/overview` |
| CREATE TABLE | `https://duckdb.org/docs/sql/statements/create_table` |
| SELECT | `https://duckdb.org/docs/sql/statements/select` |
| COPY | `https://duckdb.org/docs/sql/statements/copy` |
| Joins | `https://duckdb.org/docs/sql/query_syntax/from` |

**URL pattern:** `https://duckdb.org/docs/sql/statements/<statement>`
or `https://duckdb.org/docs/sql/functions/<category>`

### PostgreSQL

| Topic | URL |
|-------|-----|
| SQL Commands | `https://www.postgresql.org/docs/current/sql-commands.html` |
| Functions | `https://www.postgresql.org/docs/current/functions.html` |
| Data Types | `https://www.postgresql.org/docs/current/datatype.html` |
| Indexes | `https://www.postgresql.org/docs/current/indexes.html` |
| JSON Functions | `https://www.postgresql.org/docs/current/functions-json.html` |
| Window Functions | `https://www.postgresql.org/docs/current/functions-window.html` |
| Aggregate Functions | `https://www.postgresql.org/docs/current/functions-aggregate.html` |
| String Functions | `https://www.postgresql.org/docs/current/functions-string.html` |
| Date/Time Functions | `https://www.postgresql.org/docs/current/functions-datetime.html` |
| CREATE TABLE | `https://www.postgresql.org/docs/current/sql-createtable.html` |
| SELECT | `https://www.postgresql.org/docs/current/sql-select.html` |
| INSERT | `https://www.postgresql.org/docs/current/sql-insert.html` |
| CTEs | `https://www.postgresql.org/docs/current/queries-with.html` |
| Triggers | `https://www.postgresql.org/docs/current/trigger-definition.html` |
| Extensions | `https://www.postgresql.org/docs/current/contrib.html` |
| EXPLAIN | `https://www.postgresql.org/docs/current/sql-explain.html` |

**URL pattern:** `https://www.postgresql.org/docs/current/sql-<command>.html`
or `https://www.postgresql.org/docs/current/functions-<category>.html`
For specific versions: replace `current` with version number (e.g., `16`)

### ClickHouse

| Topic | URL |
|-------|-----|
| SQL Reference | `https://clickhouse.com/docs/sql-reference` |
| SQL Statements | `https://clickhouse.com/docs/sql-reference/statements` |
| Functions | `https://clickhouse.com/docs/sql-reference/functions` |
| Aggregate Functions | `https://clickhouse.com/docs/sql-reference/aggregate-functions` |
| Table Engines | `https://clickhouse.com/docs/engines/table-engines` |
| MergeTree | `https://clickhouse.com/docs/engines/table-engines/mergetree-family/mergetree` |
| Data Types | `https://clickhouse.com/docs/sql-reference/data-types` |
| CREATE TABLE | `https://clickhouse.com/docs/sql-reference/statements/create/table` |
| SELECT | `https://clickhouse.com/docs/sql-reference/statements/select` |
| INSERT INTO | `https://clickhouse.com/docs/sql-reference/statements/insert-into` |
| Materialized Views | `https://clickhouse.com/docs/materialized-view` |
| Window Functions | `https://clickhouse.com/docs/sql-reference/window-functions` |
| JSON | `https://clickhouse.com/docs/sql-reference/data-types/json` |
| Dictionaries | `https://clickhouse.com/docs/sql-reference/dictionaries` |

**URL pattern:** `https://clickhouse.com/docs/sql-reference/statements/<statement>`
or `https://clickhouse.com/docs/sql-reference/functions/<category>`

### BigQuery

| Topic | URL |
|-------|-----|
| SQL Reference | `https://cloud.google.com/bigquery/docs/reference/standard-sql/query-syntax` |
| Functions | `https://cloud.google.com/bigquery/docs/reference/standard-sql/functions-and-operators` |
| Data Types | `https://cloud.google.com/bigquery/docs/reference/standard-sql/data-types` |
| DML | `https://cloud.google.com/bigquery/docs/reference/standard-sql/dml-syntax` |
| DDL | `https://cloud.google.com/bigquery/docs/reference/standard-sql/data-definition-language` |
| Window Functions | `https://cloud.google.com/bigquery/docs/reference/standard-sql/analytic-function-concepts` |
| JSON Functions | `https://cloud.google.com/bigquery/docs/reference/standard-sql/json_functions` |
| MERGE | `https://cloud.google.com/bigquery/docs/reference/standard-sql/dml-syntax#merge_statement` |

**URL pattern:** `https://cloud.google.com/bigquery/docs/reference/standard-sql/<topic>`

---

## Example Usage

### Context7 (libraries/SDKs)

```bash
# dbt incremental model docs
npx -y ctx7@latest docs /dbt-labs/dbt-core "how to create incremental models with merge strategy"

# Airflow operator reference
npx -y ctx7@latest docs /apache/airflow "BigQueryInsertJobOperator parameters"

# Snowpark DataFrame API
npx -y ctx7@latest docs /snowflakedb/snowpark-python "DataFrame join operations"

# PySpark window functions
npx -y ctx7@latest docs /apache/spark "window functions in PySpark"

# Polars lazy evaluation
npx -y ctx7@latest docs /pola-rs/polars "lazy evaluation and collect"

# DuckDB Python API
npx -y ctx7@latest docs /duckdb/duckdb "read_parquet and query parquet files"

# psycopg3 connection pooling
npx -y ctx7@latest docs /psycopg/psycopg "connection pool async"

# ClickHouse Python client
npx -y ctx7@latest docs /clickhouse/clickhouse-connect "insert dataframe"
```

### Web Fetch (platform SQL docs)

```
# Snowflake MERGE syntax
webfetch(url="https://docs.snowflake.com/en/sql-reference/sql/merge",
         prompt="Extract MERGE syntax, parameters, and examples")

# DuckDB window functions
webfetch(url="https://duckdb.org/docs/sql/functions/window_functions",
         prompt="List all window functions with syntax and examples")

# PostgreSQL JSONB operators
webfetch(url="https://www.postgresql.org/docs/current/functions-json.html",
         prompt="Extract JSONB operators and functions with examples")

# ClickHouse MergeTree engine
webfetch(url="https://clickhouse.com/docs/engines/table-engines/mergetree-family/mergetree",
         prompt="Extract MergeTree settings, ORDER BY, and partition key docs")

# Databricks MERGE INTO
webfetch(url="https://docs.databricks.com/aws/en/sql/language-manual/delta-merge-into",
         prompt="Extract MERGE INTO syntax for Delta tables")

# BigQuery window functions
webfetch(url="https://cloud.google.com/bigquery/docs/reference/standard-sql/analytic-function-concepts",
         prompt="Extract window function syntax and examples")
```
