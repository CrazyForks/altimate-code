# Theme C: Streaming & CDC-Based Data Validation

_Iteration 3 — 2026-03-13_

## 1. Change Data Capture (CDC) for Validation

### How CDC Works for Data Validation

CDC captures row-level changes (INSERT, UPDATE, DELETE) from database logs and streams them as events. Instead of comparing entire tables, you validate only the *changes* — reducing the comparison surface from billions of rows to thousands of events per interval.

```
Source DB ──► CDC Log ──► Event Stream ──► Target DB
                              │
                         Validation Layer
                         (compare events vs target state)
```

### Debezium + Kafka Connect Architecture

Debezium is the dominant open-source CDC platform. It reads database transaction logs (WAL, binlog, redo log) and emits structured change events to Kafka.

**Debezium change event structure:**
```json
{
  "before": {"id": 42, "name": "Alice", "balance": 100.00},
  "after":  {"id": 42, "name": "Alice", "balance": 150.00},
  "source": {
    "version": "2.5.0",
    "connector": "postgresql",
    "db": "orders",
    "table": "accounts",
    "lsn": 33495936,
    "txId": 7804,
    "ts_ms": 1710300000000
  },
  "op": "u",
  "ts_ms": 1710300000123
}
```

**Validation connector configuration:**
```json
{
  "name": "pg-source-validator",
  "config": {
    "connector.class": "io.debezium.connector.postgresql.PostgresConnector",
    "database.hostname": "source-db",
    "database.port": "5432",
    "database.dbname": "orders",
    "database.user": "debezium",
    "slot.name": "validation_slot",
    "plugin.name": "pgoutput",
    "table.include.list": "public.orders,public.accounts",
    "snapshot.mode": "never",
    "tombstones.on.delete": true,
    "transforms": "unwrap",
    "transforms.unwrap.type": "io.debezium.transforms.ExtractNewRecordState",
    "transforms.unwrap.add.fields": "op,source.ts_ms,source.lsn"
  }
}
```

### CDC-Based Reconciliation Patterns

#### Pattern 1: Dual-Write Verification

Both source and target emit CDC events. A reconciler compares them:

```python
from confluent_kafka import Consumer
import hashlib
import json
from collections import defaultdict

class DualWriteReconciler:
    """Compares CDC events from two databases to detect drift."""

    def __init__(self, source_topic: str, target_topic: str):
        self.source_events: dict[str, dict] = {}
        self.target_events: dict[str, dict] = {}
        self.reconciliation_window_ms = 30_000  # 30 seconds

    def fingerprint(self, record: dict, exclude_keys: set = None) -> str:
        """Deterministic hash of a record, excluding metadata fields."""
        exclude = exclude_keys or {"_cdc_ts", "_cdc_op", "__debezium_ts"}
        filtered = {k: v for k, v in sorted(record.items()) if k not in exclude}
        return hashlib.md5(json.dumps(filtered, default=str).encode()).hexdigest()

    def reconcile_window(self) -> dict:
        """Compare accumulated events within the reconciliation window."""
        mismatches = {
            "missing_in_target": [],
            "missing_in_source": [],
            "value_mismatch": [],
        }

        all_keys = set(self.source_events) | set(self.target_events)
        for key in all_keys:
            src = self.source_events.get(key)
            tgt = self.target_events.get(key)

            if src and not tgt:
                mismatches["missing_in_target"].append(key)
            elif tgt and not src:
                mismatches["missing_in_source"].append(key)
            elif self.fingerprint(src) != self.fingerprint(tgt):
                mismatches["value_mismatch"].append({
                    "key": key,
                    "source": src,
                    "target": tgt,
                })

        return mismatches
```

**Real-world use**: Stripe's [Scientist](https://github.com/github/scientist) library implements this pattern at the application layer — run both code paths, compare results, report mismatches without affecting users.

#### Pattern 2: Event Sourcing Reconciliation

Replay events from the event store and compare materialized state:

```python
def validate_read_model_against_events(
    event_store,
    read_model_db,
    entity_id: str,
) -> list[str]:
    """Replay events and compare against current read model state."""
    events = event_store.get_events(entity_id)

    # Rebuild state from events
    expected_state = {}
    for event in events:
        match event["type"]:
            case "OrderCreated":
                expected_state = event["data"]
            case "OrderUpdated":
                expected_state.update(event["data"])
            case "OrderCancelled":
                expected_state["status"] = "cancelled"

    # Compare with read model
    actual_state = read_model_db.get(entity_id)

    diffs = []
    for key in set(expected_state) | set(actual_state or {}):
        expected = expected_state.get(key)
        actual = (actual_state or {}).get(key)
        if expected != actual:
            diffs.append(f"{key}: expected={expected}, actual={actual}")

    return diffs
```

### Exactly-Once Semantics Challenges

The fundamental problem: CDC pipelines can produce duplicates or lose events at failure boundaries.

| Failure Mode | Effect on Validation | Mitigation |
|---|---|---|
| Connector crash before offset commit | Duplicate events replayed | Idempotent consumers + dedup on primary key |
| Kafka broker failure during replication | Events lost if `acks=1` | Use `acks=all` + `min.insync.replicas=2` |
| Consumer crash after processing, before commit | Duplicate processing | Exactly-once consumer groups (Kafka Streams) |
| Schema evolution mid-stream | Deserialization failure | Schema Registry with compatibility checks |
| Replication slot overflow (Postgres) | WAL segments recycled, events lost | Monitor `pg_replication_slots`, set `max_slot_wal_keep_size` |

**Kafka exactly-once configuration:**
```properties
# Producer
enable.idempotence=true
transactional.id=cdc-validator-001
acks=all
max.in.flight.requests.per.connection=5

# Consumer
isolation.level=read_committed
enable.auto.commit=false
```

**Debezium offset tracking validation:**
```sql
-- Check for gaps in Postgres LSN sequence
-- (indicates potentially lost CDC events)
SELECT
    slot_name,
    confirmed_flush_lsn,
    pg_current_wal_lsn() AS current_lsn,
    pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn) AS lag_bytes
FROM pg_replication_slots
WHERE slot_name = 'debezium';

-- Alert if lag_bytes > threshold (e.g., 1 GB)
```

### Detecting Data Loss/Corruption via CDC Logs

