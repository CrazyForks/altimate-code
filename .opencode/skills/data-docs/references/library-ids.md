# Data Engineering Library IDs for Context7

Use these Context7 library IDs directly with `npx -y ctx7@latest docs <libraryId> "<query>"`
to skip the library resolution step.

If a library isn't listed here, resolve it first with:
`npx -y ctx7@latest library <name> "<query>"`

## Transformation & Modeling

| Tool | Library ID | Python Package |
|------|-----------|----------------|
| dbt Core | `/dbt-labs/dbt-core` | dbt-core |
| SQLAlchemy | `/sqlalchemy/sqlalchemy` | SQLAlchemy |
| Polars | `/pola-rs/polars` | polars |
| Pandas | `/pandas-dev/pandas` | pandas |

## Orchestration

| Tool | Library ID | Python Package |
|------|-----------|----------------|
| Apache Airflow | `/apache/airflow` | apache-airflow |

## Processing

| Tool | Library ID | Python Package |
|------|-----------|----------------|
| Apache Spark / PySpark | `/apache/spark` | pyspark |

## Cloud Data Warehouses

| Tool | Library ID | Python Package |
|------|-----------|----------------|
| Snowflake Connector | `/snowflakedb/snowflake-connector-python` | snowflake-connector-python |
| Snowpark Python | `/snowflakedb/snowpark-python` | snowpark-python |
| BigQuery Python Client | `/googleapis/python-bigquery` | google-cloud-bigquery |
| Databricks SDK | `/databricks/databricks-sdk-py` | databricks-sdk |

## Streaming

| Tool | Library ID | Python Package |
|------|-----------|----------------|
| Confluent Kafka | `/confluentinc/confluent-kafka-python` | confluent-kafka |

## Data Quality

| Tool | Library ID | Python Package |
|------|-----------|----------------|
| Great Expectations | `/great-expectations/great_expectations` | great-expectations |

## dbt Packages

| Package | Library ID |
|---------|-----------|
| dbt-utils | `/dbt-labs/dbt-utils` |
| dbt-expectations | `/calogica/dbt-expectations` |
| dbt-date | `/calogica/dbt-date` |
| dbt-codegen | `/dbt-labs/dbt-codegen` |
| elementary | `/elementary-data/elementary` |

## dbt Adapters

| Adapter | Library ID |
|---------|-----------|
| dbt-snowflake | `/dbt-labs/dbt-snowflake` |
| dbt-bigquery | `/dbt-labs/dbt-bigquery` |
| dbt-databricks | `/databricks/dbt-databricks` |
| dbt-postgres | `/dbt-labs/dbt-postgres` |
| dbt-redshift | `/dbt-labs/dbt-redshift` |
| dbt-spark | `/dbt-labs/dbt-spark` |

## Example Usage

```bash
# Fetch dbt incremental model docs
npx -y ctx7@latest docs /dbt-labs/dbt-core "how to create incremental models with merge strategy"

# Fetch Airflow operator reference
npx -y ctx7@latest docs /apache/airflow "BigQueryInsertJobOperator parameters"

# Fetch Snowpark DataFrame API
npx -y ctx7@latest docs /snowflakedb/snowpark-python "DataFrame join operations"

# Fetch PySpark window functions
npx -y ctx7@latest docs /apache/spark "window functions in PySpark"

# Fetch Polars lazy evaluation
npx -y ctx7@latest docs /pola-rs/polars "lazy evaluation and collect"
```
