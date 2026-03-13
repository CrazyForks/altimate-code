# Theme W: Data Versioning, Time-Travel & Lineage-Aware Validation

_Iteration 1 — 2026-03-13_

## Table of Contents

1. [Time-Travel SQL Syntax Per Database](#1-time-travel-sql-syntax-per-database)
2. [Validation Use Cases for Time-Travel](#2-validation-use-cases-for-time-travel)
3. [Data Versioning Systems](#3-data-versioning-systems)
4. [Lineage-Aware Validation](#4-lineage-aware-validation)
5. [Temporal Data Patterns](#5-temporal-data-patterns)
6. [Implementation Recommendations for Reladiff](#6-implementation-recommendations-for-reladiff)
7. [References](#7-references)

---

## 1. Time-Travel SQL Syntax Per Database

Time-travel is the ability to query data as it existed at a prior point in time. Each database implements it differently — or not at all. For Reladiff, this is the foundation of "compare the same table at two points in time" without needing to materialize snapshots.

### 1.1 Snowflake

Snowflake provides the richest time-travel syntax of any cloud data warehouse. Every table automatically retains historical data for a configurable retention period.

**Retention:** 1 day (default) to 90 days (Enterprise edition). Controlled per table via `DATA_RETENTION_TIME_IN_DAYS`.

```sql
-- Query by absolute timestamp
SELECT * FROM my_db.my_schema.orders
AT(TIMESTAMP => '2026-01-15 14:30:00'::TIMESTAMP_LTZ);

-- Query by relative offset (seconds before current time)
SELECT * FROM my_db.my_schema.orders
AT(OFFSET => -300);  -- 5 minutes ago

-- Query by statement ID (exact point-in-time of a specific query/DML)
SELECT * FROM my_db.my_schema.orders
AT(STATEMENT => '01b2c3d4-0001-1234-0000-00000000abcd');

-- BEFORE keyword: state immediately before the event
SELECT * FROM my_db.my_schema.orders
BEFORE(STATEMENT => '01b2c3d4-0001-1234-0000-00000000abcd');

-- Time-travel in a diff context (Reladiff use case)
SELECT a.id, a.amount AS before_amount, b.amount AS after_amount
FROM my_db.my_schema.orders AT(TIMESTAMP => '2026-01-15 00:00:00'::TIMESTAMP_LTZ) a
FULL OUTER JOIN my_db.my_schema.orders b
ON a.id = b.id
WHERE a.amount != b.amount OR a.id IS NULL OR b.id IS NULL;
```

**Key behaviors:**
- `AT(TIMESTAMP => ...)` returns data as of the specified timestamp (inclusive).
- `AT(OFFSET => -N)` is relative to current wall-clock time, measured in seconds.
- `AT(STATEMENT => ...)` returns data as it existed at the moment a specific query completed. This is the most precise form — it corresponds to an exact micro-partition version.
- Time-travel queries consume the same warehouse compute as regular queries.
- Dropped tables can be recovered with `UNDROP TABLE` within the retention window.
- After the retention period expires, data enters the Fail-safe period (7 days, Snowflake-managed, not user-accessible).

**Gotchas for Reladiff:**
- Timestamps must use `TIMESTAMP_LTZ` (local time zone); `TIMESTAMP_NTZ` can silently shift by the session timezone.
- If the table was recreated (DROP + CREATE), time-travel only covers the new table's lifetime. The `BEFORE(STATEMENT => ...)` of the DROP is the last accessible state.
- Transient and temporary tables have a max retention of 1 day regardless of edition.

### 1.2 BigQuery

BigQuery provides automatic time-travel with a fixed 7-day window. No configuration needed — every table has it.

```sql
-- Query at a specific timestamp
SELECT * FROM `project.dataset.orders`
FOR SYSTEM_TIME AS OF TIMESTAMP '2026-01-15 14:30:00 UTC';

-- Query at a relative offset
SELECT * FROM `project.dataset.orders`
FOR SYSTEM_TIME AS OF TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 HOUR);

-- Query at a relative offset (days)
SELECT * FROM `project.dataset.orders`
FOR SYSTEM_TIME AS OF TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 3 DAY);

-- Diff pattern: compare table at two timestamps
SELECT
  COALESCE(old.id, new.id) AS id,
  old.amount AS amount_before,
  new.amount AS amount_after
FROM `project.dataset.orders`
  FOR SYSTEM_TIME AS OF TIMESTAMP '2026-01-14 00:00:00 UTC' AS old
FULL OUTER JOIN `project.dataset.orders` AS new
  ON old.id = new.id
WHERE old.amount != new.amount
   OR old.id IS NULL
   OR new.id IS NULL;
```

**Key behaviors:**
- 7-day maximum window (previously configurable up to 7 days, now fixed).
- Uses the `FOR SYSTEM_TIME AS OF` clause from SQL:2011 standard.
- Works on tables, not views (views are re-evaluated against the current state).
- Storage pricing: historical data stored in the 7-day window counts toward storage costs at the same rate as active storage.
- Partitioned tables: time-travel applies to the entire table, not individual partitions.

**Gotchas for Reladiff:**
- The 7-day limit is hard — no Enterprise upgrade extends it beyond 7 days.
- If a table is deleted and recreated, the old table's history is gone immediately (unless you use table snapshots: `CREATE SNAPSHOT TABLE`).
- Streaming buffer data may not be available via time-travel for a short window after ingestion.
- `FOR SYSTEM_TIME AS OF` with a timestamp before the table's creation time returns an error, not an empty result.

### 1.3 Delta Lake (Databricks / Spark)

Delta Lake provides unlimited time-travel through its transaction log. Every commit creates a new version, and old versions persist until explicitly removed via `VACUUM`.

```sql
-- Query by version number
SELECT * FROM my_catalog.my_schema.orders VERSION AS OF 5;

-- Query by timestamp
SELECT * FROM my_catalog.my_schema.orders
TIMESTAMP AS OF '2026-01-15 14:30:00';

-- In Databricks SQL, also supported:
SELECT * FROM my_catalog.my_schema.orders@v5;

-- View table history (all versions with timestamps and operations)
DESCRIBE HISTORY my_catalog.my_schema.orders;

-- Diff between two versions (Reladiff use case)
SELECT
  COALESCE(v1.id, v2.id) AS id,
  v1.amount AS amount_v5,
  v2.amount AS amount_v10
FROM my_catalog.my_schema.orders VERSION AS OF 5 v1
FULL OUTER JOIN my_catalog.my_schema.orders VERSION AS OF 10 v2
  ON v1.id = v2.id
WHERE v1.amount != v2.amount
   OR v1.id IS NULL
   OR v2.id IS NULL;

-- Restore table to a previous version
RESTORE TABLE my_catalog.my_schema.orders TO VERSION AS OF 5;
```

**Key behaviors:**
- Versions are sequential integers starting from 0.
- The transaction log (`_delta_log/`) retains version metadata in JSON files, checkpointed every 10 versions as Parquet.
- `VACUUM` removes data files older than a threshold (default 7 days). Without vacuum, history is unlimited.
- `DESCRIBE HISTORY` returns: version, timestamp, operation type (WRITE, MERGE, DELETE, etc.), user, and operation parameters.
- Change Data Feed (CDF) can be enabled to expose `_change_type` column (insert, update_preimage, update_postimage, delete).

**Gotchas for Reladiff:**
- After `VACUUM`, old versions return `FileNotFoundException`. Reladiff must check version availability before querying.
- `TIMESTAMP AS OF` resolution is to the commit timestamp, not the exact second. If multiple commits happen in the same second, you get the last one.
- Delta Lake's time-travel works through Spark/Databricks SQL. Direct Parquet readers (e.g., DuckDB reading Delta files) may have limited time-travel support.
- Version numbers are not portable — they reset if the table is recreated.

### 1.4 Apache Iceberg

Iceberg provides snapshot-based time-travel with rich metadata for each snapshot.

```sql
-- Spark SQL: query by snapshot ID
SELECT * FROM my_catalog.my_schema.orders
FOR SYSTEM_VERSION AS OF 3821550127947089987;

-- Spark SQL: query by timestamp
SELECT * FROM my_catalog.my_schema.orders
FOR SYSTEM_TIME AS OF '2026-01-15 14:30:00';

-- Trino/Presto: query by snapshot ID
SELECT * FROM my_catalog.my_schema.orders
FOR VERSION AS OF 3821550127947089987;

-- Trino: query by timestamp
SELECT * FROM my_catalog.my_schema.orders
FOR TIMESTAMP AS OF TIMESTAMP '2026-01-15 14:30:00 UTC';

-- List snapshots (Spark)
SELECT * FROM my_catalog.my_schema.orders.snapshots;

-- List snapshot history
SELECT * FROM my_catalog.my_schema.orders.history;

-- Incremental read between snapshots (Spark)
SELECT * FROM my_catalog.my_schema.orders
WHERE snapshot_id BETWEEN 3821550127947089987 AND 5765432198765432100;

-- Rollback to snapshot
CALL my_catalog.system.rollback_to_snapshot('my_schema.orders', 3821550127947089987);
```

**Key behaviors:**
- Every write operation creates a new snapshot. Snapshots are identified by 64-bit IDs (not sequential integers).
- The `snapshots` metadata table exposes: snapshot_id, parent_id, operation, summary (added/deleted files, row counts), and timestamp.
- Snapshot expiration is controlled via `history.expire.max-snapshot-age-ms` (default 5 days) and `history.expire.min-snapshots-to-keep` (default 1).
- Expired snapshots remove metadata pointers but not data files. `expire_snapshots` + `remove_orphan_files` together reclaim space.
- Iceberg supports branching and tagging (since spec v2): create named references to snapshots for audit/rollback.

**Gotchas for Reladiff:**
- SQL syntax varies by engine (Spark, Trino, Flink, Dremio each have slightly different clauses).
- Snapshot IDs are large integers, not human-friendly. Timestamps or tags are more practical for Reladiff UX.
- After snapshot expiration, querying by old snapshot ID fails. Reladiff should validate snapshot existence first.
- Schema evolution across snapshots: a column added in snapshot N won't exist in snapshot N-1. Reladiff must handle schema differences in time-travel diffs.

### 1.5 DuckDB

DuckDB has no native time-travel capability. However, several workaround patterns exist that Reladiff can leverage.

```sql
-- Pattern 1: Parquet file versioning (external versioning)
-- Compare two versioned Parquet snapshots
SELECT * FROM read_parquet('s3://bucket/orders/v1/data.parquet') AS v1
FULL OUTER JOIN read_parquet('s3://bucket/orders/v2/data.parquet') AS v2
  ON v1.id = v2.id
WHERE v1.amount != v2.amount
   OR v1.id IS NULL
   OR v2.id IS NULL;

-- Pattern 2: Read Iceberg table at a specific snapshot
-- (DuckDB 1.2+ with iceberg extension)
SELECT * FROM iceberg_scan('s3://bucket/orders/', allow_moved_paths := true);
-- Note: snapshot selection requires specifying metadata file path directly
SELECT * FROM iceberg_scan(
  's3://bucket/orders/metadata/snap-3821550127947089987-0.avro'
);

-- Pattern 3: Read Delta Lake table at a specific version
-- (DuckDB with delta extension)
SELECT * FROM delta_scan('s3://bucket/orders/');
-- Version selection not yet directly supported; use _delta_log parsing

-- Pattern 4: ATTACH two database files for comparison
ATTACH 'orders_v1.duckdb' AS v1;
ATTACH 'orders_v2.duckdb' AS v2;
SELECT * FROM v1.main.orders
EXCEPT
SELECT * FROM v2.main.orders;

-- Pattern 5: COPY + compare (snapshot to local)
COPY (SELECT * FROM remote_db.orders) TO 'snapshot_t1.parquet';
-- Later...
SELECT * FROM read_parquet('snapshot_t1.parquet') AS t1
FULL OUTER JOIN remote_db.orders AS t2
  ON t1.id = t2.id;
```

**Key implications for Reladiff:**
- DuckDB is Reladiff's local compute engine. For time-travel, Reladiff must either (a) leverage the source database's time-travel natively, or (b) manage snapshots externally.
- The ATTACH pattern is powerful for comparing two materialized states.
- DuckDB's Iceberg and Delta extensions are maturing rapidly; version-aware reads may land in future releases.
- For databases without time-travel, Reladiff could maintain a snapshot cache in DuckDB format.

### 1.6 PostgreSQL

PostgreSQL has no built-in time-travel. Several approaches exist to approximate it.

```sql
-- Approach 1: SQL:2011 Temporal Tables (manual implementation)
-- Create a history table with system-time period
CREATE TABLE orders (
  id BIGINT PRIMARY KEY,
  amount NUMERIC(10,2),
  sys_period TSTZRANGE NOT NULL DEFAULT tstzrange(now(), NULL)
);

CREATE TABLE orders_history (LIKE orders);

-- Use the temporal_tables extension (pgxn)
-- or trigger-based approach:
CREATE TRIGGER orders_versioning_trigger
BEFORE INSERT OR UPDATE OR DELETE ON orders
FOR EACH ROW EXECUTE FUNCTION versioning(
  'sys_period', 'orders_history', true
);

-- Query historical state at a specific time
SELECT * FROM orders_history
WHERE sys_period @> '2026-01-15 14:30:00+00'::TIMESTAMPTZ;

-- Approach 2: pg_audit for read-only audit trail
-- (records DML statements, not row states)

-- Approach 3: Logical replication slots
-- Capture WAL changes for replay; not practical for point-in-time queries

-- Approach 4: pg_dump snapshots
-- Take periodic dumps and compare files externally

-- Approach 5: pgBackRest point-in-time recovery (PITR)
-- Restore a secondary instance to a specific timestamp
-- Then connect Reladiff to both instances
```

**Key implications for Reladiff:**
- PostgreSQL time-travel requires application-level support (temporal tables or triggers).
- For migration validation, the practical pattern is: snapshot the source state before migration, then compare against post-migration state.
- Reladiff should offer a "snapshot" command that materializes a table's current state to a local DuckDB file for later comparison.
- PITR-based comparison is operationally heavy (spin up a second PG instance) but provides exact point-in-time state.

### 1.7 MySQL

MySQL has no time-travel capability. Recovery options are limited to binary log replay.

```sql
-- Approach 1: Binary log (binlog) for point-in-time recovery
-- Extract DML statements from binlog
-- mysqlbinlog --start-datetime='2026-01-15 14:30:00' binlog.000042

-- Approach 2: Temporal tables (MariaDB 10.3.4+, not MySQL)
-- MariaDB implements SQL:2011 temporal tables natively:
CREATE TABLE orders (
  id BIGINT PRIMARY KEY,
  amount DECIMAL(10,2),
  row_start TIMESTAMP(6) GENERATED ALWAYS AS ROW START,
  row_end TIMESTAMP(6) GENERATED ALWAYS AS ROW END,
  PERIOD FOR SYSTEM_TIME (row_start, row_end)
) WITH SYSTEM VERSIONING;

-- Query historical state (MariaDB only)
SELECT * FROM orders FOR SYSTEM_TIME AS OF '2026-01-15 14:30:00';

-- Approach 3: MySQL Enterprise Backup (physical backup + PITR)
-- Similar to PostgreSQL PITR: restore secondary instance, compare

-- Approach 4: Application-level versioning
-- Add version columns, soft deletes, or history tables
```

**Key implications for Reladiff:**
- MySQL users need Reladiff's snapshot feature most urgently — there is no database-level fallback.
- MariaDB's system versioning is a notable exception; if detected, Reladiff could use `FOR SYSTEM_TIME AS OF`.
- For MySQL migration validation, the recommended pattern is: Reladiff snapshots the table pre-migration, then diffs against the live table post-migration.

### 1.8 Syntax Summary Matrix

```
┌─────────────┬────────────────────────────────────┬──────────┬──────────────┐
│ Database    │ Time-Travel Syntax                 │ Retention│ Version Type │
├─────────────┼────────────────────────────────────┼──────────┼──────────────┤
│ Snowflake   │ AT(TIMESTAMP => '...')              │ 1-90 days│ Micro-part.  │
│             │ AT(OFFSET => -N)                   │          │              │
│             │ AT(STATEMENT => '...')              │          │              │
├─────────────┼────────────────────────────────────┼──────────┼──────────────┤
│ BigQuery    │ FOR SYSTEM_TIME AS OF              │ 7 days   │ Snapshot     │
│             │ TIMESTAMP_SUB(...)                 │          │              │
├─────────────┼────────────────────────────────────┼──────────┼──────────────┤
│ Delta Lake  │ VERSION AS OF N                    │ Unlimited│ Sequential   │
│             │ TIMESTAMP AS OF '...'              │ (vacuum) │ integer      │
├─────────────┼────────────────────────────────────┼──────────┼──────────────┤
│ Iceberg     │ FOR SYSTEM_TIME AS OF '...'        │ Configur.│ Snapshot ID  │
│             │ FOR SYSTEM_VERSION AS OF id        │ (default │ (64-bit int) │
│             │                                    │  5 days) │              │
├─────────────┼────────────────────────────────────┼──────────┼──────────────┤
│ DuckDB      │ None (use external snapshots)      │ N/A      │ N/A          │
├─────────────┼────────────────────────────────────┼──────────┼──────────────┤
│ PostgreSQL  │ None (temporal tables via ext.)    │ N/A      │ N/A          │
├─────────────┼────────────────────────────────────┼──────────┼──────────────┤
│ MySQL       │ None (binlog recovery only)        │ N/A      │ N/A          │
│ MariaDB     │ FOR SYSTEM_TIME AS OF (native)     │ Configur.│ Row-level    │
└─────────────┴────────────────────────────────────┴──────────┴──────────────┘
```

---

## 2. Validation Use Cases for Time-Travel

Time-travel transforms Reladiff from a "two-database comparison tool" into a "same-database temporal comparison tool." This section catalogs the high-value use cases.

### 2.1 Migration Validation

**Scenario:** A DDL migration alters a table — adds columns, changes types, restructures data. You need to verify that no data was lost or corrupted.

```
┌──────────────────────────────────────────────────────┐
│                Migration Validation Flow              │
│                                                      │
│  T1 (pre-migration)          T2 (post-migration)    │
│  ┌──────────────┐            ┌──────────────┐       │
│  │  orders      │            │  orders      │       │
│  │  id: INT     │ ─ ALTER ─→ │  id: BIGINT  │       │
│  │  amount: DEC │  TABLE     │  amount: DEC │       │
│  │  100K rows   │            │  amount_usd: │       │
│  └──────────────┘            │  100K rows   │       │
│         │                    └──────────────┘       │
│         │                           │                │
│         └───────── Reladiff ────────┘                │
│                      │                               │
│              ┌───────────────┐                       │
│              │ Diff Report:  │                       │
│              │ - 0 rows lost │                       │
│              │ - id type OK  │                       │
│              │ - new col OK  │                       │
│              └───────────────┘                       │
└──────────────────────────────────────────────────────┘
```

**Reladiff implementation:**

```bash
# Snowflake: compare pre-migration vs current
reladiff diff \
  --source "snowflake://account/db.schema.orders AT(STATEMENT => 'migration-stmt-id')" \
  --target "snowflake://account/db.schema.orders" \
  --key id

# BigQuery: compare 1 hour ago vs now
reladiff diff \
  --source "bigquery://project.dataset.orders FOR SYSTEM_TIME AS OF '2026-01-15T14:00:00Z'" \
  --target "bigquery://project.dataset.orders" \
  --key id

# Delta Lake: compare version 5 (pre-migration) vs current
reladiff diff \
  --source "delta://catalog.schema.orders@v5" \
  --target "delta://catalog.schema.orders" \
  --key id
```

**What to validate:**
- Row count preservation (no rows lost or duplicated)
- Primary key integrity (all keys present in both states)
- Value preservation for unchanged columns
- Type widening correctness (INT to BIGINT: no truncation)
- NULL handling for new columns (should be NULL or default)

### 2.2 Backfill Validation

**Scenario:** A pipeline backfills historical data — reprocessing old partitions with corrected logic. You need to verify the backfill against the original data.

```
┌──────────────────────────────────────────────────────────┐
│                 Backfill Validation                       │
│                                                          │
│  Original Pipeline (v1)       Backfill Pipeline (v2)    │
│  ┌─────────────────────┐     ┌─────────────────────┐   │
│  │ events_2026_01       │     │ events_2026_01       │   │
│  │ Computed with bug:   │     │ Computed correctly:  │   │
│  │ revenue = qty * list │     │ revenue = qty * net  │   │
│  └─────────────────────┘     └─────────────────────┘   │
│           │                           │                  │
│     Time-travel to               Current state          │
│     pre-backfill state                                  │
│           │                           │                  │
│           └────── Reladiff diff ──────┘                  │
│                       │                                  │
│            Expected: all rows changed                    │
│            revenue values differ                         │
│            row count identical                           │
│            non-revenue columns identical                 │
└──────────────────────────────────────────────────────────┘
```

**Validation checks:**
- Row count unchanged (backfill should not add or remove rows)
- Only expected columns changed (revenue, not customer_id)
- Changed values are directionally correct (e.g., new revenue <= old revenue if switching from list to net price)
- Aggregate validation: `SUM(new_revenue)` should be approximately `SUM(old_revenue) * expected_discount_factor`

### 2.3 Regression Testing

**Scenario:** A new version of a dbt model or ETL pipeline is deployed. Before switching traffic, you want to verify that the new version produces the same output as the old version (or that differences are expected).

```
┌──────────────────────────────────────────────────────────┐
│              Pipeline Regression Testing                  │
│                                                          │
│  ┌──────────────┐    ┌──────────────┐                   │
│  │ Pipeline v1   │    │ Pipeline v2   │                   │
│  │ (production)  │    │ (staging)     │                   │
│  └──────┬───────┘    └──────┬───────┘                   │
│         │                    │                            │
│    Same input data     Same input data                   │
│         │                    │                            │
│         v                    v                            │
│  ┌──────────────┐    ┌──────────────┐                   │
│  │ output_prod   │    │ output_stg   │                   │
│  └──────┬───────┘    └──────┬───────┘                   │
│         │                    │                            │
│         └──── Reladiff ──────┘                           │
│                   │                                      │
│        ┌──────────────────────┐                          │
│        │ Regression Report:   │                          │
│        │ 99.97% rows match    │                          │
│        │ 3 rows differ in     │                          │
│        │ `tax_amount` column  │                          │
│        │ Max delta: $0.01     │                          │
│        │ → Rounding change,   │                          │
│        │   acceptable.        │                          │
│        └──────────────────────┘                          │
└──────────────────────────────────────────────────────────┘
```

**Time-travel enhancement:** Instead of maintaining two parallel outputs, use time-travel to compare the same table before and after the pipeline version switch:

```bash
# Deploy new pipeline version, let it write to the same table
# Then compare the table at T1 (old pipeline's last write) vs T2 (new pipeline's first write)
reladiff diff \
  --source "snowflake://db.schema.fact_orders AT(TIMESTAMP => '2026-01-15 00:00:00')" \
  --target "snowflake://db.schema.fact_orders AT(TIMESTAMP => '2026-01-16 00:00:00')" \
  --key order_id \
  --where "order_date = '2026-01-14'"  # Same business day, different pipeline versions
```

### 2.4 SOX / Audit Compliance

**Scenario:** Financial systems require quarterly attestation that data has not been tampered with. SOX Section 404 requires documentation of data integrity controls.

**Requirements:**
- Prove that quarter-end financial data has not changed since the close.
- Document the exact state of critical tables at quarter-close.
- Detect unauthorized modifications post-close.

**Reladiff approach:**

```bash
# At quarter-close: snapshot critical tables
reladiff snapshot \
  --source "snowflake://finance_db.reporting.revenue" \
  --at "2026-03-31 23:59:59" \
  --output "s3://audit-snapshots/2026-Q1/revenue.parquet" \
  --checksum sha256

# Weekly audit: verify no changes since quarter-close
reladiff diff \
  --source "s3://audit-snapshots/2026-Q1/revenue.parquet" \
  --target "snowflake://finance_db.reporting.revenue AT(TIMESTAMP => '2026-03-31 23:59:59')" \
  --key transaction_id \
  --report-format audit-log \
  --output "s3://audit-reports/2026-Q1/weekly-check-$(date +%Y%m%d).json"
```

**Audit report metadata:**
- Snapshot hash (SHA-256 of the entire dataset)
- Row count at snapshot time
- Schema fingerprint
- Timestamp of comparison
- Number of differences found (should be zero)
- Signed attestation (who ran the check, when)

### 2.5 Use Case Summary

```
┌────────────────────┬──────────────┬──────────────────┬─────────────────────┐
│ Use Case           │ Compare Mode │ Time-Travel Need │ Key Metric          │
├────────────────────┼──────────────┼──────────────────┼─────────────────────┤
│ Migration          │ Same table,  │ Before/after DDL │ Zero row loss,      │
│                    │ two times    │                  │ value preservation  │
├────────────────────┼──────────────┼──────────────────┼─────────────────────┤
│ Backfill           │ Same table,  │ Before/after     │ Only expected cols  │
│                    │ two times    │ backfill run     │ changed             │
├────────────────────┼──────────────┼──────────────────┼─────────────────────┤
│ Regression         │ Same table   │ Before/after     │ Match percentage,   │
│                    │ or two tables│ pipeline deploy  │ max value delta     │
├────────────────────┼──────────────┼──────────────────┼─────────────────────┤
│ SOX/Audit          │ Snapshot vs  │ Quarter-end      │ Zero differences,   │
│                    │ live table   │ freeze point     │ cryptographic proof │
├────────────────────┼──────────────┼──────────────────┼─────────────────────┤
│ Data Recovery      │ Current vs   │ Before corruption│ Identify corrupted  │
│ Verification       │ restored     │ event            │ rows and scope      │
└────────────────────┴──────────────┴──────────────────┴─────────────────────┘
```

---

## 3. Data Versioning Systems

Beyond database-native time-travel, dedicated data versioning systems provide Git-like semantics for data lakes. These systems are orthogonal to time-travel — they version the data catalog itself, enabling branch/merge workflows.

### 3.1 lakeFS

lakeFS provides a Git-like interface for data lakes. It wraps S3/GCS/Azure Blob with a versioned object store that supports branches, commits, diffs, and merges.

**Architecture:**

```
┌──────────────────────────────────────────────────────────────┐
│                        lakeFS                                 │
│                                                              │
│  ┌─────────┐     ┌─────────┐     ┌─────────┐               │
│  │  main   │     │ staging │     │  dev    │  ← branches    │
│  │ branch  │     │ branch  │     │ branch  │               │
│  └────┬────┘     └────┬────┘     └────┬────┘               │
│       │               │               │                      │
│  commit c1        commit c4       commit c5                  │
│  commit c2        (branched        (branched                │
│  commit c3         from c3)        from c3)                 │
│       │               │               │                      │
│       └───── merge ───┘               │                      │
│               │                       │                      │
│          commit c6                    │                      │
│               └──── merge ────────────┘                      │
│                       │                                      │
│                  commit c7                                   │
│                                                              │
│  Underlying storage: S3/GCS/Azure (unchanged Parquet/ORC)   │
└──────────────────────────────────────────────────────────────┘
```

**Key capabilities for Reladiff:**

```bash
# lakeFS CLI: create a branch for testing a pipeline change
lakectl branch create lakefs://repo/test-pipeline --source lakefs://repo/main

# Run pipeline against the branch (writes to branch, not main)
spark.read.parquet("s3://repo/test-pipeline/data/orders/")

# lakeFS diff: see what changed
lakectl diff lakefs://repo/main lakefs://repo/test-pipeline

# lakeFS merge: if the diff looks good, merge to main
lakectl merge lakefs://repo/test-pipeline lakefs://repo/main
```

**Reladiff integration pattern:**

```bash
# Compare data on two lakeFS branches
reladiff diff \
  --source "lakefs://repo/main/data/orders/" \
  --target "lakefs://repo/test-pipeline/data/orders/" \
  --format parquet \
  --key order_id

# Compare data at two lakeFS commits
reladiff diff \
  --source "lakefs://repo/main/data/orders/@commit-abc123" \
  --target "lakefs://repo/main/data/orders/@commit-def456" \
  --format parquet \
  --key order_id
```

**Why lakeFS matters for Reladiff:**
- Zero-copy branching: branches don't duplicate data, only metadata. This makes "branch, modify, compare" cheap.
- Atomic commits: a pipeline either commits all changes or none. This guarantees consistent snapshots for comparison.
- Pre-merge hooks: lakeFS supports hooks that could trigger Reladiff automatically before allowing a merge.
- lakeFS exposes an S3-compatible API, so Reladiff can read from branches using standard S3 tooling (DuckDB's `read_parquet('s3://lakefs-endpoint/...')`).

### 3.2 DVC (Data Version Control)

DVC extends Git to handle large datasets and ML artifacts. It stores data in remote storage (S3, GCS, NFS) and tracks versions via small `.dvc` metadata files in Git.

**Architecture:**

```
┌──────────────────────────────────────────────────────────────┐
│                          DVC                                  │
│                                                              │
│  Git Repository                Remote Storage                │
│  ┌────────────────────┐       ┌───────────────────────┐     │
│  │ data/               │       │ s3://bucket/dvc-store/ │     │
│  │   orders.csv.dvc ──│──────→│   md5/ab/cd1234...     │     │
│  │   features.dvc  ───│──────→│   md5/ef/gh5678...     │     │
│  │                     │       │                        │     │
│  │ .dvc/config         │       │ (content-addressed)    │     │
│  │ dvc.yaml            │       └───────────────────────┘     │
│  │ dvc.lock            │                                     │
│  └────────────────────┘                                     │
│                                                              │
│  Git tags/branches version the .dvc pointers                │
│  Data is fetched on-demand: dvc pull                        │
└──────────────────────────────────────────────────────────────┘
```

**Reladiff integration pattern:**

```bash
# Compare dataset at two Git tags
git checkout v1.0 -- data/orders.csv.dvc && dvc pull data/orders.csv
cp data/orders.csv /tmp/orders_v1.csv

git checkout v2.0 -- data/orders.csv.dvc && dvc pull data/orders.csv
cp data/orders.csv /tmp/orders_v2.csv

reladiff diff \
  --source "/tmp/orders_v1.csv" \
  --target "/tmp/orders_v2.csv" \
  --key order_id
```

**Relevance to Reladiff:** DVC is primarily used in ML workflows. Reladiff's integration here is less about DVC-specific APIs and more about comparing files at different Git revisions. The integration is file-based, not SQL-based.

### 3.3 Nessie (Project Nessie)

Nessie is a Git-like catalog for Iceberg (and Delta Lake) tables. It provides branching and tagging at the catalog level, meaning you can have multiple "versions" of your entire data lakehouse visible simultaneously.

**Architecture:**

```
┌──────────────────────────────────────────────────────────────┐
│                        Nessie                                │
│                                                              │
│  ┌─────────────────────────────────────────┐                │
│  │           Nessie Catalog                 │                │
│  │  main: orders → snapshot-100            │                │
│  │         users  → snapshot-50             │                │
│  │                                          │                │
│  │  dev:   orders → snapshot-105            │  ← branched   │
│  │         users  → snapshot-50             │    from main   │
│  │                                          │                │
│  │  tag/Q1-2026: orders → snapshot-95      │  ← immutable  │
│  │               users  → snapshot-48       │    point       │
│  └─────────────────────────────────────────┘                │
│                                                              │
│  Query engine (Spark/Trino/Flink) resolves table refs       │
│  through Nessie, getting the correct Iceberg snapshot        │
│  for each branch/tag.                                        │
└──────────────────────────────────────────────────────────────┘
```

**Reladiff integration:**

```sql
-- Spark SQL with Nessie: query table on a specific branch
SELECT * FROM nessie.orders  -- resolves via current branch context

-- Switch branch context
ALTER SESSION SET nessie.ref = 'dev';
SELECT * FROM nessie.orders  -- now reads from dev branch

-- Compare across branches
SELECT * FROM nessie.`orders@main`
EXCEPT
SELECT * FROM nessie.`orders@dev`;
```

**Why Nessie matters for Reladiff:**
- Nessie enables comparing the same logical table across branches without time-travel SQL syntax — it's branch resolution at the catalog level.
- Tags provide immutable references (e.g., `Q1-2026-close`) that survive snapshot expiration.
- Nessie + Iceberg + Reladiff = a complete data validation workflow: branch the catalog, run a pipeline on the branch, use Reladiff to diff main vs branch, merge if clean.

### 3.4 Versioning Systems Comparison

```
┌──────────┬────────────────┬───────────────┬──────────────┬──────────────────┐
│ System   │ Versioning     │ Data Format   │ Branching    │ Best For         │
│          │ Granularity    │ Support       │              │                  │
├──────────┼────────────────┼───────────────┼──────────────┼──────────────────┤
│ lakeFS   │ Object-level   │ Any (S3-compat│ Full Git-like│ Data lake QA,    │
│          │ (files/objects)│ Parquet, ORC) │ branch/merge │ CI/CD for data   │
├──────────┼────────────────┼───────────────┼──────────────┼──────────────────┤
│ DVC      │ File-level     │ Any file      │ Via Git      │ ML datasets,     │
│          │ (content hash) │               │ branches     │ experiment track.│
├──────────┼────────────────┼───────────────┼──────────────┼──────────────────┤
│ Nessie   │ Table-level    │ Iceberg,      │ Full Git-like│ Lakehouse        │
│          │ (catalog refs) │ Delta Lake    │ branch/tag   │ catalog mgmt     │
├──────────┼────────────────┼───────────────┼──────────────┼──────────────────┤
│ Iceberg  │ Snapshot-level │ Iceberg       │ Branches +   │ Table-level      │
│ (native) │ (per-table)    │               │ tags (spec v2│ versioning       │
├──────────┼────────────────┼───────────────┼──────────────┼──────────────────┤
│ Delta    │ Version-level  │ Delta Lake    │ No native    │ Table-level      │
│ (native) │ (per-table)    │               │ branching    │ versioning       │
└──────────┴────────────────┴───────────────┴──────────────┴──────────────────┘
```

---

## 4. Lineage-Aware Validation

Lineage answers the question: "where did this data come from, and what depends on it?" When combined with validation, lineage enables targeted, efficient, and automated data quality checks.

### 4.1 The OpenLineage Standard

OpenLineage is an open standard for collecting and transmitting lineage metadata. It defines a common event model that captures data movement across systems.

**Core concepts:**

```
┌──────────────────────────────────────────────────────────────┐
│                   OpenLineage Event Model                     │
│                                                              │
│  RunEvent {                                                  │
│    eventType: START | RUNNING | COMPLETE | FAIL | ABORT      │
│    eventTime: "2026-01-15T14:30:00Z"                        │
│    run: {                                                    │
│      runId: "uuid-of-this-execution"                        │
│      facets: {                                               │
│        parent: { job: {...}, run: {...} }                    │
│        nominalTime: { start, end }                          │
│      }                                                       │
│    }                                                         │
│    job: {                                                    │
│      namespace: "my-airflow"                                │
│      name: "etl.transform_orders"                           │
│      facets: {                                               │
│        sql: { query: "INSERT INTO ... SELECT ..." }         │
│        sourceCode: { ... }                                  │
│      }                                                       │
│    }                                                         │
│    inputs: [                                                 │
│      {                                                       │
│        namespace: "snowflake://account"                      │
│        name: "raw.orders"                                   │
│        facets: {                                             │
│          schema: { fields: [...] }                          │
│          columnLineage: {                                    │
│            fields: {                                         │
│              "total_amount": {                               │
│                inputFields: [                                │
│                  { namespace: "...", name: "raw.orders",     │
│                    field: "quantity" },                      │
│                  { namespace: "...", name: "raw.orders",     │
│                    field: "unit_price" }                     │
│                ],                                            │
│                transformationType: "EXPRESSION"              │
│              }                                               │
│            }                                                 │
│          }                                                   │
│        }                                                     │
│      }                                                       │
│    ]                                                         │
│    outputs: [                                                │
│      {                                                       │
│        namespace: "snowflake://account"                      │
│        name: "analytics.fact_orders"                        │
│        facets: {                                             │
│          schema: { fields: [...] }                          │
│          outputStatistics: { rowCount: 50000, size: ... }   │
│        }                                                     │
│      }                                                       │
│    ]                                                         │
│  }                                                           │
└──────────────────────────────────────────────────────────────┘
```

**How Reladiff uses OpenLineage:**

1. **Discover upstream sources:** Given a target table, query OpenLineage to find all upstream tables. Reladiff can then validate each upstream source to diagnose root causes.

2. **Column-level lineage for targeted diffs:** If only `total_amount` changed, OpenLineage tells us it depends on `quantity` and `unit_price`. Reladiff can focus its diff on just those columns upstream.

3. **Automated trigger:** An OpenLineage COMPLETE event can trigger a Reladiff validation run on the output dataset.

### 4.2 Column-Level Lineage for Blast Radius Analysis

When data changes in a source table, column-level lineage tells us exactly which downstream columns are affected — the "blast radius."

```
┌──────────────────────────────────────────────────────────────┐
│              Blast Radius Analysis                            │
│                                                              │
│  Source change: raw.products.unit_price modified             │
│                                                              │
│  Column lineage graph:                                       │
│                                                              │
│  raw.products.unit_price                                     │
│       │                                                      │
│       ├──→ staging.orders.item_price                         │
│       │        │                                             │
│       │        ├──→ analytics.fact_orders.total_amount       │
│       │        │        │                                    │
│       │        │        └──→ reporting.daily_revenue.revenue │
│       │        │                                             │
│       │        └──→ analytics.fact_orders.tax_amount         │
│       │                 │                                    │
│       │                 └──→ reporting.daily_revenue.tax     │
│       │                                                      │
│       └──→ ml.features.price_feature                         │
│                │                                             │
│                └──→ ml.predictions.expected_revenue          │
│                                                              │
│  Blast radius: 6 downstream columns across 4 tables         │
│                                                              │
│  Reladiff action: validate these 4 tables, focusing on      │
│  the 6 affected columns.                                     │
└──────────────────────────────────────────────────────────────┘
```

**Implementation in Reladiff:**

```bash
# Given a source change, compute blast radius and validate all affected tables
reladiff validate-downstream \
  --source-table "raw.products" \
  --changed-columns "unit_price" \
  --lineage-source openlineage \
  --lineage-endpoint "http://marquez:5000" \
  --time-travel-before "2026-01-15 00:00:00" \
  --time-travel-after  "2026-01-15 06:00:00"
```

This command would:
1. Query OpenLineage for all downstream tables/columns of `raw.products.unit_price`.
2. For each affected table, run a time-travel diff on the affected columns.
3. Produce a consolidated report showing which downstream tables changed as expected and which show anomalies.

### 4.3 Automated Re-Validation on Upstream Changes

The most powerful integration of lineage and validation is automated re-validation: when an upstream dataset changes, automatically trigger validation on downstream datasets.

```
┌──────────────────────────────────────────────────────────────┐
│          Automated Lineage-Driven Validation                 │
│                                                              │
│  1. Pipeline writes to staging.orders (OpenLineage COMPLETE) │
│                                                              │
│  2. Lineage service identifies downstream tables:            │
│     - analytics.fact_orders                                  │
│     - reporting.daily_revenue                                │
│                                                              │
│  3. Reladiff triggered for each downstream table:            │
│     - Compare state before pipeline run vs after             │
│     - Check row count delta within threshold                 │
│     - Check value distributions haven't shifted              │
│                                                              │
│  4. Results:                                                 │
│     ✓ analytics.fact_orders: +500 rows, all columns OK      │
│     ✗ reporting.daily_revenue: revenue dropped 40%           │
│       → Alert sent, pipeline paused                          │
└──────────────────────────────────────────────────────────────┘
```

**Integration architecture:**

```
┌────────────┐    ┌───────────────┐    ┌──────────────┐    ┌─────────────┐
│  Airflow/  │───→│  OpenLineage  │───→│  Reladiff    │───→│  Alerting   │
│  dbt/Spark │    │  Collector    │    │  Validator   │    │  (Slack/PD) │
│  (pipeline)│    │  (Marquez)    │    │  (triggered) │    │             │
└────────────┘    └───────────────┘    └──────────────┘    └─────────────┘
                         │
                         v
                  ┌───────────────┐
                  │  Lineage      │
                  │  Graph (DAG)  │
                  └───────────────┘
```

### 4.4 Tools for Lineage

**DataHub (LinkedIn/Acryl Data):**
- Open-source metadata platform with column-level lineage.
- REST and GraphQL APIs for querying lineage.
- Integrations with dbt, Spark, Airflow, Snowflake, BigQuery.
- Reladiff could query DataHub's GraphQL API to discover downstream impacts.

**Marquez (WeWork/Linux Foundation):**
- OpenLineage reference implementation.
- Stores lineage events and provides a search API.
- Lightweight: single Java service + PostgreSQL.
- Best for teams already emitting OpenLineage events.

**dbt `ref()` graph:**
- dbt's `manifest.json` contains a complete DAG of model dependencies.
- Column-level lineage available via `catalog.json` + `manifest.json` parsing.
- No external service needed — the graph is a static artifact of `dbt compile`.
- Reladiff integration: parse `manifest.json`, extract upstream/downstream for a given model, validate each.

```python
# Parsing dbt manifest for lineage
import json

with open("target/manifest.json") as f:
    manifest = json.load(f)

# Get all upstream dependencies of a model
model = manifest["nodes"]["model.my_project.fact_orders"]
upstream = model["depends_on"]["nodes"]
# → ["model.my_project.stg_orders", "model.my_project.stg_products"]

# Get column-level lineage (if available via dbt-osmosis or similar)
columns = model.get("columns", {})
for col_name, col_info in columns.items():
    # Column-level depends_on (dbt 1.6+)
    pass
```

**Snowflake ACCESS_HISTORY:**
- Snowflake's `SNOWFLAKE.ACCOUNT_USAGE.ACCESS_HISTORY` view provides column-level lineage for all queries.
- `base_objects_accessed` and `direct_objects_accessed` columns track table/column reads.
- `objects_modified` tracks table/column writes.
- No external tooling needed — lineage is a query against the Snowflake metadata database.

### 4.5 Lineage Integration Design for Reladiff

```
┌──────────────────────────────────────────────────────────────┐
│               Reladiff Lineage Integration                   │
│                                                              │
│  LineageProvider (interface)                                 │
│  ├── OpenLineageProvider                                    │
│  │     └── Queries Marquez API                              │
│  ├── DataHubProvider                                        │
│  │     └── Queries DataHub GraphQL                          │
│  ├── DbtManifestProvider                                    │
│  │     └── Parses manifest.json + catalog.json              │
│  ├── SnowflakeAccessHistoryProvider                         │
│  │     └── Queries ACCESS_HISTORY view                      │
│  └── StaticProvider                                         │
│        └── User-defined YAML/JSON lineage graph             │
│                                                              │
│  LineageProvider.get_downstream(table, column?)              │
│    → List<AffectedTable>                                    │
│                                                              │
│  LineageProvider.get_upstream(table, column?)                │
│    → List<SourceTable>                                      │
│                                                              │
│  Reladiff uses this to:                                      │
│  1. Scope diffs to affected columns only                    │
│  2. Chain validations across the DAG                        │
│  3. Report blast radius in diff output                      │
└──────────────────────────────────────────────────────────────┘
```

---

## 5. Temporal Data Patterns

Data systems often model time explicitly through patterns like Slowly Changing Dimensions (SCD), bitemporal tables, and event sourcing. Each pattern creates unique validation challenges.

### 5.1 SCD Type 1 (Overwrite)

The simplest temporal pattern: when a value changes, overwrite it in place. No history is retained in the table itself.

```sql
-- Before update
-- | customer_id | name      | city        |
-- |-------------|-----------|-------------|
-- | 1001        | Alice     | New York    |

UPDATE dim_customer SET city = 'Boston' WHERE customer_id = 1001;

-- After update
-- | customer_id | name      | city        |
-- |-------------|-----------|-------------|
-- | 1001        | Alice     | Boston      |
```

**Validation challenge:** With SCD1, the only way to validate the change is via time-travel (if available) or an external snapshot. Without either, the previous value is simply gone.

**Reladiff approach:** For SCD1 tables on databases with time-travel, compare `AT(TIMESTAMP => pre-update)` vs current. For databases without time-travel, Reladiff's snapshot feature is essential.

### 5.2 SCD Type 2 (Versioned Rows)

Each change creates a new row, with effective dates marking which version is current.

```sql
-- | sk  | customer_id | name  | city      | eff_start   | eff_end     | is_current |
-- |-----|-------------|-------|-----------|-------------|-------------|------------|
-- | 101 | 1001        | Alice | New York  | 2025-01-01  | 2026-01-15  | false      |
-- | 102 | 1001        | Alice | Boston    | 2026-01-15  | 9999-12-31  | true       |
```

**Validation challenges:**
- Must validate that exactly one row per business key has `is_current = true`.
- Must validate that `eff_end` of the previous version equals `eff_start` of the new version (no gaps or overlaps).
- Must validate that expired rows are not modified.
- Row count increases with every change, making naive row-count comparison misleading.

**Reladiff approach:**

```bash
# Validate SCD2 integrity
reladiff scd2-validate \
  --table "snowflake://db.schema.dim_customer" \
  --business-key customer_id \
  --surrogate-key sk \
  --effective-start eff_start \
  --effective-end eff_end \
  --current-flag is_current

# Diff only current rows between two time points
reladiff diff \
  --source "snowflake://db.schema.dim_customer AT(TIMESTAMP => '2026-01-14')" \
  --target "snowflake://db.schema.dim_customer" \
  --key customer_id \
  --where "is_current = true"
```

**Validation rules for SCD2:**

```
┌──────────────────────────────────────────────────────┐
│             SCD Type 2 Validation Rules              │
│                                                      │
│  1. Uniqueness: exactly one is_current=true per      │
│     business key                                     │
│                                                      │
│  2. Continuity: for each business key, date ranges   │
│     form a contiguous, non-overlapping sequence      │
│     eff_end[n] = eff_start[n+1]                     │
│                                                      │
│  3. Completeness: the current row has                │
│     eff_end = '9999-12-31' (or NULL)                │
│                                                      │
│  4. Immutability: historical rows (is_current=false) │
│     should not change between validation runs        │
│                                                      │
│  5. Monotonicity: eff_start values should increase   │
│     for successive versions of the same key          │
└──────────────────────────────────────────────────────┘
```

### 5.3 SCD Type 6 (Hybrid)

Combines Type 1 (overwrite current value), Type 2 (keep history), and Type 3 (previous value column). Each row has both the historical value and the current value.

```sql
-- | sk  | customer_id | hist_city | curr_city | eff_start  | eff_end    | is_current |
-- |-----|-------------|-----------|-----------|------------|------------|------------|
-- | 101 | 1001        | New York  | Boston    | 2025-01-01 | 2026-01-15 | false      |
-- | 102 | 1001        | Boston    | Boston    | 2026-01-15 | 9999-12-31 | true       |
```

**Validation challenge:** The `curr_city` column must be updated across ALL rows for a business key when the current value changes (Type 1 overwrite on historical rows). This is easy to get wrong.

**Reladiff validation:**
- After an SCD6 update, verify that `curr_city` is identical across all rows for the same `customer_id`.
- Verify that `hist_city` on historical rows has NOT changed.
- The combination of "some columns change on all rows" and "other columns must not change on old rows" makes SCD6 a complex validation target.

### 5.4 Bitemporal Data

Bitemporal tables track two independent time dimensions:
- **Transaction time (system time):** when the row was recorded in the database.
- **Valid time (business time):** when the fact was true in the real world.

```sql
-- | customer_id | city     | valid_from  | valid_to    | txn_from            | txn_to              |
-- |-------------|----------|-------------|-------------|---------------------|---------------------|
-- | 1001        | New York | 2025-01-01  | 9999-12-31  | 2025-01-01 00:00:00 | 2026-01-15 10:00:00 |
-- | 1001        | New York | 2025-01-01  | 2026-01-15  | 2026-01-15 10:00:00 | 9999-12-31 23:59:59 |
-- | 1001        | Boston   | 2026-01-15  | 9999-12-31  | 2026-01-15 10:00:00 | 9999-12-31 23:59:59 |

-- Query: "What did we think the customer's city was on Jan 10, as known on Jan 14?"
SELECT city FROM dim_customer
WHERE customer_id = 1001
  AND '2026-01-10' BETWEEN valid_from AND valid_to
  AND '2026-01-14 00:00:00' BETWEEN txn_from AND txn_to;
-- → New York (because on Jan 14, we hadn't yet recorded the move to Boston)
```

**Validation challenges:**
- Two-dimensional overlap detection: no two rows for the same business key should overlap in both valid time AND transaction time.
- Retroactive corrections: when a past fact is corrected, the old transaction-time row is closed and a new one opened. Must validate that the old row's `txn_to` is properly set.
- Query complexity: every validation query needs both time dimensions as filters.

**Reladiff approach:**
- Bitemporal diff requires specifying BOTH time dimensions: "compare the business-time view of the world as-of transaction-time T1 vs T2."
- This enables answering: "what corrections were made between yesterday and today?"

### 5.5 Event Sourcing

In event-sourced systems, the source of truth is an append-only event log. Materialized views (projections) are derived by replaying events.

```
┌──────────────────────────────────────────────────────────────┐
│                Event Sourcing Validation                     │
│                                                              │
│  Event Log (append-only):                                   │
│  ┌────────────────────────────────────────────────────────┐ │
│  │ {event_id: 1, type: "OrderCreated", order_id: 100,    │ │
│  │  amount: 50.00, timestamp: "2026-01-15T10:00:00"}     │ │
│  │ {event_id: 2, type: "OrderItemAdded", order_id: 100,  │ │
│  │  amount: 25.00, timestamp: "2026-01-15T10:01:00"}     │ │
│  │ {event_id: 3, type: "OrderCompleted", order_id: 100,  │ │
│  │  timestamp: "2026-01-15T10:05:00"}                    │ │
│  └────────────────────────────────────────────────────────┘ │
│                        │                                     │
│                   Replay/Project                             │
│                        │                                     │
│                        v                                     │
│  Materialized State:                                        │
│  ┌────────────────────────────────────────────────────────┐ │
│  │ | order_id | total_amount | status    |                │ │
│  │ | 100      | 75.00        | completed |                │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                              │
│  Validation: replay events → expected state                 │
│              compare expected state vs actual materialized   │
│              state using Reladiff                            │
└──────────────────────────────────────────────────────────────┘
```

**Reladiff validation for event sourcing:**
- Replay events to produce an expected materialized state.
- Diff the expected state against the actual materialized view.
- Any differences indicate a bug in the projection logic or missed events.
- This is particularly valuable when the projection logic is updated: replay all events with the new logic and diff against the old materialized state to understand the impact.

### 5.6 Snapshot Isolation for Consistent Reads

When Reladiff reads from a source and target, both reads must see a consistent snapshot. If the source is being written to during the diff, Reladiff could see partial updates.

**Database isolation guarantees:**

| Database   | Default Isolation    | Snapshot Read Available? |
|------------|---------------------|------------------------|
| Snowflake  | Read Committed      | Yes (time-travel provides implicit snapshot) |
| BigQuery   | Snapshot            | Yes (every query sees a consistent snapshot) |
| Delta Lake | Serializable        | Yes (reads are pinned to a snapshot version) |
| Iceberg    | Serializable        | Yes (reads are pinned to a snapshot) |
| PostgreSQL | Read Committed      | Yes (`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`) |
| MySQL      | Repeatable Read     | Yes (InnoDB MVCC) |
| DuckDB     | Serializable        | Yes (single-writer, all reads are consistent) |

**Reladiff recommendation:** For databases with time-travel, pin both source and target reads to explicit timestamps or snapshot IDs. This guarantees consistency even if the table is being written to:

```bash
reladiff diff \
  --source "snowflake://db.schema.orders AT(TIMESTAMP => '2026-01-15 14:30:00')" \
  --target "snowflake://db.schema.orders AT(TIMESTAMP => '2026-01-15 18:30:00')" \
  --key order_id
# Both reads are pinned to exact timestamps — no risk of partial updates
```

For databases without time-travel, Reladiff should acquire a transaction with `REPEATABLE READ` isolation (PostgreSQL, MySQL) to ensure both the source query and checksum queries see the same snapshot.

---

## 6. Implementation Recommendations for Reladiff

### 6.1 SQL Generation for Time-Travel Queries

Reladiff needs a SQL generator that produces the correct time-travel syntax for each database, parameterized by the user's version specification.

**Version specification types:**

```typescript
type VersionSpec =
  | { type: "timestamp"; value: string }           // ISO 8601 timestamp
  | { type: "offset"; seconds: number }            // Relative offset
  | { type: "version"; value: number }             // Delta Lake version number
  | { type: "snapshot_id"; value: string }          // Iceberg snapshot ID
  | { type: "statement_id"; value: string }         // Snowflake statement ID
  | { type: "branch"; value: string }               // lakeFS/Nessie branch
  | { type: "tag"; value: string }                   // Nessie/Iceberg tag
  | { type: "commit"; value: string };               // lakeFS commit hash

interface TimeTravelQuery {
  table: string;
  version?: VersionSpec;
  database: DatabaseType;
}
```

**SQL generation per database:**

```typescript
function generateTimeTravelSQL(query: TimeTravelQuery): string {
  const { table, version, database } = query;

  if (!version) return `SELECT * FROM ${table}`;

  switch (database) {
    case "snowflake":
      switch (version.type) {
        case "timestamp":
          return `SELECT * FROM ${table} AT(TIMESTAMP => '${version.value}'::TIMESTAMP_LTZ)`;
        case "offset":
          return `SELECT * FROM ${table} AT(OFFSET => -${version.seconds})`;
        case "statement_id":
          return `SELECT * FROM ${table} AT(STATEMENT => '${version.value}')`;
        default:
          throw new Error(`Snowflake does not support version type: ${version.type}`);
      }

    case "bigquery":
      switch (version.type) {
        case "timestamp":
          return `SELECT * FROM ${table} FOR SYSTEM_TIME AS OF TIMESTAMP '${version.value}'`;
        case "offset":
          return `SELECT * FROM ${table} FOR SYSTEM_TIME AS OF TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL ${version.seconds} SECOND)`;
        default:
          throw new Error(`BigQuery does not support version type: ${version.type}`);
      }

    case "databricks":
    case "delta":
      switch (version.type) {
        case "timestamp":
          return `SELECT * FROM ${table} TIMESTAMP AS OF '${version.value}'`;
        case "version":
          return `SELECT * FROM ${table} VERSION AS OF ${version.value}`;
        default:
          throw new Error(`Delta Lake does not support version type: ${version.type}`);
      }

    case "iceberg":
      switch (version.type) {
        case "timestamp":
          return `SELECT * FROM ${table} FOR SYSTEM_TIME AS OF '${version.value}'`;
        case "snapshot_id":
          return `SELECT * FROM ${table} FOR SYSTEM_VERSION AS OF ${version.value}`;
        default:
          throw new Error(`Iceberg does not support version type: ${version.type}`);
      }

    case "postgres":
    case "mysql":
    case "duckdb":
      throw new Error(`${database} does not support native time-travel. Use Reladiff snapshots instead.`);
  }
}
```

### 6.2 Version-Aware Connection Configuration

Reladiff's connection configuration should support version parameters natively, not as SQL injection in the table name.

**Connection config schema:**

```yaml
# reladiff.yaml
connections:
  snowflake_prod:
    type: snowflake
    account: xy12345.us-east-1
    database: analytics
    schema: public
    warehouse: compute_wh

diffs:
  migration_check:
    source:
      connection: snowflake_prod
      table: fact_orders
      version:
        type: timestamp
        value: "2026-01-15T00:00:00Z"
    target:
      connection: snowflake_prod
      table: fact_orders
      # No version = current state
    key_columns: [order_id]
    compare_columns: [amount, status, updated_at]

  branch_comparison:
    source:
      connection: lakefs_prod
      table: data/orders/
      version:
        type: branch
        value: main
    target:
      connection: lakefs_prod
      table: data/orders/
      version:
        type: branch
        value: feature/new-pricing
    key_columns: [order_id]
```

### 6.3 Result Metadata: Version Context

Every Reladiff output should include metadata about which versions were compared, making results reproducible.

```json
{
  "diff_id": "d7f3a2b1-4c5e-6f7a-8b9c-0d1e2f3a4b5c",
  "timestamp": "2026-01-15T14:35:00Z",
  "source": {
    "connection": "snowflake_prod",
    "table": "analytics.public.fact_orders",
    "version": {
      "type": "timestamp",
      "value": "2026-01-15T00:00:00Z",
      "resolved_to": {
        "snowflake_stream_offset": "01b2c3d4-...",
        "row_count": 1250000
      }
    }
  },
  "target": {
    "connection": "snowflake_prod",
    "table": "analytics.public.fact_orders",
    "version": {
      "type": "current",
      "resolved_to": {
        "query_timestamp": "2026-01-15T14:34:58Z",
        "row_count": 1250347
      }
    }
  },
  "summary": {
    "rows_added": 347,
    "rows_removed": 0,
    "rows_modified": 12,
    "rows_identical": 1249988,
    "columns_compared": ["amount", "status", "updated_at"],
    "columns_with_differences": ["amount", "status"]
  },
  "reproducibility": {
    "reladiff_version": "0.5.0",
    "command": "reladiff diff --source ... --target ... --key order_id",
    "config_hash": "sha256:abc123..."
  }
}
```

### 6.4 Integration with Lineage Graph for Targeted Validation

When combined, time-travel and lineage enable a powerful validation pattern: "something changed upstream; validate all affected downstream tables at the relevant time window."

**Workflow:**

```
┌──────────────────────────────────────────────────────────────┐
│        Lineage-Driven Temporal Validation Workflow           │
│                                                              │
│  Step 1: Detect change                                       │
│  ┌─────────────────────────────────────────┐                │
│  │ OpenLineage event: raw.orders updated   │                │
│  │ at 2026-01-15T14:00:00Z                 │                │
│  │ Columns modified: quantity, unit_price   │                │
│  └─────────────────────────────────────────┘                │
│                      │                                       │
│  Step 2: Compute blast radius                               │
│  ┌─────────────────────────────────────────┐                │
│  │ Lineage query → downstream tables:      │                │
│  │   staging.orders (quantity, item_price)  │                │
│  │   analytics.fact_orders (total_amount)   │                │
│  │   reporting.daily_revenue (revenue)      │                │
│  └─────────────────────────────────────────┘                │
│                      │                                       │
│  Step 3: Validate each downstream table                     │
│  ┌─────────────────────────────────────────┐                │
│  │ For each table in blast radius:         │                │
│  │   reladiff diff                         │                │
│  │     --source table AT(T - pipeline_lag) │                │
│  │     --target table (current)            │                │
│  │     --columns affected_columns_only     │                │
│  │     --thresholds from data contract     │                │
│  └─────────────────────────────────────────┘                │
│                      │                                       │
│  Step 4: Report and act                                     │
│  ┌─────────────────────────────────────────┐                │
│  │ Consolidated report:                    │                │
│  │   staging.orders: OK (+500 rows)        │                │
│  │   analytics.fact_orders: OK (+500 rows) │                │
│  │   reporting.daily_revenue: ALERT        │                │
│  │     revenue dropped 40% — investigate   │                │
│  └─────────────────────────────────────────┘                │
└──────────────────────────────────────────────────────────────┘
```

### 6.5 Snapshot Management for Databases Without Time-Travel

For PostgreSQL, MySQL, and DuckDB, Reladiff should provide a built-in snapshot mechanism.

**Snapshot storage format:**

```
~/.reladiff/snapshots/
├── postgres_prod/
│   ├── public.orders/
│   │   ├── 2026-01-15T00:00:00Z.parquet    (data)
│   │   ├── 2026-01-15T00:00:00Z.meta.json  (metadata)
│   │   ├── 2026-01-15T06:00:00Z.parquet
│   │   └── 2026-01-15T06:00:00Z.meta.json
│   └── public.customers/
│       └── ...
└── mysql_prod/
    └── ...
```

**Metadata file:**

```json
{
  "snapshot_id": "snap-abc123",
  "table": "public.orders",
  "connection": "postgres_prod",
  "timestamp": "2026-01-15T00:00:00Z",
  "row_count": 125000,
  "schema": {
    "columns": [
      { "name": "id", "type": "INT8" },
      { "name": "amount", "type": "NUMERIC(10,2)" }
    ]
  },
  "checksum": "sha256:def456...",
  "size_bytes": 4521984,
  "isolation_level": "REPEATABLE READ",
  "reladiff_version": "0.5.0"
}
```

**Commands:**

```bash
# Take a snapshot
reladiff snapshot take \
  --connection postgres_prod \
  --table public.orders \
  --label "pre-migration-2026-01-15"

# List snapshots
reladiff snapshot list --connection postgres_prod --table public.orders

# Diff current state against a snapshot
reladiff diff \
  --source "snapshot://pre-migration-2026-01-15" \
  --target "postgres://postgres_prod/public.orders" \
  --key id

# Clean old snapshots
reladiff snapshot prune --older-than 30d
```

### 6.6 Priority Implementation Order

Based on user value and implementation complexity:

```
┌────┬───────────────────────────────────────┬────────────┬──────────┐
│ #  │ Feature                               │ Complexity │ Value    │
├────┼───────────────────────────────────────┼────────────┼──────────┤
│ 1  │ Time-travel SQL generation            │ Low        │ High     │
│    │ (Snowflake, BigQuery, Delta, Iceberg) │            │          │
├────┼───────────────────────────────────────┼────────────┼──────────┤
│ 2  │ Version-aware connection config       │ Low        │ High     │
│    │ (YAML schema + CLI flags)             │            │          │
├────┼───────────────────────────────────────┼────────────┼──────────┤
│ 3  │ Version metadata in diff output       │ Low        │ Medium   │
│    │ (JSON report enhancement)             │            │          │
├────┼───────────────────────────────────────┼────────────┼──────────┤
│ 4  │ Snapshot management for PG/MySQL      │ Medium     │ High     │
│    │ (snapshot take/list/diff/prune)        │            │          │
├────┼───────────────────────────────────────┼────────────┼──────────┤
│ 5  │ dbt manifest lineage integration      │ Medium     │ High     │
│    │ (parse DAG, targeted validation)      │            │          │
├────┼───────────────────────────────────────┼────────────┼──────────┤
│ 6  │ SCD2 validation rules                 │ Medium     │ Medium   │
│    │ (continuity, uniqueness checks)       │            │          │
├────┼───────────────────────────────────────┼────────────┼──────────┤
│ 7  │ OpenLineage/DataHub integration       │ High       │ Medium   │
│    │ (API clients, event-driven triggers)  │            │          │
├────┼───────────────────────────────────────┼────────────┼──────────┤
│ 8  │ lakeFS/Nessie branch comparison       │ High       │ Low      │
│    │ (requires catalog integration)        │ (for now)  │          │
├────┼───────────────────────────────────────┼────────────┼──────────┤
│ 9  │ Bitemporal validation                 │ High       │ Low      │
│    │ (two-dimensional overlap detection)   │ (niche)    │          │
└────┴───────────────────────────────────────┴────────────┴──────────┘
```

### 6.7 Cross-Cutting Concerns

**Error handling for expired versions:**
- Before executing a time-travel query, validate that the requested version is available.
- Snowflake: query `INFORMATION_SCHEMA.TABLE_STORAGE_METRICS` for `RETENTION_TIME`.
- BigQuery: check if timestamp is within 7 days.
- Delta Lake: parse `_delta_log` for available versions; catch `FileNotFoundException`.
- Iceberg: query the `snapshots` metadata table.
- Provide a clear error message: "Requested version '2026-01-01' is outside the retention window. The earliest available version is '2026-01-10'. Consider using Reladiff snapshots for longer retention."

**Performance considerations:**
- Time-travel queries on Snowflake/BigQuery have the same performance characteristics as regular queries — they don't scan "extra" data.
- Delta Lake time-travel may read from older, uncompacted files (pre-OPTIMIZE), potentially slower than current state.
- For large tables, combine time-travel with Reladiff's existing sampling/segmentation strategies (see Theme A: Cost-Effective Validation).

**Security:**
- Time-travel access follows the same permissions as regular table access. No additional grants are needed.
- Snapshot files stored locally contain full table data — apply same security controls as database credentials.
- Audit trail: log which versions were accessed and by whom, especially for SOX compliance use cases.

---

## 7. References

### Database Documentation
- Snowflake Time Travel: https://docs.snowflake.com/en/user-guide/data-time-travel
- BigQuery Time Travel: https://cloud.google.com/bigquery/docs/time-travel
- Delta Lake Time Travel: https://docs.delta.io/latest/delta-batch.html#query-an-older-snapshot-of-a-table-time-travel
- Apache Iceberg Branching and Tagging: https://iceberg.apache.org/docs/latest/branching/
- PostgreSQL Temporal Tables: https://pgxn.org/dist/temporal_tables/
- MariaDB System Versioned Tables: https://mariadb.com/kb/en/system-versioned-tables/

### Data Versioning Systems
- lakeFS: https://docs.lakefs.io/
- DVC: https://dvc.org/doc
- Project Nessie: https://projectnessie.org/

### Lineage Standards and Tools
- OpenLineage: https://openlineage.io/
- Marquez: https://marquezproject.ai/
- DataHub: https://datahubproject.io/
- dbt Manifest Specification: https://docs.getdbt.com/reference/artifacts/manifest-json

### Temporal Data Patterns
- Kimball SCD Types: https://www.kimballgroup.com/data-warehouse-business-intelligence-resources/kimball-techniques/dimensional-modeling-techniques/type-2/
- SQL:2011 Temporal: ISO/IEC 9075-2:2011 (SQL/Foundation), Part 2, Section 11
- Martin Fowler on Temporal Patterns: https://martinfowler.com/eaaDev/timeNarrative.html
- Event Sourcing (Martin Fowler): https://martinfowler.com/eaaDev/EventSourcing.html