**Sequence gap detection:**
```python
class CDCSequenceValidator:
    """Detect gaps in CDC event sequences that indicate data loss."""

    def __init__(self):
        self.last_seen_lsn: dict[str, int] = {}  # per-table
        self.gaps: list[dict] = []

    def validate_event(self, event: dict) -> bool:
        table = event["source"]["table"]
        lsn = event["source"]["lsn"]

        if table in self.last_seen_lsn:
            expected_next = self.last_seen_lsn[table]
            if lsn > expected_next + 1:
                self.gaps.append({
                    "table": table,
                    "expected_lsn": expected_next + 1,
                    "actual_lsn": lsn,
                    "gap_size": lsn - expected_next - 1,
                    "timestamp": event["source"]["ts_ms"],
                })
                return False

        self.last_seen_lsn[table] = lsn
        return True
```

**Transaction boundary validation** — ensure all rows in a transaction arrive together:
```python
def validate_transaction_completeness(
    events: list[dict],
    expected_tx_sizes: dict[int, int],
) -> list[int]:
    """Check that all events within each transaction ID are present."""
    tx_counts: dict[int, int] = defaultdict(int)
    for event in events:
        tx_id = event["source"]["txId"]
        tx_counts[tx_id] += 1

    incomplete = []
    for tx_id, expected in expected_tx_sizes.items():
        if tx_counts.get(tx_id, 0) != expected:
            incomplete.append(tx_id)
    return incomplete
```

---

## 2. Streaming Validation Patterns

### Real-Time Data Quality Monitoring

#### Great Expectations + Streaming

Great Expectations added experimental streaming support via its `RuntimeBatchRequest`. The pattern: validate micro-batches as they arrive.

```python
import great_expectations as gx
from great_expectations.core.batch import RuntimeBatchRequest
import pandas as pd

context = gx.get_context()

def validate_micro_batch(batch_df: pd.DataFrame, suite_name: str) -> dict:
    """Validate a streaming micro-batch against an expectation suite."""
    batch_request = RuntimeBatchRequest(
        datasource_name="streaming_source",
        data_connector_name="runtime_connector",
        data_asset_name="micro_batch",
        runtime_parameters={"batch_data": batch_df},
        batch_identifiers={"batch_id": str(pd.Timestamp.now())},
    )

    results = context.run_checkpoint(
        checkpoint_name="streaming_checkpoint",
        batch_request=batch_request,
        expectation_suite_name=suite_name,
    )

    return {
        "success": results.success,
        "statistics": results.statistics,
        "failed_expectations": [
            r.expectation_config.expectation_type
            for r in results.results
            if not r.success
        ],
    }
```

#### Soda Core Streaming (Programmatic API)

```python
from soda.core.scan import Scan

def soda_validate_batch(batch_df, checks_yaml: str):
    """Run Soda checks against a streaming batch."""
    scan = Scan()
    scan.set_data_source_name("batch")
    scan.add_pandas_dataframe(dataset_name="events", pandas_df=batch_df)
    scan.add_sodacl_yaml_str(checks_yaml)
    scan.execute()

    return {
        "has_failures": scan.has_check_fails(),
        "results": scan.get_checks_fail(),
    }

# Example checks
STREAMING_CHECKS = """
checks for events:
  - row_count > 0
  - missing_count(user_id) = 0
  - invalid_count(amount) = 0:
      valid min: 0
  - duplicate_count(event_id) = 0
  - freshness(event_timestamp) < 5m
"""
```

### Watermark-Based Completeness Checks

Watermarks track "how far along" a stream has progressed. They enable completeness validation without waiting for all events.

```python
from datetime import datetime, timedelta, timezone

class WatermarkCompletenessChecker:
    """
    Validate that all expected partitions have been received
    based on event-time watermarks.

    Watermark = max(event_time) - allowed_lateness
    If watermark passes a partition boundary, that partition is "complete."
    """

    def __init__(self, allowed_lateness: timedelta = timedelta(minutes=5)):
        self.allowed_lateness = allowed_lateness
        self.partition_counts: dict[str, int] = defaultdict(int)
        self.max_event_time: datetime = datetime.min.replace(tzinfo=timezone.utc)

    def process_event(self, event_time: datetime, partition_key: str):
        self.partition_counts[partition_key] += 1
        if event_time > self.max_event_time:
            self.max_event_time = event_time

    @property
    def watermark(self) -> datetime:
        return self.max_event_time - self.allowed_lateness

    def get_complete_partitions(self) -> list[str]:
        """Partitions whose time window is fully past the watermark."""
        complete = []
        for partition, count in self.partition_counts.items():
            partition_end = self._partition_end_time(partition)
            if partition_end <= self.watermark:
                complete.append(partition)
        return complete

    def validate_completeness(
        self,
        expected_counts: dict[str, int],
    ) -> dict[str, dict]:
        """Compare actual vs expected counts for complete partitions."""
        results = {}
        for partition in self.get_complete_partitions():
            expected = expected_counts.get(partition, 0)
            actual = self.partition_counts[partition]
            results[partition] = {
                "expected": expected,
                "actual": actual,
                "complete": actual >= expected,
                "deficit": max(0, expected - actual),
            }
        return results

    def _partition_end_time(self, partition_key: str) -> datetime:
        # Parse partition key like "2026-03-13T14:00" to get window end
        dt = datetime.fromisoformat(partition_key).replace(tzinfo=timezone.utc)
        return dt + timedelta(hours=1)  # hourly partitions
```

**Apache Flink watermark validation:**
```java
// Flink: validate completeness using side outputs for late data
SingleOutputStreamOperator<Event> mainStream = source
    .assignTimestampsAndWatermarks(
        WatermarkStrategy.<Event>forBoundedOutOfOrderness(Duration.ofMinutes(5))
            .withTimestampAssigner((event, ts) -> event.getTimestamp())
    )
    .process(new ProcessFunction<Event, Event>() {
        @Override
        public void processElement(Event event, Context ctx, Collector<Event> out) {
            if (event.getTimestamp() < ctx.timerService().currentWatermark()) {
                // Late event — route to side output for validation
                ctx.output(lateEventsTag, event);
            } else {
                out.collect(event);
            }
        }
    });

// Count late events per window for data quality monitoring
DataStream<LateEventMetric> lateMetrics = mainStream
    .getSideOutput(lateEventsTag)
    .keyBy(Event::getPartition)
    .window(TumblingEventTimeWindows.of(Time.hours(1)))
    .aggregate(new CountAggregator());
```

