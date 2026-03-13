# Theme G: Deterministic Replay & Idempotency Validation

## Research Summary

This document covers deterministic replay, pipeline idempotency verification, time-travel-based validation, shadow pipeline patterns, determinism challenges in SQL, regression testing for data pipelines, and snapshot/golden-file testing. All findings are sourced from engineering blogs, official documentation, conference talks, and community discussions.

---

## 1. Pipeline Idempotency Verification

### Core Definition

An idempotent data pipeline produces the same result whether executed once or multiple times with the same input. This is the single most important property for safe retries, replays, and disaster recovery.

> "Running a data pipeline multiple times with the same input will always produce the same output."
> -- [Start Data Engineering](https://www.startdataengineering.com/post/why-how-idempotent-data-pipeline/)

### Implementation Patterns

#### Delete-Write Pattern (SQL)

The most common approach for batch pipelines: delete existing data for the target partition, then insert fresh results. Use run-specific temporary tables to prevent collisions during concurrent job execution.

```sql
-- Create temp table with transformed data
CREATE TEMP TABLE temp_orders_2024_01_15 AS
SELECT
    order_id,
    customer_id,
    SOME_TRANSFORMATION(amount) AS amount
FROM staging.orders
WHERE order_date = '2024-01-15';

-- Delete existing data for target partition
DELETE FROM analytics.orders
WHERE order_date = '2024-01-15';

-- Insert fresh results
INSERT INTO analytics.orders (order_id, customer_id, amount)
SELECT order_id, customer_id, amount
FROM temp_orders_2024_01_15;

DROP TABLE temp_orders_2024_01_15;
```

Source: [Start Data Engineering](https://www.startdataengineering.com/post/why-how-idempotent-data-pipeline/)

#### Delete-Write Pattern (Python/Spark)

```python
import os
import shutil

def run_pipeline(input_file: str, output_loc: str, run_id: str) -> None:
    output_path = os.path.join(output_loc, run_id)
    if os.path.exists(output_path):
        shutil.rmtree(output_path)  # Remove prior output entirely

    df = pd.read_csv(input_file)
    # ... transformations ...
    df.to_parquet(
        os.path.join(output_loc, run_id),
        partition_cols=["region"]
    )
```

**Key Principle**: Delete only data the pipeline will recreate. Without the `rmtree`, rerunning produces stale data alongside new records when logic changes.

Source: [Start Data Engineering](https://www.startdataengineering.com/post/why-how-idempotent-data-pipeline/)

#### MERGE/UPSERT Pattern

```sql
MERGE INTO target_table AS t
USING staging_table AS s
ON t.id = s.id
WHEN MATCHED THEN
    UPDATE SET t.value = s.value, t.updated_at = s.updated_at
WHEN NOT MATCHED THEN
    INSERT (id, value, updated_at)
    VALUES (s.id, s.value, s.updated_at);
```

If the MERGE runs twice with the same staging data, the result is identical: existing records update to the same values, new records insert once.

Source: [Airbyte - Idempotency in Data Pipelines](https://airbyte.com/data-engineering-resources/idempotency-in-data-pipelines)

#### Overwrite Partition Pattern

The simplest and most reliable idempotency pattern for batch pipelines is to overwrite the entire partition instead of appending rows:

```python
# Spark overwrite mode
df.write.mode("overwrite").partitionBy("date").format("parquet").save(output_path)
```

```sql
-- Snowflake overwrite
INSERT OVERWRITE INTO analytics.daily_orders
SELECT * FROM staging.orders WHERE order_date = '2024-01-15';
```

Source: [ml4devs - Backfilling Historical Data With Idempotent Data Pipelines](https://www.ml4devs.com/what-is/backfilling-data/)

#### Atomic Upsert Pattern (Validation-First)

Stage data first, validate to ensure correctness, then perform an atomic merge/upsert in a single transaction:

```sql
BEGIN TRANSACTION;

-- Stage incoming data
CREATE TEMP TABLE staging_orders AS
SELECT * FROM incoming_data;

-- Validate staged data
SELECT COUNT(*) AS invalid_count
FROM staging_orders
WHERE order_id IS NULL OR amount < 0;
-- If invalid_count > 0, ROLLBACK

-- Atomic upsert
MERGE INTO orders AS target
USING staging_orders AS source
ON target.order_id = source.order_id
WHEN MATCHED THEN UPDATE SET ...
WHEN NOT MATCHED THEN INSERT ...;

COMMIT;
```

Source: [Sportscape Tech - No Key No Trust](https://medium.com/sportscape-tech/no-key-no-trust-how-we-built-idempotent-reliable-data-pipelines-with-validation-and-atomic-d4ccbf71384d)

### Verification: How to Test Idempotency

The simplest idempotency test: **run the pipeline twice intentionally and verify that the target table has the same row count each time**. More thorough verification includes:

1. **Row count equality** between first and second run
2. **Checksum comparison** of all rows after each run
3. **Failure scenario simulation**: kill the pipeline mid-run, restart, verify no duplicates or missing data
4. **Concurrent execution testing**: run two instances simultaneously, verify no conflicts

Source: [ml4devs - Backfilling Historical Data](https://www.ml4devs.com/what-is/backfilling-data/)

### Streaming Idempotency

For streaming systems like Apache Kafka with Flink or Spark Structured Streaming:

- **Stateful deduplication with watermarking**: the watermark tells the system how long to remember event IDs. Setting the watermark too short risks missing duplicates; too long wastes memory.
- **Event IDs must be intrinsic to events**, not generated during processing -- otherwise, replaying the same event produces different IDs and breaks deduplication.
- **Separate data computation from side effect execution**: reprocessing computes the correct state and a separate idempotent reconciliation layer compares computed state to actual external state and emits only the delta.

Source: [System Overflow - Failure Modes & Idempotency](https://www.systemoverflow.com/learn/data-pipelines-orchestration/backfill-strategies/failure-modes-idempotency)

### Airflow Task Retries and Idempotency

Airflow's official best practices documentation gives three concrete recommendations for Task idempotence:

1. **Replace INSERT with UPSERT** to avoid duplicate rows
2. **Avoid volatile functions** (e.g., `NOW()`, `RANDOM()`) when executing critical computations
3. **Never read the latest data** -- read from a specific partition tied to `{{ ds }}` (execution date)

```python
# Airflow DAG with idempotent retry configuration
default_args = {
    'retries': 3,
    'retry_delay': timedelta(minutes=5),
    'retry_exponential_backoff': True,
}

@task
def process_orders(**context):
    # Use execution_date, NOT current time
    partition_date = context['ds']

    # Delete-write: idempotent by design
    engine.execute(f"""
        DELETE FROM analytics.daily_orders
        WHERE order_date = '{partition_date}';

        INSERT INTO analytics.daily_orders
        SELECT * FROM staging.orders
        WHERE order_date = '{partition_date}';
    """)
```

**Best practices for retry configuration:**
- Set retries as a `default_arg` at DAG level, customize per-task only when needed (recommended: ~3 retries)
- Pair exponential backoff with jitter to avoid synchronized retry storms
- Differentiate between transient (timeouts, 500 errors) and permanent (401s, invalid payloads) failures
- Enforce idempotency with unique keys or upserts so replays don't corrupt data
- Atomize tasks: each task should be responsible for one operation that can be re-run independently

Sources:
- [Astronomer - DAG Best Practices](https://www.astronomer.io/docs/learn/dag-best-practices)
- [Airflow Best Practices](https://airflow.apache.org/docs/apache-airflow/stable/best-practices.html)

### Writing Idempotent dbt Tasks for Airflow

When running dbt models from Airflow, the key challenge is avoiding volatile functions. Instead of database functions like `CURRENT_DATE`, use dbt variables with Airflow templating:

```sql
-- dbt model: use variable instead of CURRENT_DATE
SELECT id, customer_id, product_id, price, date_of_sale
FROM sales
WHERE date_of_sale = '{{ var("report_date") }}'
```

```python
# Airflow DAG: pass logical date as dbt variable
dbt_run = DbtRunOperator(
    vars={"report_date": "{{ ds }}"},
)
```

For incremental models, replace `max(event_time)` subqueries with bounded intervals:

```sql
{% if is_incremental() %}
  where event_time >= '{{ var("data_interval_start") }}'
    and event_time < '{{ var("data_interval_end") }}'
{% endif %}
```

Source: [Writing Idempotent dbt Tasks for Airflow](https://tomasfarias.dev/articles/writing-idempotent-dbt-tasks-for-airflow/)

### dbt `--full-refresh` vs Incremental: When They Diverge

Incremental models accumulate drift over time for several reasons:

1. **Logic changes**: If you modify transformation logic, historical rows (transformed with old logic) diverge from new rows (transformed with new logic).
2. **Late-arriving facts**: Loaders miss data that arrives after the incremental cutoff window.
3. **Source mutations**: Manual updates to source tables are never picked up by incremental logic.
4. **Missing `is_incremental()` guard**: A model that is materialized as incremental but has no `is_incremental()` macro will append the results on every execution, breaking idempotency entirely.

> "Due to the imperfection of loaders and the reality of late arriving facts, we can't help but miss some data in-between our incremental runs, and this accumulates."
> -- [dbt Best Practices: Incremental Models In-Depth](https://docs.getdbt.com/best-practices/materializations/4-incremental-models)

**Key distinction**: Full-refresh models are inherently idempotent -- assuming the source data is the same, you get the same result. With incremental models, the data that is loaded depends on the contents of the table, making them state-dependent.

**Mitigation: Scheduled full refreshes and lookback windows.**

```bash
# Weekly full refresh to reset drift
dbt build --full-refresh -s orders

# Daily incremental with lookback window
dbt build -s orders --vars '{"lookback_days": 3}'
```

A lookback window subtracts a few days from `max(updated_at)` to re-process late arrivals:

```sql
-- dbt incremental model with lookback
{{
  config(
    materialized='incremental',
    unique_key='order_id'
  )
}}

SELECT * FROM {{ source('raw', 'orders') }}
{% if is_incremental() %}
WHERE updated_at >= (
    SELECT DATEADD(day, -3, MAX(updated_at))
    FROM {{ this }}
)
{% endif %}
```

Sources:
- [dbt Incremental Models](https://docs.getdbt.com/docs/build/incremental-models)
- [dbt Best Practices: Incremental Models In-Depth](https://docs.getdbt.com/best-practices/materializations/4-incremental-models)
- [Finatext Tech Blog - dbt Incremental Strategy and Idempotency](https://techblog.finatext.com/dbt-incremental-strategy-and-idempotency-877993f48448)

### Dagster Asset Materialization Verification

Dagster tracks both **code versions** and **data versions** to predict whether re-materialization will change the underlying value:

- **Code version**: A string representing the version of the code that computes an asset. If unchanged since last materialization, Dagster can skip redundant computation.
- **Data version**: A string representing the version of the data itself.

```python
from dagster import asset

@asset(code_version="v2")
def daily_revenue(orders):
    """Deterministic asset with explicit code version."""
    return orders.groupby("date")["amount"].sum()
```

When `code_version` changes, Dagster knows it must re-materialize. When it hasn't changed and inputs are the same, it can serve cached results. This is a form of memoized idempotency.

**Asset Checks for Post-Materialization Validation:**

Dagster's Asset Checks validate data quality after materialization, providing pass/fail results with configurable severity levels. Setting `blocking=True` ensures downstream assets are not materialized if the source contains erroneous data.

```python
from dagster import asset_check, AssetCheckResult

@asset_check(asset=daily_revenue, blocking=True)
def check_revenue_positive(context, daily_revenue):
    """Block downstream if revenue contains negative values."""
    invalid = daily_revenue[daily_revenue["amount"] < 0]
    return AssetCheckResult(
        passed=len(invalid) == 0,
        metadata={"invalid_count": len(invalid)},
    )
```

Sources:
- [Dagster - Asset Checks](https://docs.dagster.io/guides/test/asset-checks)
- [Dagster - Data Contracts with Asset Checks](https://docs.dagster.io/guides/test/data-contracts)

---

## 2. Time-Travel Based Validation

Time travel enables before/after comparison of table state without maintaining separate audit tables. Each major platform implements this differently.

### Snowflake Time Travel

Snowflake supports `AT` and `BEFORE` clauses with three reference types: `TIMESTAMP`, `OFFSET`, and `STATEMENT`.

**Key distinction**: `AT` includes changes made by the referenced statement; `BEFORE` references the point immediately preceding statement completion.

#### Before/After Comparison Using Statement ID

```sql
-- Compare table state before and after a specific DML operation
SELECT
    old.id AS old_id,
    new.id AS new_id,
    old.amount AS old_amount,
    new.amount AS new_amount
FROM my_table BEFORE(STATEMENT => '8e5d0ca9-005e-44e6-b858-a8f5b37c5726') AS old
FULL OUTER JOIN my_table AT(STATEMENT => '8e5d0ca9-005e-44e6-b858-a8f5b37c5726') AS new
    ON old.id = new.id
WHERE old.id IS NULL    -- newly inserted rows
   OR new.id IS NULL    -- deleted rows
   OR old.amount != new.amount;  -- modified rows
```

#### Offset-Based Comparison

```sql
-- Compare current state vs 1 hour ago
SELECT
    curr.id,
    curr.status AS current_status,
    hist.status AS status_1hr_ago
FROM my_table AS curr
JOIN my_table AT(OFFSET => -3600) AS hist
    ON curr.id = hist.id
WHERE curr.status != hist.status;
```

#### Timestamp-Based Validation After Pipeline Run

```sql
-- Validate pipeline output by comparing pre-run and post-run state
SELECT
    COUNT(*) AS changed_rows,
    SUM(CASE WHEN pre.id IS NULL THEN 1 ELSE 0 END) AS inserted,
    SUM(CASE WHEN post.id IS NULL THEN 1 ELSE 0 END) AS deleted,
    SUM(CASE WHEN pre.amount != post.amount THEN 1 ELSE 0 END) AS modified
FROM my_table AT(TIMESTAMP => '2024-01-15 08:00:00'::TIMESTAMP_LTZ) AS pre
FULL OUTER JOIN my_table AT(TIMESTAMP => '2024-01-15 09:00:00'::TIMESTAMP_LTZ) AS post
    ON pre.id = post.id;
```

**Retention**: Default 1 day; Enterprise Edition supports up to 90 days.

Source: [Snowflake AT/BEFORE Documentation](https://docs.snowflake.com/en/sql-reference/constructs/at-before)

### BigQuery `FOR SYSTEM_TIME AS OF`

```sql
-- Query table state from 1 hour ago
SELECT * FROM `project.dataset.orders`
FOR SYSTEM_TIME AS OF TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 HOUR);

-- Compare current vs historical state
SELECT
    curr.order_id,
    curr.status AS current_status,
    hist.status AS historical_status
FROM `project.dataset.orders` AS curr
FULL OUTER JOIN `project.dataset.orders`
    FOR SYSTEM_TIME AS OF TIMESTAMP '2024-01-15 08:00:00 UTC' AS hist
    ON curr.order_id = hist.order_id
WHERE curr.status IS DISTINCT FROM hist.status;
```

**Retention**: 7-day time travel window (extendable to 14 days with Enterprise Plus). For longer retention, create explicit table snapshots:

```sql
CREATE SNAPSHOT TABLE `project.dataset.orders_snapshot_20240115`
CLONE `project.dataset.orders`
FOR SYSTEM_TIME AS OF '2024-01-15T08:00:00Z';
```

**Table Decorators (Legacy SQL)**: Support relative (`-3600000` = 1 hour ago in milliseconds) and absolute (epoch milliseconds) time values. CLI recovery uses `bq cp mydataset.mytable@-3600000 mydataset.recovered_table`.

Sources:
- [BigQuery - Access Historical Data](https://docs.cloud.google.com/bigquery/docs/access-historical-data)
- [BigQuery - Time Travel](https://cloud.google.com/bigquery/docs/time-travel)
- [BigQuery - Table Snapshots](https://cloud.google.com/bigquery/docs/table-snapshots-intro)

### Apache Iceberg Snapshot Versioning

Iceberg creates immutable snapshots on every table modification. Every update creates a new snapshot, and you can specify a `snapshot-id` or `timestamp` to query data as it was at any point.

```sql
-- Time-based travel
SELECT * FROM prod.db.orders
FOR TIMESTAMP AS OF TIMESTAMP '2024-01-15 08:00:00';

-- Snapshot-ID-based travel
SELECT * FROM prod.db.orders
FOR VERSION AS OF 10963874102873;

-- Compare two snapshots (Athena syntax)
SELECT
    before_run.*,
    after_run.*
FROM prod.db.orders FOR VERSION AS OF 5487432386996890161 AS before_run
FULL OUTER JOIN prod.db.orders FOR VERSION AS OF 7291048573920184532 AS after_run
    ON before_run.id = after_run.id
WHERE before_run.id IS NULL OR after_run.id IS NULL;
```

Iceberg achieves these capabilities by tracking metadata files (manifests) through point-in-time snapshots and retaining all deltas when the table is modified over time, with each snapshot describing the table's schema, partitions, and files in detail.

Sources:
- [Apache Iceberg - Spark Queries](https://iceberg.apache.org/docs/latest/spark-queries/)
- [AWS Athena - Iceberg Time Travel](https://docs.aws.amazon.com/athena/latest/ug/querying-iceberg-time-travel-and-version-travel-queries.html)

### Delta Lake Version Comparison

Delta Lake uses a transaction log (`_delta_log/`) to track every modification:

```python
# PySpark: Create versioned table
df = spark.range(0, 3)
df.repartition(1).write.format("delta").save("tmp/some_nums")  # Version 0

df = spark.range(8, 11)
df.repartition(1).write.mode("append").format("delta").save("tmp/some_nums")  # Version 1

# Read specific version
spark.read.format("delta").option("versionAsOf", "0").load("tmp/some_nums").show()

# Read by timestamp
spark.read.format("delta").option("timestampAsOf", "2019-01-01").load("tmp/some_nums")

# View table history
from delta.tables import DeltaTable
delta_table = DeltaTable.forPath(spark, "tmp/some_nums")
delta_table.history().select("version", "timestamp", "operation").show(truncate=False)
```

```sql
-- SQL: Query specific version
SELECT * FROM delta.`/path/to/table` VERSION AS OF 2;

-- SQL: Query by timestamp
SELECT count(*) FROM my_table TIMESTAMP AS OF "2019-01-01";

-- View operation history
DESCRIBE HISTORY delta.`/path/to/table`;

-- Compare two versions
SELECT
    v1.id,
    v1.amount AS old_amount,
    v2.amount AS new_amount
FROM delta.`/path/to/table` VERSION AS OF 5 AS v1
FULL OUTER JOIN delta.`/path/to/table` VERSION AS OF 8 AS v2
    ON v1.id = v2.id
WHERE v1.amount != v2.amount
   OR v1.id IS NULL
   OR v2.id IS NULL;
```

Delta Lake implements idempotency through transaction application IDs and version numbering. The `delta.logRetentionDuration` setting controls how long history is kept (default: 30 days).

Sources:
- [Delta Lake - Time Travel](https://delta.io/blog/2023-02-01-delta-lake-time-travel/)
- [Databricks - Delta Lake History](https://docs.databricks.com/en/delta/history.html)

### lakeFS: Git-Like Data Versioning

lakeFS provides Git semantics (branch, commit, merge, diff) directly on object storage, enabling a **Write-Audit-Publish (WAP)** pattern:

1. **Write**: Create a branch, run pipeline on the branch
2. **Audit**: Run data quality checks (hooks) on the branch
3. **Publish**: Merge to main only if checks pass

```python
# lakeFS branch-based validation
import lakefs_client

# Create isolated branch for pipeline run
client.branches.create_branch(
    repository="my-repo",
    branch_creation=BranchCreation(name="pipeline-run-20240115", source="main")
)

# Run pipeline writing to branch...

# Compare branch output vs main
diff = client.refs.diff_refs(
    repository="my-repo",
    left_ref="main",
    right_ref="pipeline-run-20240115"
)

# Only merge if validation passes
if validate(diff):
    client.refs.merge_into_branch(
        repository="my-repo",
        source_ref="pipeline-run-20240115",
        destination_branch="main"
    )
```

lakeFS hooks can enforce data quality gates automatically before merge. Creating a branch doesn't duplicate data but creates an isolated metadata copy -- performs in milliseconds at any scale.

> "Only data that passed these tests will become part of production."

Real-world use case: teams branch exact versions of sensor capture, calibration, and map tiles, then replay the pipeline -- perception to tracking to planner -- compare metrics across commits, fix preprocessing, and merge.

Sources:
- [lakeFS - Write-Audit-Publish for Data Pipelines](https://lakefs.io/blog/wap-for-data-pipelines/)
- [lakeFS - Acceptance Testing for Data Pipelines](https://lakefs.io/blog/acceptance-testing-for-data-pipelines/)
- [lakeFS - Data Reproducibility](https://lakefs.io/blog/reproducibility/)

---

## 3. Shadow Pipeline / Dark Launch Patterns

### Stripe's 4-Phase Online Migration Pattern

Stripe's engineering blog describes their battle-tested approach for migrating hundreds of millions of Subscriptions objects:

**Phase 1 -- Dual Writing**: Write to both old and new tables simultaneously. New subscriptions are recorded in both locations. Backfill historical data using MapReduce on offline database snapshots (via Scalding on Hadoop). Two approaches for existing data:
- **Lazy migration**: Objects copied when updated
- **Batch backfill**: Process all objects requiring migration via MapReduce

**Phase 2 -- Read Path Migration**: Use GitHub's Scientist library to read from both tables and compare results in real-time. If the results don't match, raise an error alerting engineers to the inconsistency. Only after verification does the system read exclusively from the new table.

**Phase 3 -- Write Path Refactoring**: The most challenging phase. Reverse write direction: write to the new store first, then archive to old store. Apply changes incrementally (never more than a few hundred lines at once) with continued Scientist experiments monitoring for data divergence.

**Phase 4 -- Legacy Data Removal**: Stop writing to old table, deprecate it. Accessing deprecated fields triggers explicit failure notifications to prevent accidental usage.

> "All the changes we made were incremental... All changes were highly transparent and observable, and Scientist experiments alerted us as soon as a single piece of data was inconsistent in production."

Source: [Stripe Engineering - Online Migrations at Scale](https://stripe.com/blog/online-migrations)

### GitHub's Scientist Library

Scientist wraps read paths to run both old and new code, compare results, and report mismatches -- all without affecting the response to the user:

```ruby
# Ruby example from github/scientist
require "scientist"

class MyClass
  include Scientist

  def permissions_for(user)
    science "permissions" do |experiment|
      experiment.use { legacy_permissions(user) }     # Control: always returned
      experiment.try { new_permissions(user) }         # Candidate: compared silently

      experiment.compare { |control, candidate|
        control.sort == candidate.sort
      }
    end
  end
end
```

**How it works at runtime:**
- Both code paths run (order randomized to avoid ordering issues)
- Results of control and candidate are compared; differences recorded
- Duration of execution for both blocks recorded
- Result of the control code is returned from the experiment (user never sees candidate)

**Critical constraint**: Scientist is **only safe for read operations**. Candidate code must not write to databases, invalidate caches, or modify state.

The pattern has been ported to 20+ languages: Python (`laboratory`), Java, Go, .NET, etc.

Sources:
- [GitHub Scientist Repository](https://github.com/github/scientist)
- [GitHub Blog - Scientist: Measure Twice, Cut Once](https://github.blog/developer-skills/application-development/scientist/)
- [Flexport Engineering - Using Scientist to Refactor with Confidence](https://flexport.engineering/using-githubs-scientist-library-to-refactor-with-confidence-9d34600edd5e)

### Shadow Table Strategy for Database Migrations

The shadow table strategy follows six phases:

1. **Create shadow table** with the desired schema
2. **Backfill** existing records in controlled chunks
3. **Sync ongoing changes** via triggers or CDC
4. **Verify** shadow matches source (row counts, checksums, deep comparisons)
5. **Cutover** application to shadow table
6. **Cleanup** old table

Two synchronization approaches:

- **Trigger-based**: Runs inside the transaction commit, ensuring atomicity and transactional integrity. When the source commits a change, the trigger automatically applies it to the shadow table.
- **CDC-based**: Captures committed changes from database logs. Decoupled from production load, processes changes asynchronously through event streams like Kafka, with guaranteed ordering and idempotency requirements.

**Validation approach**: Automated comparison framework continuously monitors:
- Row count totals between systems
- Deep object comparisons across sample records
- Checksums for data integrity verification
- Replication lag monitoring to catch pipeline delays

**Key advantage over dual-writes**: Shadow tables using triggers provide stronger consistency guarantees than application-level dual writes, which risk partial failures and race conditions.

Source: [InfoQ - Shadow Table Strategy for Data Migration](https://www.infoq.com/articles/shadow-table-strategy-data-migration/)

### Microsoft's Shadow Testing Playbook

Microsoft's Engineering Fundamentals Playbook describes shadow testing as replicating live production traffic to a candidate environment:

- **Traffic Replication**: Incoming requests sent simultaneously to V-Current and V-Next
- **Response Comparison**: Responses captured and compared via tools like Twitter's Diffy/OpenDiffy
- **Zero User Impact**: Only V-Current responses reach users

| Tool | Purpose | Origin |
|------|---------|--------|
| **Diffy/OpenDiffy** | Response comparison proxy | Twitter/Airbnb/ByteDance |
| **Envoy** | Service proxy with traffic mirroring | Cloud-native ecosystem |
| **Scientist** | Controlled experimentation library | GitHub |
| **Keploy** | API traffic recording and replay | Modern testing platform |
| **McRouter** | Caching layer traffic management | Facebook |

Source: [Microsoft Engineering Playbook - Shadow Testing](https://microsoft.github.io/code-with-engineering-playbook/automated-testing/shadow-testing/)

### LaunchDarkly Migration Flags

LaunchDarkly provides a structured multi-stage migration framework with built-in comparison:

- **Shadow stage**: Initial validation -- start reading data from the new database and compare with the legacy database
- **Dualwrite stage**: Data is read from only the old system but written to both old and new. When data in the new system is identical to the old, proceed to next stage
- **Live stage**: Full cutover to new system

Source: [LaunchDarkly - Performing Multi-Stage Migrations](https://launchdarkly.com/docs/guides/flags/migrations)

### Netflix Data Validation Approaches

Netflix employs multiple complementary validation strategies:

#### Data Canary System (2026)

Netflix built an automated data canary system that validates data transformations using production traffic:
- **Orchestrator** coordinates the flow, ensuring baseline and canary clusters are healthy and version-synchronized
- **Two dedicated service clusters** running continuously: baseline serves the latest production catalog version, canary receives new versions for validation
- Detection in under 10 minutes, blocking bad data from reaching members

Source: [Netflix TechBlog - The Data Canary (Feb 2026)](https://netflixtechblog.medium.com/the-data-canary-how-netflix-validates-catalog-metadata-18b699d58e36)

#### Circuit Breakers for Data (InfoQ Talk)

Netflix's Video Metadata Service uses a single publisher, multiple consumers model. Their validation approach:

**Circuit breaker types:**
- **Integrity checks**: Verify consumers can access data from S3
- **Duplicate detection**: Identify erroneous duplicate objects
- **Object counts**: Monitor critical objects (video counts shouldn't drop 500 to 20 without explanation)
- **Semantic checks**: Business-logic validation (e.g., "videos should have titles")

**Implementation refinements:**
- Dynamic thresholds using percentages rather than absolute numbers
- Business-value weighting (popular content receives stricter validation than test videos)
- Exclusion capabilities to isolate problematic data while maintaining coverage elsewhere
- Knobs for on/off toggling and threshold adjustment

**Data Canary Service (original):**
- Tests new data against old data using representative datasets
- Runs key use cases (e.g., "play a video") with both versions
- Compares performance metrics to detect degradation
- Reduces environmental noise by running paired comparisons

**Staggered deployment:**
- Pushes data to single AWS region first
- Monitors stability signals
- Gradually expands to additional regions
- Reduces blast radius during problematic releases

**Rollback ("Pin/Unpin"):**
- **Pinning**: Rolls data to last stable version when issues emerge
- **Unpin**: Propagates fixed data after debugging

**Key learning**: "Treat data changes like code pushes -- apply equivalent rigor (detection, canaries, staggering, rollback)."

Source: [InfoQ - Crisis to Calm: Story of Data Validation at Netflix](https://www.infoq.com/presentations/data-validation-netflix/)

#### Netflix Queue Data Migration

During the Queue service migration from SimpleDB to Cassandra:
- Queue data returned from both systems was compared
- They tracked the number of requests for which data mismatched
- Within a short span, minimal data mismatch (<0.01%) was found during shadow reads, incremental replication, and consistency checking

Source: [Netflix TechBlog - Queue Data Migration](https://netflixtechblog.com/netflix-queue-data-migration-for-a-high-volume-web-application-76cb64272198)

---

## 4. Determinism Challenges

### Non-Deterministic `ROW_NUMBER()` with Ties

When `ROW_NUMBER()` is partitioned/ordered by non-unique columns, tied rows receive arbitrary row numbers that can change between executions:

```sql
-- NON-DETERMINISTIC: grp + datacol is not unique
SELECT id, grp, datacol,
    ROW_NUMBER() OVER (PARTITION BY grp ORDER BY datacol) AS rn
FROM dbo.T1;

-- Two rows with grp='A', datacol=50 can swap rn values between runs
```

**Fix: Add a unique tiebreaker column.**

```sql
-- DETERMINISTIC: id makes the ordering unique
SELECT id, grp, datacol,
    ROW_NUMBER() OVER (PARTITION BY grp ORDER BY datacol, id) AS rn
FROM dbo.T1;
```

Source: [SQLPerformance - Row Numbers with Nondeterministic Order](https://sqlperformance.com/2019/11/t-sql-queries/row-numbers-with-nondeterministic-order)

#### Deeper Determinism Pitfalls in SQL (Itzik Ben-Gan's Analysis)

A comprehensive analysis of SQL determinism bugs reveals multiple attack surfaces:

**1. OFFSET-FETCH without unique ordering causes rows to appear in multiple pages:**

```sql
-- PROBLEMATIC: Nondeterministic pagination
SELECT orderid, orderdate, custid
FROM Sales.Orders
ORDER BY orderdate DESC
OFFSET 0 ROWS FETCH NEXT 10 ROWS ONLY;

-- SOLUTION: Add tiebreaker for deterministic results
SELECT orderid, orderdate, custid
FROM Sales.Orders
ORDER BY orderdate DESC, orderid DESC
OFFSET 0 ROWS FETCH NEXT 10 ROWS ONLY;
```

**2. CTE references with nondeterministic functions expand independently:**

```sql
-- PROBLEMATIC: Self-pairing employees due to independent ROW_NUMBER() executions
WITH C AS (
  SELECT empid, firstname, lastname,
    ROW_NUMBER() OVER(ORDER BY CHECKSUM(NEWID())) AS n
  FROM HR.Employees
)
SELECT C1.empid, C2.empid
FROM C AS C1 INNER JOIN C AS C2 ON C1.n = C2.n + 1;
-- Result: Some employees pair with themselves because each CTE reference
-- gets expanded separately, producing different row numbers

-- SOLUTION: Persist CTE result to temporary table
SELECT empid, firstname, lastname,
  ROW_NUMBER() OVER(ORDER BY CHECKSUM(NEWID())) AS n
INTO #EmployeesRandom
FROM HR.Employees;
```

**3. CASE expression with nondeterministic functions evaluates multiple times:**

```sql
-- PROBLEMATIC: Can return NULL instead of 'Even' or 'Odd'
SELECT CASE ABS(CHECKSUM(NEWID())) % 2
  WHEN 0 THEN 'Even'
  WHEN 1 THEN 'Odd'
END;
-- Translates to two separate evaluations:
-- WHEN ABS(CHECKSUM(NEWID())) % 2 = 0  -- First evaluation: returns 3 (odd)
-- WHEN ABS(CHECKSUM(NEWID())) % 2 = 1  -- Second evaluation: returns 4 (even)
-- Neither matches -> NULL!

-- SOLUTION: Persist value before CASE logic
DECLARE @RandomValue INT = ABS(CHECKSUM(NEWID())) % 2;
SELECT CASE @RandomValue
  WHEN 0 THEN 'Even'
  WHEN 1 THEN 'Odd'
END;
```

**4. NULLIF with nondeterministic functions also expands to double evaluation:**

```sql
-- PROBLEMATIC: May return 0 instead of 1 or NULL
SELECT NULLIF(ABS(CHECKSUM(NEWID())) % 2, 0);
-- Expands to:
-- CASE WHEN val1 = 0 THEN NULL ELSE val2 END
-- val1 and val2 are different evaluations!

-- SOLUTION: Store intermediate value
DECLARE @Value INT = ABS(CHECKSUM(NEWID())) % 2;
SELECT NULLIF(@Value, 0);
```

**Key takeaways:**
- Always include tiebreaker columns in ORDER BY and window function clauses
- Avoid multiple CTE references when using nondeterministic calculations; use temporary tables
- Persist nondeterministic values in variables or temp tables before using in CASE/NULLIF
- Most nondeterministic functions evaluate once per reference; `NEWID()` is the exception

Source: [SQLPerformance - T-SQL Bugs, Pitfalls, Best Practices: Determinism](https://sqlperformance.com/2019/03/t-sql-queries/bugs-pitfalls-best-practices-determinism)

#### Snowflake-Specific Gotchas

**Query recompilation changes row ordering:** In Snowflake, even seemingly identical queries can produce different `ROW_NUMBER()` results because tweaking the query text (e.g., adding a schema qualifier) causes recompilation, bypassing cached results and changing the execution plan's row ordering.

**`SEQ4()` is not deterministic across warehouses:** The `SEQ4()` function produces different sequences on different warehouses. The same view returned identical results when executed repeatedly on the same warehouse, but varied across different warehouses. Fix: replace `SEQ4()` with `ROW_NUMBER()`.

Source: [bene.haus - Nondeterministic Behaviour of Snowflake](https://www.bene.haus/snowflake_nondeterministic/)

#### Window Function Non-Determinism (General Pattern)

All window functions (`ROW_NUMBER()`, `RANK()`, `DENSE_RANK()`) can be non-deterministic when the ORDER BY clause is incomplete:

```sql
-- PROBLEMATIC: Incomplete ORDER BY
SELECT
  employee_id,
  salary,
  ROW_NUMBER() OVER (ORDER BY department_id) AS row_num
FROM employees;
-- When multiple employees share the same department_id,
-- their row numbers vary between executions

-- CORRECTED: Complete ORDER BY with tiebreaker
SELECT
  employee_id,
  salary,
  ROW_NUMBER() OVER (ORDER BY department_id, employee_id) AS row_num
FROM employees;
```

**Best practice**: Write down the tie rule in plain English and bake the ranking query into a repeatable check with a small test dataset with forced ties that you can run as a regression test.

Source: [Chen Hirsh - SQL Windows Functions Might Be Non-Deterministic](https://chenhirsh.com/sql-windows-functions-might-be-non-deterministic/)

### Floating-Point Aggregation Order Dependence

Floating-point addition is **not associative**: `(a + b) + c != a + (b + c)`. When a database executes `SUM()` in parallel, different workers process rows in different orders, producing different intermediate sums. The final result varies between executions.

**Real-world demonstration from PostgreSQL mailing list:**

```sql
-- First execution
SELECT sum(l_extendedprice::double precision) FROM lineitem;
-- Result: 229577310901.211

-- Second execution (different row ordering due to parallelism)
SELECT sum(l_extendedprice::double precision) FROM lineitem;
-- Result: 229577310901.198
```

The last three decimal places differ purely due to floating-point rounding in different addition orders. The splitting of input during parallel aggregation remains non-deterministic, even when making the aggregation operators of each subplan reproducible.

**Root cause**: Accumulated rounding errors depend on the sequence, so the commutative law does not apply to these errors, and the sequence of rows can change with every parallel execution.

**Academic research** (arXiv 1802.09883) shows that the performance of a deterministic implementation can be faster or only slightly slower than its non-deterministic counterpart, suggesting there is no inherent reason to use nondeterministic approaches.

**Workarounds:**

```sql
-- Option 1: Disable parallel execution
SET max_parallel_workers_per_gather TO 0;

-- Option 2: Use NUMERIC/DECIMAL instead of FLOAT
SELECT sum(l_extendedprice::numeric(18,2)) FROM lineitem;

-- Option 3: Accept the inherent imprecision and use approximate comparison
-- (e.g., abs(a - b) < epsilon)
```

Sources:
- [PostgreSQL Mailing List - Non-deterministic floating point in parallel mode](https://www.postgresql.org/message-id/CAEepm=2n7onP5aeypEYxAxgo0FX4eLRbALajzibkF8JhBKiZEw@mail.gmail.com)
- [InsideSQL - Aggregate Functions on Floats May Be Non-Deterministic](https://www.insidesql.org/blogs/holgerschmeling/2010/11/02/did-you-know-aggregate-functions-on-floats-may-be-non-deterministic)
- [arXiv - Reproducible Floating-Point Aggregation in RDBMSs](https://arxiv.org/pdf/1802.09883)

### Timezone-Dependent Transformations

Timezone transformations break replay determinism because:

1. **DST transitions**: The same UTC timestamp maps to different local times depending on when the conversion happens relative to DST rule changes. Daylight saving is a recurring threat to data automation, with many pipelines designed timezone-specifically without accounting for DST.
2. **IANA timezone database updates**: Governments change timezone rules; if the tz database version differs between original run and replay, results differ.
3. **`NOW()`/`CURRENT_TIMESTAMP` in transformations**: Reading wall-clock time produces different values on replay.

```python
# NON-DETERMINISTIC: Uses current time and local timezone
df['local_time'] = pd.to_datetime(df['utc_time']).dt.tz_localize('UTC').dt.tz_convert('US/Eastern')

# DETERMINISTIC: Pin timezone rules and avoid wall-clock dependencies
from zoneinfo import ZoneInfo
eastern = ZoneInfo("America/New_York")
df['local_time'] = df['utc_time'].apply(lambda t: t.replace(tzinfo=ZoneInfo("UTC")).astimezone(eastern))
```

**Best practice**: Store all timestamps in UTC. Perform timezone conversion only at the presentation layer, never in the pipeline transformation logic.

Sources:
- [Temporal Community - Replay for Non-Deterministic Change](https://community.temporal.io/t/replay-for-non-deterministic-change/8572)
- [Medium - For Data Engineers The Real Y2K Happens Twice A Year](https://medium.com/pipeline-a-data-engineering-resource/for-data-engineers-the-real-y2k-happens-twice-a-year-7674620ac757)

### Non-Deterministic UDFs

UDFs are non-deterministic when they:
- Use threading/parallelism internally (e.g., linear algebra operations with multithreaded BLAS)
- Call external services (API responses may differ)
- Use random number generators without fixed seeds
- Read system state (`NOW()`, hostname, etc.)

**Spark-specific trap**: UDFs in Apache Spark are considered deterministic by default. Due to optimization, duplicate invocations may be eliminated or the function may even be invoked more times than it is present in the query. If a UDF is actually non-deterministic but not marked as such, this causes confusing results.

```python
# Spark: Mark UDF as non-deterministic
from pyspark.sql.functions import udf
from pyspark.sql.types import StringType

@udf(returnType=StringType())
def my_udf(x):
    return external_api_call(x)  # Non-deterministic!

# Must explicitly mark it
my_udf = my_udf.asNondeterministic()
```

**Pathway framework**: Assumes UDFs are not deterministic unless told otherwise, and memoizes UDF call results until the corresponding input row is deleted.

**dbt perspective on UDFs**: UDFs in dbt can harm data pipelines because they create dependencies on database-specific functions, make testing harder, and introduce hidden non-determinism.

Sources:
- [Medium - Spark UDFs and Its Deterministic Nature](https://medium.com/@deepa.account/spark-udfs-and-its-deterministic-nature-b69e3dfc020e)
- [Brooklyn Data - UDFs in dbt: Why User-Defined Functions Can Harm Your Data Pipeline](https://www.brooklyndata.co/ideas/2025/12/09/udfs-and-why-not-in-dbt)
- [Pathway - User-Defined Functions](https://pathway.com/developers/user-guide/data-transformation/user-defined-functions/)

### Cross-Database Hash Incompatibility

`HASH()`, `MD5()`, and `SHA256()` implementations differ across databases. DB2, for example, has no built-in MD5 that produces results compatible with other platforms. When migrating between databases or running cross-database validation, hash-based deduplication keys can silently break.

Source: [data.KISS - Data Vault 2.0, Hashing and DB2](https://buckenhofer.com/2015/12/data-vault-20-hashing-and-db2-luw/)

---

## 5. Regression Testing for Data Pipelines

### dbt Unit Tests (since v1.8, 2024)

dbt unit tests validate transformation logic with mock data before materialization:

```yaml
unit_tests:
  - name: test_revenue_calculation
    description: "Validates revenue = quantity * price - discount"
    model: fct_orders
    given:
      - input: ref('stg_orders')
        rows:
          - {order_id: 1, quantity: 10, price: 5.00, discount: 2.50}
          - {order_id: 2, quantity: 1, price: 100.00, discount: 0.00}
    expect:
      rows:
        - {order_id: 1, revenue: 47.50}
        - {order_id: 2, revenue: 100.00}

  - name: test_incremental_logic
    description: "Validates incremental model filters correctly"
    model: fct_events
    overrides:
      macros:
        is_incremental: true
    given:
      - input: ref('stg_events')
        rows:
          - {event_id: 1, event_time: '2024-01-01'}
          - {event_id: 2, event_time: '2024-01-15'}
      - input: this
        rows:
          - {event_id: 0, event_time: '2023-12-31'}
    expect:
      rows:
        - {event_id: 1, event_time: '2024-01-01'}
        - {event_id: 2, event_time: '2024-01-15'}

  - name: test_is_valid_email_address
    description: "Validate email logic handles edge cases"
    model: dim_customers
    given:
      - input: ref('stg_customers')
        rows:
          - {email: cool@example.com, email_top_level_domain: example.com}
          - {email: cool@unknown.com, email_top_level_domain: unknown.com}
          - {email: badgmail.com, email_top_level_domain: gmail.com}
      - input: ref('top_level_email_domains')
        rows:
          - {tld: example.com}
          - {tld: gmail.com}
    expect:
      rows:
        - {email: cool@example.com, is_valid_email_address: true}
        - {email: cool@unknown.com, is_valid_email_address: false}
        - {email: badgmail.com, is_valid_email_address: false}
```

For ephemeral models, use SQL format for inputs:

```yaml
unit_tests:
  - name: my_unit_test
    model: dim_customers
    given:
      - input: ref('ephemeral_model')
        format: sql
        rows: |
          select 1 as id, 'emily' as first_name
    expect:
      rows:
        - {id: 1, first_name: emily}
```

```bash
# Run all unit tests
dbt test --select "test_type:unit"

# Run unit tests for a specific model
dbt test --select "fct_orders,test_type:unit"
```

**When to add unit tests:**
- Parsing strings with regular expressions or string functions
- Anything with high business criticality (key metrics, payout calculations)
- Retrospectively: where bugs have been previously reported
- Prospectively: edge cases that don't yet exist in current data

> "Unit tests catch logic errors in your transformations; data tests catch quality regressions in the data itself."

**Important**: dbt unit tests are relevant only to the development process. Running them in production is pointless and will only increase execution time.

Source: [dbt Documentation - Unit Tests](https://docs.getdbt.com/docs/build/unit-tests)

### Testing Strategy Comparison

| Aspect | Generic Tests | Unit Tests | Data Diffing |
|--------|--------------|-----------|--------------|
| **Implementation Effort** | Medium | High | Low |
| **Coverage** | Medium | Low | High |
| **Specificity** | Medium | High | Medium |
| **Best For** | Structural validation | Complex logic | Regression detection |
| **Scalability** | Limited by data volume | Excellent | Excellent |

Source: [Datafold - 7 dbt Testing Best Practices](https://www.datafold.com/blog/7-dbt-testing-best-practices/)

### Datafold CI: PR-Level Data Validation

Datafold integrates into CI/CD to automatically diff production vs. development data on every pull request:

1. Developer opens PR with dbt model changes
2. CI builds changed models in a staging schema
3. Datafold analyzes SQL in changed files, extracts relevant table names
4. Diffs staging output against production tables (including downstream impact)
5. Summary posted as PR comment: row counts, column-level match percentages, sample divergent rows

The diff algorithm uses a binary-search-on-hashes approach: divide the dataset into chunks, compare chunk hashes, recursively subdivide mismatched chunks until individual divergent rows are found. This makes billion-row comparisons feasible in under 5 minutes.

Thumbtack reported a **20% productivity increase** and hundreds of monthly review hours saved after implementing Datafold's automated regression testing.

> "Every change to SQL code is validated through the Datafold API automatically, and the detailed impact analysis report is published for every change to the pull request."

Sources:
- [Datafold - Automated Regression Testing for Data Quality](https://www.datafold.com/blog/automated-regression-testing-data-quality)
- [Datafold - Setup Data Quality Testing in CI](https://www.datafold.com/blog/automating-data-quality-testing-in-ci)
- [Thumbtack Case Study](https://www.datafold.com/case-study/thumbtack)

### SQLMesh Built-In Audits

SQLMesh audits run after every model materialization as automated data quality gates. They are written as SQL queries that should return 0 rows (any returned row = failure):

```sql
-- Custom audit: query for bad data
AUDIT (
  name revenue_is_positive
);
SELECT * FROM @this_model
WHERE revenue < 0;
```

```sql
-- Parameterized audit for reuse across models
AUDIT (
  name does_not_exceed_threshold,
  defaults (
    threshold = 10,
    column = id
  )
);
SELECT * FROM @this_model
WHERE @column >= @threshold;
```

```sql
-- Applied to a model
MODEL (
  name analytics.fct_orders,
  audits (
    not_null(columns := (order_id, customer_id)),
    unique_values(columns := (order_id)),
    does_not_exceed_threshold(column := amount, threshold := 1000000),
    forall(criteria := (amount > 0, quantity > 0))
  )
);
```

**Comprehensive built-in audit library:**

| Category | Audits |
|----------|--------|
| **NULL checks** | `not_null`, `at_least_one`, `not_null_proportion` |
| **Uniqueness** | `unique_values`, `unique_combination_of_columns` |
| **Value constraints** | `accepted_values`, `not_constant`, `accepted_range` |
| **String validation** | `not_empty_string`, `string_length_equal`, `string_length_between`, `valid_email`, `valid_uuid`, `valid_url` |
| **Pattern matching** | `match_regex_pattern_list`, `match_like_pattern_list` |
| **Statistical** | `mean_in_range`, `z_score`, `kl_divergence`, `chi_square` |
| **Row counts** | `number_of_rows`, `sequential_values`, `mutually_exclusive_ranges` |

Audits can be **blocking** (halt pipeline on failure) or **non-blocking** (emit warnings). Can also apply audits project-wide via global configuration:

```yaml
model_defaults:
  audits:
    - assert_positive_order_ids
    - does_not_exceed_threshold(column := id, threshold := 1000)
```

Source: [SQLMesh - Auditing](https://sqlmesh.readthedocs.io/en/latest/concepts/audits/)

### SQLMesh Table Diff

SQLMesh provides a built-in `table_diff` command for comparing data across environments:

```bash
# Compare model output between prod and dev environments
sqlmesh table_diff prod:dev sqlmesh_example.incremental_model

# Compare with sample rows shown
sqlmesh table_diff prod:dev --show-sample

# Compare by model selector patterns
sqlmesh table_diff prod:dev --select-model "analytics.*"
sqlmesh table_diff prod:dev -m "+model_name"   # with upstream deps
sqlmesh table_diff prod:dev -m "tag:finance"   # by tag

# Direct table comparison
sqlmesh table_diff schema.table_v1:schema.table_v2 -o id -o date
```

Output includes schema diff, row counts (COMMON / SOURCE ONLY / TARGET ONLY), and per-column `pct_match` statistics.

Source: [SQLMesh - Table Diff Guide](https://sqlmesh.readthedocs.io/en/stable/guides/tablediff/)

### SQLMesh Unit Tests

SQLMesh also provides unit tests that validate logic with predefined inputs and expected values:

```yaml
# tests/test_model.yaml
test_sushi_items:
  model: sushi.items
  inputs:
    sushi.seed:
      - {id: 1, name: "Hamachi", price: 10.0}
      - {id: 2, name: "Unagi", price: 15.0}
  outputs:
    query:
      - {id: 1, name: "Hamachi", price: 10.0}
      - {id: 2, name: "Unagi", price: 15.0}
```

SQLMesh automatically runs tests when you apply a plan, or you can run them on demand with the `test` command.

Source: [SQLMesh - Testing Guide](https://sqlmesh.readthedocs.io/en/stable/guides/testing/)

### Great Expectations Checkpoints as Regression Gates

Checkpoints are the primary means for validating data in production deployments. They validate a Batch of data against an Expectation Suite, save validation results, run configured Actions, and create Data Docs.

```python
# Python checkpoint definition
import great_expectations as gx

context = gx.get_context()
checkpoint = context.add_or_update_checkpoint(
    name="orders_checkpoint",
    validations=[{
        "batch_request": {
            "datasource_name": "warehouse",
            "data_connector_name": "default",
            "data_asset_name": "orders",
        },
        "expectation_suite_name": "orders_quality_suite",
    }],
    action_list=[
        {"name": "store_validation_result", "action": {"class_name": "StoreValidationResultAction"}},
        {"name": "update_data_docs", "action": {"class_name": "UpdateDataDocsAction"}},
    ]
)

result = checkpoint.run()
assert result.success, "Data quality checkpoint failed!"
```

Integration with CI via GitHub Actions:

```yaml
# Great Expectations GitHub Action
- name: Run Great Expectations
  uses: great-expectations/great_expectations_action@v1
  with:
    CHECKPOINTS: "orders_checkpoint,customers_checkpoint"
    GE_DIRECTORY: "./great_expectations"
```

Integration with Airflow via the Great Expectations Airflow operator, or other DAG runners by invoking a Python task.

Sources:
- [Great Expectations - Checkpoint Documentation](https://docs.greatexpectations.io/docs/0.18/reference/learn/terms/checkpoint/)
- [Great Expectations - Run a Checkpoint](https://docs.greatexpectations.io/docs/core/trigger_actions_based_on_results/run_a_checkpoint/)
- [trivago tech blog - Implementing Data Validation with Great Expectations](https://tech.trivago.com/post/2023-04-25-implementing-data-validation-with-great-expectations-in-hybrid-environments.html)

---

## 6. Snapshot Testing / Golden File Patterns

### Core Concept

Snapshot testing stores expected query results and compares subsequent runs against them. The first run saves the state as the "golden file." On subsequent runs, results are compared to the stored snapshot. If they differ, the test fails and a new file is created for review.

> "When the result set produced by the pipeline execution matches the expected result (golden data set), the test succeeds."

If the change was deliberate, developers approve the change and the golden file is updated.

Sources:
- [Medium - Golden Tests](https://medium.com/casperblockchain/golden-tests-e521077ae235)
- [Medium - Snapshot Testing in Data Science](https://martinahindura.medium.com/snapshot-testing-in-data-science-f2a9bac5b48a)

### dbt-audit-helper: Comparison Macros

The `dbt-audit-helper` package provides a comprehensive suite of macros for row-by-row and column-by-column comparison:

#### Row-Level Comparison (compare_and_classify_query_results)

```sql
{% set old_relation = adapter.get_relation(
    database="old_database",
    schema="old_schema",
    identifier="fct_orders"
) %}
{% set dbt_relation = ref('fct_orders') %}

{{ audit_helper.compare_and_classify_relation_rows(
    a_relation=old_relation,
    b_relation=dbt_relation,
    primary_key_columns=["order_id"],
    columns=None  -- auto-detect intersecting columns
) }}
```

Output includes `dbt_audit_row_status` (added, removed, identical, modified) and `dbt_audit_num_rows_in_status`.

#### Column-Level Comparison (compare_column_values)

```sql
{% set audit_query = audit_helper.compare_column_values(
    a_query="SELECT * FROM legacy.dim_product WHERE is_latest",
    b_query="SELECT * FROM " ~ ref('dim_product'),
    primary_key="product_id",
    column_to_compare="status"
) %}

{% set audit_results = run_query(audit_query) %}
{% if execute %}
    {% do audit_results.print_table() %}
{% endif %}
```

Output statuses: perfect match, both null, values do not match, missing from a/b, null in a/b only.

#### Finding Which Columns Differ

```sql
{% set columns = dbt_utils.get_filtered_columns_in_relation(
    old_relation,
    except=["loaded_at"]
) %}

{{ audit_helper.compare_which_relation_columns_differ(
    a_relation=old_relation,
    b_relation=dbt_relation,
    primary_key_columns=["order_id"],
    columns=columns
) }}
```

Output: column_name, has_difference (True/False).

#### Quick Hash-Based Comparison

```sql
-- Fast check: are two relations identical? (Snowflake/BigQuery)
{{ audit_helper.quick_are_relations_identical(
    a_relation=old_relation,
    b_relation=dbt_relation
) }}
-- Returns: single boolean column `are_tables_identical`
```

**Best practices from dbt Labs:**
1. Start with 5 columns, gradually add more
2. Ensure identical column naming (use aliases)
3. Verify matching data types
4. Comment out timezone-dependent or calculated fields initially

Sources:
- [GitHub - dbt-labs/dbt-audit-helper](https://github.com/dbt-labs/dbt-audit-helper)
- [dbt Developer Blog - Audit Helper for Migration](https://docs.getdbt.com/blog/audit-helper-for-migration)

### dbt-expectations

dbt-expectations (originally inspired by Great Expectations, now maintained by Metaplane as of Dec 2024) ports assertion tests to dbt:

```yaml
models:
  - name: fct_orders
    columns:
      - name: order_id
        tests:
          - dbt_expectations.expect_column_values_to_be_unique
          - dbt_expectations.expect_column_values_to_not_be_null
      - name: amount
        tests:
          - dbt_expectations.expect_column_values_to_be_between:
              min_value: 0
              max_value: 1000000
      - name: email
        tests:
          - dbt_expectations.expect_column_values_to_match_regex:
              regex: "^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$"
      - name: created_at
        tests:
          - dbt_expectations.expect_row_values_to_have_recent_data:
              datepart: day
              interval: 1
```

Capabilities extend to:
- **Statistical validation**: outlier detection, distribution patterns
- **Time-series analysis**: data freshness, completeness across time periods
- **Complex data validation**: JSON/semi-structured data, nested schemas, custom ID formats

Source: [Datafold - How to Use dbt-expectations](https://www.datafold.com/blog/dbt-expectations/)

### Golden File / Snapshot Testing Challenges

When storing expected query results for comparison, several challenges arise:

1. **Floating-point precision**: Results like `229577310901.211` vs `229577310901.198` are both "correct" but fail exact comparison. Use epsilon-based comparison or `NUMERIC` types.

2. **Timestamp precision**: Microsecond vs millisecond precision differs across databases. Truncate to consistent precision before comparison.

3. **Row ordering**: SQL query results have no guaranteed order. Sort both expected and actual results by a deterministic key before comparison.

4. **Non-deterministic functions**: Replace `NOW()`, `UUID()`, `RANDOM()` with deterministic alternatives or scrub them from comparison.

```python
# Python golden file pattern with scrubbing
import json
from deepdiff import DeepDiff

def compare_with_golden(actual_rows, golden_file, ignore_keys=None):
    """Compare pipeline output against stored golden file."""
    with open(golden_file) as f:
        expected = json.load(f)

    # Sort both by deterministic key
    actual_sorted = sorted(actual_rows, key=lambda r: r['id'])
    expected_sorted = sorted(expected, key=lambda r: r['id'])

    diff = DeepDiff(
        expected_sorted,
        actual_sorted,
        exclude_paths=ignore_keys or [],
        significant_digits=2,  # Handle floating point
        ignore_order=True,
    )

    if diff:
        raise AssertionError(f"Golden file mismatch:\n{diff.to_json(indent=2)}")
```

### Reladiff (Open Source)

Reladiff (formerly data-diff) is a high-performance diffing tool for large datasets across databases. It employs a divide-and-conquer algorithm based on matching hashes:

- Efficiently identifies modified segments by executing diff calculations within the database itself
- Only hash values (not actual data) are transferred over the network
- Handles precision differences automatically by rounding according to database specification
- **Performance**: 25M rows in under 10 seconds; 1B rows in ~5 minutes
- **Cross-database**: Supports MySQL, PostgreSQL, Snowflake, BigQuery, Oracle, ClickHouse, and more

```bash
# Compare tables across databases
data-diff \
  postgresql://user:pass@host/db1 orders \
  snowflake://user:pass@account/db2 orders \
  --key-columns id \
  --columns amount,status,updated_at

# Compare within same database (different schemas)
data-diff \
  postgresql://user:pass@host/db prod.orders dev.orders \
  --key-columns id
```

Sources:
- [GitHub - erezsh/reladiff](https://github.com/erezsh/reladiff)
- [Reladiff Documentation](https://reladiff.readthedocs.io/en/latest/index.html)
- [GitHub - datafold/data-diff](https://github.com/datafold/data-diff)

### Custom dbt Generic Tests as Regression Guards

```yaml
version: 2
models:
  - name: fact_transactions
    columns:
      - name: quantity
        tests:
          - order_limit  # Custom generic test
```

```sql
-- tests/generic/order_limit.sql
{% test order_limit(model, column_name) %}
with validation as (
    select {{ column_name }} as limit_field
    from {{ model }}
),
validation_errors as (
    select limit_field
    from validation
    where limit_field > 500
)
select * from validation_errors
{% endtest %}
```

```sql
-- Singular test: one-off SQL assertion
-- tests/no_negative_quantities.sql
select transaction_id
from {{ ref('fact_transactions') }}
where quantity < 0
-- Returns zero rows = pass, any rows = fail
```

Source: [Datafold - 7 dbt Testing Best Practices](https://www.datafold.com/blog/7-dbt-testing-best-practices/)

---

## Implications for Reladiff

Based on this research, a data-diff/validation tool like Reladiff should consider:

### Must-Have Capabilities

1. **Time-travel integration**: First-class support for Snowflake `AT`/`BEFORE`, BigQuery `FOR SYSTEM_TIME AS OF`, Iceberg `FOR VERSION AS OF`, and Delta Lake `VERSION AS OF` to enable before/after pipeline run comparisons without maintaining separate audit tables.

2. **Determinism detection**: Flag common non-deterministic SQL patterns:
   - `ROW_NUMBER()` without unique tiebreakers in `ORDER BY`
   - `FLOAT`/`DOUBLE` aggregations that may vary under parallelism
   - Use of `SEQ4()`, `RANDOM()`, `NEWID()`, `UUID()`, `NOW()` in deterministic contexts
   - CTEs referenced multiple times with nondeterministic functions
   - `CASE`/`NULLIF` expressions wrapping nondeterministic functions

3. **Epsilon-based numeric comparison**: Rather than exact equality, support configurable tolerance for floating-point columns (absolute and relative thresholds).

4. **Idempotency verification mode**: Run a pipeline twice, diff the outputs, and report any divergence. This is the simplest and most powerful test of pipeline correctness.

### High-Value Features

5. **PR-level regression testing** (like Datafold CI): Diff model outputs between feature branch and main, post summary in PR.

6. **Golden file management**: Store expected query results, automatically compare on each run, with scrubbing for timestamps and non-deterministic values.

7. **Cross-database comparison**: Use checksum-based algorithms (like data-diff/reladiff) for efficient comparison across database boundaries.

8. **Schema-aware diffing**: Detect column additions, removals, type changes alongside data changes (like SQLMesh table_diff).

### Architectural Patterns to Support

9. **Shadow pipeline validation**: Dual-run comparison mode where the tool orchestrates running old and new pipeline versions and diffs outputs. Inspired by Stripe's Scientist pattern and Netflix's Data Canary.

10. **Write-Audit-Publish gates**: Integration with lakeFS-style branching or database staging schemas to validate data before promotion to production.

11. **Circuit breaker patterns**: Netflix-style threshold-based gates with configurable sensitivity:
    - Dynamic thresholds (percentages, not absolutes)
    - Business-value weighting for different data segments
    - Blocking vs non-blocking modes (like SQLMesh audits)

12. **Incremental vs full-refresh drift detection**: Periodically compare incremental model outputs against full-refresh outputs to measure accumulated drift, surfacing when a `--full-refresh` is overdue.

---

## Sources

### Pipeline Idempotency
- [Start Data Engineering - How to Make Data Pipelines Idempotent](https://www.startdataengineering.com/post/why-how-idempotent-data-pipeline/)
- [Airbyte - Idempotency in Data Pipelines](https://airbyte.com/data-engineering-resources/idempotency-in-data-pipelines)
- [Astronomer - DAG Best Practices](https://www.astronomer.io/docs/learn/dag-best-practices)
- [Airflow - Best Practices](https://airflow.apache.org/docs/apache-airflow/stable/best-practices.html)
- [Writing Idempotent dbt Tasks for Airflow](https://tomasfarias.dev/articles/writing-idempotent-dbt-tasks-for-airflow/)
- [Dagster - Asset Checks](https://docs.dagster.io/guides/test/asset-checks)
- [Dagster - Data Contracts with Asset Checks](https://docs.dagster.io/guides/test/data-contracts)
- [dbt - Incremental Models In-Depth](https://docs.getdbt.com/best-practices/materializations/4-incremental-models)
- [dbt - Configure Incremental Models](https://docs.getdbt.com/docs/build/incremental-models)
- [Finatext Tech Blog - dbt Incremental Strategy and Idempotency](https://techblog.finatext.com/dbt-incremental-strategy-and-idempotency-877993f48448)
- [Sportscape Tech - No Key No Trust: Idempotent Data Pipelines](https://medium.com/sportscape-tech/no-key-no-trust-how-we-built-idempotent-reliable-data-pipelines-with-validation-and-atomic-d4ccbf71384d)
- [ml4devs - Backfilling Historical Data With Idempotent Data Pipelines](https://www.ml4devs.com/what-is/backfilling-data/)
- [System Overflow - Failure Modes & Idempotency](https://www.systemoverflow.com/learn/data-pipelines-orchestration/backfill-strategies/failure-modes-idempotency)
- [Medium - Designing Robust Data Pipelines: Idempotency, Replays & Backfills](https://medium.com/@manjindersingh_10145/designing-robust-data-pipelines-idempotency-replays-backfills-explained-640c9920f7b9)

### Time-Travel Based Validation
- [Snowflake - AT/BEFORE Clause](https://docs.snowflake.com/en/sql-reference/constructs/at-before)
- [Snowflake - Understanding & Using Time Travel](https://docs.snowflake.com/en/user-guide/data-time-travel)
- [BigQuery - Access Historical Data](https://docs.cloud.google.com/bigquery/docs/access-historical-data)
- [BigQuery - Time Travel](https://cloud.google.com/bigquery/docs/time-travel)
- [BigQuery - Table Snapshots](https://cloud.google.com/bigquery/docs/table-snapshots-intro)
- [Apache Iceberg - Spark Queries](https://iceberg.apache.org/docs/latest/spark-queries/)
- [AWS Athena - Iceberg Time Travel](https://docs.aws.amazon.com/athena/latest/ug/querying-iceberg-time-travel-and-version-travel-queries.html)
- [Delta Lake - Time Travel](https://delta.io/blog/2023-02-01-delta-lake-time-travel/)
- [Databricks - Delta Lake History](https://docs.databricks.com/en/delta/history.html)
- [lakeFS - Write-Audit-Publish](https://lakefs.io/blog/wap-for-data-pipelines/)
- [lakeFS - Acceptance Testing for Data Pipelines](https://lakefs.io/blog/acceptance-testing-for-data-pipelines/)
- [lakeFS - Data Reproducibility](https://lakefs.io/blog/reproducibility/)

### Shadow Pipeline / Dark Launch
- [Stripe Engineering - Online Migrations at Scale](https://stripe.com/blog/online-migrations)
- [GitHub - Scientist Library](https://github.com/github/scientist)
- [GitHub Blog - Scientist: Measure Twice, Cut Once](https://github.blog/developer-skills/application-development/scientist/)
- [Flexport Engineering - Using Scientist](https://flexport.engineering/using-githubs-scientist-library-to-refactor-with-confidence-9d34600edd5e)
- [InfoQ - Shadow Table Strategy for Data Migration](https://www.infoq.com/articles/shadow-table-strategy-data-migration/)
- [Microsoft Engineering Playbook - Shadow Testing](https://microsoft.github.io/code-with-engineering-playbook/automated-testing/shadow-testing/)
- [Netflix TechBlog - The Data Canary (Feb 2026)](https://netflixtechblog.medium.com/the-data-canary-how-netflix-validates-catalog-metadata-18b699d58e36)
- [InfoQ - Crisis to Calm: Data Validation at Netflix](https://www.infoq.com/presentations/data-validation-netflix/)
- [Netflix TechBlog - Queue Data Migration](https://netflixtechblog.com/netflix-queue-data-migration-for-a-high-volume-web-application-76cb64272198)
- [LaunchDarkly - Performing Multi-Stage Migrations](https://launchdarkly.com/docs/guides/flags/migrations)

### Determinism Challenges
- [SQLPerformance - ROW_NUMBER with Nondeterministic Order](https://sqlperformance.com/2019/11/t-sql-queries/row-numbers-with-nondeterministic-order)
- [SQLPerformance - T-SQL Bugs, Pitfalls, Best Practices: Determinism](https://sqlperformance.com/2019/03/t-sql-queries/bugs-pitfalls-best-practices-determinism)
- [Chen Hirsh - SQL Windows Functions Might Be Non-Deterministic](https://chenhirsh.com/sql-windows-functions-might-be-non-deterministic/)
- [bene.haus - Nondeterministic Snowflake Behavior](https://www.bene.haus/snowflake_nondeterministic/)
- [Snowflake Community - ROW_NUMBER Non-Deterministic Behavior](https://community.snowflake.com/s/article/ROW-NUMBER-function-causing-Non-deterministic-behavior)
- [PostgreSQL - Non-deterministic Floating Point in Parallel Mode](https://www.postgresql.org/message-id/CAEepm=2n7onP5aeypEYxAxgo0FX4eLRbALajzibkF8JhBKiZEw@mail.gmail.com)
- [InsideSQL - Aggregate Functions on Floats](https://www.insidesql.org/blogs/holgerschmeling/2010/11/02/did-you-know-aggregate-functions-on-floats-may-be-non-deterministic)
- [arXiv - Reproducible Floating-Point Aggregation in RDBMSs](https://arxiv.org/pdf/1802.09883)
- [data.KISS - Data Vault 2.0 Hashing and DB2](https://buckenhofer.com/2015/12/data-vault-20-hashing-and-db2-luw/)
- [Medium - Spark UDFs and Its Deterministic Nature](https://medium.com/@deepa.account/spark-udfs-and-its-deterministic-nature-b69e3dfc020e)
- [Brooklyn Data - UDFs in dbt](https://www.brooklyndata.co/ideas/2025/12/09/udfs-and-why-not-in-dbt)
- [Pathway - User-Defined Functions](https://pathway.com/developers/user-guide/data-transformation/user-defined-functions/)
- [Medium - For Data Engineers The Real Y2K Happens Twice A Year](https://medium.com/pipeline-a-data-engineering-resource/for-data-engineers-the-real-y2k-happens-twice-a-year-7674620ac757)

### Regression Testing
- [dbt - Unit Tests](https://docs.getdbt.com/docs/build/unit-tests)
- [Datafold - Automated Regression Testing](https://www.datafold.com/blog/automated-regression-testing-data-quality)
- [Datafold - Setup Data Quality Testing in CI](https://www.datafold.com/blog/automating-data-quality-testing-in-ci)
- [Datafold - 7 dbt Testing Best Practices](https://www.datafold.com/blog/7-dbt-testing-best-practices/)
- [Thumbtack Case Study](https://www.datafold.com/case-study/thumbtack)
- [SQLMesh - Auditing](https://sqlmesh.readthedocs.io/en/latest/concepts/audits/)
- [SQLMesh - Testing Guide](https://sqlmesh.readthedocs.io/en/stable/guides/testing/)
- [SQLMesh - Table Diff Guide](https://sqlmesh.readthedocs.io/en/stable/guides/tablediff/)
- [Great Expectations - Checkpoint](https://docs.greatexpectations.io/docs/0.18/reference/learn/terms/checkpoint/)
- [Great Expectations - Run a Checkpoint](https://docs.greatexpectations.io/docs/core/trigger_actions_based_on_results/run_a_checkpoint/)
- [trivago tech blog - Data Validation with Great Expectations](https://tech.trivago.com/post/2023-04-25-implementing-data-validation-with-great-expectations-in-hybrid-environments.html)

### Snapshot Testing / Golden Files
- [dbt Developer Blog - Audit Helper for Migration](https://docs.getdbt.com/blog/audit-helper-for-migration)
- [GitHub - dbt-labs/dbt-audit-helper](https://github.com/dbt-labs/dbt-audit-helper)
- [Datafold - dbt-expectations](https://www.datafold.com/blog/dbt-expectations/)
- [GitHub - erezsh/reladiff](https://github.com/erezsh/reladiff)
- [Reladiff Documentation](https://reladiff.readthedocs.io/en/latest/index.html)
- [GitHub - datafold/data-diff](https://github.com/datafold/data-diff)
- [Datafold - Open Source Data Diff](https://www.datafold.com/open-source-data-diff/)
- [Medium - Golden Tests](https://medium.com/casperblockchain/golden-tests-e521077ae235)
- [Medium - Snapshot Testing in Data Science](https://martinahindura.medium.com/snapshot-testing-in-data-science-f2a9bac5b48a)
