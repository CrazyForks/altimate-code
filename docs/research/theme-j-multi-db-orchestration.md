# Theme J: Multi-Database Orchestration & Cross-Platform Data Movement Validation

## Executive Summary

Cross-platform data movement validation is one of the most painful unsolved problems in data engineering. Teams routinely move data between databases (Snowflake to ClickHouse, BigQuery to Postgres, MySQL to Snowflake) using tools like Fivetran, Airbyte, dlt, and Meltano, yet validation of these movements remains largely manual or ad-hoc. This research covers the complete landscape: ETL/ELT post-load validation, federated query engines as validation bridges, data lake format validation, reverse ETL verification, replication consistency, and orchestrator-level quality gates.

**Key opportunity for Reladiff**: No single tool today provides unified, cross-database validation that spans warehouse-to-warehouse, warehouse-to-lake, and warehouse-to-SaaS scenarios. Reladiff's existing cross-database diffing capability positions it to become the validation layer for the entire data movement lifecycle.

---

## 1. Cross-Database Data Movement Patterns

### 1.1 ETL/ELT Post-Load Validation

#### The Problem

Teams using ingestion tools (Fivetran, Airbyte, dlt, Meltano) have surprisingly few options for verifying data after load. Most rely on row counts and spot checks.

#### Fivetran Validation Approach

Fivetran recommends integration with dbt for post-load testing, but provides no built-in row-level validation. Their guidance focuses on:
- Cross-source data validation: comparing the same dataset across CRM and billing systems
- Bi-directional validation for reverse ETL workflows
- Integration with dbt tests for automated schema and value checks