### Window-Based Validation

#### Tumbling Windows (Non-Overlapping)
```sql
-- Kafka Streams / ksqlDB: Validate row counts per 1-hour tumbling window
CREATE TABLE validation_counts AS
SELECT
    source_table,
    WINDOWSTART AS window_start,
    WINDOWEND AS window_end,
    COUNT(*) AS event_count,
    COUNT_DISTINCT(primary_key) AS distinct_keys,
    COUNT(*) - COUNT_DISTINCT(primary_key) AS duplicate_count
FROM cdc_events
WINDOW TUMBLING (SIZE 1 HOUR)
GROUP BY source_table
EMIT FINAL;  -- Emit only when window closes (after watermark)
```

#### Sliding Windows (Overlapping)
```sql
-- Detect sudden drops in event rate (anomaly detection)
CREATE TABLE rate_anomalies AS
SELECT
    source_table,
    WINDOWSTART AS window_start,
    COUNT(*) AS current_rate,
    -- Compare with previous window
    LAG(COUNT(*), 1) OVER (PARTITION BY source_table ORDER BY WINDOWSTART) AS prev_rate
FROM cdc_events
WINDOW HOPPING (SIZE 10 MINUTES, ADVANCE BY 1 MINUTE)
GROUP BY source_table
HAVING current_rate < prev_rate * 0.5;  -- >50% drop = anomaly
```

#### Session Windows (Gap-Based)
```python
# Validate that data loading sessions complete within expected bounds
class SessionValidator:
    """Detect incomplete loading sessions based on event gaps."""

    def __init__(self, session_gap: timedelta = timedelta(minutes=5)):
        self.session_gap = session_gap
        self.sessions: list[dict] = []
        self.current_session_start: datetime | None = None
        self.current_session_end: datetime | None = None
        self.current_count: int = 0

    def process(self, event_time: datetime):
        if (
            self.current_session_end is None
            or event_time - self.current_session_end > self.session_gap
        ):
            # Close previous session
            if self.current_session_start:
                self.sessions.append({
                    "start": self.current_session_start,
                    "end": self.current_session_end,
                    "count": self.current_count,
                    "duration": self.current_session_end - self.current_session_start,
                })
            # Start new session
            self.current_session_start = event_time
            self.current_count = 0

        self.current_session_end = event_time
        self.current_count += 1
```

### Backpressure and Late-Arriving Data

**Late data handling strategies for validation:**

| Strategy | Tradeoff | When to Use |
|---|---|---|
| Drop late events | Validation may under-count | Real-time dashboards |
| Wait with allowed lateness | Higher latency, better accuracy | Financial reconciliation |
| Side-output late events | Separate late validation pass | Best of both worlds |
| Retract-and-update | Complex, accurate | Event sourcing systems |

```python
class LateArrivalTracker:
    """Track late-arriving data impact on validation accuracy."""

    def __init__(self, allowed_lateness: timedelta):
        self.allowed_lateness = allowed_lateness
        self.total_events = 0
        self.late_events = 0
        self.very_late_events = 0  # > 2x allowed lateness

    def record(self, event_time: datetime, processing_time: datetime):
        self.total_events += 1
        lateness = processing_time - event_time

        if lateness > self.allowed_lateness:
            self.late_events += 1
        if lateness > self.allowed_lateness * 2:
            self.very_late_events += 1

    @property
    def late_ratio(self) -> float:
        return self.late_events / max(1, self.total_events)

    def should_revalidate(self) -> bool:
        """If >5% of events are late, trigger a batch revalidation."""
        return self.late_ratio > 0.05
```

---

## 3. Delta/Incremental Validation

### Delta Lake Change Data Feed (CDF)

Delta Lake's CDF tracks row-level changes (insert, update_preimage, update_postimage, delete) starting from version N.

```sql
-- Enable CDF on a Delta table
ALTER TABLE orders SET TBLPROPERTIES (delta.enableChangeDataFeed = true);

-- Read changes since last validation
SELECT *
FROM table_changes('orders', 5)  -- from version 5
ORDER BY _commit_version, _change_type;

-- Incremental validation: compare changes with target
WITH source_changes AS (
    SELECT *, _change_type, _commit_version, _commit_timestamp
    FROM table_changes('source_db.orders', 5)
    WHERE _change_type IN ('insert', 'update_postimage')
),
target_state AS (
    SELECT * FROM target_db.orders
    WHERE updated_at >= '2026-03-12T00:00:00'
)
SELECT
    s.order_id,
    s._change_type,
    CASE
        WHEN t.order_id IS NULL THEN 'missing_in_target'
        WHEN hash(s.*) != hash(t.*) THEN 'value_mismatch'
        ELSE 'ok'
    END AS validation_status
FROM source_changes s
LEFT JOIN target_state t ON s.order_id = t.order_id;
```

```python
# PySpark: Incremental validation with CDF
from delta.tables import DeltaTable

def validate_incremental_changes(
    spark,
    source_table: str,
    target_table: str,
    from_version: int,
) -> dict:
    """Validate only changed rows since last validation checkpoint."""
    changes = (
        spark.read
        .format("delta")
        .option("readChangeFeed", "true")
        .option("startingVersion", from_version)
        .table(source_table)
    )

    # Only validate inserts and updates (deletes handled separately)
    new_or_updated = changes.filter(
        changes._change_type.isin("insert", "update_postimage")
    ).drop("_change_type", "_commit_version", "_commit_timestamp")

    target = spark.table(target_table)

    # Anti-join: find rows in source changes missing from target
    missing = new_or_updated.join(
        target,
        on="order_id",
        how="left_anti",
    )

    return {
        "changes_count": changes.count(),
        "missing_in_target": missing.count(),
        "current_version": DeltaTable.forName(spark, source_table).history(1)
            .select("version").first()[0],
    }
```

### Apache Iceberg Incremental Scan

Iceberg tracks snapshots and provides incremental reads between snapshot IDs.

```sql
-- Iceberg: Read only changes between snapshots
SELECT *
FROM orders.snapshots
ORDER BY committed_at DESC
LIMIT 5;

-- Incremental scan (Spark SQL)
SELECT *
FROM orders
WHERE _snapshot_id BETWEEN 123456789 AND 987654321;

-- Iceberg metadata tables for validation
SELECT
    snapshot_id,
    committed_at,
    summary['added-records'] AS added,
    summary['deleted-records'] AS deleted,
    summary['changed-partition-count'] AS changed_partitions
FROM orders.snapshots
ORDER BY committed_at DESC;
```

