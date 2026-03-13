# Theme S: Data Lakehouse Validation — Iceberg, Delta Lake, and Hudi

_Iteration 1 — 2026-03-13_

## Table of Contents

1. [Apache Iceberg Validation Patterns](#1-apache-iceberg-validation-patterns)
2. [Delta Lake Validation](#2-delta-lake-validation)
3. [Apache Hudi Validation](#3-apache-hudi-validation)
4. [Lakehouse-Specific Challenges](#4-lakehouse-specific-challenges)
5. [DuckDB as a Lakehouse Validation Engine](#5-duckdb-as-a-lakehouse-validation-engine)
6. [Trino/Presto for Cross-Lakehouse Validation](#6-trinopresto-for-cross-lakehouse-validation)
7. [Great Expectations + Lakehouse](#7-great-expectations--lakehouse)
8. [Partition-Level Validation Strategies](#8-partition-level-validation-strategies)
9. [Data Lakehouse Migration Validation](#9-data-lakehouse-migration-validation)
10. [Our Reladiff Engine Positioning](#10-our-reladiff-engine-positioning)
11. [References](#11-references)

---

## 1. Apache Iceberg Validation Patterns

### 1.1 The Iceberg Metadata Architecture

Apache Iceberg's architecture is uniquely suited to data validation because it maintains a rich, multi-layered metadata tree that tracks every change to a table. Unlike traditional data lake formats (raw Parquet/ORC on S3), Iceberg gives us the building blocks to answer the question "what changed, when, and how?" without scanning the full dataset.

```
                        Iceberg Metadata Architecture
  ┌──────────────────────────────────────────────────────────────────┐
  │                         CATALOG                                  │
  │  (Hive Metastore, AWS Glue, Nessie, REST Catalog, Polaris)      │
  │  Points to → current metadata.json                               │
  └──────────────────────┬───────────────────────────────────────────┘
                         │
                         v
  ┌──────────────────────────────────────────────────────────────────┐
  │                    metadata.json (v3)                             │
  │  ┌────────────────────────────────────────────────────────────┐  │
  │  │  table-uuid: "abc-123"                                     │  │
  │  │  format-version: 2                                         │  │
  │  │  schemas: [                                                │  │
  │  │    { schema-id: 0, fields: [...] },   ← original schema   │  │
  │  │    { schema-id: 1, fields: [...] },   ← after ADD COLUMN  │  │
  │  │    { schema-id: 2, fields: [...] }    ← after RENAME      │  │
  │  │  ]                                                         │  │
  │  │  current-schema-id: 2                                      │  │
  │  │  partition-specs: [...]                                    │  │
  │  │  current-snapshot-id: 48320956843                          │  │
  │  │  snapshots: [                                              │  │
  │  │    { snapshot-id: 10001, manifest-list: "snap-10001.avro" }│  │
  │  │    { snapshot-id: 10002, manifest-list: "snap-10002.avro" }│  │
  │  │    { snapshot-id: 48320, manifest-list: "snap-48320.avro" }│  │
  │  │  ]                                                         │  │
  │  │  snapshot-log: [{ timestamp, snapshot-id }, ...]           │  │
  │  └────────────────────────────────────────────────────────────┘  │
  └──────────────────────┬───────────────────────────────────────────┘
                         │
                         v
  ┌──────────────────────────────────────────────────────────────────┐
  │              Manifest List (Avro) — one per snapshot             │
  │  ┌────────────────────────────────────────────────────────────┐  │
  │  │  manifest_path: "manifest-001.avro"                        │  │
  │  │  added_files_count: 12                                     │  │
  │  │  existing_files_count: 340                                 │  │
  │  │  deleted_files_count: 0                                    │  │
  │  │  partition_summaries: [                                    │  │
  │  │    { field: "date", lower: "2026-01-01", upper: "2026-01" }│  │
  │  │  ]                                                         │  │
  │  └────────────────────────────────────────────────────────────┘  │
  │  ┌────────────────────────────────────────────────────────────┐  │
  │  │  manifest_path: "manifest-002.avro"                        │  │
  │  │  added_files_count: 0                                      │  │
  │  │  existing_files_count: 200                                 │  │
  │  │  deleted_files_count: 3                                    │  │
  │  │  partition_summaries: [...]                                │  │
  │  └────────────────────────────────────────────────────────────┘  │
  └──────────────────────┬───────────────────────────────────────────┘
                         │
                         v
  ┌──────────────────────────────────────────────────────────────────┐
  │              Manifest Files (Avro) — list data files             │
  │  ┌────────────────────────────────────────────────────────────┐  │
  │  │  data_file: {                                              │  │
  │  │    file_path: "s3://bucket/data/date=2026-03-12/part-0.pq" │  │
  │  │    partition: { date: "2026-03-12" }                       │  │
  │  │    record_count: 145000                                    │  │
  │  │    file_size_in_bytes: 23456789                            │  │
  │  │    column_sizes: { 1: 5000000, 2: 3000000, ... }          │  │
  │  │    value_counts: { 1: 145000, 2: 144800, ... }            │  │
  │  │    null_value_counts: { 1: 0, 2: 200, ... }               │  │
  │  │    lower_bounds: { 1: "A001", 2: 100, ... }               │  │
  │  │    upper_bounds: { 1: "Z999", 2: 99999, ... }             │  │
  │  │  }                                                         │  │
  │  └────────────────────────────────────────────────────────────┘  │
  └──────────────────────────────────────────────────────────────────┘
                         │
                         v
  ┌──────────────────────────────────────────────────────────────────┐
  │              Data Files (Parquet, ORC, Avro)                     │
  │  s3://bucket/data/date=2026-03-12/part-00000-abc.parquet         │
  │  s3://bucket/data/date=2026-03-12/part-00001-def.parquet         │
  │  s3://bucket/data/date=2026-03-13/part-00000-ghi.parquet         │
  └──────────────────────────────────────────────────────────────────┘
```

Every write to an Iceberg table creates a new snapshot. Each snapshot is a consistent, complete view of the table at a given point in time. This makes Iceberg inherently diff-able: comparing two snapshots tells you exactly what changed.

### 1.2 Snapshot-Based Comparison

The most fundamental validation pattern in Iceberg is comparing the table at two points in time. Iceberg tracks every snapshot with a unique `snapshot_id` and a timestamp, allowing precise time-travel queries.

**Spark SQL — Time Travel Queries:**

```sql
-- Query by snapshot ID
SELECT * FROM prod.db.orders VERSION AS OF 10963874102873;

-- Query by timestamp
SELECT * FROM prod.db.orders TIMESTAMP AS OF '2026-03-12 14:30:00';

-- Compare row counts between two snapshots
SELECT 'before' AS version, COUNT(*) AS row_count
FROM prod.db.orders VERSION AS OF 10963874102873
UNION ALL
SELECT 'after' AS version, COUNT(*) AS row_count
FROM prod.db.orders VERSION AS OF 63874143573109;

-- Detect changed rows between snapshots using a full outer join
WITH before AS (
    SELECT *, md5(concat_ws('|', order_id, customer_id, amount, status))
        AS row_hash
    FROM prod.db.orders VERSION AS OF 10963874102873
),
after AS (
    SELECT *, md5(concat_ws('|', order_id, customer_id, amount, status))
        AS row_hash
    FROM prod.db.orders VERSION AS OF 63874143573109
)
SELECT
    COALESCE(b.order_id, a.order_id) AS order_id,
    CASE
        WHEN b.row_hash IS NULL THEN 'INSERTED'
        WHEN a.row_hash IS NULL THEN 'DELETED'
        WHEN b.row_hash != a.row_hash THEN 'MODIFIED'
        ELSE 'UNCHANGED'
    END AS change_type
FROM before b
FULL OUTER JOIN after a ON b.order_id = a.order_id
WHERE b.row_hash IS NULL OR a.row_hash IS NULL OR b.row_hash != a.row_hash;
```

**Spark DataFrame API — Incremental Read Between Snapshots:**

Iceberg also supports reading only the data appended between two snapshots, which is far more efficient than joining full snapshots:

```python
# Read only rows added between two snapshots (append-only)
df_changes = spark.read \
    .format("iceberg") \
    .option("start-snapshot-id", "10963874102873") \
    .option("end-snapshot-id", "63874143573109") \
    .load("prod.db.orders")

# Validate: count of changes matches expected ETL output
expected_count = 15000
actual_count = df_changes.count()
assert actual_count == expected_count, \
    f"Expected {expected_count} new rows, got {actual_count}"
```

**Important limitation:** Incremental reads only capture `APPEND` operations. They cannot detect `DELETE`, `OVERWRITE`, or `UPDATE` operations. For those, you need the full snapshot comparison approach. This is a critical distinction for validation — if your pipeline uses MERGE or UPDATE, incremental reads alone will miss changes.

### 1.3 Manifest File Inspection for Partition-Level Validation

Iceberg's manifest files contain partition-level statistics that enable validation without reading actual data files. Each manifest in the manifest list includes:

- `added_files_count`, `existing_files_count`, `deleted_files_count` — how many files were added, carried forward, or removed in this manifest
- `partition_summaries` — partition bounds (lower/upper) for each partition field
- Per-data-file statistics: `record_count`, `null_value_counts`, `lower_bounds`, `upper_bounds`

This means you can answer questions like "which partitions changed in the last commit?" by inspecting metadata alone:

```sql
-- Spark SQL: Query the manifests metadata table
SELECT
    path,
    added_data_files_count,
    existing_data_files_count,
    deleted_data_files_count,
    partition_summaries
FROM prod.db.orders.manifests;

-- Query the files metadata table to see per-file statistics
SELECT
    file_path,
    partition,
    record_count,
    file_size_in_bytes,
    null_value_counts,
    lower_bounds,
    upper_bounds
FROM prod.db.orders.files;

-- Query the history metadata table to find snapshots
SELECT
    made_current_at,
    snapshot_id,
    parent_id,
    is_current_ancestor
FROM prod.db.orders.history
ORDER BY made_current_at DESC;

-- Query the snapshots metadata table
SELECT
    committed_at,
    snapshot_id,
    parent_id,
    operation,
    manifest_list,
    summary
FROM prod.db.orders.snapshots
ORDER BY committed_at DESC;
```

The `summary` column in the snapshots table contains a map with keys like `added-data-files`, `added-records`, `deleted-data-files`, `deleted-records`, `total-records`, and `total-data-files`. This is a goldmine for validation:

```sql
-- Validate that a snapshot added the expected number of records
SELECT
    snapshot_id,
    summary['added-records'] AS added_records,
    summary['deleted-records'] AS deleted_records,
    summary['total-records'] AS total_records,
    summary['total-data-files'] AS total_files
FROM prod.db.orders.snapshots
WHERE snapshot_id = 63874143573109;
```

### 1.4 Schema Evolution Tracking via metadata.json

Iceberg tracks schema evolution through unique integer field IDs, not column names or positions. This is a fundamental architectural decision that prevents silent data corruption when columns are renamed, reordered, or recycled.

The `metadata.json` file contains a `schemas` array with every schema version the table has ever used:

```json
{
  "format-version": 2,
  "table-uuid": "abc-123-def-456",
  "schemas": [
    {
      "schema-id": 0,
      "fields": [
        { "id": 1, "name": "order_id", "type": "long", "required": true },
        { "id": 2, "name": "customer_id", "type": "long", "required": true },
        { "id": 3, "name": "amount", "type": "decimal(10,2)", "required": false }
      ]
    },
    {
      "schema-id": 1,
      "fields": [
        { "id": 1, "name": "order_id", "type": "long", "required": true },
        { "id": 2, "name": "customer_id", "type": "long", "required": true },
        { "id": 3, "name": "total_amount", "type": "decimal(10,2)", "required": false },
        { "id": 4, "name": "currency", "type": "string", "required": false }
      ]
    }
  ],
  "current-schema-id": 1
}
```

Key behaviors for validation:

- **Renaming a column** changes only the name in metadata; the ID stays the same. Old data files still map correctly — no rewrite needed.
- **Adding a column** assigns a new ID. Old data files return `null` for the new column.
- **Dropping a column** removes the ID from the active schema. Old data files still contain the data, but it is never read.
- **Dropping and re-adding a column with the same name** assigns a fresh ID, preventing old data from being misinterpreted.

**Validation implications:** When comparing data across schema versions, you must be aware that:
1. Columns added after certain snapshots will return `null` for earlier data
2. Column names may have changed, but the underlying field IDs are stable
3. Type promotions (e.g., `int` to `long`) are safe, but other type changes may require data rewriting

### 1.5 The iceberg() Table Function Across Engines

Different query engines provide their own Iceberg integration points, each with validation-relevant capabilities:

| Engine | Function/Connector | Time Travel | Metadata Tables | Write Support |
|--------|-------------------|-------------|-----------------|---------------|
| Spark | Native Iceberg catalog | `VERSION AS OF`, `TIMESTAMP AS OF` | `.snapshots`, `.history`, `.manifests`, `.files`, `.entries`, `.partitions` | Full |
| Trino | Iceberg connector | `FOR VERSION AS OF`, `FOR TIMESTAMP AS OF` | `$snapshots`, `$manifests`, `$files`, `$history`, `$partitions` | Full |
| DuckDB | `iceberg_scan()`, `iceberg_snapshots()`, `iceberg_metadata()` | `AT (VERSION => id)`, `AT (TIMESTAMP => ts)` | Via functions | Read + Write (v1.3+) |
| ClickHouse | `iceberg()` table function | Limited | None | Read-only |
| Presto | Iceberg connector | `FOR VERSION AS OF` | `$snapshots`, `$manifests` | Limited |

---

## 2. Delta Lake Validation

### 2.1 Transaction Log Architecture

Delta Lake's approach to validation is centered on its transaction log — a sequence of JSON files in the `_delta_log/` directory that records every mutation to a Delta table. Each commit creates a new JSON file (`00000000000000000001.json`, `00000000000000000002.json`, etc.) containing the actions performed.

```
                    Delta Lake Transaction Log
  ┌──────────────────────────────────────────────────────────────┐
  │                       _delta_log/                            │
  │                                                              │
  │  00000000000000000000.json  ← Initial table creation         │
  │  00000000000000000001.json  ← First INSERT                   │
  │  00000000000000000002.json  ← UPDATE (add + remove actions)  │
  │  00000000000000000003.json  ← MERGE                          │
  │  00000000000000000004.json  ← DELETE                         │
  │  ...                                                         │
  │  00000000000000000010.checkpoint.parquet  ← Checkpoint        │
  │  _last_checkpoint                        ← Pointer           │
  │                                                              │
  │  Each JSON file contains:                                    │
  │  {                                                           │
  │    "add": { "path": "part-00001.parquet",                    │
  │             "partitionValues": {"date": "2026-03-12"},       │
  │             "size": 23456789,                                │
  │             "stats": "{\"numRecords\":145000,...}" },         │
  │    "remove": { "path": "part-00000.parquet",                 │
  │                "deletionTimestamp": 1710244200000 },          │
  │    "commitInfo": { "operation": "MERGE",                     │
  │                    "operationMetrics": {                      │
  │                      "numTargetRowsInserted": "5000",        │
  │                      "numTargetRowsUpdated": "3200",         │
  │                      "numTargetRowsDeleted": "150" } }       │
  │  }                                                           │
  └──────────────────────────────────────────────────────────────┘
```

Every change to a Delta table is recorded as a commit in JSON format, creating a complete audit trail. This makes Delta Lake inherently auditable — you can reconstruct the exact sequence of operations that produced the current table state.

### 2.2 DESCRIBE HISTORY for Change Tracking

The `DESCRIBE HISTORY` command is the primary tool for auditing Delta table changes. It returns provenance information for each write, including the operation type, user, timestamp, and operational metrics.

```sql
-- View full table history
DESCRIBE HISTORY prod.db.orders;

-- Output columns:
-- version | timestamp | userId | userName | operation | operationMetrics
-- | operationParameters | ...

-- View last 10 operations
DESCRIBE HISTORY prod.db.orders LIMIT 10;

-- Key fields in operationMetrics (varies by operation):
-- MERGE:
--   numTargetRowsInserted, numTargetRowsUpdated,
--   numTargetRowsDeleted, numSourceRows,
--   numTargetRowsMatchedUpdated, numTargetRowsNotMatchedInserted
-- INSERT:
--   numOutputRows, numOutputBytes
-- DELETE:
--   numDeletedRows, numRemovedFiles, numCopiedRows
-- UPDATE:
--   numUpdatedRows, numCopiedRows
```

**Validation use case:** After running an ETL pipeline that performs a MERGE, you can validate the operation by checking `operationMetrics`:

```sql
-- Validate a MERGE operation
WITH last_merge AS (
    SELECT operationMetrics
    FROM (DESCRIBE HISTORY prod.db.orders)
    WHERE operation = 'MERGE'
    ORDER BY version DESC
    LIMIT 1
)
SELECT
    operationMetrics.numSourceRows AS source_rows,
    operationMetrics.numTargetRowsInserted AS inserted,
    operationMetrics.numTargetRowsUpdated AS updated,
    operationMetrics.numTargetRowsDeleted AS deleted,
    -- Validate: source rows should equal inserts + updates + deletes
    (operationMetrics.numTargetRowsInserted +
     operationMetrics.numTargetRowsUpdated +
     operationMetrics.numTargetRowsDeleted) AS total_affected,
    CASE
        WHEN operationMetrics.numSourceRows =
             operationMetrics.numTargetRowsInserted +
             operationMetrics.numTargetRowsUpdated +
             operationMetrics.numTargetRowsDeleted
        THEN 'VALID'
        ELSE 'MISMATCH - investigate'
    END AS validation_result
FROM last_merge;
```

### 2.3 VERSION AS OF for Snapshot Comparison

Delta Lake's time travel uses version numbers (integers) or timestamps for snapshot comparison:

```sql
-- Query a specific version
SELECT * FROM prod.db.orders VERSION AS OF 5;

-- Query by timestamp
SELECT * FROM prod.db.orders TIMESTAMP AS OF '2026-03-12 14:30:00';

-- Compare row counts between versions
SELECT 'v5' AS version, COUNT(*) AS cnt FROM prod.db.orders VERSION AS OF 5
UNION ALL
SELECT 'v8' AS version, COUNT(*) AS cnt FROM prod.db.orders VERSION AS OF 8;

-- Find rows that changed between versions
WITH v5 AS (
    SELECT *, sha2(concat_ws('|', order_id, customer_id, amount, status), 256)
        AS row_hash
    FROM prod.db.orders VERSION AS OF 5
),
v8 AS (
    SELECT *, sha2(concat_ws('|', order_id, customer_id, amount, status), 256)
        AS row_hash
    FROM prod.db.orders VERSION AS OF 8
)
SELECT
    COALESCE(a.order_id, b.order_id) AS order_id,
    CASE
        WHEN a.row_hash IS NULL THEN 'INSERTED'
        WHEN b.row_hash IS NULL THEN 'DELETED'
        WHEN a.row_hash != b.row_hash THEN 'MODIFIED'
    END AS change_type,
    a.amount AS old_amount,
    b.amount AS new_amount
FROM v5 a
FULL OUTER JOIN v8 b ON a.order_id = b.order_id
WHERE a.row_hash IS NULL OR b.row_hash IS NULL OR a.row_hash != b.row_hash;
```

**Retention caveat:** Table history is retained for 30 days by default. After that, old versions are vacuumed. Set `delta.logRetentionDuration` and `delta.deletedFileRetentionDuration` appropriately for validation windows.

### 2.4 Change Data Feed (CDF) for Incremental Validation

Change Data Feed is Delta Lake's most powerful validation tool. When enabled, it records row-level changes with metadata columns indicating the change type.

```sql
-- Enable CDF on a table
ALTER TABLE prod.db.orders
SET TBLPROPERTIES (delta.enableChangeDataFeed = true);

-- Read changes between versions (SQL)
SELECT *
FROM table_changes('prod.db.orders', 5, 8);

-- The output includes additional metadata columns:
-- _change_type: 'insert', 'update_preimage', 'update_postimage', 'delete'
-- _commit_version: the Delta version that produced this change
-- _commit_timestamp: when the change was committed
```

```python
# Read CDF in Spark (Python)
changes = spark.read.format("delta") \
    .option("readChangeFeed", "true") \
    .option("startingVersion", 5) \
    .option("endingVersion", 8) \
    .table("prod.db.orders")

# Validate: count changes by type
changes.groupBy("_change_type").count().show()
# +-------------------+-----+
# |       _change_type|count|
# +-------------------+-----+
# |             insert| 5000|
# |    update_preimage| 3200|
# |   update_postimage| 3200|
# |             delete|  150|
# +-------------------+-----+

# Validate: update preimages and postimages should be 1:1
pre = changes.filter("_change_type = 'update_preimage'").count()
post = changes.filter("_change_type = 'update_postimage'").count()
assert pre == post, f"Preimage count {pre} != postimage count {post}"
```

**CDF validation patterns:**

1. **Row count reconciliation** — Verify that the number of inserts in CDF matches the expected ingest count
2. **Update integrity** — Confirm that every `update_preimage` has a matching `update_postimage`
3. **Delete auditing** — Track every deletion with the full pre-delete row state
4. **Downstream pipeline verification** — Use CDF to validate that downstream tables received exactly the changes they should have

**Critical caveat:** CDF only records changes made *after* it is enabled. Past changes are not retroactively captured. Enable CDF early in the table lifecycle.

### 2.5 Delta Lake Constraints

Delta Lake supports SQL constraint management for data quality enforcement at write time:

```sql
-- NOT NULL constraint
ALTER TABLE prod.db.orders ALTER COLUMN order_id SET NOT NULL;

-- CHECK constraint
ALTER TABLE prod.db.orders ADD CONSTRAINT valid_amount
    CHECK (amount > 0 AND amount < 1000000);

ALTER TABLE prod.db.orders ADD CONSTRAINT valid_status
    CHECK (status IN ('pending', 'shipped', 'delivered', 'cancelled'));

-- View constraints
DESCRIBE DETAIL prod.db.orders;

-- When a constraint is violated, Delta Lake throws
-- InvariantViolationException and the write is rejected.
```

### 2.6 Databricks Lakeflow Declarative Pipelines (formerly Delta Live Tables)

Databricks extends Delta Lake with pipeline-level data quality expectations:

```sql
-- Define a streaming table with expectations
CREATE OR REFRESH STREAMING TABLE orders_clean (
    -- Expect: order_id must not be null
    CONSTRAINT valid_order_id EXPECT (order_id IS NOT NULL)
        ON VIOLATION DROP ROW,

    -- Expect: amount must be positive
    CONSTRAINT valid_amount EXPECT (amount > 0)
        ON VIOLATION FAIL UPDATE,

    -- Expect: at least 99% of records have valid email
    CONSTRAINT valid_email EXPECT (email RLIKE '^[^@]+@[^@]+\\.[^@]+$')
        -- Default: retain invalid rows but track violations
)
AS SELECT * FROM STREAM(raw_orders);
```

The three violation handling modes:
- **Default (EXPECT only):** Retain invalid records but track metrics on pass/fail rates
- **ON VIOLATION DROP ROW:** Silently drop invalid records (great for filtering junk data)
- **ON VIOLATION FAIL UPDATE:** Abort the entire pipeline update if any record violates the constraint

Expectation results are automatically logged into Delta tables as event logs, enabling dashboards and SQL alerts on data quality trends.

---

## 3. Apache Hudi Validation

### 3.1 Timeline-Based Validation

Apache Hudi's timeline is the backbone of its validation architecture. It serves as a log of all actions performed on the table at different instants (points in time), acting as the source of truth for table state.

```
                        Hudi Timeline Architecture
  ┌──────────────────────────────────────────────────────────────────┐
  │                       .hoodie/ directory                         │
  │                                                                  │
  │  Timeline Instants:                                              │
  │  ┌─────────────────────────────────────────────────────────────┐ │
  │  │  20260312143000.commit          ← Completed UPSERT          │ │
  │  │  20260312150000.deltacommit     ← MOR log append            │ │
  │  │  20260312160000.compaction.requested ← Compaction plan      │ │
  │  │  20260312160000.compaction.inflight  ← Compaction running   │ │
  │  │  20260312160500.compaction          ← Compaction completed  │ │
  │  │  20260312170000.clean               ← Old files cleaned     │ │
  │  │  20260312180000.commit              ← Next UPSERT           │ │
  │  └─────────────────────────────────────────────────────────────┘ │
  │                                                                  │
  │  Each instant has:                                               │
  │  - Action (commit, deltacommit, compaction, clean, rollback)     │
  │  - State (REQUESTED → INFLIGHT → COMPLETED)                     │
  │  - Instant time (acts as transaction ID)                         │
  │                                                                  │
  │  Archived Timeline (LSM-based):                                  │
  │  .hoodie/timeline/ ← Parquet files with historical actions       │
  └──────────────────────────────────────────────────────────────────┘
```

Hudi guarantees that state transitions are atomic and timeline-consistent. This means you can inspect the timeline to validate the exact sequence of operations that led to the current table state.

### 3.2 COW vs MOR Validation Differences

The choice between Copy-on-Write (COW) and Merge-on-Read (MOR) tables has significant implications for validation:

| Aspect | COW | MOR |
|--------|-----|-----|
| **Write behavior** | Rewrites entire file on update | Appends delta log files |
| **Read behavior** | Read base files directly | Merge base + delta at read time |
| **Snapshot consistency** | Each file is self-contained | Must merge to get consistent view |
| **Validation timing** | Can validate immediately after write | Must consider compaction state |
| **File count** | Fewer, larger files | Many small delta files (before compaction) |
| **Compaction impact** | Not applicable | Validation results may differ pre/post compaction |

**COW validation:** straightforward — each snapshot is a set of complete Parquet files. Validate by comparing file-level statistics.

**MOR validation:** more nuanced — you must decide whether to validate the "optimistic" view (base files only, stale but fast) or the "real-time" view (base + delta files merged, current but slower). The compaction schedule determines when these views converge.

```sql
-- Hudi snapshot query (reads latest merged view)
SELECT COUNT(*) FROM hudi_table;

-- Hudi read-optimized query (reads base files only, faster but stale)
SELECT COUNT(*) FROM hudi_table_ro;

-- Hudi incremental query (changes since a given commit)
SELECT COUNT(*) FROM hudi_table
WHERE `_hoodie_commit_time` > '20260312143000';
```

### 3.3 Precommit Validators for Data Quality

Hudi provides a first-class precommit validation framework — a feature unique among the three table formats. Precommit validators run data quality checks before a commit is finalized, rejecting bad data before it enters the table.

**Built-in validators:**

1. **SqlQueryEqualityPreCommitValidator** — Runs a SQL query before and after ingestion, confirms outputs match:

```properties
# Hudi configuration
hoodie.precommit.validators=
    org.apache.hudi.client.validator.SqlQueryEqualityPreCommitValidator

# The query runs against both pre-commit and post-commit datasets
hoodie.precommit.validators.equality.sql.queries=
    SELECT COUNT(*) FROM <TABLE>
```

2. **SqlQueryInequalityPreCommitValidator** — Confirms outputs do NOT match (i.e., data actually changed):

```properties
hoodie.precommit.validators=
    org.apache.hudi.client.validator.SqlQueryInequalityPreCommitValidator

hoodie.precommit.validators.inequality.sql.queries=
    SELECT COUNT(*) FROM <TABLE>
```

3. **SqlQuerySingleResultPreCommitValidator** — Validates that a query produces a specific expected value:

```properties
hoodie.precommit.validators=
    org.apache.hudi.client.validator.SqlQuerySingleResultPreCommitValidator

# Format: query#expected_result;query#expected_result
hoodie.precommit.validators.single.value.sql.queries=
    SELECT COUNT(*) FROM <TABLE> WHERE amount < 0#0;
    SELECT COUNT(DISTINCT status) FROM <TABLE>#4
```

4. **Custom validators** — Extend `SparkPreCommitValidator`:

```java
public class MyValidator extends SparkPreCommitValidator {
    @Override
    public void validateRecordsBeforeAndAfter(
            Dataset<Row> before,
            Dataset<Row> after,
            Set<String> partitionsAffected) {
        // Custom validation logic
        long beforeCount = before.count();
        long afterCount = after.count();
        if (afterCount < beforeCount * 0.5) {
            throw new HoodieValidationException(
                "Row count dropped by more than 50%: " +
                beforeCount + " -> " + afterCount);
        }
    }
}
```

### 3.4 Record-Level Change Tracking

Hudi treats record-level change streams as a first-order design goal. Unlike Iceberg and Delta Lake (which primarily track changes at the file level), Hudi embeds change metadata into individual records via metafields:

- `_hoodie_commit_time` — When the record was last committed
- `_hoodie_commit_seqno` — Sequence number within the commit
- `_hoodie_record_key` — Primary key of the record
- `_hoodie_partition_path` — Partition path
- `_hoodie_file_name` — File containing the record

This means you can track changes to individual records without joining full snapshots:

```sql
-- Find all versions of a specific record
SELECT
    _hoodie_commit_time,
    _hoodie_record_key,
    order_id,
    amount,
    status
FROM hudi_table
WHERE _hoodie_record_key = 'order_12345'
ORDER BY _hoodie_commit_time;

-- Incremental query: all changes since a specific commit
SELECT * FROM hudi_table
WHERE `_hoodie_commit_time` > '20260312143000';
```

This is a significant advantage for validation. Where Iceberg and Delta Lake require comparing file-level snapshots (potentially scanning terabytes), Hudi can provide record-level change streams natively — more precise and more efficient for targeted validation.

### 3.5 Table Format Validation Comparison

| Feature | Iceberg | Delta Lake | Hudi |
|---------|---------|------------|------|
| **Time travel** | Snapshot ID or timestamp | Version number or timestamp | Instant time |
| **Change tracking granularity** | File-level (snapshot diff) | Row-level (CDF, when enabled) | Record-level (native) |
| **Pre-commit validation** | None built-in | Constraints (CHECK, NOT NULL) | Full precommit validator framework |
| **Schema evolution tracking** | Field-ID-based, full history in metadata.json | Schema enforcement/evolution in transaction log | Schema evolution via timeline |
| **Partition-level metadata** | Manifest summaries with partition bounds | File-level stats in transaction log | File group based |
| **Incremental read** | Append-only between snapshots | CDF for all change types | Native incremental queries for all change types |
| **Metadata inspection** | Rich metadata tables (.snapshots, .manifests, .files) | DESCRIBE HISTORY, DESCRIBE DETAIL | Timeline inspection |
| **Audit trail** | Snapshot log in metadata.json | Full transaction log in _delta_log/ | Timeline with action history |

---

## 4. Lakehouse-Specific Challenges

### 4.1 Object Store Consistency

The most fundamental challenge in lakehouse validation is that data lives on object stores (S3, GCS, ADLS), which behave differently from traditional filesystems.

**The historical problem (pre-December 2020):**
Amazon S3 originally provided only *eventual consistency* for certain operations. After a PUT to create a new object, a subsequent LIST might not include the new object. After a DELETE, a subsequent GET might still return the deleted object. This caused real data quality issues:

- ETL jobs could miss files that were just written
- List operations could leave behind objects, causing data loss during moves
- Query results could be incorrect when reading partially-visible writes

**The current state (post-December 2020):**
AWS announced strong read-after-write consistency for all S3 operations: all S3 GET, PUT, and LIST operations are now strongly consistent. This eliminated the need for workarounds like EMRFS Consistent View and S3Guard.

**Validation implications today:**
While S3 itself is strongly consistent, the *table format metadata* introduces its own consistency considerations:

```
               Consistency Model Comparison
  ┌────────────────┬──────────────────────────────────────────┐
  │  Layer         │  Consistency Guarantee                   │
  ├────────────────┼──────────────────────────────────────────┤
  │  S3 Object     │  Strong read-after-write (since 2020)   │
  │  Storage       │  PUT → immediate GET returns new data   │
  ├────────────────┼──────────────────────────────────────────┤
  │  Iceberg       │  Optimistic concurrency via catalog      │
  │  Catalog       │  Atomic metadata pointer swap            │
  │                │  Readers may cache stale metadata         │
  ├────────────────┼──────────────────────────────────────────┤
  │  Delta Lake    │  Optimistic concurrency via _delta_log   │
  │  Transaction   │  Conflict detection on commit            │
  │  Log           │  Checkpoints every 10 commits            │
  ├────────────────┼──────────────────────────────────────────┤
  │  Hudi          │  Timeline-based MVCC                     │
  │  Timeline      │  Atomic transitions between states       │
  │                │  MOR: eventual via compaction             │
  ├────────────────┼──────────────────────────────────────────┤
  │  Query Engine  │  Engine-specific metadata caching        │
  │  Cache         │  Spark, Trino cache manifests/metadata   │
  │                │  May read stale data until cache refresh  │
  └────────────────┴──────────────────────────────────────────┘
```

**Validation best practice:** When validating data immediately after a write, ensure that the query engine has refreshed its metadata cache. In Spark, this may require `REFRESH TABLE` or `spark.catalog.refreshTable()`. In Trino, metadata caching has configurable TTLs.

### 4.2 The Small File Problem

Frequent writes to lakehouse tables (especially streaming ingestion) create many small files. This affects validation in several ways:

1. **Validation performance degrades** — Scanning thousands of small files is far slower than scanning a few large files. The overhead comes from S3 LIST operations, file open/close operations, and reduced Parquet column chunk efficiency.

2. **Row count validation may be misleading** — If compaction hasn't run, you might see the "correct" row count but from an inefficient file layout. Validation should check both data correctness and operational health (file sizes, file counts).

3. **Compaction timing affects validation** — In Hudi MOR tables and Iceberg tables with pending delete files, the "true" state of the table depends on whether compaction has reconciled base and delta files. Validation before compaction may see different results than after.

**Iceberg compaction validation:**

```sql
-- Check file size distribution to detect small file problem
SELECT
    partition,
    COUNT(*) AS file_count,
    AVG(file_size_in_bytes) AS avg_file_size,
    MIN(file_size_in_bytes) AS min_file_size,
    MAX(file_size_in_bytes) AS max_file_size,
    SUM(record_count) AS total_records
FROM prod.db.orders.files
GROUP BY partition
HAVING AVG(file_size_in_bytes) < 10000000  -- Files under 10MB
ORDER BY file_count DESC;

-- After compaction, validate that data is unchanged
-- (total records should be identical)
SELECT SUM(record_count) AS total_records
FROM prod.db.orders.files;
```

### 4.3 Schema Evolution Challenges

All three lakehouse formats support schema evolution, but they handle it differently, creating unique validation challenges:

```
          Schema Evolution Comparison
  ┌─────────────────┬──────────┬──────────┬──────────┐
  │  Operation      │ Iceberg  │ Delta    │ Hudi     │
  ├─────────────────┼──────────┼──────────┼──────────┤
  │  Add column     │ ✓ (null) │ ✓ (null) │ ✓ (null) │
  │  Drop column    │ ✓ (meta) │ ✓ (meta) │ ✓ (meta) │
  │  Rename column  │ ✓ (ID)   │ ✓ (map)  │ ✓        │
  │  Reorder columns│ ✓ (ID)   │ ✓        │ ✓        │
  │  Type promotion │ ✓ (safe) │ ✓ (safe) │ ✓ (safe) │
  │  Nested schemas │ ✓        │ ✓        │ ✓        │
  │  Partition evol. │ ✓        │ Limited  │ ✗        │
  └─────────────────┴──────────┴──────────┴──────────┘
```

**Validation challenge 1: Comparing across schema versions.** When a column is renamed, a naive column-name-based comparison breaks. Iceberg's field-ID approach solves this at the format level, but validation tools must be aware of it. Delta Lake uses column mapping (via `delta.columnMapping.mode`) which can be set to `name` or `id`.

**Validation challenge 2: Null semantics.** When a column is added, all historical data returns `null` for that column. A validation check like "column X should have no nulls" would fail for historical data even though nothing is actually wrong.

**Validation challenge 3: Partition evolution.** Iceberg supports changing the partition scheme without rewriting data. Old files stay partitioned by the old scheme; new files use the new scheme. Partition-level validation must handle multiple partition specs simultaneously.

### 4.4 Eventual Consistency in Multi-Writer Scenarios

Multiple writers to the same lakehouse table create validation challenges:

```
                Multi-Writer Conflict Scenario
  ┌──────────┐     ┌──────────┐     ┌──────────┐
  │ Writer A │     │ Writer B │     │ Validator │
  │ (ETL)    │     │ (Stream) │     │ (Checker) │
  └─────┬────┘     └────┬─────┘     └─────┬─────┘
        │               │                 │
        │  Read snap 10  │                 │
        │◄──────────────►│  Read snap 10   │
        │               │                 │  Read snap 10
        │  Write files   │                 │  (stale by now)
        │               │  Write files    │
        │               │                 │
        │  Commit snap 11│                 │
        │───────────────►│                 │
        │               │  Commit snap 12 │
        │               │────────────────►│
        │               │                 │  Still sees snap 10!
        │               │                 │  Must refresh metadata
        │               │                 │  to see snaps 11 & 12
```

Iceberg uses optimistic concurrency control at the catalog level. If two writers modify different partitions, there is no conflict. If they modify the same files, one writer's commit will be retried. The implication for validation: you may be validating against a snapshot that has already been superseded by the time your validation completes.

---

## 5. DuckDB as a Lakehouse Validation Engine

### 5.1 Why DuckDB Is a Natural Fit

DuckDB occupies a unique position in the lakehouse ecosystem. It is an in-process analytical database that can read Iceberg, Delta Lake, and Parquet files directly — without requiring a Spark cluster, Trino deployment, or any distributed infrastructure. This makes it the ideal engine for lightweight, fast data validation.

```
              DuckDB as a Validation Bridge
  ┌─────────────────────────────────────────────────────────┐
  │                      DuckDB Process                      │
  │                                                          │
  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
  │  │   Iceberg     │  │  Delta Lake  │  │   Parquet    │  │
  │  │   Extension   │  │  Extension   │  │  (built-in)  │  │
  │  │              │  │              │  │              │  │
  │  │ iceberg_scan()│  │ delta_scan() │  │read_parquet()│  │
  │  │ iceberg_     │  │              │  │              │  │
  │  │  snapshots() │  │              │  │              │  │
  │  │ iceberg_     │  │              │  │              │  │
  │  │  metadata()  │  │              │  │              │  │
  │  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  │
  │         │                 │                 │           │
  │         v                 v                 v           │
  │  ┌──────────────────────────────────────────────────┐   │
  │  │          Unified SQL Interface                    │   │
  │  │  SELECT * FROM iceberg_scan('s3://...')           │   │
  │  │  EXCEPT                                           │   │
  │  │  SELECT * FROM delta_scan('s3://...')             │   │
  │  └──────────────────────────────────────────────────┘   │
  │         │                 │                 │           │
  │         v                 v                 v           │
  │  ┌──────────────────────────────────────────────────┐   │
  │  │              S3 / GCS / Local FS                  │   │
  │  └──────────────────────────────────────────────────┘   │
  └─────────────────────────────────────────────────────────┘
```

Key advantages:
- **Zero infrastructure** — Runs as a single process, no cluster to manage
- **Multi-format support** — Reads Iceberg, Delta, Parquet, CSV, JSON natively
- **S3 direct access** — Queries object stores without data movement
- **SQL-native** — Full SQL support including window functions, CTEs, hash functions
- **Fast** — Vectorized execution engine, consistently top-tier in benchmarks
- **Embeddable** — Can be embedded in Python, Node.js, or any application

### 5.2 DuckDB Iceberg Integration

DuckDB's Iceberg extension provides three key functions for validation:

```sql
-- Install and load the Iceberg extension
INSTALL iceberg;
LOAD iceberg;

-- Configure S3 credentials
CREATE SECRET (
    TYPE S3,
    KEY_ID 'AKIAIOSFODNN7EXAMPLE',
    SECRET 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    REGION 'us-east-1'
);

-- 1. ICEBERG_SCAN: Read an Iceberg table
SELECT COUNT(*) AS row_count
FROM iceberg_scan('s3://my-bucket/warehouse/orders');

-- 2. ICEBERG_SNAPSHOTS: List all snapshots
SELECT
    sequence_number,
    snapshot_id,
    timestamp_ms,
    manifest_list
FROM iceberg_snapshots('s3://my-bucket/warehouse/orders');

-- 3. ICEBERG_METADATA: Inspect manifest-level metadata
SELECT
    manifest_path,
    manifest_sequence_number,
    status,
    content,
    file_path,
    file_format,
    record_count
FROM iceberg_metadata('s3://my-bucket/warehouse/orders');
```

**Time travel in DuckDB:**

```sql
-- Attach an Iceberg REST Catalog
ATTACH 'my_warehouse' AS iceberg_catalog (
    TYPE iceberg,
    ENDPOINT 'https://my-rest-catalog.example.com',
    TOKEN 'my-oauth-token'
);

-- Query at a specific snapshot
SELECT COUNT(*)
FROM iceberg_catalog.default.orders
AT (VERSION => 10963874102873);

-- Query at a specific timestamp
SELECT COUNT(*)
FROM iceberg_catalog.default.orders
AT (TIMESTAMP => TIMESTAMP '2026-03-12 14:30:00');

-- Compare two snapshots
WITH snap_a AS (
    SELECT *, hash(order_id, customer_id, amount, status) AS row_hash
    FROM iceberg_catalog.default.orders
    AT (VERSION => 10963874102873)
),
snap_b AS (
    SELECT *, hash(order_id, customer_id, amount, status) AS row_hash
    FROM iceberg_catalog.default.orders
    AT (VERSION => 63874143573109)
)
SELECT
    COALESCE(a.order_id, b.order_id) AS order_id,
    CASE
        WHEN a.row_hash IS NULL THEN 'INSERTED'
        WHEN b.row_hash IS NULL THEN 'DELETED'
        WHEN a.row_hash != b.row_hash THEN 'MODIFIED'
    END AS change_type
FROM snap_a a
FULL OUTER JOIN snap_b b ON a.order_id = b.order_id
WHERE a.row_hash IS NULL OR b.row_hash IS NULL OR a.row_hash != b.row_hash;
```

### 5.3 DuckDB Delta Lake Integration

```sql
-- Install and load the Delta extension
INSTALL delta;
LOAD delta;

-- Scan a Delta table (auto-installs since DuckDB v1.2.0)
SELECT COUNT(*) FROM delta_scan('s3://my-bucket/delta/orders');

-- Scan a local Delta table
SELECT * FROM delta_scan('file:///data/delta/orders') LIMIT 10;

-- DuckDB's Delta extension supports:
-- - Multithreaded scans
-- - Filter/predicate pushdown
-- - Projection pushdown
-- - Partition pruning
-- - Deletion vectors
-- - S3, GCS, Azure cloud storage

-- Attach a Delta table for repeated queries
ATTACH 's3://my-bucket/delta/orders' AS delta_orders (TYPE delta);

-- Cross-format validation: compare Iceberg vs Delta
SELECT 'iceberg' AS source, COUNT(*) AS cnt
FROM iceberg_scan('s3://my-bucket/iceberg/orders')
UNION ALL
SELECT 'delta' AS source, COUNT(*) AS cnt
FROM delta_scan('s3://my-bucket/delta/orders');
```

### 5.4 DuckDB Parquet Validation

DuckDB's native Parquet support is the foundation for all lakehouse validation, since all three table formats use Parquet as their data file format:

```sql
-- Read Parquet files directly from S3
SELECT COUNT(*) FROM read_parquet('s3://my-bucket/data/*.parquet');

-- Read with glob patterns
SELECT COUNT(*) FROM read_parquet('s3://my-bucket/data/date=2026-03-*/*.parquet');

-- Inspect Parquet metadata without reading data
SELECT * FROM parquet_metadata('s3://my-bucket/data/part-00001.parquet');

-- Get schema information
SELECT * FROM parquet_schema('s3://my-bucket/data/part-00001.parquet');

-- Aggregate checksum for validation
SELECT
    COUNT(*) AS row_count,
    SUM(amount) AS total_amount,
    bit_xor(md5_number(
        CAST(order_id AS VARCHAR) || '|' ||
        CAST(customer_id AS VARCHAR) || '|' ||
        CAST(amount AS VARCHAR)
    )) AS content_checksum
FROM read_parquet('s3://my-bucket/data/date=2026-03-12/*.parquet');
```

### 5.5 Cross-Format Data Comparison in DuckDB

The true power of DuckDB for lakehouse validation is its ability to compare data across formats in a single query:

```sql
-- Compare row counts across three formats
SELECT 'iceberg' AS format, COUNT(*) AS rows
FROM iceberg_scan('s3://bucket/iceberg/orders')
UNION ALL
SELECT 'delta' AS format, COUNT(*) AS rows
FROM delta_scan('s3://bucket/delta/orders')
UNION ALL
SELECT 'parquet' AS format, COUNT(*) AS rows
FROM read_parquet('s3://bucket/raw/orders/*.parquet');

-- Full data comparison: find rows in Iceberg but not in Delta
SELECT order_id, customer_id, amount
FROM iceberg_scan('s3://bucket/iceberg/orders')
EXCEPT
SELECT order_id, customer_id, amount
FROM delta_scan('s3://bucket/delta/orders');

-- Checksum comparison across formats
WITH iceberg_check AS (
    SELECT
        COUNT(*) AS cnt,
        SUM(amount) AS total,
        bit_xor(md5_number(
            order_id::VARCHAR || customer_id::VARCHAR || amount::VARCHAR
        )) AS checksum
    FROM iceberg_scan('s3://bucket/iceberg/orders')
),
delta_check AS (
    SELECT
        COUNT(*) AS cnt,
        SUM(amount) AS total,
        bit_xor(md5_number(
            order_id::VARCHAR || customer_id::VARCHAR || amount::VARCHAR
        )) AS checksum
    FROM delta_scan('s3://bucket/delta/orders')
)
SELECT
    i.cnt = d.cnt AS count_match,
    i.total = d.total AS total_match,
    i.checksum = d.checksum AS checksum_match,
    i.cnt AS iceberg_count,
    d.cnt AS delta_count,
    i.total AS iceberg_total,
    d.total AS delta_total
FROM iceberg_check i, delta_check d;
```

---

## 6. Trino/Presto for Cross-Lakehouse Validation

### 6.1 Federated Query Architecture

Trino (formerly PrestoSQL) is a distributed SQL query engine designed for federated analytics. Its connector architecture allows simultaneous access to multiple data sources — Iceberg, Delta Lake, Hive, PostgreSQL, MySQL — within a single SQL query. This makes it the engine of choice for large-scale cross-lakehouse validation.

```
                   Trino Federated Validation Architecture
  ┌───────────────────────────────────────────────────────────────┐
  │                        Trino Cluster                          │
  │                                                               │
  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
  │  │  Iceberg    │  │  Delta Lake │  │  Hive Connector     │  │
  │  │  Connector  │  │  Connector  │  │  (legacy Parquet)   │  │
  │  │             │  │             │  │                     │  │
  │  │ iceberg_cat │  │ delta_cat   │  │ hive_cat            │  │
  │  └──────┬──────┘  └──────┬──────┘  └──────────┬──────────┘  │
  │         │                │                    │              │
  │  ┌──────┴──────┐  ┌──────┴──────┐  ┌──────────┴──────────┐  │
  │  │ PostgreSQL  │  │  MySQL      │  │  Elasticsearch      │  │
  │  │ Connector   │  │  Connector  │  │  Connector          │  │
  │  │             │  │             │  │                     │  │
  │  │ pg_cat      │  │ mysql_cat   │  │ es_cat              │  │
  │  └──────┬──────┘  └──────┴──────┘  └──────────┴──────────┘  │
  │         │                │                    │              │
  │         v                v                    v              │
  │  ┌──────────────────────────────────────────────────────┐    │
  │  │          Unified SQL — Cross-Catalog Joins            │    │
  │  │                                                       │    │
  │  │  SELECT * FROM iceberg_cat.db.orders i                │    │
  │  │  JOIN pg_cat.public.customers c ON i.cust_id = c.id   │    │
  │  │  JOIN delta_cat.db.shipments s ON i.order_id = s.oid  │    │
  │  └──────────────────────────────────────────────────────┘    │
  └───────────────────────────────────────────────────────────────┘
```

### 6.2 Trino Iceberg Validation Queries

```sql
-- Time travel by snapshot ID
SELECT * FROM iceberg_cat.db.orders
FOR VERSION AS OF 241938428756831817;

-- Time travel by timestamp
SELECT * FROM iceberg_cat.db.orders
FOR TIMESTAMP AS OF TIMESTAMP '2026-03-12 14:30:00 UTC';

-- Query snapshots metadata table
SELECT
    snapshot_id,
    parent_id,
    operation,
    manifest_list,
    summary
FROM iceberg_cat.db."orders$snapshots"
ORDER BY committed_at DESC;

-- Query files metadata for partition-level statistics
SELECT
    file_path,
    partition,
    record_count,
    file_size_in_bytes
FROM iceberg_cat.db."orders$files"
WHERE partition = ROW(DATE '2026-03-12');

-- Query history
SELECT
    made_current_at,
    snapshot_id,
    parent_id,
    is_current_ancestor
FROM iceberg_cat.db."orders$history";

-- Rollback to a previous snapshot
CALL iceberg_cat.system.rollback_to_snapshot('db', 'orders', 241938428756831817);
```

### 6.3 Cross-Catalog Validation Patterns

The most powerful Trino validation pattern is comparing data across different catalogs and table formats:

```sql
-- Pattern 1: Row count reconciliation across formats
SELECT 'iceberg' AS source, COUNT(*) AS cnt
FROM iceberg_cat.analytics.orders
UNION ALL
SELECT 'delta' AS source, COUNT(*) AS cnt
FROM delta_cat.analytics.orders
UNION ALL
SELECT 'hive' AS source, COUNT(*) AS cnt
FROM hive_cat.analytics.orders;

-- Pattern 2: Full data comparison (Iceberg vs PostgreSQL)
-- Find orders in Iceberg that are missing from PostgreSQL
SELECT i.order_id, i.amount, i.created_at
FROM iceberg_cat.analytics.orders i
LEFT JOIN pg_cat.public.orders p ON i.order_id = p.order_id
WHERE p.order_id IS NULL;

-- Pattern 3: Aggregate comparison across catalogs
WITH iceberg_agg AS (
    SELECT
        date_trunc('day', created_at) AS dt,
        COUNT(*) AS cnt,
        SUM(amount) AS total
    FROM iceberg_cat.analytics.orders
    GROUP BY 1
),
delta_agg AS (
    SELECT
        date_trunc('day', created_at) AS dt,
        COUNT(*) AS cnt,
        SUM(amount) AS total
    FROM delta_cat.analytics.orders
    GROUP BY 1
)
SELECT
    COALESCE(i.dt, d.dt) AS dt,
    i.cnt AS iceberg_count,
    d.cnt AS delta_count,
    i.cnt - d.cnt AS count_diff,
    i.total AS iceberg_total,
    d.total AS delta_total,
    i.total - d.total AS total_diff
FROM iceberg_agg i
FULL OUTER JOIN delta_agg d ON i.dt = d.dt
WHERE i.cnt != d.cnt OR i.total != d.total
ORDER BY dt;
```

### 6.4 Hive-to-Iceberg Migration Validation via Trino

Trino's Hive connector supports automatic redirection to Iceberg tables, which is invaluable during migrations:

```properties
# Trino catalog configuration: hive.properties
hive.iceberg-catalog-name=iceberg_cat
hive.delta-lake-catalog-name=delta_cat
```

This means when a Hive table is migrated to Iceberg, Trino automatically redirects queries to the Iceberg catalog. For validation, you can temporarily disable redirection to compare both:

```sql
-- Compare Hive source with Iceberg target during migration
SELECT
    'hive' AS source,
    COUNT(*) AS cnt,
    SUM(amount) AS total,
    MIN(created_at) AS min_date,
    MAX(created_at) AS max_date
FROM hive_cat.legacy.orders
UNION ALL
SELECT
    'iceberg' AS source,
    COUNT(*) AS cnt,
    SUM(amount) AS total,
    MIN(created_at) AS min_date,
    MAX(created_at) AS max_date
FROM iceberg_cat.analytics.orders;
```

---

## 7. Great Expectations + Lakehouse

### 7.1 Integration Architecture

Great Expectations (GX) is the most widely adopted open-source data quality framework, and it integrates with lakehouse environments primarily through Spark DataFrames and Databricks.

```
              Great Expectations + Lakehouse Integration
  ┌────────────────────────────────────────────────────────────┐
  │                 Great Expectations Framework                │
  │                                                            │
  │  ┌───────────────┐  ┌────────────────┐  ┌──────────────┐  │
  │  │  Data Context │  │  Expectation   │  │  Validation  │  │
  │  │               │  │  Suite         │  │  Results     │  │
  │  │  - Datasource │  │               │  │              │  │
  │  │    configs    │  │  - Constraints │  │  - Pass/Fail │  │
  │  │  - Store      │  │  - Thresholds  │  │  - Metrics   │  │
  │  │    backends   │  │  - Custom      │  │  - Data Docs │  │
  │  └───────┬───────┘  └───────┬────────┘  └──────┬───────┘  │
  │          │                  │                   │          │
  │          v                  v                   v          │
  │  ┌────────────────────────────────────────────────────┐    │
  │  │              Execution Engine                       │    │
  │  │  - SparkDFExecutionEngine (Databricks, EMR, etc.)  │    │
  │  │  - SqlAlchemyExecutionEngine (DuckDB, Trino, etc.) │    │
  │  │  - PandasExecutionEngine (local development)        │    │
  │  └───────────────────────┬────────────────────────────┘    │
  │                          │                                 │
  │                          v                                 │
  │  ┌────────────────────────────────────────────────────┐    │
  │  │              Data Sources                           │    │
  │  │  Spark DataFrames ← read from Iceberg/Delta/Hudi   │    │
  │  │  JDBC/ODBC ← Trino, DuckDB, ClickHouse            │    │
  │  │  Pandas DataFrames ← local Parquet files           │    │
  │  └────────────────────────────────────────────────────┘    │
  └────────────────────────────────────────────────────────────┘
```

### 7.2 Lakehouse-Specific Expectations

While GX doesn't have Iceberg- or Delta-specific expectations out of the box, you can leverage its Spark integration to validate lakehouse data:

```python
import great_expectations as gx
from great_expectations.core.batch import RuntimeBatchRequest

# Initialize GX context in Databricks
context = gx.get_context()

# Read Iceberg table as Spark DataFrame
df = spark.read.format("iceberg").load("prod.db.orders")

# Create a runtime batch from the DataFrame
batch_request = RuntimeBatchRequest(
    datasource_name="spark_datasource",
    data_connector_name="runtime_data_connector",
    data_asset_name="orders",
    runtime_parameters={"batch_data": df},
    batch_identifiers={"batch_id": "orders_2026_03_12"}
)

# Define expectations
validator = context.get_validator(
    batch_request=batch_request,
    expectation_suite_name="orders_suite"
)

# Basic expectations
validator.expect_column_values_to_not_be_null("order_id")
validator.expect_column_values_to_be_between("amount", min_value=0, max_value=1000000)
validator.expect_column_values_to_be_in_set(
    "status", ["pending", "shipped", "delivered", "cancelled"]
)

# Aggregate expectations
validator.expect_table_row_count_to_be_between(min_value=100000, max_value=10000000)
validator.expect_column_mean_to_be_between("amount", min_value=50, max_value=500)

# Uniqueness
validator.expect_column_values_to_be_unique("order_id")

# Freshness (lakehouse-specific: validate data is not stale)
validator.expect_column_max_to_be_between(
    "created_at",
    min_value="2026-03-12",  # Data should be no older than yesterday
    max_value="2026-03-14"
)

# Run validation
results = validator.validate()
print(f"Success: {results.success}")
print(f"Statistics: {results.statistics}")
```

**Time-travel validation with GX:**

```python
# Validate that data at two snapshots is consistent
df_before = spark.read.format("iceberg") \
    .option("snapshot-id", "10963874102873") \
    .load("prod.db.orders")

df_after = spark.read.format("iceberg") \
    .option("snapshot-id", "63874143573109") \
    .load("prod.db.orders")

# Validate: row count should not decrease
before_count = df_before.count()
after_count = df_after.count()
assert after_count >= before_count, \
    f"Row count decreased: {before_count} -> {after_count}"

# Validate: no duplicate order_ids in the new snapshot
from pyspark.sql.functions import count, col
dupes = df_after.groupBy("order_id").agg(count("*").alias("cnt")) \
    .filter(col("cnt") > 1)
assert dupes.count() == 0, f"Found {dupes.count()} duplicate order_ids"
```

### 7.3 Deequ — Amazon's Alternative for Spark Lakehouses

AWS Deequ is a Spark-native data quality library that is often preferred over GX in AWS lakehouse environments. It is purpose-built for large-scale validation:

```python
# PyDeequ example
from pydeequ.checks import Check, CheckLevel
from pydeequ.verification import VerificationSuite, VerificationResult

# Read Iceberg table
df = spark.read.format("iceberg").load("prod.db.orders")

# Define checks
check = Check(spark, CheckLevel.Warning, "Orders Quality Check") \
    .hasSize(lambda x: x >= 100000) \
    .isComplete("order_id") \
    .isUnique("order_id") \
    .isNonNegative("amount") \
    .isContainedIn("status", ["pending", "shipped", "delivered", "cancelled"]) \
    .hasCompleteness("customer_id", lambda x: x >= 0.99) \
    .hasMean("amount", lambda x: 50 <= x <= 500)

# Run verification
result = VerificationSuite(spark) \
    .onData(df) \
    .addCheck(check) \
    .run()

# Get results
result_df = VerificationResult.checkResultsAsDataFrame(spark, result)
result_df.show(truncate=False)
```

Deequ's key advantage is **constraint suggestion** — it can analyze your data and automatically propose quality constraints:

```python
from pydeequ.suggestions import ConstraintSuggestionRunner, Rules

# Automatically suggest constraints based on data profiling
suggestion_result = ConstraintSuggestionRunner(spark) \
    .onData(df) \
    .addConstraintRule(Rules.CategoricalRangeRule()) \
    .addConstraintRule(Rules.CompleteIfCompleteRule()) \
    .addConstraintRule(Rules.NonNegativeNumbersRule()) \
    .addConstraintRule(Rules.UniqueIfApproximatelyUniqueRule()) \
    .run()

# Print suggested constraints
for suggestion in suggestion_result['constraint_suggestions']:
    print(f"Column: {suggestion['column_name']}")
    print(f"  Constraint: {suggestion['description']}")
    print(f"  Code: {suggestion['code_for_constraint']}")
```

### 7.4 Soda Core and DQX

**Soda Core** is a CLI-based data quality tool that works well for lakehouse validation when you need lightweight, configuration-driven checks:

```yaml
# soda-checks.yml
checks for orders:
  - row_count > 100000
  - missing_count(order_id) = 0
  - duplicate_count(order_id) = 0
  - avg(amount) between 50 and 500
  - max(created_at) > '2026-03-11'
  - schema:
      fail:
        when mismatching columns:
          - order_id
          - customer_id
          - amount
          - status
          - created_at
```

**DQX** is a newer framework optimized for Databricks/Spark/Delta Lake ecosystems, providing orchestrated data quality checks across engines.

---

## 8. Partition-Level Validation Strategies

### 8.1 Why Partition-Level Validation Matters

Full-table validation of lakehouse tables is expensive. A table with 10TB of data across 365 daily partitions does not need to be fully scanned to validate today's ETL run. The key insight is: **validate only the partitions that changed**.

All three table formats provide mechanisms to identify changed partitions without reading data:

```
          Partition-Level Validation Strategy
  ┌─────────────────────────────────────────────────────────┐
  │                     Pipeline Run                        │
  │                                                         │
  │  Step 1: Identify Changed Partitions                    │
  │  ┌────────────────────────────────────────────────────┐ │
  │  │  Iceberg: Compare manifest lists between snapshots │ │
  │  │  Delta: Read _delta_log entries for add/remove     │ │
  │  │  Hudi: Query timeline for affected partitions      │ │
  │  └──────────────────────┬─────────────────────────────┘ │
  │                         │                               │
  │  Step 2: Validate Only Changed Partitions               │
  │  ┌──────────────────────┴─────────────────────────────┐ │
  │  │  For each changed partition:                        │ │
  │  │    - Row count comparison (source vs target)        │ │
  │  │    - Aggregate checksum (hash of key columns)       │ │
  │  │    - Schema validation (column types match)         │ │
  │  │    - Business rules (amount > 0, etc.)              │ │
  │  └──────────────────────┬─────────────────────────────┘ │
  │                         │                               │
  │  Step 3: Report Results                                 │
  │  ┌──────────────────────┴─────────────────────────────┐ │
  │  │  Changed: 3 partitions                              │ │
  │  │  Validated: 3 partitions (PASS)                     │ │
  │  │  Skipped: 362 unchanged partitions                  │ │
  │  │  Time: 45 seconds (vs ~2 hours for full scan)       │ │
  │  └────────────────────────────────────────────────────┘ │
  └─────────────────────────────────────────────────────────┘
```

### 8.2 Iceberg: Manifest-Based Partition Detection

Iceberg's manifest list contains partition summaries that let you identify which partitions changed between snapshots without reading any data files:

```sql
-- Spark SQL: Find partitions that changed between two snapshots
-- Step 1: Get manifests for the current snapshot
SELECT
    path,
    added_data_files_count,
    deleted_data_files_count,
    partition_summaries
FROM prod.db.orders.manifests
WHERE added_data_files_count > 0 OR deleted_data_files_count > 0;

-- Step 2: For granular partition detection, query the entries metadata table
-- which shows individual file entries with their statuses
SELECT DISTINCT
    partition.date AS partition_date,
    status  -- 1 = ADDED, 2 = DELETED, 0 = EXISTING
FROM prod.db.orders.entries
WHERE status != 0  -- Only changed entries
  AND snapshot_id = 63874143573109;

-- Step 3: Validate only changed partitions
-- (Use the detected partitions in a WHERE clause)
SELECT
    date AS partition_date,
    COUNT(*) AS row_count,
    SUM(amount) AS total_amount,
    COUNT(DISTINCT customer_id) AS unique_customers
FROM prod.db.orders
WHERE date IN ('2026-03-12', '2026-03-13')  -- Only changed partitions
GROUP BY date;
```

### 8.3 Delta Lake: Transaction Log Partition Detection

Delta Lake's transaction log records which files were added and removed in each version, along with their partition values:

```python
# PySpark: Read Delta transaction log to find changed partitions
from delta.tables import DeltaTable

dt = DeltaTable.forPath(spark, "s3://bucket/delta/orders")

# Get the transaction log history
history = dt.history(10)  # Last 10 operations

# Read the raw transaction log to find affected partitions
log_df = spark.read.json("s3://bucket/delta/orders/_delta_log/00000000000000000008.json")

# Extract partition values from added files
added_partitions = log_df.select("add.partitionValues.*").distinct()
added_partitions.show()

# Extract partition values from removed files
removed_partitions = log_df.select("remove.partitionValues.*").distinct()
removed_partitions.show()
```

```sql
-- SQL approach: validate only changed partitions
-- (After identifying changed partitions programmatically)
SELECT
    date,
    COUNT(*) AS row_count,
    SUM(amount) AS total_amount
FROM prod.db.orders
WHERE date >= '2026-03-12'  -- Only recently changed partitions
GROUP BY date;
```

### 8.4 Hudi: File Group Based Partition Tracking

Hudi organizes data into file groups within partitions. The timeline records which partitions were affected by each commit:

```sql
-- Query Hudi to find records changed in specific partitions
SELECT
    _hoodie_partition_path,
    COUNT(*) AS changed_records
FROM hudi_orders
WHERE _hoodie_commit_time > '20260312143000'
GROUP BY _hoodie_partition_path;
```

### 8.5 Cross-Format Partition Validation with DuckDB

```sql
-- DuckDB: Validate a specific partition across Iceberg and Delta
WITH iceberg_partition AS (
    SELECT
        COUNT(*) AS cnt,
        SUM(amount) AS total,
        bit_xor(md5_number(
            order_id::VARCHAR || customer_id::VARCHAR || amount::VARCHAR
        )) AS checksum
    FROM iceberg_scan('s3://bucket/iceberg/orders')
    WHERE date = '2026-03-12'
),
delta_partition AS (
    SELECT
        COUNT(*) AS cnt,
        SUM(amount) AS total,
        bit_xor(md5_number(
            order_id::VARCHAR || customer_id::VARCHAR || amount::VARCHAR
        )) AS checksum
    FROM delta_scan('s3://bucket/delta/orders')
    WHERE date = '2026-03-12'
)
SELECT
    i.cnt AS iceberg_count,
    d.cnt AS delta_count,
    i.cnt = d.cnt AS count_match,
    i.total AS iceberg_total,
    d.total AS delta_total,
    abs(i.total - d.total) < 0.01 AS total_match,
    i.checksum = d.checksum AS checksum_match
FROM iceberg_partition i, delta_partition d;
```

---

## 9. Data Lakehouse Migration Validation

### 9.1 Hive to Iceberg Migration

The Hive-to-Iceberg migration is the most common lakehouse migration path. Organizations move from Hive's metastore-based approach to Iceberg's self-contained metadata for better performance, schema evolution, and time travel.

**Migration approaches and their validation strategies:**

```
              Hive → Iceberg Migration Validation
  ┌──────────────────────────────────────────────────────────┐
  │                                                          │
  │  Approach 1: In-Place Migration (ALTER TABLE)            │
  │  ┌────────────────────────────────────────────────────┐  │
  │  │  ALTER TABLE db.orders                             │  │
  │  │  SET TBLPROPERTIES ('table_type' = 'ICEBERG');     │  │
  │  │                                                    │  │
  │  │  Validation: metadata-only, data files unchanged   │  │
  │  │  - Verify row count matches                        │  │
  │  │  - Verify schema mapping is correct                │  │
  │  │  - Verify partition spec is preserved              │  │
  │  └────────────────────────────────────────────────────┘  │
  │                                                          │
  │  Approach 2: Shadow Migration (Netflix pattern)          │
  │  ┌────────────────────────────────────────────────────┐  │
  │  │  1. Create Iceberg table alongside Hive table      │  │
  │  │  2. Copy data incrementally                        │  │
  │  │  3. Shadow: keep both in sync                      │  │
  │  │  4. Validate continuously during probation         │  │
  │  │  5. Cut over when confidence is high               │  │
  │  │                                                    │  │
  │  │  Validation: full dual-write comparison            │  │
  │  │  - Row count per partition                         │  │
  │  │  - Checksum per partition                          │  │
  │  │  - Schema compatibility                            │  │
  │  │  - Query result comparison                         │  │
  │  └────────────────────────────────────────────────────┘  │
  │                                                          │
  │  Approach 3: Partition-by-Partition Migration             │
  │  ┌────────────────────────────────────────────────────┐  │
  │  │  For each partition:                               │  │
  │  │    1. Copy partition data to Iceberg               │  │
  │  │    2. Validate partition (count + checksum)         │  │
  │  │    3. Mark partition as migrated                    │  │
  │  │    4. Proceed to next partition                     │  │
  │  │                                                    │  │
  │  │  Validation: per-partition with metadata tracking   │  │
  │  └────────────────────────────────────────────────────┘  │
  └──────────────────────────────────────────────────────────┘
```

**Netflix's shadow migration validation pattern:**

Netflix's open-source `hive2iceberg-migration` tool implements a sophisticated validation workflow. The Shadower component performs incremental synchronization by:

1. Tracking a watermark (Hive table property) that records the latest Iceberg snapshot_id successfully copied back to the Hive shadow table
2. When the watermark doesn't match the current Iceberg snapshot, incrementally copying new data from Iceberg to the Hive shadow table (named `<original>_hive`)
3. Allowing data consumers to compare both tables during a probation period

```sql
-- Validation query pattern during shadow migration
-- Compare event dates, counts, and totals between Hive and Iceberg
SELECT
    'hive' AS source,
    event_date,
    COUNT(*) AS row_count,
    SUM(amount) AS total_amount
FROM hive_cat.db.orders
GROUP BY event_date
UNION ALL
SELECT
    'iceberg' AS source,
    event_date,
    COUNT(*) AS row_count,
    SUM(amount) AS total_amount
FROM iceberg_cat.db.orders
GROUP BY event_date
HAVING COUNT(*) != (
    SELECT COUNT(*) FROM hive_cat.db.orders
    WHERE orders.event_date = event_date
);
```

**Schema reconciliation during migration:**

```python
# Validate schema compatibility between Hive and Iceberg
hive_schema = spark.table("hive_cat.db.orders").schema
iceberg_schema = spark.table("iceberg_cat.db.orders").schema

# Check field-by-field compatibility
for hive_field in hive_schema.fields:
    iceberg_field = next(
        (f for f in iceberg_schema.fields if f.name == hive_field.name), None
    )
    if iceberg_field is None:
        print(f"WARNING: {hive_field.name} missing in Iceberg table")
    elif str(hive_field.dataType) != str(iceberg_field.dataType):
        print(
            f"TYPE MISMATCH: {hive_field.name} "
            f"Hive={hive_field.dataType} Iceberg={iceberg_field.dataType}"
        )
```

### 9.2 Parquet to Delta Lake Migration

Databricks provides multiple approaches for Parquet-to-Delta conversion, each with different validation requirements:

```sql
-- Approach 1: CONVERT TO DELTA (metadata-only, no data rewrite)
CONVERT TO DELTA parquet.`s3://bucket/raw/orders`;

-- Validation: data is identical since files are reused
SELECT COUNT(*) FROM delta.`s3://bucket/raw/orders`;

-- Approach 2: CLONE (creates a copy)
CREATE TABLE prod.db.orders_delta
DEEP CLONE parquet.`s3://bucket/raw/orders`;

-- Validation: compare source and target
SELECT
    'source' AS tbl, COUNT(*) AS cnt, SUM(amount) AS total
FROM parquet.`s3://bucket/raw/orders`
UNION ALL
SELECT
    'target' AS tbl, COUNT(*) AS cnt, SUM(amount) AS total
FROM prod.db.orders_delta;
```

**Post-conversion validation checklist:**

1. Row count matches between source Parquet and Delta table
2. Schema is correctly inferred (check data types, nullability)
3. Partition structure is preserved
4. Aggregate checksums match (SUM, AVG of numeric columns)
5. Sample rows match (random sample comparison)
6. Delta table constraints are enforced going forward
7. Stop writing new Parquet files — all writes go through Delta

### 9.3 Iceberg-to-Delta and Delta-to-Iceberg Migration

With the rise of Databricks' UniForm (which can expose Delta tables as Iceberg), bidirectional validation becomes relevant:

```sql
-- Databricks UniForm: Enable Iceberg compatibility on a Delta table
ALTER TABLE prod.db.orders
SET TBLPROPERTIES (
    'delta.universalFormat.enabledFormats' = 'iceberg'
);

-- Validate: query through both formats and compare
-- (Via separate catalogs or using different connectors)
SELECT 'delta' AS format, COUNT(*), SUM(amount)
FROM delta_cat.db.orders
UNION ALL
SELECT 'iceberg' AS format, COUNT(*), SUM(amount)
FROM iceberg_cat.db.orders;
```

### 9.4 Migration Validation Best Practices

| Phase | Validation | Tool |
|-------|-----------|------|
| **Pre-migration** | Profile source data (row counts, column stats, partition counts) | Spark, DuckDB |
| **During migration** | Partition-by-partition comparison (count + checksum) | Trino (cross-catalog), DuckDB |
| **Post-migration** | Full data reconciliation (row-level diff of sample) | Reladiff, DuckDB |
| **Probation** | Dual-write with continuous comparison (1-2 weeks) | Airflow + GX/Deequ |
| **Cutover** | Final full comparison, then stop writes to old format | Trino, Spark |

---

## 10. Our Reladiff Engine Positioning

### 10.1 Current Capabilities

Reladiff is a DuckDB-based data validation engine. This is a strategic advantage for lakehouse validation because DuckDB can natively read Iceberg, Delta Lake, and Parquet formats without requiring any distributed infrastructure.

**What we already have:**

1. **DuckDB as the execution engine** — We can leverage DuckDB's Iceberg extension (`iceberg_scan`), Delta extension (`delta_scan`), and native Parquet support (`read_parquet`) to validate lakehouse data directly
2. **`where_clause` support** — Our existing partition-level filtering maps naturally to lakehouse partition validation. Users can specify `WHERE date = '2026-03-12'` to validate only changed partitions
3. **Row-level diff engine** — Our core diff algorithm can compare rows across any two DuckDB-readable sources, which now includes Iceberg tables, Delta tables, and raw Parquet files
4. **Checksum-based validation** — DuckDB's `md5_number` + `bit_xor` aggregate pattern gives us fast whole-table checksums

### 10.2 Lakehouse Features We Would Need to Add

```
              Reladiff Lakehouse Roadmap
  ┌──────────────────────────────────────────────────────────────┐
  │                                                              │
  │  Phase 1: Direct Lakehouse Source Support                    │
  │  ┌────────────────────────────────────────────────────────┐  │
  │  │  - Add Iceberg connection type (iceberg_scan + S3)     │  │
  │  │  - Add Delta connection type (delta_scan + S3)         │  │
  │  │  - Add raw Parquet/S3 connection type                  │  │
  │  │  - Auto-configure S3 credentials from env/IAM          │  │
  │  │  - Support REST Catalog connections (Iceberg)           │  │
  │  └────────────────────────────────────────────────────────┘  │
  │                                                              │
  │  Phase 2: Snapshot-Aware Validation                          │
  │  ┌────────────────────────────────────────────────────────┐  │
  │  │  - Validate "table at snapshot A" vs "table at snap B" │  │
  │  │  - Time-travel-based comparison (before/after ETL)     │  │
  │  │  - Snapshot metadata extraction (row counts, file      │  │
  │  │    counts from Iceberg snapshots table)                │  │
  │  │  - Delta version-based comparison (VERSION AS OF)       │  │
  │  └────────────────────────────────────────────────────────┘  │
  │                                                              │
  │  Phase 3: Partition-Aware Validation                         │
  │  ┌────────────────────────────────────────────────────────┐  │
  │  │  - Auto-detect changed partitions from metadata        │  │
  │  │    (Iceberg manifests, Delta transaction log)           │  │
  │  │  - Validate only changed partitions (smart WHERE)      │  │
  │  │  - Report partition-level results                       │  │
  │  │  - Track validation state per partition                 │  │
  │  └────────────────────────────────────────────────────────┘  │
  │                                                              │
  │  Phase 4: Cross-Format Validation                            │
  │  ┌────────────────────────────────────────────────────────┐  │
  │  │  - Compare Iceberg table vs Delta table                 │  │
  │  │  - Compare Iceberg table vs PostgreSQL/ClickHouse       │  │
  │  │  - Migration validation workflows                       │  │
  │  │  - Schema compatibility checking across formats         │  │
  │  └────────────────────────────────────────────────────────┘  │
  │                                                              │
  │  Phase 5: Metadata-Only Validation (Fast Path)               │
  │  ┌────────────────────────────────────────────────────────┐  │
  │  │  - Use Iceberg snapshot summaries for row count checks  │  │
  │  │  - Use manifest-level statistics without reading data   │  │
  │  │  - File-level stats for column bounds, null counts      │  │
  │  │  - Zero-data-scan validation for simple checks          │  │
  │  └────────────────────────────────────────────────────────┘  │
  └──────────────────────────────────────────────────────────────┘
```

### 10.3 Architecture for Lakehouse Validation

The core insight is that DuckDB already gives us the bridge between lakehouse formats and traditional databases. We do not need separate connectors for each format — DuckDB handles the translation:

```
                    Reladiff Lakehouse Architecture
  ┌─────────────────────────────────────────────────────────────┐
  │                     Reladiff Engine                          │
  │                                                             │
  │  ┌──────────────────────────────────────────────────────┐   │
  │  │              Validation Definition                    │   │
  │  │                                                       │   │
  │  │  source:                                              │   │
  │  │    type: iceberg                                      │   │
  │  │    path: s3://bucket/warehouse/orders                 │   │
  │  │    snapshot_id: 63874143573109  (optional)             │   │
  │  │    catalog: https://rest-catalog.example.com           │   │
  │  │                                                       │   │
  │  │  target:                                              │   │
  │  │    type: postgres                                     │   │
  │  │    connection: postgresql://host:5432/db               │   │
  │  │    table: public.orders                               │   │
  │  │                                                       │   │
  │  │  key_columns: [order_id]                              │   │
  │  │  compare_columns: [customer_id, amount, status]       │   │
  │  │  where_clause: "date >= '2026-03-12'"                 │   │
  │  └──────────────────────┬───────────────────────────────┘   │
  │                         │                                   │
  │                         v                                   │
  │  ┌──────────────────────────────────────────────────────┐   │
  │  │              DuckDB Execution Engine                  │   │
  │  │                                                       │   │
  │  │  -- Source query (auto-generated)                     │   │
  │  │  SELECT order_id, customer_id, amount, status         │   │
  │  │  FROM iceberg_scan('s3://bucket/warehouse/orders')    │   │
  │  │  WHERE date >= '2026-03-12'                           │   │
  │  │                                                       │   │
  │  │  -- Target query (auto-generated)                     │   │
  │  │  SELECT order_id, customer_id, amount, status         │   │
  │  │  FROM postgres_scan('host:5432', 'db', 'orders')      │   │
  │  │  WHERE date >= '2026-03-12'                           │   │
  │  │                                                       │   │
  │  │  -- Diff computation (existing Reladiff logic)        │   │
  │  │  WITH source AS (...), target AS (...)                 │   │
  │  │  SELECT ... EXCEPT / FULL OUTER JOIN ...              │   │
  │  └──────────────────────────────────────────────────────┘   │
  └─────────────────────────────────────────────────────────────┘
```

### 10.4 SQL Patterns for Reladiff Lakehouse Integration

**Pattern 1: Iceberg-to-PostgreSQL validation (our ingestion pipeline)**

This maps directly to our altimate-ingestion pipeline, where Iceberg tables are loaded into ClickHouse and PostgreSQL:

```sql
-- DuckDB: Compare Iceberg source with ClickHouse target
-- (ClickHouse via postgres_scan or httpfs)
WITH source AS (
    SELECT
        order_id,
        customer_id,
        amount,
        status,
        created_at
    FROM iceberg_scan('s3://bucket/iceberg/orders')
    WHERE date >= '2026-03-12'
),
target AS (
    SELECT
        order_id,
        customer_id,
        amount,
        status,
        created_at
    FROM postgres_scan('localhost', 'contracts', 'orders',
                       'user', 'password', 'tenant_schema')
    WHERE date >= '2026-03-12'
)
-- Count comparison
SELECT
    (SELECT COUNT(*) FROM source) AS source_count,
    (SELECT COUNT(*) FROM target) AS target_count,
    (SELECT COUNT(*) FROM source) - (SELECT COUNT(*) FROM target) AS diff;

-- Row-level diff
SELECT * FROM source
EXCEPT
SELECT * FROM target;
```

**Pattern 2: Snapshot diff (before/after ETL)**

```sql
-- Compare Iceberg table at two snapshots via DuckDB
WITH before AS (
    SELECT order_id, customer_id, amount, status
    FROM my_catalog.default.orders
    AT (VERSION => 10963874102873)
),
after AS (
    SELECT order_id, customer_id, amount, status
    FROM my_catalog.default.orders
    AT (VERSION => 63874143573109)
)
SELECT
    'rows_added' AS metric,
    COUNT(*) AS value
FROM (SELECT * FROM after EXCEPT SELECT * FROM before)
UNION ALL
SELECT
    'rows_removed' AS metric,
    COUNT(*) AS value
FROM (SELECT * FROM before EXCEPT SELECT * FROM after);
```

**Pattern 3: Cross-format migration validation**

```sql
-- Validate Hive-to-Iceberg migration with DuckDB
-- (Read Hive data as Parquet, Iceberg via iceberg_scan)
WITH hive_data AS (
    SELECT order_id, customer_id, amount, status
    FROM read_parquet('s3://bucket/hive/orders/date=2026-03-12/*.parquet')
),
iceberg_data AS (
    SELECT order_id, customer_id, amount, status
    FROM iceberg_scan('s3://bucket/iceberg/orders')
    WHERE date = '2026-03-12'
)
SELECT
    (SELECT COUNT(*) FROM hive_data) AS hive_count,
    (SELECT COUNT(*) FROM iceberg_data) AS iceberg_count,
    (SELECT bit_xor(md5_number(
        order_id::VARCHAR || customer_id::VARCHAR || amount::VARCHAR
    )) FROM hive_data) AS hive_checksum,
    (SELECT bit_xor(md5_number(
        order_id::VARCHAR || customer_id::VARCHAR || amount::VARCHAR
    )) FROM iceberg_data) AS iceberg_checksum;
```

### 10.5 Competitive Positioning

| Feature | Reladiff (DuckDB) | Great Expectations | Deequ | Soda Core | lakeFS |
|---------|-------------------|-------------------|-------|-----------|--------|
| **Iceberg support** | Direct via `iceberg_scan` | Via Spark | Via Spark | Via connectors | REST Catalog |
| **Delta support** | Direct via `delta_scan` | Via Spark | Via Spark | Via connectors | N/A |
| **Parquet support** | Native `read_parquet` | Via Spark/Pandas | Via Spark | Via connectors | N/A |
| **Cross-format comparison** | Yes (single query) | No | No | No | N/A |
| **Snapshot comparison** | Yes (time travel) | Manual | Manual | No | Branch-based |
| **Infrastructure needed** | None (embedded) | Spark cluster | Spark cluster | Agent/CLI | lakeFS server |
| **Row-level diff** | Yes (core feature) | No | No | No | No |
| **Partition-aware** | Via `where_clause` | Via partitioned batches | Via Spark partitions | Via filters | Via branches |
| **Pre-commit validation** | No (post-hoc) | No | No | No | Yes (hooks) |
| **Schema validation** | Implicit (type checking) | Yes (expectations) | Yes (analyzers) | Yes (checks) | Yes (hooks) |

**Our unique advantages:**
1. **Zero infrastructure** — No Spark cluster, no Trino deployment, no agents. Just DuckDB.
2. **Cross-format comparison** — The only tool that can compare Iceberg vs Delta vs Parquet vs PostgreSQL in a single SQL query.
3. **Row-level diff** — We provide the actual differing rows, not just pass/fail metrics.
4. **Embeddable** — Can be integrated into any CI/CD pipeline, Airflow DAG, or CLI workflow.

### 10.6 lakeFS Integration Opportunity

lakeFS provides Git-like branching for data lakes, implementing a spec-compliant Iceberg REST Catalog. This creates an interesting integration point:

```
              lakeFS + Reladiff Integration
  ┌──────────────────────────────────────────────────────────┐
  │                                                          │
  │  1. Data engineer creates lakeFS branch                  │
  │     lakectl branch create lakefs://repo/dev              │
  │                                                          │
  │  2. ETL writes to branch (isolated from production)      │
  │     INSERT INTO lakefs://repo/dev/orders ...              │
  │                                                          │
  │  3. Pre-merge hook triggers Reladiff validation           │
  │     reladiff compare                                     │
  │       --source iceberg://lakefs-rest-catalog/repo/dev    │
  │       --target iceberg://lakefs-rest-catalog/repo/main   │
  │       --key-columns order_id                             │
  │                                                          │
  │  4. If validation passes → merge to main                 │
  │     lakectl merge lakefs://repo/dev lakefs://repo/main   │
  │                                                          │
  │  5. If validation fails → reject merge, alert team       │
  │                                                          │
  └──────────────────────────────────────────────────────────┘
```

This pattern combines lakeFS's branching isolation with Reladiff's diff capabilities, creating a "data CI/CD" workflow similar to how code CI/CD works with Git branches and test suites.

---

## 11. References

### Apache Iceberg

- [Apache Iceberg Spec](https://iceberg.apache.org/spec/) — Authoritative table format specification
- [Iceberg Spark Queries](https://iceberg.apache.org/docs/latest/spark-queries/) — Time travel, metadata tables, incremental reads
- [Iceberg Evolution](https://iceberg.apache.org/docs/latest/evolution/) — Schema and partition evolution semantics
- [Iceberg Maintenance](https://iceberg.apache.org/docs/latest/maintenance/) — Compaction, snapshot expiry, orphan file cleanup
- [Apache Iceberg Metadata Explained: Snapshots & Manifests](https://olake.io/blog/2025/10/03/iceberg-metadata/) — Deep dive into metadata file structure
- [Understanding the Apache Iceberg Manifest List (Snapshot)](https://dev.to/alexmercedcoder/understanding-the-apache-iceberg-manifest-list-snapshot-507) — Manifest list internals
- [Understanding Apache Iceberg's metadata.json file](https://dev.to/alexmercedcoder/understanding-apache-icebergs-metadatajson-file-23f) — Schema tracking via metadata.json
- [Schema Evolution in Apache Iceberg](https://cazpian.ai/blog/schema-evolution-in-apache-iceberg) — Field-ID-based schema evolution
- [Apache Iceberg Time Travel Guide](https://estuary.dev/blog/time-travel-apache-iceberg/) — Snapshots, queries, and rollbacks
- [Iceberg Partitioning and Performance Optimization](https://www.conduktor.io/glossary/iceberg-partitioning-and-performance-optimization/) — Hidden partitioning, partition evolution
- [A Guide to Apache Iceberg Snapshots and Time Travel](https://www.e6data.com/blog/apache-iceberg-snapshots-time-travel) — Snapshot management

### Delta Lake

- [Delta Lake Change Data Feed](https://docs.delta.io/delta-change-data-feed/) — Official CDF documentation
- [Use Delta Lake change data feed on Databricks](https://docs.databricks.com/aws/en/delta/delta-change-data-feed) — Databricks-specific CDF guide
- [DESCRIBE HISTORY](https://docs.databricks.com/aws/en/sql/language-manual/delta-describe-history) — SQL syntax and output columns
- [Work with table history](https://docs.databricks.com/aws/en/delta/history) — Querying Delta table history
- [Table utility commands](https://docs.delta.io/delta-utility/) — DESCRIBE HISTORY, DESCRIBE DETAIL, OPTIMIZE
- [Delta Lake Transaction Log: How It Works](https://www.conduktor.io/glossary/delta-lake-transaction-log-how-it-works) — Transaction log internals
- [How to Simplify CDC With Delta Lake's Change Data Feed](https://www.databricks.com/blog/2021/06/09/how-to-simplify-cdc-with-delta-lakes-change-data-feed.html) — CDF introduction blog
- [Schema Evolution & Enforcement on Delta Lake](https://www.databricks.com/blog/2019/09/24/diving-into-delta-lake-schema-enforcement-evolution.html) — Schema enforcement at write time
- [Manage data quality with pipeline expectations](https://docs.databricks.com/aws/en/ldp/expectations) — Lakeflow Declarative Pipelines expectations
- [Delta Lake feature compatibility and protocols](https://docs.databricks.com/en/delta/feature-compatibility.html) — CHECK constraints, NOT NULL

### Apache Hudi

- [Hudi Timeline](https://hudi.apache.org/docs/timeline/) — Timeline architecture and instant actions
- [Hudi Querying Data](https://hudi.apache.org/docs/querying_data/) — Snapshot, incremental, and read-optimized queries
- [Hudi Pre-Commit Validators](https://hudi.apache.org/docs/precommit_validator/) — Built-in data quality validators
- [Apply Pre-Commit Validation for Data Quality in Apache Hudi](https://www.onehouse.ai/blog/apply-pre-commit-validation-for-data-quality-in-apache-hudi) — Practical guide to precommit validators
- [Hudi Metafields Demystified](https://www.onehouse.ai/blog/hudi-metafields-demystified) — Record-level metadata columns
- [Change query support in Apache Hudi](https://jack-vanlightly.com/analyses/2024/9/27/change-query-support-in-apache-hudi) — Deep analysis of change tracking

### DuckDB Lakehouse Extensions

- [DuckDB Iceberg Extension](https://duckdb.org/docs/stable/core_extensions/iceberg/overview) — iceberg_scan, iceberg_snapshots, iceberg_metadata
- [DuckDB Iceberg REST Catalogs](https://duckdb.org/docs/stable/core_extensions/iceberg/iceberg_rest_catalogs) — ATTACH catalog support
- [DuckDB Writes in Iceberg](https://duckdb.org/2025/11/28/iceberg-writes-in-duckdb) — Write support announcement
- [DuckDB Iceberg in the Browser](https://duckdb.org/2025/12/16/iceberg-in-the-browser) — Wasm-based Iceberg reading
- [DuckDB Delta Extension](https://duckdb.org/docs/stable/core_extensions/delta) — delta_scan function
- [Native Delta Lake Support in DuckDB](https://duckdb.org/2024/06/10/delta) — Delta extension introduction
- [Maximizing Your Delta Scan Performance in DuckDB](https://duckdb.org/2025/03/21/maximizing-your-delta-scan-performance) — Partition info pushdown
- [DuckDB S3 Iceberg Import](https://duckdb.org/docs/stable/guides/network_cloud_storage/s3_iceberg_import) — S3 configuration
- [DuckDB S3 Parquet Import](https://duckdb.org/docs/stable/guides/network_cloud_storage/s3_import) — S3 Parquet reading
- [DuckDB Reading and Writing Parquet Files](https://duckdb.org/docs/stable/data/parquet/overview) — Native Parquet support
- [How to Compare Tables in DuckDB SQL](https://sekuel.com/learn-sql/duckdb-cookbook/compare-tables-in-duckdb/) — Hash-based table comparison

### Trino/Presto

- [Trino Iceberg Connector](https://trino.io/docs/current/connector/iceberg.html) — Full Iceberg connector documentation
- [Trino Delta Lake Connector](https://trino.io/docs/current/connector/delta-lake.html) — Delta Lake connector
- [Trino Hive Connector](https://trino.io/docs/current/connector/hive.html) — Hive connector with format redirection
- [Apache Iceberg Time Travel & Rollbacks in Trino](https://www.starburst.io/blog/apache-iceberg-time-travel-rollbacks-in-trino/) — Practical Trino time travel guide
- [Working with Iceberg tables by using Trino](https://docs.aws.amazon.com/prescriptive-guidance/latest/apache-iceberg-on-aws/iceberg-trino.html) — AWS guide

### Data Quality Frameworks

- [Great Expectations with Databricks](https://docs.greatexpectations.io/docs/0.18/oss/get_started/get_started_with_gx_and_databricks/) — GX + Databricks setup
- [Ensuring Data Quality with Great Expectations and Databricks](https://dzone.com/articles/data-quality-great-expectations-databricks) — Practical integration guide
- [AWS Deequ](https://github.com/awslabs/deequ) — Spark-native data quality library
- [Test data quality at scale with Deequ](https://aws.amazon.com/blogs/big-data/test-data-quality-at-scale-with-deequ/) — Official AWS blog
- [PyDeequ](https://github.com/awslabs/python-deequ) — Python API for Deequ
- [Deequ: Data Quality Validation for ML Pipelines](https://deem.berlin/pdf/deequ.pdf) — Original research paper

### Lakehouse Challenges and Best Practices

- [What Is a Lakehouse and How to Maintain Data Quality in It](https://www.digna.ai/what-is-lakehouse-how-maintain-data-quality) — Data quality in lakehouses
- [How To Maintain Data Quality In Your Data Lake](https://lakefs.io/blog/how-to-maintain-data-quality-in-your-data-lake/) — lakeFS blog on data quality
- [Amazon S3 Strong Consistency](https://aws.amazon.com/s3/consistency/) — S3 consistency model
- [Diving Deep on S3 Consistency](https://www.allthingsdistributed.com/2021/04/s3-strong-consistency.html) — Werner Vogels on S3 consistency
- [The Apache Iceberg Small File Problem](https://dev.to/thedanicafine/the-apache-iceberg-small-file-problem-1k2m) — Small file problem analysis
- [Compaction in Apache Iceberg](https://www.dremio.com/blog/compaction-in-apache-iceberg-fine-tuning-your-iceberg-tables-data-files/) — Compaction strategies
- [Apache Iceberg optimization: Solving the small files problem in Amazon EMR](https://aws.amazon.com/blogs/big-data/apache-iceberg-optimization-solving-the-small-files-problem-in-amazon-emr/) — AWS optimization guide

### Migration

- [Melting the ice — How Natural Intelligence simplified a data lake migration to Apache Iceberg](https://aws.amazon.com/blogs/big-data/melting-the-ice-how-natural-intelligence-simplified-a-data-lake-migration-to-apache-iceberg/) — Real-world migration case study
- [Netflix hive2iceberg-migration](https://github.com/Netflix-Skunkworks/hive2iceberg-migration) — Netflix's open-source migration tool
- [Migrating from Hive Tables to Apache Iceberg: The Complete Guide](https://cazpian.ai/blog/migrating-from-hive-tables-to-apache-iceberg) — Comprehensive migration guide
- [Hive Migration - Apache Iceberg](https://iceberg.apache.org/docs/1.4.1/hive-migration/) — Official Iceberg migration docs
- [Migrate a Parquet data lake to Delta Lake](https://docs.databricks.com/aws/en/migration/parquet-to-delta-lake) — Databricks Parquet migration guide
- [Migrating existing tables to Iceberg - AWS](https://docs.aws.amazon.com/prescriptive-guidance/latest/apache-iceberg-on-aws/table-migration.html) — AWS migration guidance

### Table Format Comparisons

- [Apache Iceberg vs Delta Lake vs Apache Hudi — Feature Comparison Deep Dive](https://www.onehouse.ai/blog/apache-hudi-vs-delta-lake-vs-apache-iceberg-lakehouse-feature-comparison) — Comprehensive comparison (updated Oct 2025)
- [Hudi vs Iceberg vs Delta Lake: Detailed Comparison](https://lakefs.io/blog/hudi-iceberg-and-delta-lake-data-lake-table-formats-compared/) — lakeFS comparison
- [Iceberg vs Delta Lake: Features, Differences & Use Cases](https://www.datacamp.com/blog/iceberg-vs-delta-lake) — DataCamp comparison
- [Apache Iceberg vs Delta Lake (II): Schema and partition evolution](https://www.flexera.com/blog/finops/iceberg-vs-delta-lake-schema-partition/) — Schema/partition comparison

### lakeFS

- [lakeFS Documentation](https://docs.lakefs.io/latest/) — Official docs
- [Guarantee Consistency in Your Delta Lake Tables With lakeFS](https://lakefs.io/blog/guarantee-consistency-in-your-delta-lake-tables-with-lakefs/) — lakeFS + Delta Lake
- [Schema Validation with lakeFS](https://lakefs.io/blog/schema-validation-lakefs-tutorial/) — Pre-merge schema validation
- [Data Quality Framework: Best Practices & Tools](https://lakefs.io/data-quality/data-quality-framework/) — lakeFS DQ framework guide