Source: [Fivetran Data Integrity](https://www.fivetran.com/learn/data-integrity-issues), [Fivetran Data Validation Tools](https://fivetran.com/docs/transformations/troubleshooting/data-profiling-validation-tools)

#### Airbyte Validation Approach

Airbyte provides multi-layer validation:
- **Ingestion-time**: Basic format checks, type coercion
- **Transformation-time**: Business rule validation via dbt integration
- **Post-load**: Row-count reconciliation, table-level checksums, schema/metadata validation

Post-migration validation includes full row-count reconciliation and table-level checksums, plus schema and metadata validation to ensure keys and constraints remain intact.

Source: [Airbyte Data Integrity After Migration](https://airbyte.com/data-engineering-resources/validate-data-integrity-after-migration), [Airbyte Data Quality Monitoring](https://airbyte.com/data-engineering-resources/data-quality-monitoring)

#### dlt (data load tool) Validation

dlt provides the most comprehensive built-in validation among ingestion tools, with checks across three lifecycle stages:

```python
# dlt data contract enforcement
import dlt

@dlt.resource
def users():
    yield {"id": 1, "name": "Alice", "email": "alice@example.com"}

# Schema contract modes: evolve, freeze, discard
pipeline = dlt.pipeline(
    pipeline_name="users_pipeline",
    destination="postgres",
    dataset_name="production",
)

# Data contracts control schema evolution
pipeline.run(
    users(),
    schema_contract={
        "tables": "freeze",        # No new tables allowed
        "columns": "discard_value", # Unknown columns silently dropped
        "data_type": "freeze",      # No type changes allowed
    }
)
```

dlt quality lifecycle stages:
1. **In-flight checks**: Individual record validation during extraction
2. **Staging checks**: Transient staging area for testing before final load
3. **Destination checks**: Full dataset validation at the destination

Source: [dlt Data Quality Lifecycle](https://dlthub.com/docs/general-usage/data-quality-lifecycle), [dlt Data Quality](https://dlthub.com/docs/plus/features/quality/data-quality)

#### Meltano Validation

Meltano relies on dbt integration for post-load validation:

```bash
# Run dbt tests after Meltano extract-load
meltano run tap-postgres target-snowflake dbt-snowflake:test
```

Source: [Meltano EL Best Practices](https://meltano.com/blog/5-helpful-extract-load-practices-for-high-quality-raw-data/)

### 1.2 Cross-Database Migration Validation

#### Datafold data-diff

The most prominent open-source tool for cross-database table comparison. Originally used a hashdiff algorithm (divide-and-conquer with MD5 checksums), now consolidated to in-memory diffing.

**Algorithm (historical hashdiff)**:
1. Split table into segments by primary key range
2. Compute MD5 checksum of each segment in both databases
3. When checksums differ, binary-search subdivide until individual differing rows are found
4. Performance: ~COUNT(*) when few differences; degrades with many diffs

**Current state**: Deprecated hashdiff in favor of unified in-memory diffing. Supports datasets up to 10M rows efficiently. Handles text, float, JSON, and more.

```bash
# CLI usage (historical, pre-deprecation)
data-diff \
  postgresql://user:pass@host/db table1 \
  snowflake://user:pass@account/db/schema table2 \
  --key-columns id \
  --columns name,amount,created_at
```

Source: [datafold/data-diff GitHub](https://github.com/datafold/data-diff), [data-diff Algorithm Update](https://www.datafold.com/blog/data-diff-gets-faster-and-simpler-one-algorithm-better-performance)

#### Reladiff

A fork/evolution of data-diff with continued development of the high-performance hashdiff algorithm:

```python
from reladiff import connect_to_table, diff_tables

# Connect to tables across different databases
table1 = connect_to_table("postgresql:///", "events", "id")
table2 = connect_to_table("snowflake://user:pass@account/DB/SCHEMA", "events", "id")

# Iterate over differences
for sign, row in diff_tables(table1, table2):
    # sign is '+' (in target only) or '-' (in source only)
    print(sign, row)
```

```bash
# CLI: PostgreSQL to Snowflake comparison
reladiff \
  postgresql:/// events \
  "snowflake://<user>:<pass>@<host>/<DB>/<SCHEMA>?warehouse=<WH>&role=<ROLE>" \
  events \
  -k event_id \
  -c event_data \
  -w "event_time < '2024-10-10'"
```

**Performance**: 25M+ rows in under 10 seconds (no differences), 1B+ rows in ~5 minutes. Supports 12+ databases including MySQL, Postgres, Snowflake, BigQuery, Oracle, ClickHouse.

Source: [erezsh/reladiff GitHub](https://github.com/erezsh/reladiff)

#### Recce (ThoughtWorks)

Server-based database reconciliation tool using configured SQL expressions. Supports MySQL, Postgres, MSSQL, MariaDB, Aurora, and Oracle.

Source: [thoughtworks/recce GitHub](https://github.com/thoughtworks/recce)

### 1.3 Cross-Cloud Data Movement

Migration testing across AWS, GCP, and Azure requires:

1. **Schema alignment validation**: Column types, constraints, defaults
2. **Data parity verification**: Row counts, checksums, sampling
3. **Pipeline reconstruction testing**: ETL logic equivalence
4. **Performance validation**: Query latency, throughput

Datafold recommends applying "tooling and automation always and everywhere" with continuous validation throughout migration phases, prioritizing business-critical assets first.

Source: [Datafold Migration Testing Strategy](https://www.datafold.com/blog/data-migration-testing-strategy)

---

## 2. Federated Query Validation

### 2.1 DuckDB as a Validation Bridge

DuckDB's multi-database support makes it the most compelling lightweight validation bridge available today. It can simultaneously attach PostgreSQL, MySQL, SQLite, and read from Snowflake, S3 Parquet, and more.

#### Attaching Multiple Databases

```sql
-- Attach multiple databases simultaneously
ATTACH 'sqlite:production.db' AS sqlite_db;
ATTACH 'postgres:dbname=warehouse host=localhost' AS pg_db;
ATTACH 'mysql:user=root database=analytics' AS mysql_db;

-- Cross-database join for validation
SELECT
    pg.id,
    pg.amount AS pg_amount,
    mysql.amount AS mysql_amount,
    pg.amount - mysql.amount AS diff
FROM pg_db.orders pg
JOIN mysql_db.orders mysql ON pg.id = mysql.id
WHERE pg.amount != mysql.amount;
```

#### Cross-Database Data Migration/Validation

```sql
-- Copy entire database for comparison
ATTACH 'postgres:dbname=source' AS source;
ATTACH 'postgres:dbname=target' AS target;
COPY FROM DATABASE source TO target;

-- Validate row counts across databases
SELECT
    'source' AS db, COUNT(*) AS row_count FROM source.events
UNION ALL
SELECT
    'target' AS db, COUNT(*) AS row_count FROM target.events;
```

#### Validation Pattern: S3 Parquet vs. Warehouse

```sql
-- Compare S3 Parquet data against PostgreSQL
ATTACH 'postgres:dbname=warehouse' AS wh;

SELECT
    COUNT(*) AS parquet_rows
FROM read_parquet('s3://bucket/data/*.parquet')
EXCEPT
SELECT
    COUNT(*) AS pg_rows
FROM wh.analytics.events;
```

**Key limitation**: A single DuckDB transaction can only write to a single attached database. Read operations across all attached databases are unrestricted.

Source: [DuckDB Multi-Database Support](https://duckdb.org/2024/01/26/multi-database-support-in-duckdb), [DuckDB PostgreSQL Import](https://duckdb.org/docs/stable/guides/database_integration/postgres)

#### DuckDB + Snowflake Extension

```sql
-- Attach Snowflake and query directly from DuckDB
INSTALL snowflake;
LOAD snowflake;

ATTACH 'snowflake://user:pass@account/DB/SCHEMA' AS sf;

-- Compare local Parquet with Snowflake
SELECT sf.id, sf.amount, local.amount
FROM sf.orders sf
JOIN read_parquet('local_orders.parquet') local ON sf.id = local.id
WHERE sf.amount != local.amount;
```

Source: [Querying Snowflake with DuckDB](https://blog.greybeam.ai/querying-snowflake-with-duckdb/)

### 2.2 Trino/Presto for Federated Validation

Trino enables querying across multiple heterogeneous data sources with a single ANSI SQL interface. This makes it suitable for cross-database validation at scale where DuckDB's single-node architecture becomes limiting.

```sql
-- Trino: Compare tables across catalogs (each catalog = different database)
SELECT
    m.id,
    m.amount AS mysql_amount,
    s.amount AS snowflake_amount
FROM mysql.production.orders m
FULL OUTER JOIN snowflake.analytics.orders s ON m.id = s.id
WHERE m.amount != s.amount
   OR m.id IS NULL
   OR s.id IS NULL;

-- Trino: Row count reconciliation across catalogs
SELECT 'mysql' AS source, COUNT(*) AS cnt FROM mysql.production.orders
UNION ALL
SELECT 'snowflake' AS source, COUNT(*) AS cnt FROM snowflake.analytics.orders
UNION ALL
SELECT 'bigquery' AS source, COUNT(*) AS cnt FROM bigquery.dataset.orders;
```

Trino supports connectors for: PostgreSQL, MySQL, SQL Server, Oracle, MongoDB, Cassandra, Elasticsearch, Redis, Kafka, S3 (Hive/Iceberg/Delta), BigQuery, Snowflake, and more.

Source: [Trino Documentation](https://trino.io/), [Trino GitHub](https://github.com/trinodb/trino)

### 2.3 Snowflake External Tables + Validation

Snowflake now supports write operations on externally managed Iceberg tables (as of July 2025), enabling bi-directional data flow with external systems while maintaining validation through Snowflake's SQL engine.

```sql
-- Validate external Iceberg table against managed table
SELECT
    COUNT(*) AS external_rows
FROM my_iceberg_catalog.schema.events
MINUS
SELECT
    COUNT(*) AS managed_rows
FROM managed_db.schema.events;

-- Compare specific columns
SELECT e.id, e.amount, m.amount
FROM my_iceberg_catalog.schema.events e
JOIN managed_db.schema.events m ON e.id = m.id
WHERE e.amount != m.amount;
```

Source: [Snowflake Iceberg Tables](https://docs.snowflake.com/en/user-guide/tables-iceberg), [Snowflake External Writes](https://docs.snowflake.com/en/release-notes/2025/other/2025-07-18-iceberg-external-writes-cld)

---

## 3. Data Lake Validation

### 3.1 Validating S3/GCS Data Against Warehouse Tables

#### Great Expectations with Spark + S3

```python
import great_expectations as gx

# Create context and connect to S3 Parquet
context = gx.get_context()

# Add S3 data source
s3_source = context.data_sources.add_spark(name="s3_data")
s3_asset = s3_source.add_dataframe_asset(name="events_parquet")

# Add warehouse data source
pg_source = context.data_sources.add_postgres(
    name="warehouse",
    connection_string="postgresql://user:pass@host/db"
)
pg_asset = pg_source.add_table_asset(name="events", table_name="events")

# Define expectations
suite = context.suites.add(
    gx.ExpectationSuite(name="cross_source_validation")
)
suite.add_expectation(
    gx.expectations.ExpectTableRowCountToEqual(value=1000000)
)
suite.add_expectation(
    gx.expectations.ExpectColumnValuesToNotBeNull(column="id")
)

# Run checkpoint against both sources
checkpoint = context.checkpoints.add(
    gx.Checkpoint(
        name="cross_source_check",
        validation_definitions=[
            gx.ValidationDefinition(
                name="s3_check", data=s3_asset.build_batch_request(),
                suite=suite
            ),
            gx.ValidationDefinition(
                name="pg_check", data=pg_asset.build_batch_request(),
                suite=suite
            ),
        ]
    )
)
result = checkpoint.run()
```

Source: [Great Expectations GX Core](https://docs.greatexpectations.io/docs/core/introduction/gx_overview/), [AWS GX with Redshift](https://aws.amazon.com/blogs/big-data/provide-data-reliability-in-amazon-redshift-at-scale-using-great-expectations-library/)

#### DuckDB for Lake-to-Warehouse Validation

```sql
-- Compare Parquet files on S3 with ClickHouse data via DuckDB
INSTALL httpfs;
LOAD httpfs;
SET s3_region = 'us-east-1';
SET s3_access_key_id = 'AKIAIOSFODNN7EXAMPLE';
SET s3_secret_access_key = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

-- Row count comparison
SELECT
    (SELECT COUNT(*) FROM read_parquet('s3://bucket/events/*.parquet')) AS lake_count,
    (SELECT COUNT(*) FROM postgres_db.public.events) AS warehouse_count;

-- Column-level checksum comparison
SELECT
    SUM(hash(id || amount::VARCHAR)) AS lake_hash
FROM read_parquet('s3://bucket/events/*.parquet')
EXCEPT
SELECT
    SUM(hash(id || amount::VARCHAR)) AS warehouse_hash
FROM postgres_db.public.events;
```

### 3.2 Apache Iceberg Metadata Validation

Iceberg's layered metadata architecture enables validation without full table scans:

#### Metadata Hierarchy
1. **Metadata file** (`metadata.json`): Table schema, partition spec, snapshot list
2. **Manifest list** (`snap-*.avro`): List of manifest files with partition summaries
3. **Manifest files**: Data file locations with column-level min/max statistics
4. **Data files**: Actual Parquet/ORC/Avro files

#### Metadata Inspection Queries (Spark SQL)

```sql
-- Inspect snapshots without scanning data
SELECT snapshot_id, committed_at, operation, summary
FROM prod.db.events.snapshots;

-- Check manifest-level statistics (partition bounds, file counts)
SELECT path, length, partition_spec_id, added_data_files_count,
       existing_data_files_count, deleted_data_files_count
FROM prod.db.events.manifests;

-- Partition-level validation
SELECT partition, record_count, file_count
FROM prod.db.events.partitions;

-- File-level metadata (row counts, column stats without reading data)
SELECT file_path, record_count, file_size_in_bytes,
       column_sizes, value_counts, null_value_counts,
       lower_bounds, upper_bounds
FROM prod.db.events.files;

-- Time-travel metadata inspection
SELECT * FROM prod.db.events.manifests
TIMESTAMP AS OF '2024-10-01 08:00:00';

-- Join snapshots with history for audit trail
SELECT h.made_current_at, s.operation, h.snapshot_id,
       h.is_current_ancestor, s.summary['spark.app.id']
FROM prod.db.events.history h
JOIN prod.db.events.snapshots s ON h.snapshot_id = s.snapshot_id;
```

**Key insight**: Manifest files contain partition statistics and column-level min/max values, enabling engines to validate data completeness and bounds without reading a single data file. Operations use O(1) remote calls for scan planning, not O(n) where n grows with table size.

Source: [Iceberg Spec](https://iceberg.apache.org/spec/), [Iceberg Spark Queries](https://iceberg.apache.org/docs/latest/spark-queries/), [Iceberg Metadata Explained](https://olake.io/blog/2025/10/03/iceberg-metadata/)

### 3.3 Delta Lake Change Tracking Validation

```sql
-- View table change history
DESCRIBE HISTORY delta.`/path/to/table`;

-- Compare current vs. previous version
SELECT
    COUNT(*) AS current_rows,
    (SELECT COUNT(*) FROM delta.`/path/to/table` VERSION AS OF 5) AS previous_rows;

-- Time-travel based data quality monitoring
-- Compare row counts between two points in time
SELECT
    (SELECT COUNT(*) FROM my_table TIMESTAMP AS OF '2024-10-01') AS before_count,
    (SELECT COUNT(*) FROM my_table TIMESTAMP AS OF '2024-10-02') AS after_count;

-- Detect schema changes between versions
SELECT * FROM (DESCRIBE delta.`/path/to/table` VERSION AS OF 5)
EXCEPT
SELECT * FROM (DESCRIBE delta.`/path/to/table`);
```

Delta Lake validates data types on every write operation. When incompatible data attempts to write to a table, Delta Lake cancels the transaction, preventing corrupt data from entering the table.

Source: [Delta Lake Time Travel](https://www.databricks.com/blog/2019/02/04/introducing-delta-time-travel-for-large-scale-data-lakes.html), [Delta Lake Data Quality Monitoring](https://medium.com/@victorjmp9/beyond-backup-using-delta-lake-time-travel-for-data-quality-monitoring-dfa4e24703a4)

### 3.4 Apache Hudi Pre-Commit Validation

Hudi provides built-in pre-commit validators that run before data is committed:

```scala
// Spark write with pre-commit validation
spark.write.format("hudi")
  .option("hoodie.table.name", "events")
  // Enable SQL-based validation
  .option("hoodie.precommit.validators",
    "org.apache.hudi.client.validator.SqlQuerySingleResultPreCommitValidator")
  // Validate: no null IDs in committed data
  .option("hoodie.precommit.validators.single.value.sql.queries",
    "SELECT count(*) FROM <TABLE_NAME> WHERE id IS NULL#0")
  .save(basePath)

// Multiple validators
spark.write.format("hudi")
  .option("hoodie.precommit.validators",
    "org.apache.hudi.client.validator.SqlQuerySingleResultPreCommitValidator," +
    "org.apache.hudi.client.validator.SqlQueryEqualityPreCommitValidator")
  .option("hoodie.precommit.validators.single.value.sql.queries",
    "SELECT count(*) FROM <TABLE_NAME> WHERE amount < 0#0;" +
    "SELECT count(*) FROM <TABLE_NAME> WHERE status IS NULL#0")
  .option("hoodie.precommit.validators.equality.sql.queries",
    "SELECT count(DISTINCT customer_id) FROM <TABLE_NAME>")
  .save(basePath)
```

**Three built-in validator types**:
1. `SqlQuerySingleResultPreCommitValidator` -- validates query output matches expected value
2. `SqlQueryEqualityPreCommitValidator` -- confirms results unchanged before/after commit
3. `SqlQueryInequalityPreCommitValidator` -- confirms results DO change before/after commit

Custom validators extend `SparkPreCommitValidator` and override `validateRecordsBeforeAndAfter(Dataset<Row> before, Dataset<Row> after, Set<String> partitionsAffected)`.

**Limitation**: Pre-commit validators are skipped when using `BULK_INSERT` write operation type.

Source: [Hudi Pre-Commit Validators](https://hudi.apache.org/docs/precommit_validator/), [Onehouse Hudi Validation](https://www.onehouse.ai/blog/apply-pre-commit-validation-for-data-quality-in-apache-hudi)

---

## 4. Reverse ETL Validation

### 4.1 The Reverse ETL Validation Gap

Reverse ETL tools (Census, Hightouch, Polytomic) push data from warehouses TO SaaS applications (Salesforce, HubSpot, Marketo, etc.). Validating this direction is significantly harder because:

1. **SaaS APIs have rate limits**: Can't query-back millions of records
2. **Schema mismatch**: Warehouse schemas don't map 1:1 to SaaS object models
3. **Eventual consistency**: SaaS systems may not reflect changes immediately
4. **No SQL access**: Most SaaS tools don't support SQL-based validation

### 4.2 Tool-Specific Validation Features

**Census**:
- Advanced scheduling, error handling, and monitoring
- dbt model support for activating curated datasets
- Field-level sync configuration
- Data lineage tracking
- Role-based access controls

**Hightouch**:
- Live Debugger for monitoring sync health
- Error messaging system displaying third-party API errors
- Version control features
- Detailed logging for data quality assurance

**Common pattern**: Both tools provide sync-level metrics (records synced, failed, skipped) but neither provides row-level validation against the SaaS destination.

Source: [Census vs Hightouch](https://www.polytomic.com/versus/census-vs-hightouch), [Hightouch Reverse ETL](https://hightouch.com/blog/reverse-etl)

### 4.3 Warehouse-to-SaaS Validation Pattern

```python
# Conceptual pattern: validate Salesforce data against warehouse
import simple_salesforce
import duckdb

# Connect to both sources
sf = simple_salesforce.Salesforce(
    username="user@company.com",
    password="password",
    security_token="token"
)
con = duckdb.connect()
con.execute("ATTACH 'postgres:dbname=warehouse' AS wh")

# Query Salesforce
sf_accounts = sf.query_all(
    "SELECT Id, Name, AnnualRevenue FROM Account WHERE LastModifiedDate > 2024-01-01T00:00:00Z"
)

# Load into DuckDB for comparison
con.execute("CREATE TABLE sf_accounts AS SELECT * FROM ?", [sf_accounts['records']])

# Compare
discrepancies = con.execute("""
    SELECT w.id, w.name, w.annual_revenue AS wh_revenue,
           s.AnnualRevenue AS sf_revenue
    FROM wh.public.accounts w
    LEFT JOIN sf_accounts s ON w.salesforce_id = s.Id
    WHERE w.annual_revenue != s.AnnualRevenue
       OR s.Id IS NULL
""").fetchall()
```

**Reladiff opportunity**: A reverse ETL validation connector that can query SaaS APIs and compare against warehouse truth would be a significant differentiator.

---

## 5. Data Replication Validation

### 5.1 AWS DMS Validation

AWS DMS provides the most comprehensive built-in replication validation:

**How it works**: Compares each row in the source with its corresponding row at the target, verifies identical data, and reports mismatches. Uses partition-based comparison (default 10,000 rows per partition) with multiple validation threads (default 5).

```bash
# Enable validation on DMS task
aws dms create-replication-task \
  --replication-task-settings '{
    "ValidationSettings": {
      "EnableValidation": true,
      "ValidationOnly": false,
      "ThreadCount": 5,
      "PartitionSize": 10000
    }
  }' \
  --replication-instance-arn arn:aws:dms:us-east-1:123456:rep:XXXXX \
  --source-endpoint-arn arn:aws:dms:us-east-1:123456:endpoint:SOURCE \
  --target-endpoint-arn arn:aws:dms:us-east-1:123456:endpoint:TARGET \
  --migration-type full-load-and-cdc \
  --table-mappings '{"rules": [{"rule-type": "selection", "rule-id": "1", "rule-name": "1", "object-locator": {"schema-name": "%", "table-name": "%"}, "rule-action": "include"}]}'
```

**Validation-only tasks** (DMS 3.4.6+):
```json
{
  "ValidationSettings": {
    "EnableValidation": true,
    "ValidationOnly": true
  }
}
```

**Validation states**: Not enabled, Pending records, Mismatched records, Suspended records, No primary key, Table error, Validated, Error, Pending validation, Preparing table, Pending revalidation.

**Failure tracking**: DMS creates `awsdms_control.awsdms_validation_failures_v1` at the target:

```sql
-- Query validation failures
SELECT task_name, table_owner, table_name, failure_time,
       key_type, key, failure_type, details
FROM awsdms_control.awsdms_validation_failures_v1
WHERE failure_type = 'RECORD_DIFF';
```

`failure_type` values: `RECORD_DIFF`, `MISSING_SOURCE`, `MISSING_TARGET`, `TABLE_WARNING`.

**Supported sources**: Oracle, PostgreSQL, MySQL, MariaDB, Aurora, SQL Server, IBM Db2 LUW.
**Supported targets**: All sources plus Amazon Redshift and Amazon S3.
**Limitation**: Stops after 10,000+ failed/suspended records. Primary key required.

Source: [AWS DMS Data Validation](https://docs.aws.amazon.com/dms/latest/userguide/CHAP_Validating.html), [AWS DMS Validation-Only Tasks](https://aws.amazon.com/blogs/database/optimize-data-validation-using-aws-dms-validation-only-tasks/)

### 5.2 PostgreSQL Logical Replication Validation

```sql
-- Monitor replication lag on the primary
SELECT
    slot_name,
    active,
    pg_size_pretty(
        pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn)
    ) AS replication_lag
FROM pg_replication_slots;

-- Monitor streaming replication lag
SELECT
    client_addr,
    state,
    sent_lsn,
    write_lsn,
    flush_lsn,
    replay_lsn,
    write_lag,
    flush_lag,
    replay_lag
FROM pg_stat_replication;

-- Validate data consistency between primary and replica
-- Run on both primary and replica, compare results
SELECT
    schemaname,
    relname AS table_name,
    n_live_tup AS row_count,
    last_autovacuum,
    last_autoanalyze
FROM pg_stat_user_tables
ORDER BY schemaname, relname;
```

**Key constraints for logical replication validation**:
- Tables must have a primary key or replica identity
- DDL changes are NOT replicated (indexes, tablespace, column type changes)
- Only table data is replicated (not sequences, large objects)
- Subscriber applies data in publisher's commit order for transactional consistency

Source: [PostgreSQL Logical Replication](https://www.postgresql.org/docs/current/logical-replication.html), [Monitoring PostgreSQL Replication](https://www.cybertec-postgresql.com/en/monitoring-postgresql-replication/)

### 5.3 Read Replica Lag Detection

```sql
-- PostgreSQL: Measure replication lag in seconds
SELECT
    CASE
        WHEN pg_last_wal_receive_lsn() = pg_last_wal_replay_lsn()
        THEN 0
        ELSE EXTRACT(EPOCH FROM now() - pg_last_xact_replay_timestamp())
    END AS replica_lag_seconds;

-- MySQL: Check replica lag
SHOW SLAVE STATUS\G
-- Key field: Seconds_Behind_Master (or Seconds_Behind_Source in newer versions)
```

**OpenTelemetry-based monitoring** (2025 best practice):

```yaml
# OpenTelemetry collector config for replication lag
receivers:
  postgresql:
    endpoint: localhost:5432
    username: monitor
    password: ${POSTGRES_PASSWORD}
    databases:
      - production
    metrics:
      postgresql.replication.lag:
        enabled: true

exporters:
  prometheus:
    endpoint: "0.0.0.0:8889"

service:
  pipelines:
    metrics:
      receivers: [postgresql]
      exporters: [prometheus]
```

Source: [PostgreSQL Replication Lag Monitoring](https://oneuptime.com/blog/post/2026-01-21-postgresql-replication-lag-monitoring/view), [Monitor Replication with OpenTelemetry](https://oneuptime.com/blog/post/2026-02-06-monitor-database-replication-lag-opentelemetry-metrics/view)

---

## 6. Orchestrator-Level Validation

### 6.1 Airflow SQL Check Operators

Airflow provides three built-in SQL check operators for data quality gates:

```python
from airflow.decorators import dag
from airflow.providers.common.sql.operators.sql import (
    SQLColumnCheckOperator,
    SQLTableCheckOperator,
    SQLCheckOperator,
)
from pendulum import datetime

CONN_ID = "snowflake_conn"
TABLE = "events"

@dag(start_date=datetime(2024, 1, 1), schedule="@daily", catchup=False)
def data_quality_dag():

    # Column-level checks
    column_checks = SQLColumnCheckOperator(
        task_id="column_checks",
        conn_id=CONN_ID,
        table=TABLE,
        column_mapping={
            "event_id": {
                "null_check": {"equal_to": 0},
                "distinct_check": {"geq_to": 100},
            },
            "amount": {
                "min": {"greater_than": 0},
                "max": {"less_than": 1000000},
            },
            "created_at": {
                "null_check": {"equal_to": 0},
            },
        },
    )

    # Table-level checks
    table_checks = SQLTableCheckOperator(
        task_id="table_checks",
        conn_id=CONN_ID,
        table=TABLE,
        checks={
            "row_count_check": {
                "check_statement": "COUNT(*) >= 1000"
            },
            "freshness_check": {
                "check_statement": "MAX(created_at) >= CURRENT_DATE - INTERVAL '1 day'"
            },
            "no_duplicates": {
                "check_statement": "COUNT(*) = COUNT(DISTINCT event_id)"
            },
        },
    )

    # Custom SQL check
    custom_check = SQLCheckOperator(
        task_id="custom_check",
        conn_id=CONN_ID,
        sql="""
            SELECT CASE
                WHEN ABS(today.cnt - yesterday.cnt) / yesterday.cnt < 0.5
                THEN 1 ELSE 0
            END
            FROM (SELECT COUNT(*) cnt FROM events WHERE date = CURRENT_DATE) today,
                 (SELECT COUNT(*) cnt FROM events WHERE date = CURRENT_DATE - 1) yesterday
        """,
    )

    column_checks >> table_checks >> custom_check

data_quality_dag()
```

**Great Expectations integration with Airflow**:

```python
from airflow import DAG
from great_expectations_provider.operators.great_expectations import (
    GreatExpectationsOperator,
)
from pendulum import datetime

with DAG(
    dag_id="ge_validation",
    start_date=datetime(2024, 1, 1),
    schedule="@daily",
) as dag:

    validate_source = GreatExpectationsOperator(
        task_id="validate_source_data",
        data_context_root_dir="/opt/airflow/include/great_expectations",
        checkpoint_name="source_checkpoint",
    )

    validate_target = GreatExpectationsOperator(
        task_id="validate_target_data",
        data_context_root_dir="/opt/airflow/include/great_expectations",
        checkpoint_name="target_checkpoint",
    )

    validate_source >> validate_target
```

Source: [Astronomer SQL Data Quality](https://www.astronomer.io/docs/learn/airflow-sql-data-quality), [Astronomer GX Integration](https://www.astronomer.io/docs/learn/airflow-great-expectations)

### 6.2 Dagster Asset Checks

Dagster provides first-class data quality validation through asset checks:

```python
import dagster as dg
import duckdb

@dg.asset
def raw_events() -> None:
    """Load events from source into warehouse."""
    # ... loading logic ...
    pass

@dg.asset_check(asset=raw_events, blocking=True)
def events_row_count_check():
    """Validate row count is within expected range."""
    conn = duckdb.connect("warehouse.db")
    count = conn.execute("SELECT COUNT(*) FROM raw_events").fetchone()[0]
    return dg.AssetCheckResult(
        passed=count >= 1000,
        metadata={"row_count": count},
    )

@dg.asset_check(asset=raw_events, blocking=True)
def events_no_nulls():
    """Validate no null IDs."""
    conn = duckdb.connect("warehouse.db")
    null_count = conn.execute(
        "SELECT COUNT(*) FROM raw_events WHERE id IS NULL"
    ).fetchone()[0]
    return dg.AssetCheckResult(
        passed=null_count == 0,
        metadata={"null_count": null_count},
    )

# Factory pattern for generating checks dynamically
from collections.abc import Iterable, Mapping, Sequence

def make_null_checks(
    check_configs: Sequence[Mapping[str, str]],
) -> dg.AssetChecksDefinition:
    @dg.multi_asset_check(
        specs=[
            dg.AssetCheckSpec(
                name=f"{cfg['column']}_not_null",
                asset=cfg["asset"]
            )
            for cfg in check_configs
        ]
    )
    def null_checks() -> Iterable[dg.AssetCheckResult]:
        conn = duckdb.connect("warehouse.db")
        for cfg in check_configs:
            null_count = conn.execute(
                f"SELECT COUNT(*) FROM {cfg['table']} WHERE {cfg['column']} IS NULL"
            ).fetchone()[0]
            yield dg.AssetCheckResult(
                check_name=f"{cfg['column']}_not_null",
                passed=null_count == 0,
                metadata={"null_count": null_count},
                asset_key=cfg["asset"],
            )
    return null_checks

# Schedule checks independently from asset materialization
asset_job = dg.define_asset_job(
    "asset_job",
    selection=dg.AssetSelection.assets(raw_events).without_checks(),
)
check_job = dg.define_asset_job(
    "check_job",
    selection=dg.AssetSelection.checks_for_assets(raw_events),
)

asset_schedule = dg.ScheduleDefinition(job=asset_job, cron_schedule="0 0 * * *")
check_schedule = dg.ScheduleDefinition(job=check_job, cron_schedule="0 6 * * *")
```

**Dagster data contracts with asset checks**:

```yaml
# Contract definition (contracts/shipments.yaml)
name: shipments_contract
version: "1.0"
schema:
  columns:
    shipment_id:
      type: "int64"
      required: true
    customer_name:
      type: "string"
      required: true
    amount:
      type: "float64"
      required: true
```

```python
# Validate asset against contract
@dg.asset_check(asset="shipments")
def validate_contract():
    import yaml
    with open("contracts/shipments.yaml") as f:
        contract = yaml.safe_load(f)
    # Compare actual schema against contract...
    return dg.AssetCheckResult(passed=True)
```

Key feature: `blocking=True` on asset checks prevents downstream asset materialization if checks fail.

Source: [Dagster Asset Checks](https://docs.dagster.io/guides/test/asset-checks), [Dagster Data Contracts](https://docs.dagster.io/guides/test/data-contracts)

### 6.3 Prefect Flow-Level Validation

```python
from prefect import flow, task
from prefect_great_expectations import run_checkpoint_validation

@task
def extract_data():
    """Extract from source."""
    return {"records": 1000}

@task
def validate_source():
    """Run Great Expectations validation."""
    result = run_checkpoint_validation(
        checkpoint_name="source_checkpoint",
        context_root_dir="/path/to/great_expectations",
    )
    if not result.success:
        raise ValueError("Source validation failed")
    return result

@task
def load_data(data):
    """Load to target."""
    pass

@task
def validate_target():
    """Validate loaded data."""
    result = run_checkpoint_validation(
        checkpoint_name="target_checkpoint",
        context_root_dir="/path/to/great_expectations",
    )
    return result

@flow
def etl_with_validation():
    data = extract_data()
    validate_source()
    load_data(data)
    result = validate_target()
    return result

etl_with_validation()
```

Prefect 3.x introduced `@materialize` (assets) with built-in data quality monitoring, flagging assets as unhealthy when data falls outside expected bounds.

Source: [Prefect + Great Expectations](https://docs.greatexpectations.io/docs/deployment_patterns/how_to_use_great_expectations_with_prefect/), [Prefect Assets](https://www.prefect.io/blog/introducing-assets-from-task-to-materialize)

### 6.4 dbt Source Freshness Tests

```yaml
# models/sources.yml
version: 2

sources:
  - name: raw_stripe
    database: analytics
    schema: stripe
    freshness:
      warn_after: {count: 12, period: hour}
      error_after: {count: 24, period: hour}
    loaded_at_field: _etl_loaded_at
    tables:
      - name: payments
        freshness:
          warn_after: {count: 6, period: hour}
          error_after: {count: 12, period: hour}
        loaded_at_field: created_at
        # Filter to avoid full table scan
        freshness_filter: "created_at >= date_sub(current_date(), interval 2 day)"

      - name: customers
        # Inherits source-level freshness config

      - name: audit_log
        freshness: null  # Disable freshness for this table

  - name: raw_salesforce
    freshness:
      warn_after: {count: 1, period: day}
      error_after: {count: 3, period: day}
    loaded_at_field: _synced_at
    tables:
      - name: accounts
      - name: opportunities
```

```bash
# Run freshness checks
dbt source freshness

# Run freshness with specific selection
dbt source freshness --select source:raw_stripe

# Combine with tests
dbt build --select source:raw_stripe+  # Freshness + downstream models + tests
```

**Best practice**: Run freshness jobs at least 2x the frequency of your lowest SLA. If your SLA is "data within 6 hours," run freshness checks every 3 hours minimum.

Source: [dbt Source Freshness](https://docs.getdbt.com/reference/resource-properties/freshness), [dbt Pipeline Quality Checks](https://www.getdbt.com/blog/data-pipeline-quality-checks)

---

## 7. Comprehensive Data Quality Frameworks

### 7.1 Soda Reconciliation Checks

Soda provides the most declarative cross-database reconciliation DSL available:

```yaml
# Cross-database reconciliation: MySQL -> Snowflake
reconciliation Production:
  label: "Reconcile MySQL to Snowflake"
  datasets:
    source:
      dataset: dim_customer
      datasource: mysql_production
    target:
      dataset: dim_customer
      datasource: snowflake_analytics
  checks:
    # Row count comparison
    - row_count diff = 0

    # Aggregate metric comparisons
    - avg(total_spend) diff < 10
    - sum(order_count) diff = 0
    - missing_count(email) diff = 0:
        samples columns: [customer_id, name]

    # Freshness comparison
    - freshness(last_updated) diff < 2h

    # Row-level comparison (simple strategy)
    - rows diff = 0:
        key columns: [customer_id]

    # Row-level with different column names across databases
    - rows diff < 5:
        source key columns: [cust_id]
        target key columns: [customer_id]
        source columns: [cust_id, revenue]
        target columns: [customer_id, total_revenue]

    # Schema comparison with type mapping
    - schema:
        types:
          - source: bit
            target: boolean
          - source: enum
            target: string

    # Custom SQL reconciliation
    - active_customers diff = 0:
        source query: |
          SELECT count(*)
          FROM dim_customer
          WHERE status = 'active'
        target query: |
          SELECT count(*)
          FROM dim_customer
          WHERE is_active = true

    # Referential integrity across databases
    - values in target must exist in source:
        source columns: [customer_id]
        target columns: [cust_id]
```

```yaml
# Filtered reconciliation
reconciliation Filtered:
  datasets:
    source:
      dataset: orders
      datasource: postgres_oltp
      filter: created_at > '2024-01-01'
    target:
      dataset: orders
      datasource: snowflake_warehouse
  checks:
    - row_count diff = 0
    - rows diff = 0:
        strategy: deepdiff
```

**Supported metrics for reconciliation**: `avg`, `avg_length`, `duplicate_count`, `duplicate_percent`, `freshness`, `invalid_count`, `invalid_percent`, `max`, `max_length`, `min`, `min_length`, `missing_count`, `missing_percent`, `percentile`, `row_count`, `stddev`, `sum`, `variance`.

Source: [Soda Reconciliation Checks](https://docs.soda.io/soda-v3/sodacl-reference/recon), [Soda Reference Checks](https://docs.soda.io/soda-v3/sodacl-reference/reference)

### 7.2 Elementary (dbt-native Observability)

```yaml
# elementary tests in dbt schema.yml
version: 2

models:
  - name: orders
    tests:
      # Volume anomaly detection
      - elementary.volume_anomalies:
          timestamp_column: created_at
          time_bucket:
            period: hour
            count: 1
          training_period:
            period: day
            count: 14
          severity: warn

      # Freshness anomaly detection
      - elementary.freshness_anomalies:
          timestamp_column: updated_at
          severity: error

      # Schema change detection
      - elementary.schema_changes

    columns:
      - name: order_id
        tests:
          # Column-level anomaly detection
          - elementary.column_anomalies:
              column_anomalies:
                - null_count
                - null_percent
                - zero_count
```

Source: [Elementary GitHub](https://github.com/elementary-data/elementary), [Elementary dbt Package](https://hub.getdbt.com/elementary-data/elementary/latest/)

---

## 8. Tool Comparison Matrix

| Tool | Cross-DB | Row-Level | Declarative | Lake Support | Orchestrator Integration | OSS |
|------|----------|-----------|-------------|--------------|--------------------------|-----|
| **Reladiff** | Yes (12+ DBs) | Yes (hash-based) | CLI/Python | No | Manual | MIT |
| **data-diff** | Yes | Yes (in-memory) | CLI/Python | No | Manual | MIT |
| **Soda** | Yes | Yes (recon checks) | YAML | Limited | Airflow, Dagster | Partial |
| **Great Expectations** | Per-source | Yes | Python/JSON | Spark+S3 | Airflow, Dagster, Prefect | Apache 2.0 |
| **DuckDB (as bridge)** | Yes (attach) | SQL-based | SQL | Parquet/Iceberg | Manual | MIT |
| **AWS DMS Validation** | AWS DBs | Yes (partition) | JSON config | S3 target only | AWS native | No |
| **Elementary** | No (same DB) | No (anomaly) | YAML (dbt) | Via dbt | dbt native | Apache 2.0 |
| **Dagster Checks** | No | Python-based | Python | Via code | Native | Apache 2.0 |
| **Airflow SQL Checks** | Per-connection | SQL-based | Python/SQL | Via hooks | Native | Apache 2.0 |
| **Trino** | Yes (catalogs) | SQL-based | SQL | Hive/Iceberg | Manual | Apache 2.0 |

---

## 9. Strategic Implications for Reladiff

### 9.1 Gaps Reladiff Can Fill

1. **Lake-to-warehouse validation**: No tool today lets you `reladiff s3://bucket/data.parquet postgresql:///db events -k id`. Adding Parquet/Iceberg source support would be transformative.

2. **Post-ingestion hooks**: Integrate with Fivetran/Airbyte/dlt webhooks to auto-validate after load completion. The ingestion tools emit events; Reladiff could consume them.

3. **Orchestrator plugins**: Native Airflow operator, Dagster asset check, and Prefect task wrappers would embed Reladiff into existing workflows.

4. **Reconciliation DSL**: Soda's YAML-based reconciliation syntax is the gold standard for declarative cross-database validation. Reladiff could adopt a similar approach while leveraging its superior performance.

5. **Reverse ETL validation**: No tool validates data pushed to SaaS. A Salesforce/HubSpot connector that queries back and compares would be unique.

6. **Replication lag validation**: Automated comparison between primary and replica that goes beyond lag metrics to actual data consistency.

### 9.2 Architecture Recommendation

```
                    +------------------+
                    |   Reladiff CLI   |
                    |   / Python API   |
                    +--------+---------+
                             |
                    +--------+---------+
                    |  Validation Core |
                    |  (hash-diff alg) |
                    +--------+---------+
                             |
        +--------------------+--------------------+
        |                    |                    |
+-------+-------+   +-------+-------+   +-------+-------+
| DB Connectors |   | Lake Readers  |   | SaaS Adapters |
| - Postgres    |   | - Parquet/S3  |   | - Salesforce  |
| - MySQL       |   | - Iceberg     |   | - HubSpot     |
| - Snowflake   |   | - Delta Lake  |   | - Marketo     |
| - BigQuery    |   | - Hudi        |   |               |
| - ClickHouse  |   | - GCS/Azure   |   |               |
| - Oracle      |   |               |   |               |
+---------------+   +---------------+   +---------------+
        |                    |                    |
+-------+--------------------+--------------------+-------+
|                  Orchestrator Integrations               |
| - Airflow Operator  - Dagster Asset Check                |
| - Prefect Task      - dbt Post-hook                      |
| - Soda Plugin       - GitHub Actions                     |
+----------------------------------------------------------+
```

### 9.3 Priority Integration Points

1. **Highest value**: DuckDB-style multi-attach for reading from any source (leverage DuckDB internally as the comparison engine)
2. **Highest demand**: Airflow operator + Dagster asset check (where teams already run pipelines)
3. **Biggest moat**: Iceberg metadata-level validation (compare snapshots, manifest stats without full scan)
4. **Most unique**: Reverse ETL validation against SaaS APIs

---

## Sources

- [Fivetran Data Integrity](https://www.fivetran.com/learn/data-integrity-issues)
- [Fivetran Data Validation Tools](https://fivetran.com/docs/transformations/troubleshooting/data-profiling-validation-tools)
- [Airbyte Data Integrity After Migration](https://airbyte.com/data-engineering-resources/validate-data-integrity-after-migration)
- [Airbyte Data Quality Monitoring](https://airbyte.com/data-engineering-resources/data-quality-monitoring)
- [Airbyte + dbt + re_data Tutorial](https://airbyte.com/tutorials/identify-data-quality-issues-on-data-ingestion-pipelines)
- [dlt Data Quality Lifecycle](https://dlthub.com/docs/general-usage/data-quality-lifecycle)
- [dlt Data Quality](https://dlthub.com/docs/plus/features/quality/data-quality)
- [Meltano EL Best Practices](https://meltano.com/blog/5-helpful-extract-load-practices-for-high-quality-raw-data/)
- [datafold/data-diff GitHub](https://github.com/datafold/data-diff)
- [data-diff Unified Algorithm](https://www.datafold.com/blog/data-diff-gets-faster-and-simpler-one-algorithm-better-performance)
- [Datafold Migration Testing Strategy](https://www.datafold.com/blog/data-migration-testing-strategy)
- [erezsh/reladiff GitHub](https://github.com/erezsh/reladiff)
- [thoughtworks/recce GitHub](https://github.com/thoughtworks/recce)
- [DuckDB Multi-Database Support](https://duckdb.org/2024/01/26/multi-database-support-in-duckdb)
- [DuckDB PostgreSQL Import](https://duckdb.org/docs/stable/guides/database_integration/postgres)
- [DuckDB Federated Queries for S3/GCS](https://medium.com/@Modexa/5-duckdb-federated-queries-for-s3-gcs-like-a-pro-1959dabf90bf)
- [Querying Snowflake with DuckDB](https://blog.greybeam.ai/querying-snowflake-with-duckdb/)
- [Trino](https://trino.io/)
- [Trino GitHub](https://github.com/trinodb/trino)
- [Snowflake Iceberg Tables](https://docs.snowflake.com/en/user-guide/tables-iceberg)
- [Snowflake External Writes for Iceberg](https://docs.snowflake.com/en/release-notes/2025/other/2025-07-18-iceberg-external-writes-cld)
- [Iceberg Spec](https://iceberg.apache.org/spec/)
- [Iceberg Spark Queries (Metadata Tables)](https://iceberg.apache.org/docs/latest/spark-queries/)
- [Iceberg Metadata Explained](https://olake.io/blog/2025/10/03/iceberg-metadata/)
- [Delta Lake Time Travel](https://www.databricks.com/blog/2019/02/04/introducing-delta-time-travel-for-large-scale-data-lakes.html)
- [Delta Lake Data Quality Monitoring](https://medium.com/@victorjmp9/beyond-backup-using-delta-lake-time-travel-for-data-quality-monitoring-dfa4e24703a4)
- [Hudi Pre-Commit Validators](https://hudi.apache.org/docs/precommit_validator/)
- [Onehouse Hudi Validation](https://www.onehouse.ai/blog/apply-pre-commit-validation-for-data-quality-in-apache-hudi)
- [Census vs Hightouch](https://www.polytomic.com/versus/census-vs-hightouch)
- [Hightouch Reverse ETL](https://hightouch.com/blog/reverse-etl)
- [AWS DMS Data Validation](https://docs.aws.amazon.com/dms/latest/userguide/CHAP_Validating.html)
- [AWS DMS Validation-Only Tasks](https://aws.amazon.com/blogs/database/optimize-data-validation-using-aws-dms-validation-only-tasks/)
- [AWS DMS Custom Serverless Validation](https://aws.amazon.com/blogs/database/aws-dms-validation-a-custom-serverless-architecture/)
- [PostgreSQL Logical Replication](https://www.postgresql.org/docs/current/logical-replication.html)
- [Monitoring PostgreSQL Replication](https://www.cybertec-postgresql.com/en/monitoring-postgresql-replication/)
- [PostgreSQL Replication Lag Monitoring](https://oneuptime.com/blog/post/2026-01-21-postgresql-replication-lag-monitoring/view)
- [Monitor Replication Lag with OpenTelemetry](https://oneuptime.com/blog/post/2026-02-06-monitor-database-replication-lag-opentelemetry-metrics/view)
- [Astronomer SQL Data Quality](https://www.astronomer.io/docs/learn/airflow-sql-data-quality)
- [Astronomer GX + Airflow](https://www.astronomer.io/docs/learn/airflow-great-expectations)
- [Astronomer Data Quality Overview](https://www.astronomer.io/docs/learn/data-quality)
- [Dagster Asset Checks](https://docs.dagster.io/guides/test/asset-checks)
- [Dagster Data Contracts](https://docs.dagster.io/guides/test/data-contracts)
- [Dagster + Great Expectations](https://dagster.io/blog/ensuring-data-quality-with-dagster-and-great-expectations)
- [Prefect + Great Expectations](https://docs.greatexpectations.io/docs/deployment_patterns/how_to_use_great_expectations_with_prefect/)
- [Prefect Assets](https://www.prefect.io/blog/introducing-assets-from-task-to-materialize)
- [dbt Source Freshness](https://docs.getdbt.com/reference/resource-properties/freshness)
- [dbt Pipeline Quality Checks](https://www.getdbt.com/blog/data-pipeline-quality-checks)
- [dbt Data Quality Testing Guide](https://www.sparvi.io/blog/dbt-data-quality-testing)
- [Soda Reconciliation Checks](https://docs.soda.io/soda-v3/sodacl-reference/recon)
- [Soda Reference Checks](https://docs.soda.io/soda-v3/sodacl-reference/reference)
- [Soda Core GitHub](https://github.com/sodadata/soda-core)
- [Great Expectations GX Core](https://docs.greatexpectations.io/docs/core/introduction/gx_overview/)
- [GX Data Integrity Validation](https://docs.greatexpectations.io/docs/reference/learn/data_quality_use_cases/integrity/)
- [AWS GX with Redshift](https://aws.amazon.com/blogs/big-data/provide-data-reliability-in-amazon-redshift-at-scale-using-great-expectations-library/)
- [Elementary GitHub](https://github.com/elementary-data/elementary)
- [Elementary dbt Package](https://hub.getdbt.com/elementary-data/elementary/latest/)
- [Data Contracts Guide (Soda)](https://soda.io/blog/guide-to-data-contracts)
- [2026 Open-Source Data Quality Landscape](https://datakitchen.io/the-2026-open-source-data-quality-and-data-observability-landscape/)