```python
# PyIceberg: Incremental validation
from pyiceberg.catalog import load_catalog

catalog = load_catalog("glue")
table = catalog.load_table("db.orders")

def get_changed_partitions(
    table,
    from_snapshot: int,
    to_snapshot: int,
) -> set[str]:
    """Identify which partitions changed between two snapshots."""
    changed = set()
    for snapshot in table.history():
        if from_snapshot < snapshot.snapshot_id <= to_snapshot:
            for manifest in snapshot.manifests(table.io):
                for entry in manifest.fetch_manifest_entry(table.io):
                    partition_value = entry.data_file.partition
                    changed.add(str(partition_value))
    return changed

def validate_changed_partitions_only(
    source_table,
    target_table,
    from_snapshot: int,
    to_snapshot: int,
):
    """Only validate partitions that changed — skip unchanged ones."""
    changed_partitions = get_changed_partitions(
        source_table, from_snapshot, to_snapshot
    )

    results = {}
    for partition in changed_partitions:
        source_scan = source_table.scan(
            row_filter=f"partition_col = '{partition}'"
        )
        # Compare with target...
        results[partition] = {"status": "validated"}

    return {
        "total_partitions": source_table.spec().fields_count,
        "validated_partitions": len(changed_partitions),
        "skipped_partitions": source_table.spec().fields_count - len(changed_partitions),
        "results": results,
    }
```

### dbt `state:modified` for Incremental Validation

dbt's state comparison enables validating only models that changed since last run:

```bash
# Run only modified models and their downstream dependencies
dbt run --select state:modified+

# List models that need revalidation
dbt ls --select state:modified+ --resource-type model
```

```python
# Programmatic: determine which tables need revalidation
import json

def get_modified_models(
    manifest_path: str,
    previous_manifest_path: str,
) -> list[str]:
    """Compare dbt manifests to find modified models."""
    with open(manifest_path) as f:
        current = json.load(f)
    with open(previous_manifest_path) as f:
        previous = json.load(f)

    modified = []
    for node_id, node in current["nodes"].items():
        if node["resource_type"] != "model":
            continue
        prev_node = previous["nodes"].get(node_id)
        if not prev_node:
            modified.append(node["relation_name"])
            continue
        if node["checksum"]["checksum"] != prev_node["checksum"]["checksum"]:
            modified.append(node["relation_name"])

    return modified

# Use with reladiff: only diff tables whose dbt models changed
# tables_to_validate = get_modified_models("target/manifest.json", "prev/manifest.json")
```

### Partition-Aware Incremental Checksums

The most practical pattern for Reladiff: checksum per partition, compare only changed partitions.

```sql
-- Snowflake: Partition-level checksums for incremental validation
WITH source_checksums AS (
    SELECT
        DATE_TRUNC('day', created_at) AS partition_day,
        COUNT(*) AS row_count,
        HASH_AGG(*) AS checksum
    FROM source_db.orders
    GROUP BY 1
),
target_checksums AS (
    SELECT
        DATE_TRUNC('day', created_at) AS partition_day,
        COUNT(*) AS row_count,
        HASH_AGG(*) AS checksum
    FROM target_db.orders
    GROUP BY 1
)
SELECT
    COALESCE(s.partition_day, t.partition_day) AS partition_day,
    s.row_count AS source_rows,
    t.row_count AS target_rows,
    CASE
        WHEN s.checksum IS NULL THEN 'missing_in_source'
        WHEN t.checksum IS NULL THEN 'missing_in_target'
        WHEN s.checksum != t.checksum THEN 'data_mismatch'
        ELSE 'match'
    END AS status
FROM source_checksums s
FULL OUTER JOIN target_checksums t ON s.partition_day = t.partition_day
WHERE s.checksum IS DISTINCT FROM t.checksum
ORDER BY partition_day DESC;
```

### Time-Travel Based Validation

#### Snowflake Time Travel

```sql
-- Compare current state with state from 1 hour ago
SELECT
    'current' AS version,
    COUNT(*) AS row_count,
    HASH_AGG(*) AS checksum
FROM orders

UNION ALL

SELECT
    '1h_ago' AS version,
    COUNT(*) AS row_count,
    HASH_AGG(*) AS checksum
FROM orders AT (OFFSET => -3600);

-- Find rows that changed in the last hour
SELECT current.*, '___CHANGED___'
FROM orders AS current
EXCEPT
SELECT previous.*, '___CHANGED___'
FROM orders AT (OFFSET => -3600) AS previous;

-- Validate a specific statement's effect
-- (using query ID from the ETL job)
SELECT COUNT(*) AS rows_affected
FROM orders
CHANGES (INFORMATION => APPEND_ONLY)
AT (STATEMENT => '01b2f3a4-0001-5678-0000-00000000abcd');
```

#### BigQuery Time Travel

```sql
-- BigQuery: Compare table at two points in time
SELECT
    'current' AS version,
    COUNT(*) AS row_count,
    FARM_FINGERPRINT(TO_JSON_STRING(t)) AS checksum
FROM `project.dataset.orders` t

UNION ALL

SELECT
    '1h_ago' AS version,
    COUNT(*) AS row_count,
    FARM_FINGERPRINT(TO_JSON_STRING(t)) AS checksum
FROM `project.dataset.orders`
    FOR SYSTEM_TIME AS OF TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 HOUR) t;

-- BigQuery INFORMATION_SCHEMA for change tracking
SELECT
    table_name,
    total_rows,
    total_logical_bytes,
    TIMESTAMP_MILLIS(last_modified_time) AS last_modified
FROM `project.dataset.INFORMATION_SCHEMA.TABLE_STORAGE`
WHERE table_name = 'orders';
```

#### Iceberg Time Travel

```sql
-- Iceberg (Spark SQL): Compare snapshots
SELECT COUNT(*), hash(*) FROM orders VERSION AS OF 123456789;
SELECT COUNT(*), hash(*) FROM orders VERSION AS OF 987654321;

-- Iceberg: List all snapshots with metadata
SELECT * FROM orders.history;

-- Iceberg: Rollback to known-good snapshot if validation fails
CALL system.rollback_to_snapshot('db.orders', 123456789);
```

---

## 4. Log-Based Validation

### PostgreSQL WAL (Write-Ahead Log)

PostgreSQL's WAL is the foundation for CDC. Logical decoding exposes row-level changes.

```sql
-- Create a replication slot for validation
SELECT pg_create_logical_replication_slot('validation_slot', 'pgoutput');

-- Read changes from the slot (non-consuming peek)
SELECT * FROM pg_logical_slot_peek_changes(
    'validation_slot',
    NULL,  -- start LSN (NULL = from current position)
    NULL,  -- upto_nchanges (NULL = all available)
    'proto_version', '1',
    'publication_names', 'validation_pub'
);

-- Monitor replication slot lag (bytes behind)
SELECT
    slot_name,
    confirmed_flush_lsn,
    pg_current_wal_lsn(),
    pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn) AS lag_bytes
FROM pg_replication_slots;

-- Create publication for specific tables
CREATE PUBLICATION validation_pub FOR TABLE orders, accounts, transactions;
```

**Python WAL consumer for validation:**
```python
import psycopg2
from psycopg2.extras import LogicalReplicationConnection

def stream_wal_changes(dsn: str, slot_name: str, publication: str):
    """Stream WAL changes for real-time validation."""
    conn = psycopg2.connect(dsn, connection_factory=LogicalReplicationConnection)
    cursor = conn.cursor()

    # Start replication
    cursor.start_replication(
        slot_name=slot_name,
        decode=True,
        options={
            "proto_version": "1",
            "publication_names": publication,
        },
    )

    class WALHandler:
        def __init__(self):
            self.changes: list[dict] = []

        def __call__(self, msg):
            payload = msg.payload
            self.changes.append({
                "lsn": msg.data_start,
                "payload": payload,
            })
            msg.cursor.send_feedback(flush_lsn=msg.data_start)

    handler = WALHandler()
    cursor.consume_stream(handler)
    return handler.changes
```

### MySQL Binlog Validation

```python
from pymysqlreplication import BinLogStreamReader
from pymysqlreplication.row_event import (
    WriteRowsEvent,
    UpdateRowsEvent,
    DeleteRowsEvent,
)

def validate_binlog_changes(
    mysql_settings: dict,
    target_conn,
    tables: list[str],
    from_position: int,
) -> dict:
    """Read MySQL binlog and validate changes exist in target."""
    stream = BinLogStreamReader(
        connection_settings=mysql_settings,
        server_id=100,
        blocking=False,
        only_events=[WriteRowsEvent, UpdateRowsEvent, DeleteRowsEvent],
        only_tables=tables,
        resume_stream=True,
        log_pos=from_position,
    )

    mismatches = []
    total_events = 0

    for event in stream:
        total_events += 1
        for row in event.rows:
            if isinstance(event, WriteRowsEvent):
                pk = row["values"]["id"]
                target_row = target_conn.execute(
                    f"SELECT * FROM {event.table} WHERE id = %s", (pk,)
                ).fetchone()
                if not target_row:
                    mismatches.append({"type": "missing", "pk": pk})

            elif isinstance(event, UpdateRowsEvent):
                pk = row["after_values"]["id"]
                target_row = target_conn.execute(
                    f"SELECT * FROM {event.table} WHERE id = %s", (pk,)
                ).fetchone()
                if target_row and dict(target_row) != row["after_values"]:
                    mismatches.append({"type": "stale", "pk": pk})

            elif isinstance(event, DeleteRowsEvent):
                pk = row["values"]["id"]
                target_row = target_conn.execute(
                    f"SELECT * FROM {event.table} WHERE id = %s", (pk,)
                ).fetchone()
                if target_row:
                    mismatches.append({"type": "not_deleted", "pk": pk})

    stream.close()
    return {"total_events": total_events, "mismatches": mismatches}
```

### Snowflake Streams

Snowflake STREAMS are the native CDC mechanism — they track DML changes on tables.

```sql
-- Create a stream to track changes
CREATE OR REPLACE STREAM orders_changes ON TABLE orders
    APPEND_ONLY = FALSE;  -- Track all DML (INSERT, UPDATE, DELETE)

-- Query the stream (non-consuming)
SELECT
    *,
    METADATA$ACTION,      -- 'INSERT' or 'DELETE'
    METADATA$ISUPDATE,    -- TRUE if part of an UPDATE
    METADATA$ROW_ID       -- Unique row identifier
FROM orders_changes;

-- Validation: compare stream changes with target
WITH stream_inserts AS (
    SELECT * FROM orders_changes
    WHERE METADATA$ACTION = 'INSERT'
    AND NOT METADATA$ISUPDATE  -- True inserts only, not update pairs
),
target_recent AS (
    SELECT * FROM target_db.orders
    WHERE updated_at >= DATEADD('hour', -1, CURRENT_TIMESTAMP())
)
SELECT
    s.order_id,
    CASE
        WHEN t.order_id IS NULL THEN 'missing_in_target'
        WHEN HASH(s.*) != HASH(t.*) THEN 'value_mismatch'
        ELSE 'ok'
    END AS validation_status
FROM stream_inserts s
LEFT JOIN target_recent t ON s.order_id = t.order_id;

-- Consume the stream (advances the offset)
-- Typically done inside a transaction:
BEGIN;
INSERT INTO validation_log
    SELECT *, CURRENT_TIMESTAMP() AS validated_at
    FROM orders_changes;
COMMIT;

-- Monitor stream staleness
SELECT
    name,
    stale,
    stale_after
FROM TABLE(INFORMATION_SCHEMA.STREAMS())
WHERE name = 'ORDERS_CHANGES';
-- If stale=TRUE, the stream's offset has fallen behind and data is lost!
```

### BigQuery Change History

BigQuery doesn't have native CDC/streams, but provides change tracking via `INFORMATION_SCHEMA` and table snapshots:

```sql
-- BigQuery: Track table modifications
SELECT
    table_name,
    ddl_target_table,
    statement_type,
    start_time,
    user_email,
    total_bytes_processed
FROM `region-us`.INFORMATION_SCHEMA.JOBS
WHERE
    statement_type IN ('INSERT', 'UPDATE', 'DELETE', 'MERGE')
    AND destination_table.table_id = 'orders'
    AND start_time > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 24 HOUR)
ORDER BY start_time DESC;

-- BigQuery: Table snapshot for point-in-time comparison
CREATE SNAPSHOT TABLE orders_snapshot_20260313
    CLONE orders
    FOR SYSTEM_TIME AS OF '2026-03-13 00:00:00 UTC';

-- Compare snapshot with current
SELECT 'current' AS source, COUNT(*) AS cnt FROM orders
UNION ALL
SELECT 'snapshot' AS source, COUNT(*) AS cnt FROM orders_snapshot_20260313;
```

---

## 5. Event Sourcing & CQRS Validation

### Validating Read Models Against Event Stores

In CQRS (Command Query Responsibility Segregation), the write side (event store) is the source of truth, and read models (projections) are derived views. Validation ensures they stay in sync.

```python
class CQRSReconciler:
    """
    Reconcile a read model (e.g., PostgreSQL materialized view)
    against an event store (e.g., EventStoreDB, Kafka topic).
    """

    def __init__(self, event_store, read_model_db):
        self.event_store = event_store
        self.read_model_db = read_model_db

    def rebuild_and_compare(self, aggregate_id: str) -> dict:
        """
        Replay all events for an aggregate and compare with read model.
        This is the gold standard validation — rebuild from scratch.
        """
        events = self.event_store.read_stream(aggregate_id)

        # Rebuild expected state from events
        expected = self._apply_events(events)

        # Fetch actual read model state
        actual = self.read_model_db.get(aggregate_id)

        if expected == actual:
            return {"status": "consistent", "aggregate_id": aggregate_id}

        return {
            "status": "inconsistent",
            "aggregate_id": aggregate_id,
            "expected": expected,
            "actual": actual,
            "diff": self._compute_diff(expected, actual),
            "event_count": len(events),
            "last_event_position": events[-1]["position"] if events else None,
        }

    def sample_validation(self, sample_size: int = 100) -> dict:
        """
        Validate a random sample of aggregates.
        Cost-effective for large systems.
        """
        all_ids = self.read_model_db.get_all_ids()
        import random
        sample = random.sample(all_ids, min(sample_size, len(all_ids)))

        results = {"consistent": 0, "inconsistent": 0, "errors": []}
        for agg_id in sample:
            result = self.rebuild_and_compare(agg_id)
            if result["status"] == "consistent":
                results["consistent"] += 1
            else:
                results["inconsistent"] += 1
                results["errors"].append(result)

        return results

    def _apply_events(self, events: list[dict]) -> dict:
        state = {}
        for event in events:
            handler = getattr(self, f"_handle_{event['type']}", None)
            if handler:
                state = handler(state, event["data"])
        return state
```

### Saga Pattern Validation Across Microservices

Sagas coordinate distributed transactions. Validation ensures all steps completed:

```python
class SagaValidator:
    """
    Validate distributed saga completion across microservices.

    A saga like "CreateOrder" involves:
    1. OrderService: Create order
    2. PaymentService: Charge payment
    3. InventoryService: Reserve stock
    4. ShippingService: Create shipment

    Each step emits an event. Validation = all steps completed.
    """

    EXPECTED_STEPS = {
        "CreateOrder": [
            "OrderCreated",
            "PaymentCharged",
            "StockReserved",
            "ShipmentCreated",
        ],
        "CancelOrder": [
            "OrderCancelled",
            "PaymentRefunded",
            "StockReleased",
            "ShipmentCancelled",
        ],
    }

    def validate_saga(
        self,
        saga_id: str,
        saga_type: str,
        events: list[dict],
        max_age_minutes: int = 60,
    ) -> dict:
        expected = self.EXPECTED_STEPS.get(saga_type, [])
        actual_types = {e["type"] for e in events}

        missing = [s for s in expected if s not in actual_types]
        unexpected = [t for t in actual_types if t not in expected]

        # Check for timeout (saga started but not completed)
        first_event_time = min(e["timestamp"] for e in events) if events else None
        from datetime import datetime, timedelta, timezone
        is_timed_out = (
            first_event_time
            and missing
            and (datetime.now(timezone.utc) - first_event_time)
                > timedelta(minutes=max_age_minutes)
        )

        return {
            "saga_id": saga_id,
            "saga_type": saga_type,
            "complete": len(missing) == 0,
            "missing_steps": missing,
            "unexpected_events": unexpected,
            "timed_out": is_timed_out,
            "step_count": f"{len(actual_types)}/{len(expected)}",
        }
```

### Command-Query Reconciliation

```sql
-- Reconciliation query: Compare event store counts with read model counts
-- This runs periodically (e.g., every 5 minutes) to detect drift

WITH event_store_summary AS (
    SELECT
        aggregate_type,
        COUNT(DISTINCT aggregate_id) AS event_aggregates,
        MAX(event_position) AS latest_position,
        MAX(created_at) AS latest_event_time
    FROM events
    GROUP BY aggregate_type
),
read_model_summary AS (
    SELECT
        'Order' AS aggregate_type,
        COUNT(*) AS read_model_count
    FROM orders_read_model
    UNION ALL
    SELECT
        'Customer' AS aggregate_type,
        COUNT(*) AS read_model_count
    FROM customers_read_model
)
SELECT
    e.aggregate_type,
    e.event_aggregates,
    r.read_model_count,
    e.event_aggregates - r.read_model_count AS drift,
    e.latest_event_time,
    CASE
        WHEN ABS(e.event_aggregates - r.read_model_count) > 10 THEN 'ALERT'
        WHEN ABS(e.event_aggregates - r.read_model_count) > 0 THEN 'WARN'
        ELSE 'OK'
    END AS status
FROM event_store_summary e
LEFT JOIN read_model_summary r ON e.aggregate_type = r.aggregate_type;
```

---

## 6. Production Patterns from Companies

### Netflix: Change Data Capture with Delta

Netflix built **Delta** (not to be confused with Delta Lake), a CDC platform that captures changes from MySQL, PostgreSQL, and Cassandra.

**Architecture:**
```
MySQL/PG binlog → Delta Connector → Kafka → Delta Processors → Elasticsearch/Iceberg
                                                    │
                                              Validation Layer
                                     (compare event counts, checksums)
```

Key validation patterns:
- **Event counting**: Track events per source transaction and verify all arrive at destination. Delta uses Kafka exactly-once semantics with transactional producers.
- **Heartbeat tables**: A dedicated table receives a write every N seconds. If heartbeats stop appearing in the CDC stream, the pipeline is broken.
- **Shadow traffic**: During migrations, run both old and new pipelines in parallel. Compare outputs using a reconciliation framework (similar to Scientist pattern).

Reference: [Netflix Tech Blog: "Delta: A Data Synchronization and Enrichment Platform" (2019)](https://netflixtechblog.com/delta-a-data-synchronization-and-enrichment-platform-e82c36a79c4d)

### Uber: DBEvents and Schemaless CDC

Uber's **DBEvents** captures changes from Schemaless (their MySQL-backed key-value store):

- **Dual-path validation**: Changes flow through both CDC and direct database reads. A reconciliation service compares the two paths.
- **Per-datacenter checksums**: Each datacenter computes hourly checksums. Cross-datacenter comparison detects replication issues.
- **LedgerStore validation**: For financial data, every CDC event is checksummed and stored in an immutable ledger. Periodic full-table scans validate the ledger against the source.

Reference: [Uber Engineering: "Real-Time Data Infrastructure at Uber" (2023)](https://www.uber.com/blog/real-time-data-infrastructure-at-uber/)

**Uber's row-level checksum pattern:**
```python
# Simplified version of Uber's per-row validation
import hashlib

def compute_row_checksum(row: dict, key_cols: list[str]) -> str:
    """
    Compute deterministic checksum for a row.
    Uber computes this on both CDC event and target read,
    then compares.
    """
    sorted_values = [str(row.get(k, "")) for k in sorted(row.keys())]
    return hashlib.sha256("|".join(sorted_values).encode()).hexdigest()

def validate_cdc_event_against_target(
    cdc_event: dict,
    target_row: dict,
    key_cols: list[str],
) -> bool:
    """Compare CDC event checksum with target row checksum."""
    source_hash = compute_row_checksum(cdc_event["after"], key_cols)
    target_hash = compute_row_checksum(target_row, key_cols)
    return source_hash == target_hash
```

### LinkedIn: ValiData and Brooklin

LinkedIn's **Brooklin** is their CDC transport layer, and **ValiData** is their validation framework:

- **Audit trails**: Every CDC event gets a monotonically increasing sequence number. ValiData checks for gaps.
- **Cross-cluster validation**: Run HASH_AGG on source and target clusters, compare. Mismatches trigger row-level investigation.
- **Delayed validation**: Allow N minutes for eventual consistency, then validate. Most "diffs" resolve within the delay window.
- **Tiered validation** (from Theme A): ~85% of validation effort eliminated by starting with counts, then checksums, then row-level only for mismatches.

Reference: [LinkedIn Engineering: "Brooklin: Near Real-Time Data Streaming at Scale" (2019)](https://engineering.linkedin.com/blog/2019/brooklin-open-source)

### Airbnb: Real-Time Data Quality Monitoring

Airbnb's **Minerva** (metrics platform) and **Dataportal** include real-time DQ monitoring:

- **SLA monitoring**: Each critical dataset has an SLA (e.g., "orders table updated within 1 hour of event"). Alerts fire on breach.
- **Schema change detection**: CDC events compared against expected schema. Unexpected column additions/removals trigger alerts before data lands.
- **Freshness watermarks**: Track `MAX(event_timestamp)` per table. If it stops advancing, the pipeline is stale.

```sql
-- Airbnb-style freshness monitoring
-- (adapted from their public talks)
SELECT
    table_name,
    MAX(event_timestamp) AS latest_event,
    CURRENT_TIMESTAMP() - MAX(event_timestamp) AS staleness,
    CASE
        WHEN CURRENT_TIMESTAMP() - MAX(event_timestamp) > INTERVAL '1 hour'
            THEN 'SLA_BREACH'
        WHEN CURRENT_TIMESTAMP() - MAX(event_timestamp) > INTERVAL '30 minutes'
            THEN 'WARNING'
        ELSE 'OK'
    END AS status
FROM data_quality_watermarks
GROUP BY table_name;
```

Reference: [Airbnb Engineering: "Data Quality at Airbnb" (2022)](https://medium.com/airbnb-engineering)

### Stripe: Dual-Write Verification with Scientist

Stripe uses GitHub's [Scientist](https://github.com/github/scientist) library for safe migrations:

```ruby
# Stripe's pattern (Ruby, their primary language):
# Run both old and new code paths, compare results, use old path's result
science "migration/payment-processor" do |experiment|
  experiment.use { old_payment_service.charge(amount) }       # control
  experiment.try { new_payment_service.charge(amount) }       # candidate

  experiment.compare do |control, candidate|
    control.amount == candidate.amount &&
    control.status == candidate.status &&
    control.customer_id == candidate.customer_id
  end

  # Mismatches are logged, not raised — users always get the control result
  experiment.on_mismatch do |result|
    StatsD.increment("scientist.payment.mismatch")
    Logging.log_mismatch(
      control: result.control.value,
      candidate: result.candidate.value,
    )
  end
end
```

**Python equivalent for data pipeline validation:**
```python
class PipelineScientist:
    """
    Run old and new pipeline logic in parallel.
    Compare outputs. Use old pipeline's result.
    Log mismatches for investigation.
    """

    def __init__(self, experiment_name: str):
        self.experiment_name = experiment_name
        self.mismatches = 0
        self.total = 0

    def run(
        self,
        control_fn,   # Old pipeline
        candidate_fn,  # New pipeline
        compare_fn=None,
    ):
        self.total += 1
        control_result = control_fn()
        candidate_result = candidate_fn()

        comparator = compare_fn or (lambda a, b: a == b)
        if not comparator(control_result, candidate_result):
            self.mismatches += 1
            self._log_mismatch(control_result, candidate_result)

        return control_result  # Always return control

    def _log_mismatch(self, control, candidate):
        # In production: emit to metrics system
        print(f"[{self.experiment_name}] Mismatch: "
              f"control={control}, candidate={candidate}")

    @property
    def mismatch_rate(self) -> float:
        return self.mismatches / max(1, self.total)
```

---

## 7. Implications for Reladiff

### What Reladiff Already Handles

Reladiff is a static table comparison tool (point-in-time diff). Current capabilities:

| Capability | Status |
|---|---|
| Full table comparison across databases | Supported |
| Row-level diff with primary key matching | Supported |
| Cross-database type coercion | Supported (see Theme B) |
| Checksum-based fast comparison | Supported (HASH_AGG) |
| Sampling for large tables | Supported |

### What CDC/Streaming Could Enable

#### Tier 1: Incremental Diff (Highest Value, Moderate Effort)

**Snowflake STREAMS integration:**
```python
# Proposed API for incremental validation
from reladiff import IncrementalDiff

diff = IncrementalDiff(
    source=SnowflakeConnection(...),
    target=PostgresConnection(...),
    table="orders",
)

# First run: full diff, creates a Snowflake STREAM
result = diff.run()
# Returns: full diff result + saves checkpoint

# Subsequent runs: diff only changed rows
result = diff.run()
# Internally:
#   1. Read STREAM for changes since last checkpoint
#   2. Query target for matching PKs
#   3. Compare only changed rows
#   4. Advance STREAM offset
```

**Partition-level change tracking:**
```python
# Proposed: partition-aware incremental checksums
from reladiff import PartitionDiff

diff = PartitionDiff(
    source=SnowflakeConnection(...),
    target=BigQueryConnection(...),
    table="orders",
    partition_column="created_date",
    partition_grain="day",
)

# Only validates partitions that changed since last run
result = diff.run(since=last_checkpoint)
# Output:
# {
#     "total_partitions": 365,
#     "checked_partitions": 3,     # Only 3 changed
#     "skipped_partitions": 362,   # Unchanged, skipped
#     "mismatched_partitions": 1,
#     "cost_savings": "99.2%",
# }
```

#### Tier 2: Continuous Validation (High Value, High Effort)

**Continuous diff as a background process:**
```python
# Proposed: long-running validation daemon
from reladiff import ContinuousValidator

validator = ContinuousValidator(
    source=SnowflakeConnection(...),
    target=PostgresConnection(...),
    tables=["orders", "accounts", "transactions"],
    check_interval_minutes=15,
    strategy="partition_checksum",  # or "stream", "time_travel"
)

# Register alert handlers
validator.on_mismatch(lambda result: send_slack_alert(result))
validator.on_sla_breach(lambda table, staleness: page_oncall(table, staleness))

# Run continuously
validator.start()
```

#### Tier 3: CDC-Aware Validation (Future)

**Validate CDC pipeline integrity:**
```python
# Proposed: validate that CDC events were faithfully applied
from reladiff import CDCValidator

validator = CDCValidator(
    source_cdc_topic="debezium.orders",
    target_db=PostgresConnection(...),
    target_table="orders",
)

# Compare each CDC event against target state
report = validator.validate_window(
    from_offset="latest-1000",
    to_offset="latest",
)
# Output:
# {
#     "events_checked": 1000,
#     "applied_correctly": 997,
#     "missing_in_target": 2,
#     "stale_in_target": 1,
#     "lag_p99_ms": 450,
# }
```

### Concrete Features to Consider

**Priority 1 — Ship in v1.x (builds on existing architecture):**

1. **Snowflake STREAMS integration**: Create/consume streams for incremental diff. This is the single highest-value feature — it reduces costs by 95%+ for subsequent runs on the same table.

2. **Partition-level change tracking**: Instead of full-table HASH_AGG, compute per-partition checksums and cache them. Re-validate only partitions whose checksum changed. Works across all databases.

3. **Time-travel diff**: `reladiff diff --at "2026-03-12 00:00:00"` — compare table at a specific historical point. Snowflake (90-day retention), BigQuery (7-day), Iceberg (unlimited snapshots).

4. **Checkpoint persistence**: Store last-validated state (partition checksums, stream offsets, snapshot IDs) so subsequent runs are incremental by default.

**Priority 2 — Ship in v2.x (new capabilities):**

5. **Freshness monitoring**: `reladiff monitor --sla "1 hour"` — continuously check that target tables are fresh relative to source.

6. **dbt integration**: `reladiff diff --dbt-state target/manifest.json` — only validate tables whose dbt models changed since last run.

7. **Iceberg snapshot diff**: Read Iceberg metadata to identify changed partitions without scanning data files.

**Priority 3 — Future (requires streaming infrastructure):**

8. **Kafka CDC validation**: Consume Debezium events and validate they were applied to the target database.

9. **Continuous validation daemon**: Long-running process that periodically validates and alerts on drift.

10. **Saga/pipeline validation**: Validate that multi-step data pipelines completed all stages (extract → transform → load) with no data loss.

### Architecture Decision: Incremental Checkpointing

The key architectural decision for Reladiff is how to persist validation state between runs. Proposed approach:

```python
# Checkpoint schema (stored as JSON alongside the table)
{
    "table": "orders",
    "source": "snowflake://account.region/db/schema",
    "target": "postgresql://host/db/schema",
    "strategy": "partition_checksum",
    "last_validated_at": "2026-03-13T14:00:00Z",
    "partitions": {
        "2026-03-01": {"checksum": "abc123", "row_count": 50000},
        "2026-03-02": {"checksum": "def456", "row_count": 48000},
        "2026-03-13": {"checksum": "ghi789", "row_count": 12000}
    },
    "snowflake_stream": {
        "name": "RELADIFF_ORDERS_STREAM",
        "offset_token": "1710345600000",
        "stale": false
    },
    "iceberg_snapshot_id": 987654321
}
```

This checkpoint enables:
- **Partition skip**: If partition checksum matches cached value, skip it entirely.
- **Stream resume**: Continue from where we left off instead of full scan.
- **Staleness detection**: If checkpoint is too old, fall back to full validation.
- **Cost tracking**: Compare credits used for incremental vs full validation.

### Cost Impact Analysis

| Validation Mode | Rows Scanned | Relative Cost | Latency |
|---|---|---|---|
| Full table diff (current) | 100% | 1x | Minutes-hours |
| Partition checksum (incremental) | 1-5% (changed partitions) | 0.01-0.05x | Seconds |
| Snowflake STREAM diff | <0.1% (changed rows only) | 0.001x | Seconds |
| Time-travel diff (CHANGES clause) | <0.1% | 0.001x | Seconds |
| Count + freshness only | Metadata only | ~0x | Milliseconds |

For a 1-billion-row table with 1% daily change rate:
- Full diff: scans 1B rows, ~$5-50 in Snowflake credits
- Stream-based incremental: scans 10M rows, ~$0.05-0.50
- Partition checksum (365 daily partitions, 3 changed): scans ~30M rows, ~$0.15-1.50

**The investment in incremental validation pays for itself within a few runs on any non-trivial table.**
