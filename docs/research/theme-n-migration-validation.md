# Theme N: Migration Validation at Scale

_Iteration 3 — 2026-03-13_

> Deep research on validating data correctness during and after large-scale migrations:
> on-prem to cloud, cross-cloud, database version upgrades, schema refactors, and
> warehouse consolidations. Covers patterns, scale challenges, sampling theory,
> tool comparison, cost models, and how Reladiff's Cascade and HashDiff algorithms
> map to migration scenarios.

---

## Table of Contents

1. [Migration Validation Patterns](#1-migration-validation-patterns)
2. [Scale Challenges](#2-scale-challenges)
3. [The Progressive Validation Pyramid for Migrations](#3-the-progressive-validation-pyramid-for-migrations)
4. [Sampling Strategies with Statistical Guarantees](#4-sampling-strategies-with-statistical-guarantees)
5. [Zero-Downtime Migration Validation](#5-zero-downtime-migration-validation)
6. [Partition-Aware Validation](#6-partition-aware-validation)
7. [Time-Travel for Migration Validation](#7-time-travel-for-migration-validation)
8. [Data Type Coercion During Migration](#8-data-type-coercion-during-migration)
9. [Rollback Decision Criteria](#9-rollback-decision-criteria)
10. [Cost Models](#10-cost-models)
11. [Tools Comparison](#11-tools-comparison)
12. [Idempotent Re-Validation](#12-idempotent-re-validation)
13. [Real-World Migration Stories](#13-real-world-migration-stories)
14. [Reladiff Engine Positioning](#14-reladiff-engine-positioning)
15. [References](#15-references)

---

## 1. Migration Validation Patterns

### 1.1 The Three Phases of Migration Validation

Every migration — whether it moves 50 tables or 50,000 — follows a temporal arc. Validation is not a single step at the end; it is a continuous activity woven through three phases:

**Phase 1: Pre-Migration (Before the first row moves)**

- **Schema compatibility analysis**: Compare source DDL against target DDL. Surface type incompatibilities (Oracle `NUMBER(38,0)` → Snowflake `NUMBER(38,0)` is lossless; Oracle `CLOB` → Snowflake `VARCHAR(16777216)` truncates at 16MB).
- **Row count baselines**: Record `COUNT(*)` per table, per date partition, per logical domain.
- **Checksum baselines**: Compute `HASH_AGG(*)` or `CHECKSUM_AGG` on source tables. Store as a fingerprint registry.
- **Data profiling snapshots**: MIN/MAX/AVG/STDDEV, NULL rates, distinct counts. These become the "known-good" reference.
- **Key uniqueness verification**: Ensure primary keys are actually unique. Duplicate keys in source create non-deterministic merge behavior in target.

```sql
-- Pre-migration baseline: Snowflake source
CREATE OR REPLACE TABLE migration_baselines AS
SELECT
    'orders' AS table_name,
    COUNT(*) AS row_count,
    HASH_AGG(*) AS content_hash,
    MIN(created_at) AS min_ts,
    MAX(created_at) AS max_ts,
    COUNT(DISTINCT order_id) AS distinct_keys,
    COUNT_IF(amount IS NULL) AS null_amount_count,
    AVG(amount) AS avg_amount,
    STDDEV(amount) AS stddev_amount,
    CURRENT_TIMESTAMP() AS baseline_captured_at
FROM source_db.public.orders;
```

**Phase 2: During-Migration (While data is in flight)**

- **Incremental row count monitoring**: Compare `COUNT(*)` between source and target at regular intervals (every 5 minutes for large tables).
- **Watermark tracking**: Track the high-water mark of migrated data (latest `updated_at` timestamp, max primary key value).
- **Error stream monitoring**: Capture and classify rejected rows. AWS DMS writes rejects to a control table. Striim logs transformation failures.
- **Throughput monitoring**: Rows/second, bytes/second. A sudden drop signals a problem before validation catches it.

```python
# During-migration monitoring loop
import time
from dataclasses import dataclass
from datetime import datetime, timezone

@dataclass
class MigrationCheckpoint:
    table: str
    source_count: int
    target_count: int
    delta: int
    high_watermark: str
    errors_since_last: int
    throughput_rps: float
    checked_at: datetime

def monitor_migration(source_conn, target_conn, table: str,
                      key_column: str, interval_seconds: int = 300):
    """Continuously monitor migration progress and flag anomalies."""
    last_target_count = 0
    last_check = datetime.now(timezone.utc)

    while True:
        source_count = source_conn.execute(
            f"SELECT COUNT(*) FROM {table}"
        ).scalar()
        target_count = target_conn.execute(
            f"SELECT COUNT(*) FROM {table}"
        ).scalar()
        high_watermark = target_conn.execute(
            f"SELECT MAX({key_column}) FROM {table}"
        ).scalar()

        now = datetime.now(timezone.utc)
        elapsed = (now - last_check).total_seconds()
        throughput = (target_count - last_target_count) / max(elapsed, 1)

        checkpoint = MigrationCheckpoint(
            table=table,
            source_count=source_count,
            target_count=target_count,
            delta=source_count - target_count,
            high_watermark=str(high_watermark),
            errors_since_last=0,  # Query DMS error table
            throughput_rps=throughput,
            checked_at=now,
        )

        # Alert conditions
        if checkpoint.delta < 0:
            alert(f"Target has MORE rows than source: {checkpoint}")
        if throughput < 100 and last_target_count > 0:
            alert(f"Throughput dropped below 100 rps: {checkpoint}")

        log_checkpoint(checkpoint)
        last_target_count = target_count
        last_check = now
        time.sleep(interval_seconds)
```

**Phase 3: Post-Migration (After cutover)**

- **Full row count reconciliation**: Source count must equal target count (within tolerance for append-only tables with concurrent writes).
- **Content hash comparison**: `HASH_AGG(*)` on target must match pre-migration baseline.
- **Sample-based row diff**: Pull N% of rows and compare field-by-field.
- **Full diff on critical tables**: For financial, compliance, or customer-facing tables, accept nothing less than a full diff.
- **Application-level smoke tests**: Run the top 20 business queries against both source and target. Compare result sets.

### 1.2 The Validation Contract

Before any migration begins, establish a **validation contract** that answers:

| Question | Example Answer |
|----------|---------------|
| What constitutes "equal"? | Row counts match within 0.01%. Content hash matches for all Tier 1 tables. Sample diff shows < 5 mismatches per million rows for Tier 2. |
| What tolerance is acceptable? | Timestamps may differ by up to 1 microsecond (precision coercion). Trailing whitespace in CHAR columns is ignored. |
| What triggers a rollback? | Any Tier 1 table with > 0 row-level mismatches. Any Tier 2 table with > 0.1% mismatch rate. Any table with row count delta > 1%. |
| Who signs off? | Data engineering lead + domain owner + compliance (for regulated data). |
| How long do we validate? | 72 hours of dual-read validation post-cutover before decommissioning source. |

### 1.3 Tiered Table Classification

Not all tables deserve the same validation intensity. A common pattern from large-scale migrations (Capital One's Teradata-to-Snowflake, Netflix's Cassandra-to-CockroachDB):

| Tier | Criteria | Validation Level | Example |
|------|----------|-----------------|---------|
| **Tier 1 — Critical** | Revenue, compliance, customer PII | Full row-level diff, zero tolerance | `transactions`, `user_accounts`, `audit_log` |
| **Tier 2 — Important** | Analytics, reporting, ML features | Hash + 5% sample diff, <0.01% tolerance | `page_views`, `feature_store`, `aggregated_metrics` |
| **Tier 3 — Standard** | Operational logs, temp tables, staging | Count + schema match | `etl_log`, `staging_*`, `tmp_*` |
| **Tier 4 — Disposable** | Can be regenerated from upstream | Count only, or skip | `materialized_views`, `cache_tables` |

**The 80/20 rule of migration validation**: Tier 1 tables are typically 5-10% of total table count but require 80% of validation effort.

---

## 2. Scale Challenges

### 2.1 The Numbers That Break Naive Approaches

| Scale | Rows | Storage | Naive Full Diff Time | Naive Full Diff Cost |
|-------|------|---------|---------------------|---------------------|
| Small | < 10M | < 10 GB | Minutes | $0.01-$0.10 |
| Medium | 10M-1B | 10 GB-1 TB | Hours | $1-$50 |
| Large | 1B-100B | 1-100 TB | Days | $50-$5,000 |
| Extreme | > 100B | > 100 TB | Weeks | $5,000-$500,000 |

A naive `SELECT * FROM source EXCEPT SELECT * FROM target` on a 10 billion row table on Snowflake 4XL warehouse:
- Full table scan: ~1 TB data processed
- Time: ~45 minutes per side = 90 minutes total
- Cost: ~$120 at Snowflake on-demand rates ($4/credit, ~30 credits)
- And this only tells you *that* rows differ, not *which* ones or *how*

**The bisection approach (HashDiff)**: Same 10B row table, zero differences:
- ~15 rounds of hash queries, each scanning progressively smaller segments
- Total data processed: ~3-5x a single scan (due to repeated reads of matching segments)
- Time: ~5-8 minutes
- Cost: ~$8-$15
- And when differences exist, it pinpoints the exact rows

### 2.2 Memory Pressure

Cross-database row comparison requires materializing rows from both sides. At scale:

| Approach | Memory Required (1B rows, 500 bytes/row) | Feasible? |
|----------|----------------------------------------|-----------|
| Full materialization both sides | 1 TB | No |
| Streaming merge-join (sorted) | ~100 MB buffer | Yes, if both sorted by key |
| Hash-partitioned comparison | ~50 GB per partition (20 partitions) | Marginal |
| Bisection (HashDiff) | ~10 MB (only hashes in memory) | Yes |
| Sketch comparison (HLL, IBLT) | ~1 MB | Yes, but approximate |

**Key insight**: The bisection/HashDiff approach works at any scale because it never materializes full rows until it has narrowed the search space to the actual differences. If 99.99% of rows match (common in migrations), the memory footprint stays trivially small.

### 2.3 Network Bandwidth

Cross-database validation means data crosses network boundaries:

```
Source (on-prem Oracle) → WAN → Cloud VPN → Target (Snowflake)
         ↕                                        ↕
   100 Gbps LAN                            Internal cloud network
         ↕
   Bottleneck: 1-10 Gbps WAN
```

A 10 TB table at 1 Gbps takes ~22 hours just for data transfer. Validation strategies must minimize data movement:

| Strategy | Data Movement | Network-Friendly? |
|----------|--------------|-------------------|
| Ship all rows to comparison engine | O(n) both sides | Worst case |
| Hash comparison (HashDiff) | O(log n * hash_size) | Excellent |
| Sample comparison | O(sample_size) | Good |
| Federated query (Snowflake EXTERNAL TABLE on Oracle) | O(n) one side | Poor for WAN |
| Sketch exchange (HLL, IBLT) | O(sketch_size) ~KB | Best |

### 2.4 Time-Bounded Validation Windows

Migrations often have hard deadlines:

- **Weekend cutover**: 48 hours from Friday 6 PM to Monday 6 AM. Validation must complete within 12 hours to leave time for rollback.
- **Maintenance window**: 4 hours of downtime. Validation gets 1 hour.
- **Continuous migration**: No downtime window. Validation runs concurrently with ongoing writes.

**Practical implication**: If your validation approach takes 36 hours on a 48-hour window, you have no time for rollback. The validation strategy must be designed backward from the time budget:

```
Available time: 12 hours
Number of tables: 5,000
Tier 1 tables (full diff): 200 → 10 minutes each = 33 hours → OVER BUDGET

Solution: Parallelize across 4 warehouses:
  Tier 1: 200 tables × 10 min / 4 warehouses = 8.3 hours ✓
  Tier 2: 1,000 tables × 2 min (hash + sample) / 4 warehouses = 8.3 hours → overlap

Revised: Stagger Tier 2 after Tier 1 completes on each warehouse
  Tier 1: 8.3 hours
  Tier 2: 1,000 × 2 min / 4 = 8.3 hours → starts at hour 8.3 → finishes hour 16.6 → OVER

Real solution: Progressive validation
  Tier 1: Full diff on 200 tables (8.3 hours, 4x parallel)
  Tier 2: HASH_AGG only on 1,000 tables (0.5 hours, 4x parallel)
  Tier 2 mismatches (~50 tables): Sample diff (0.4 hours)
  Tier 3+4: COUNT(*) on 3,800 tables (0.1 hours)
  Total: ~9.3 hours ✓ with 2.7 hours buffer for rollback
```

### 2.5 Concurrent Writes During Validation

The hardest problem in migration validation: the source is still receiving writes while you validate. This creates a moving target.

**Approaches to handle concurrent writes:**

1. **Freeze source**: Stop writes to source during validation. Simple but requires downtime.

2. **Point-in-time snapshot**: Use database time-travel (Snowflake `AT(TIMESTAMP => ...)`, PostgreSQL `pg_export_snapshot()`) to freeze a consistent read point.

3. **CDC-aware validation**: Track the CDC stream. Validation compares source-at-time-T with target-at-time-T, accounting for in-flight CDC events.

4. **Watermark-based validation**: Only validate rows with `updated_at < cutoff_time`. Rows modified after cutoff are expected to differ.

```sql
-- Snowflake: Point-in-time consistent validation
-- Step 1: Record the validation timestamp
SET validation_ts = (SELECT CURRENT_TIMESTAMP());

-- Step 2: Query source at that point in time
SELECT HASH_AGG(*) FROM source_db.orders
  AT(TIMESTAMP => $validation_ts);

-- Step 3: Wait for CDC lag to drain (e.g., 5 minutes)
-- Step 4: Query target at the same logical point
SELECT HASH_AGG(*) FROM target_db.orders
  AT(TIMESTAMP => DATEADD('minutes', 5, $validation_ts));
```

---

## 3. The Progressive Validation Pyramid for Migrations

### 3.1 The Pyramid

Applied specifically to migration contexts, the validation pyramid becomes a decision tree:

```
                    ┌─────────────┐
                    │  Level 6    │  Full row-level diff (HashDiff bisection)
                    │  FULL DIFF  │  Cost: $$$   Time: hours   Confidence: 100%
                    ├─────────────┤
                   │   Level 5    │  Sample-based row comparison
                   │   SAMPLE     │  Cost: $$    Time: minutes  Confidence: 99%+
                   ├──────────────┤
                  │    Level 4     │  HASH_AGG per partition
                  │    HASH        │  Cost: $     Time: seconds  Confidence: ~100%
                  ├────────────────┤
                 │     Level 3      │  Profile comparison (min/max/avg/stddev/nulls)
                 │     PROFILE      │  Cost: $     Time: seconds  Confidence: 95%
                 ├──────────────────┤
                │      Level 2       │  Row counts (total + per partition)
                │      COUNT         │  Cost: ~$0   Time: seconds  Confidence: 80%
                ├────────────────────┤
               │       Level 1        │  Schema match (columns, types, constraints)
               │       SCHEMA         │  Cost: $0    Time: instant  Confidence: 60%
               ├──────────────────────┤
              │        Level 0         │  Table exists, is accessible, has data
              │        METADATA        │  Cost: $0    Time: instant  Confidence: 40%
              └────────────────────────┘
```

**The escalation rule**: Start at Level 0. If a level passes, escalate to the next level. If a level fails, stop and report. Each level is dramatically cheaper than the next, so early termination saves the most money.

### 3.2 Level-by-Level Implementation

**Level 0: Metadata Check**

```sql
-- Does the target table exist?
SELECT table_name, table_type, row_count, bytes
FROM information_schema.tables
WHERE table_schema = 'PUBLIC'
  AND table_name = 'ORDERS';

-- Expected: exactly one row. Zero rows = table missing.
-- row_count = 0 = table exists but empty.
```

**Level 1: Schema Compatibility**

```sql
-- Source schema
SELECT column_name, data_type, is_nullable, character_maximum_length,
       numeric_precision, numeric_scale
FROM source_db.information_schema.columns
WHERE table_name = 'ORDERS'
ORDER BY ordinal_position;

-- Target schema
SELECT column_name, data_type, is_nullable, character_maximum_length,
       numeric_precision, numeric_scale
FROM target_db.information_schema.columns
WHERE table_name = 'ORDERS'
ORDER BY ordinal_position;
```

Common schema mismatches caught at this level:

| Source Type | Target Type | Issue | Severity |
|-------------|-------------|-------|----------|
| `NUMBER(10,2)` | `NUMBER(38,0)` | Decimal truncation | Critical |
| `TIMESTAMP_NTZ` | `TIMESTAMP_TZ` | Timezone semantics change | Warning |
| `CHAR(50)` | `VARCHAR(50)` | Trailing space behavior differs | Warning |
| `BINARY` | `VARCHAR` | Encoding change | Critical |
| `VARIANT` | `VARCHAR(16777216)` | JSON serialization format | Warning |

**Level 2: Row Counts**

```sql
-- Total count
SELECT 'source' AS side, COUNT(*) AS cnt FROM source_db.orders
UNION ALL
SELECT 'target' AS side, COUNT(*) AS cnt FROM target_db.orders;

-- Per-partition count (date-partitioned table)
SELECT
    DATE_TRUNC('month', created_at) AS partition_month,
    COUNT(*) AS cnt
FROM source_db.orders
GROUP BY 1
ORDER BY 1;

-- Compare with target
SELECT
    s.partition_month,
    s.cnt AS source_count,
    t.cnt AS target_count,
    s.cnt - t.cnt AS delta,
    ROUND(100.0 * ABS(s.cnt - t.cnt) / NULLIF(s.cnt, 0), 4) AS pct_diff
FROM source_counts s
FULL OUTER JOIN target_counts t ON s.partition_month = t.partition_month
WHERE s.cnt != t.cnt OR s.cnt IS NULL OR t.cnt IS NULL
ORDER BY ABS(delta) DESC;
```

**What counts catch**: Truncated loads, failed partitions, duplicate inserts, missing WHERE clauses in ETL. **What counts miss**: Row-level data corruption, column value changes, type coercion errors.

**Level 3: Statistical Profile**

```sql
-- Profile comparison for numeric columns
SELECT
    'source' AS side,
    COUNT(*) AS row_count,
    COUNT_IF(amount IS NULL) AS null_count,
    MIN(amount) AS min_val,
    MAX(amount) AS max_val,
    AVG(amount) AS avg_val,
    STDDEV(amount) AS stddev_val,
    APPROX_PERCENTILE(amount, 0.5) AS median_val,
    APPROX_COUNT_DISTINCT(customer_id) AS distinct_customers
FROM source_db.orders

UNION ALL

SELECT
    'target' AS side,
    COUNT(*) AS row_count,
    COUNT_IF(amount IS NULL) AS null_count,
    MIN(amount) AS min_val,
    MAX(amount) AS max_val,
    AVG(amount) AS avg_val,
    STDDEV(amount) AS stddev_val,
    APPROX_PERCENTILE(amount, 0.5) AS median_val,
    APPROX_COUNT_DISTINCT(customer_id) AS distinct_customers
FROM target_db.orders;
```

**Profile thresholds for migration validation:**

| Metric | Pass | Investigate | Fail |
|--------|------|-------------|------|
| Row count delta | 0 | 1-100 | > 100 |
| NULL count delta | 0 | 1-10 | > 10 |
| MIN/MAX | Exact match | Differs in last decimal | Different order of magnitude |
| AVG | Within 0.001% | Within 0.1% | > 0.1% |
| STDDEV | Within 1% | Within 5% | > 5% |
| Distinct count (HLL) | Within 2% (HLL error) | Within 5% | > 5% |

**Level 4: Content Hash**

```sql
-- Snowflake HASH_AGG (order-independent)
SELECT HASH_AGG(*) FROM source_db.orders;
SELECT HASH_AGG(*) FROM target_db.orders;

-- PostgreSQL equivalent (requires ordering for reproducibility)
SELECT MD5(STRING_AGG(t::TEXT, '|' ORDER BY primary_key))
FROM target_db.orders t;

-- BigQuery (FARM_FINGERPRINT is order-dependent, need aggregation)
SELECT BIT_XOR(FARM_FINGERPRINT(TO_JSON_STRING(t)))
FROM target_db.orders t;
```

**Critical caveat**: `HASH_AGG` is database-specific. You cannot compare a Snowflake `HASH_AGG` with a PostgreSQL `MD5(STRING_AGG(...))`. For cross-database hash comparison, compute the hash using the same algorithm on both sides — which means pulling data or using a common SQL expression like `MD5(CONCAT(col1, '|', col2, '|', ...))`.

**Level 5: Sample Diff**

```sql
-- Snowflake: Reproducible 1% sample
SELECT * FROM source_db.orders TABLESAMPLE BERNOULLI (1) SEED (42)
ORDER BY order_id;

-- Compare with target (same sample)
SELECT * FROM target_db.orders
WHERE order_id IN (
    SELECT order_id FROM source_db.orders TABLESAMPLE BERNOULLI (1) SEED (42)
)
ORDER BY order_id;
```

**Level 6: Full Diff (HashDiff Bisection)**

This is where Reladiff's HashDiff algorithm operates. Divide the key space into segments, compute per-segment hashes, recursively narrow to the differing rows. See [Section 14](#14-reladiff-engine-positioning) for details.

### 3.3 Decision Matrix: When to Skip Levels

| Scenario | Start At | Rationale |
|----------|----------|-----------|
| Same database engine, schema-only change | Level 2 | Schema is known-compatible |
| Cross-database, first-time migration | Level 0 | Everything could be wrong |
| Incremental sync (daily partition) | Level 4 | Schema/count unlikely to change |
| Post-incident re-validation | Level 4 | Need content verification |
| Compliance audit | Level 6 | Zero tolerance for differences |
| Development/staging refresh | Level 2 | Lower stakes |

---

## 4. Sampling Strategies with Statistical Guarantees

### 4.1 The Mathematics of Sampling

For a population of N rows where we want to detect a defect rate p with confidence level C and margin of error E:

**Sample size formula** (for proportions):

```
n = (Z² × p × (1-p)) / E²
```

Where Z is the Z-score for the confidence level:
- 90% confidence: Z = 1.645
- 95% confidence: Z = 1.960
- 99% confidence: Z = 2.576
- 99.9% confidence: Z = 3.291

**Finite population correction** (when n/N > 5%):

```
n_adjusted = n / (1 + (n - 1) / N)
```

### 4.2 Practical Sample Size Tables

**Scenario: Detect if more than 0.1% of rows have errors (p = 0.001)**

| Population Size | 95% Confidence, 0.1% Margin | 99% Confidence, 0.1% Margin | 99.9% Confidence, 0.1% Margin |
|----------------|----------------------------|----------------------------|-------------------------------|
| 100,000 | 3,796 (3.8%) | 6,564 (6.6%) | 10,706 (10.7%) |
| 1,000,000 | 3,838 (0.38%) | 6,637 (0.66%) | 10,827 (1.1%) |
| 10,000,000 | 3,842 (0.038%) | 6,644 (0.066%) | 10,839 (0.11%) |
| 100,000,000 | 3,843 (0.004%) | 6,645 (0.007%) | 10,840 (0.011%) |
| 1,000,000,000 | 3,843 (0.0004%) | 6,645 (0.0007%) | 10,841 (0.001%) |

**Key insight**: Beyond ~1M rows, sample size is almost independent of population size. You need roughly the same number of samples whether you have 1M or 1B rows.

### 4.3 Stratified Sampling for Migrations

Uniform random sampling can miss concentrated errors (e.g., all errors in a single partition). Stratified sampling divides the population into strata and samples proportionally:

```sql
-- Stratified sample by date partition (Snowflake)
WITH strata AS (
    SELECT
        DATE_TRUNC('month', created_at) AS stratum,
        COUNT(*) AS stratum_size,
        -- Allocate samples proportionally, minimum 100 per stratum
        GREATEST(100, ROUND(COUNT(*) * 3843.0 / total_count)) AS sample_allocation
    FROM source_db.orders
    CROSS JOIN (SELECT COUNT(*) AS total_count FROM source_db.orders)
    GROUP BY 1
),
sampled AS (
    SELECT o.*, s.stratum,
           ROW_NUMBER() OVER (
               PARTITION BY DATE_TRUNC('month', o.created_at)
               ORDER BY RANDOM(42)
           ) AS rn
    FROM source_db.orders o
    JOIN strata s ON DATE_TRUNC('month', o.created_at) = s.stratum
)
SELECT * FROM sampled WHERE rn <= sample_allocation;
```

**Stratification dimensions for migration validation:**

| Dimension | Why It Matters |
|-----------|---------------|
| Date partition | Errors often correlate with specific load dates |
| Source system | Multi-source migrations may fail differently per source |
| Data type mix | Tables with complex types (JSON, ARRAY) have higher coercion risk |
| Row size | Large rows (LOBs) may be truncated differently |
| NULL density | High-NULL columns behave differently across databases |

### 4.4 Sequential Sampling (Wald's SPRT)

For migration validation, you often want to answer a binary question: "Is the error rate below threshold T?" Sequential Probability Ratio Test (SPRT) is more efficient than fixed-size sampling because it can stop early:

```python
import math

def sequential_migration_validation(
    source_rows, target_rows, key_column: str,
    acceptable_rate: float = 0.001,    # H0: error rate <= 0.1%
    unacceptable_rate: float = 0.01,   # H1: error rate >= 1%
    alpha: float = 0.05,               # False positive rate
    beta: float = 0.05,                # False negative rate
):
    """Wald's Sequential Probability Ratio Test for migration validation.

    Stops as soon as enough evidence is gathered to accept or reject.
    On average, requires 50-80% fewer samples than fixed-size tests.
    """
    A = (1 - beta) / alpha          # Upper boundary (reject H0)
    B = beta / (1 - alpha)          # Lower boundary (accept H0)

    log_A = math.log(A)
    log_B = math.log(B)

    cumulative_log_ratio = 0.0
    n = 0
    errors = 0

    for source_row, target_row in zip(source_rows, target_rows):
        n += 1
        is_error = not rows_match(source_row, target_row)
        if is_error:
            errors += 1

        # Log likelihood ratio update
        if is_error:
            cumulative_log_ratio += math.log(
                unacceptable_rate / acceptable_rate
            )
        else:
            cumulative_log_ratio += math.log(
                (1 - unacceptable_rate) / (1 - acceptable_rate)
            )

        # Decision boundaries
        if cumulative_log_ratio >= log_A:
            return {
                "decision": "REJECT",
                "message": f"Error rate likely >= {unacceptable_rate:.1%}",
                "samples_checked": n,
                "errors_found": errors,
                "observed_rate": errors / n,
            }
        elif cumulative_log_ratio <= log_B:
            return {
                "decision": "ACCEPT",
                "message": f"Error rate likely <= {acceptable_rate:.1%}",
                "samples_checked": n,
                "errors_found": errors,
                "observed_rate": errors / n,
            }

    return {
        "decision": "INCONCLUSIVE",
        "samples_checked": n,
        "errors_found": errors,
    }
```

**SPRT advantage for migrations**: On a clean migration (error rate ~0%), SPRT reaches "ACCEPT" after ~200 samples regardless of table size. On a broken migration (error rate ~5%), it reaches "REJECT" after ~50 samples. Fixed-size testing always requires the full sample.

### 4.5 Reservoir Sampling for Streaming Validation

During CDC-based migrations, rows arrive as a stream. Reservoir sampling maintains a uniform random sample of fixed size from an unbounded stream:

```python
import random

class ReservoirValidator:
    """Maintain a uniform random sample during streaming migration."""

    def __init__(self, reservoir_size: int = 10000, seed: int = 42):
        self.k = reservoir_size
        self.reservoir: list[tuple] = []
        self.n = 0
        self.rng = random.Random(seed)
        self.mismatches = 0

    def observe(self, source_row: tuple, target_row: tuple):
        self.n += 1

        if self.n <= self.k:
            self.reservoir.append((source_row, target_row))
        else:
            j = self.rng.randint(0, self.n - 1)
            if j < self.k:
                self.reservoir[j] = (source_row, target_row)

        if source_row != target_row:
            self.mismatches += 1

    @property
    def error_rate(self) -> float:
        return self.mismatches / max(self.n, 1)

    def validate_reservoir(self) -> dict:
        """Deep-compare all rows in the reservoir."""
        reservoir_mismatches = sum(
            1 for s, t in self.reservoir if s != t
        )
        return {
            "reservoir_size": len(self.reservoir),
            "total_observed": self.n,
            "streaming_mismatches": self.mismatches,
            "reservoir_mismatches": reservoir_mismatches,
            "estimated_error_rate": self.error_rate,
        }
```

---

## 5. Zero-Downtime Migration Validation

### 5.1 Dual-Write Verification

The gold standard for zero-downtime migrations: write to both source and target simultaneously, then compare.

```
Application
    ├── Write → Source DB (primary)
    │       └── CDC → Target DB (replica)
    │
    └── Read ← Source DB (primary)
         └── Shadow Read ← Target DB (compare results)
```

**Implementation patterns:**

**Pattern 1: Application-Level Dual Write**

```python
class DualWriteValidator:
    """Write to both databases, compare results."""

    def __init__(self, source_db, target_db, sample_rate: float = 0.10):
        self.source = source_db
        self.target = target_db
        self.sample_rate = sample_rate
        self.comparisons = 0
        self.mismatches = 0

    async def write(self, table: str, data: dict):
        # Write to source (authoritative)
        source_result = await self.source.insert(table, data)

        # Write to target (best-effort)
        try:
            target_result = await self.target.insert(table, data)
        except Exception as e:
            log_dual_write_failure(table, data, e)
            return source_result

        # Probabilistic read-back verification
        if random.random() < self.sample_rate:
            await self._verify_write(table, data)

        return source_result

    async def _verify_write(self, table: str, data: dict):
        """Read back from both and compare."""
        self.comparisons += 1
        key = data.get("id") or data.get("primary_key")

        source_row = await self.source.read(table, key)
        # Allow replication lag
        await asyncio.sleep(0.5)
        target_row = await self.target.read(table, key)

        if source_row != target_row:
            self.mismatches += 1
            log_mismatch(table, key, source_row, target_row)
```

**Pattern 2: Shadow Traffic (Read Path)**

More common and less risky than dual-write. Send all reads to both databases, compare responses, but only return the source response to the user:

```python
class ShadowReadValidator:
    """Compare read results between source and target databases."""

    def __init__(self, source_db, target_db):
        self.source = source_db
        self.target = target_db
        self.metrics = {
            "total_reads": 0,
            "shadow_reads": 0,
            "matches": 0,
            "mismatches": 0,
            "target_errors": 0,
            "target_slower": 0,
        }

    async def read(self, query: str):
        self.metrics["total_reads"] += 1

        # Source is authoritative
        source_start = time.monotonic()
        source_result = await self.source.execute(query)
        source_time = time.monotonic() - source_start

        # Shadow read from target (fire-and-forget, don't block user)
        asyncio.create_task(
            self._shadow_compare(query, source_result, source_time)
        )

        return source_result

    async def _shadow_compare(self, query, source_result, source_time):
        self.metrics["shadow_reads"] += 1
        try:
            target_start = time.monotonic()
            target_result = await self.target.execute(query)
            target_time = time.monotonic() - target_start

            if target_time > source_time * 1.5:
                self.metrics["target_slower"] += 1

            if results_equivalent(source_result, target_result):
                self.metrics["matches"] += 1
            else:
                self.metrics["mismatches"] += 1
                log_shadow_mismatch(query, source_result, target_result)

        except Exception as e:
            self.metrics["target_errors"] += 1
            log_shadow_error(query, e)
```

### 5.2 The GitHub Approach: Scientist

GitHub's `scientist` library (Ruby, with ports to Python/Go/Java) formalizes the shadow comparison pattern:

```python
# Conceptual Python equivalent of GitHub's Scientist
class Experiment:
    def __init__(self, name: str):
        self.name = name
        self.control = None       # Old code path (source of truth)
        self.candidate = None     # New code path (being validated)

    def use(self, fn):
        """The control (old) code path. Its result is always returned."""
        self.control = fn

    def try_candidate(self, fn):
        """The candidate (new) code path. Compared but not returned."""
        self.candidate = fn

    def run(self):
        # Always run control
        control_result = self.control()

        # Run candidate in parallel, catch all errors
        try:
            candidate_result = self.candidate()
            if control_result != candidate_result:
                publish_mismatch(self.name, control_result, candidate_result)
        except Exception as e:
            publish_candidate_error(self.name, e)

        # Always return control
        return control_result
```

GitHub used this pattern to migrate their primary MySQL database. Key learnings:

1. **Run experiments for weeks, not hours**. Rare code paths only trigger occasionally.
2. **Compare semantically, not byte-for-byte**. Timestamps, ordering, and floating-point precision will differ.
3. **Build dashboards on mismatch rates**. A rate that trends toward zero is your green light for cutover.
4. **Percentage rollout**: Start with 1% of traffic as shadow reads, increase to 100% over days.

### 5.3 Stripe's Online Migration Framework

Stripe migrates databases with zero downtime using a four-phase approach documented in their engineering blog:

**Phase 1: Dual Write** — Write to both old and new storage. New storage is not read.

**Phase 2: Shadow Read** — Read from both. Old storage is authoritative. Compare and log differences.

**Phase 3: New Primary** — Read from new storage as primary. Old storage is shadow. Compare and log.

**Phase 4: Old Decommission** — Stop writing to old storage. New storage is sole authority.

Each phase transition requires:
- Mismatch rate below threshold (0.001% for Stripe)
- No elevated error rates for 72 hours
- Sign-off from the owning team

### 5.4 Validation During Blue-Green Database Cutover

```
                    ┌──────────────┐
                    │  Load        │
                    │  Balancer    │
                    └──────┬───────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
        ┌─────┴─────┐     │     ┌──────┴────┐
        │  Blue DB   │     │     │  Green DB  │
        │  (current) │◄────┘     │  (target)  │
        │            │           │            │
        │  Writes ✓  │    CDC    │  Writes ✗  │
        │  Reads ✓   │───────►  │  Reads ✗   │
        └────────────┘           └────────────┘
                                       │
                              ┌────────┴────────┐
                              │  Validation      │
                              │  Queries Running │
                              │  Continuously    │
                              └─────────────────┘
```

Validation runs continuously against Green while Blue serves traffic:

1. **Count parity check** every 60 seconds
2. **Hash comparison** every 5 minutes on incrementally updated partitions
3. **Sample diff** every 15 minutes on random 0.1% sample
4. **Full diff** once daily on Tier 1 tables

When all checks pass for 24 hours, flip the load balancer to Green.

---

## 6. Partition-Aware Validation

### 6.1 Why Partitions Change Everything

A 10 TB table partitioned by date into daily partitions:
- 365 partitions × ~27 GB each
- Full table scan: $50+ on Snowflake
- Single partition scan: ~$0.14 on Snowflake
- **If you know only today's partition changed, validation cost drops 365x**

### 6.2 Partition Change Detection

**Strategy 1: Metadata-Based (Free)**

```sql
-- Snowflake: Check partition modification times
SELECT
    partition_key,
    row_count,
    bytes,
    last_modified
FROM TABLE(
    INFORMATION_SCHEMA.TABLE_STORAGE_METRICS(
        TABLE_SCHEMA => 'PUBLIC',
        TABLE_NAME => 'ORDERS'
    )
)
ORDER BY last_modified DESC
LIMIT 10;
```

**Strategy 2: Watermark Table**

```sql
-- Track which partitions have been validated
CREATE TABLE IF NOT EXISTS validation_watermarks (
    table_name VARCHAR,
    partition_key VARCHAR,
    partition_value VARCHAR,
    source_hash BIGINT,
    target_hash BIGINT,
    validated_at TIMESTAMP_NTZ,
    status VARCHAR,  -- 'MATCH', 'MISMATCH', 'PENDING'
    PRIMARY KEY (table_name, partition_key, partition_value)
);

-- Check which partitions need re-validation
SELECT
    p.partition_value,
    p.row_count AS current_rows,
    w.source_hash AS last_validated_hash
FROM table_partitions p
LEFT JOIN validation_watermarks w
    ON p.table_name = w.table_name
    AND p.partition_value = w.partition_value
WHERE w.validated_at IS NULL
   OR w.validated_at < p.last_modified
ORDER BY p.partition_value;
```

**Strategy 3: Hash-Per-Partition (Cheap)**

```sql
-- Snowflake: HASH_AGG per partition
SELECT
    DATE_TRUNC('day', created_at) AS partition_day,
    COUNT(*) AS row_count,
    HASH_AGG(*) AS partition_hash
FROM source_db.orders
GROUP BY 1
ORDER BY 1;
```

### 6.3 Parallel Partition Validation

```python
import asyncio
from dataclasses import dataclass

@dataclass
class PartitionValidationResult:
    partition_key: str
    source_count: int
    target_count: int
    source_hash: int | None
    target_hash: int | None
    status: str  # 'MATCH', 'COUNT_MISMATCH', 'HASH_MISMATCH', 'ERROR'
    duration_seconds: float

async def validate_partition(
    source_conn, target_conn,
    table: str, partition_col: str, partition_value: str,
) -> PartitionValidationResult:
    """Validate a single partition across source and target."""
    import time
    start = time.monotonic()

    where = f"WHERE {partition_col} = '{partition_value}'"

    source_count, target_count = await asyncio.gather(
        source_conn.fetchval(f"SELECT COUNT(*) FROM {table} {where}"),
        target_conn.fetchval(f"SELECT COUNT(*) FROM {table} {where}"),
    )

    if source_count != target_count:
        return PartitionValidationResult(
            partition_key=partition_value,
            source_count=source_count,
            target_count=target_count,
            source_hash=None, target_hash=None,
            status="COUNT_MISMATCH",
            duration_seconds=time.monotonic() - start,
        )

    # Counts match — check hashes
    source_hash, target_hash = await asyncio.gather(
        source_conn.fetchval(f"SELECT HASH_AGG(*) FROM {table} {where}"),
        target_conn.fetchval(f"SELECT HASH_AGG(*) FROM {table} {where}"),
    )

    status = "MATCH" if source_hash == target_hash else "HASH_MISMATCH"

    return PartitionValidationResult(
        partition_key=partition_value,
        source_count=source_count,
        target_count=target_count,
        source_hash=source_hash,
        target_hash=target_hash,
        status=status,
        duration_seconds=time.monotonic() - start,
    )


async def validate_all_partitions(
    source_conn, target_conn,
    table: str, partition_col: str, partition_values: list[str],
    max_concurrent: int = 10,
) -> list[PartitionValidationResult]:
    """Validate all partitions with bounded concurrency."""
    semaphore = asyncio.Semaphore(max_concurrent)

    async def bounded_validate(pv):
        async with semaphore:
            return await validate_partition(
                source_conn, target_conn, table, partition_col, pv
            )

    results = await asyncio.gather(
        *[bounded_validate(pv) for pv in partition_values]
    )

    # Summary
    matches = sum(1 for r in results if r.status == "MATCH")
    mismatches = [r for r in results if r.status != "MATCH"]
    print(f"Validated {len(results)} partitions: "
          f"{matches} match, {len(mismatches)} need investigation")

    return list(results)
```

### 6.4 Blast Radius Reduction

Partition-aware validation limits the blast radius of any discovered problem:

```
Full table diff fails → "Something is wrong with orders" → Must investigate all 10 TB

Partition diff fails  → "Partition 2026-03-10 has 47 mismatches" → Investigate 27 GB
                        "All other 364 partitions match" → 99.7% confirmed correct
```

**Migration teams at Shopify** reported that partition-aware validation reduced investigation time by 90%+ because engineers could immediately identify which ETL run or CDC batch was responsible for the discrepancy.

### 6.5 Partition Strategies by Database

| Database | Native Partitioning | Validation-Friendly? | Notes |
|----------|-------------------|---------------------|-------|
| Snowflake | Micro-partitions (automatic) | Partial — no user-addressable partitions | Use clustering key columns in GROUP BY |
| BigQuery | Partition by date/integer/ingestion time | Excellent — `_PARTITIONDATE` pseudo-column | Partition pruning reduces scan cost |
| Databricks | Hive-style partitioning | Excellent — directory-level access | Can validate at file level |
| PostgreSQL | Declarative (RANGE, LIST, HASH) | Good — each partition is a separate table | Can validate individual partitions independently |
| Oracle | RANGE, LIST, HASH, COMPOSITE | Excellent — `PARTITION(p_name)` syntax | Most mature partitioning in the industry |
| Redshift | Distribution + sort keys | Poor — no true partitions | Use sort key ranges as logical partitions |

---

## 7. Time-Travel for Migration Validation

### 7.1 The Problem: Validating Against a Moving Target

During migration, the source continues to receive writes. By the time you query the target for comparison, the source has changed. Time-travel solves this by letting you query a consistent historical snapshot.

### 7.2 Snowflake TIME TRAVEL

```sql
-- Query source as it was at a specific timestamp
SELECT HASH_AGG(*) FROM source_db.orders
  AT(TIMESTAMP => '2026-03-13 10:00:00'::TIMESTAMP_NTZ);

-- Query source as it was before a specific statement
SELECT HASH_AGG(*) FROM source_db.orders
  BEFORE(STATEMENT => '01b5e3a2-0002-b5d6-0000-000500016e29');

-- Query source as it was N seconds ago
SELECT HASH_AGG(*) FROM source_db.orders
  AT(OFFSET => -3600);  -- 1 hour ago
```

**Configuration**:
- `DATA_RETENTION_TIME_IN_DAYS`: 1 day (Standard), up to 90 days (Enterprise+)
- Cost: Retained data consumes storage ($23/TB/month on-demand)
- Enterprise edition required for > 1 day retention

**Migration validation workflow with TIME TRAVEL:**

```sql
-- Step 1: Mark migration start
SET migration_start = CURRENT_TIMESTAMP();

-- Step 2: Run migration (may take hours)
-- ... migration proceeds ...

-- Step 3: Mark migration end
SET migration_end = CURRENT_TIMESTAMP();

-- Step 4: Validate target against source-at-migration-start
-- This ensures we're comparing the same logical dataset
SELECT
    (SELECT COUNT(*) FROM source_db.orders AT(TIMESTAMP => $migration_start))
      AS source_count,
    (SELECT COUNT(*) FROM target_db.orders)
      AS target_count;

-- Step 5: Identify rows that changed in source DURING migration
SELECT COUNT(*) AS changed_during_migration
FROM source_db.orders
WHERE updated_at BETWEEN $migration_start AND $migration_end;

-- Step 6: These rows need separate CDC-based validation
```

### 7.3 BigQuery Snapshot Decorators and Time Travel

```sql
-- Query table as of a specific time (up to 7 days)
SELECT FARM_FINGERPRINT(TO_JSON_STRING(t))
FROM `project.dataset.orders`
  FOR SYSTEM_TIME AS OF TIMESTAMP('2026-03-13 10:00:00 UTC') AS t;

-- Create a snapshot for persistent reference
CREATE SNAPSHOT TABLE `project.dataset.orders_migration_snapshot`
CLONE `project.dataset.orders`
FOR SYSTEM_TIME AS OF TIMESTAMP('2026-03-13 10:00:00 UTC');
-- Snapshot costs: storage only (no compute to create)
-- Snapshots share storage with base table for unchanged data
```

**BigQuery time-travel details:**
- Default: 7 days retention (configurable via `OPTIONS(max_time_travel_hours=168)`)
- Snapshots can be retained indefinitely (billed as storage)
- `FOR SYSTEM_TIME AS OF` works in all DML and DDL contexts
- **Cost optimization**: Create a snapshot before migration. Validate against the snapshot. Delete snapshot after validation.

### 7.4 PostgreSQL Temporal Tables

PostgreSQL does not have native time-travel, but several approaches exist:

**Approach 1: `pg_export_snapshot()` for transaction-consistent reads**

```sql
-- Session 1: Create a snapshot
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ;
SELECT pg_export_snapshot();
-- Returns something like: '00000003-0000001A-1'

-- Session 2: Use the snapshot for consistent read
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ;
SET TRANSACTION SNAPSHOT '00000003-0000001A-1';
SELECT COUNT(*) FROM orders;  -- Sees data as of Session 1's snapshot
COMMIT;

-- Session 1: Can now proceed
COMMIT;
```

**Limitation**: Snapshot is only valid while Session 1's transaction is open. Not suitable for multi-hour validations.

**Approach 2: Temporal tables (SQL:2011 system-versioned)**

```sql
-- Create a system-versioned temporal table (requires extension or PG 17+)
CREATE TABLE orders (
    order_id BIGINT PRIMARY KEY,
    amount NUMERIC(10,2),
    sys_period TSTZRANGE NOT NULL DEFAULT TSTZRANGE(CURRENT_TIMESTAMP, NULL)
);

CREATE TABLE orders_history (LIKE orders);

CREATE TRIGGER versioning_trigger
BEFORE INSERT OR UPDATE OR DELETE ON orders
FOR EACH ROW EXECUTE PROCEDURE versioning(
    'sys_period', 'orders_history', true
);

-- Query historical state
SELECT * FROM orders_history
WHERE sys_period @> '2026-03-13 10:00:00+00'::TIMESTAMPTZ;
```

**Approach 3: Logical replication snapshots**

```sql
-- Create a replication slot (holds a consistent snapshot)
SELECT pg_create_logical_replication_slot('migration_validation', 'pgoutput');

-- The slot's consistent_point gives you a consistent view
-- Use pg_logical_slot_peek_changes() to see changes since that point
```

### 7.5 Databricks Delta Lake Time Travel

```sql
-- Query by version number
SELECT * FROM orders VERSION AS OF 42;

-- Query by timestamp
SELECT * FROM orders TIMESTAMP AS OF '2026-03-13 10:00:00';

-- Compare two versions
SELECT
    (SELECT COUNT(*) FROM orders VERSION AS OF 41) AS before_migration,
    (SELECT COUNT(*) FROM orders VERSION AS OF 42) AS after_migration;

-- View the audit log of all changes
DESCRIBE HISTORY orders;
```

**Delta Lake retention**: Default 30 days for time-travel. Configurable via `delta.logRetentionDuration` and `delta.deletedFileRetentionDuration`.

### 7.6 Cross-Database Time-Travel Coordination

The fundamental challenge: you need *both* source and target at the same logical point in time. Strategies:

| Strategy | Complexity | Accuracy | Works Cross-Cloud? |
|----------|-----------|----------|-------------------|
| Synchronized timestamps | Low | Approximate (clock skew) | Yes |
| CDC sequence markers | Medium | Exact (logical consistency) | Yes |
| Quiesce-then-snapshot | Low | Exact (downtime required) | Yes |
| Application-level fencing | High | Exact (no downtime) | Yes |

**CDC sequence marker approach:**

```python
def coordinated_time_travel_validation(
    source_conn,  # Snowflake
    target_conn,  # BigQuery
    cdc_conn,     # CDC metadata store
    table: str,
):
    """Validate using CDC sequence numbers for cross-database coordination."""

    # Step 1: Get the last fully-applied CDC sequence on target
    last_applied_seq = cdc_conn.execute(
        "SELECT max_sequence FROM cdc_checkpoints WHERE table_name = %s",
        (table,)
    ).scalar()

    # Step 2: Find the corresponding Snowflake timestamp for that sequence
    source_ts = source_conn.execute(f"""
        SELECT MAX(updated_at)
        FROM {table}
        WHERE _cdc_sequence <= {last_applied_seq}
    """).scalar()

    # Step 3: Validate source-at-that-timestamp vs target-as-is
    source_hash = source_conn.execute(f"""
        SELECT HASH_AGG(*)
        FROM {table}
        AT(TIMESTAMP => '{source_ts}'::TIMESTAMP_NTZ)
    """).scalar()

    # BigQuery target is already at that logical point
    target_hash = target_conn.execute(f"""
        SELECT BIT_XOR(FARM_FINGERPRINT(TO_JSON_STRING(t)))
        FROM `dataset.{table}` t
    """).scalar()

    # Note: these hashes use different algorithms — cannot compare directly.
    # Instead, use row-level comparison on a sample.
    return {"source_ts": source_ts, "cdc_sequence": last_applied_seq}
```

---

## 8. Data Type Coercion During Migration

### 8.1 The Silent Data Loss Taxonomy

Data type changes during migration fall into three categories:

**Lossless (Safe)**: `INT` → `BIGINT`, `VARCHAR(50)` → `VARCHAR(100)`, `FLOAT` → `DOUBLE`

**Lossy (Dangerous)**: `BIGINT` → `INT` (overflow), `VARCHAR(100)` → `VARCHAR(50)` (truncation), `DOUBLE` → `FLOAT` (precision loss), `TIMESTAMP_TZ` → `TIMESTAMP_NTZ` (timezone information lost)

**Semantic (Subtle)**: `CHAR(10)` → `VARCHAR(10)` (trailing space behavior changes), `BOOLEAN` → `INT` (representation changes), `DATE` → `TIMESTAMP` (midnight assumption), `JSON` → `VARCHAR` (serialization format varies)

### 8.2 Common Coercion Matrix

| Source Type (Oracle) | Target Type (Snowflake) | Coercion Risk | Validation Check |
|---------------------|------------------------|---------------|------------------|
| `NUMBER(10,0)` | `NUMBER(10,0)` | None | Count match |
| `NUMBER(38,10)` | `NUMBER(38,10)` | None | SUM/AVG match |
| `VARCHAR2(4000)` | `VARCHAR(4000)` | None | Length histogram match |
| `CLOB` | `VARCHAR(16777216)` | Truncation > 16MB | `MAX(LENGTH(col))` check |
| `DATE` | `TIMESTAMP_NTZ` | Oracle DATE includes time; Snowflake DATE does not | Check if time component exists |
| `CHAR(10)` | `VARCHAR(10)` | Trailing spaces | `WHERE col != RTRIM(col)` |
| `RAW(16)` | `BINARY(16)` | None | Hex comparison |
| `XMLTYPE` | `VARIANT` | Serialization differences | Parse and compare DOM |
| `INTERVAL` | Not supported | Complete data loss | Must decompose to components |
| `LONG` | `VARCHAR(16777216)` | Deprecated Oracle type, odd behavior | Full content verification |

| Source Type (PostgreSQL) | Target Type (Snowflake) | Coercion Risk | Validation Check |
|------------------------|------------------------|---------------|------------------|
| `NUMERIC` (unbounded) | `NUMBER(38,18)` | Precision > 38 digits | `MAX(LENGTH(col::TEXT))` |
| `TEXT` | `VARCHAR(16777216)` | None | Length check |
| `BOOLEAN` | `BOOLEAN` | `t/f` → `true/false` display | Semantic match |
| `TIMESTAMPTZ` | `TIMESTAMP_TZ` | Microsecond vs nanosecond | `ABS(EXTRACT(EPOCH FROM src) - EXTRACT(EPOCH FROM tgt)) < 0.000001` |
| `JSONB` | `VARIANT` | Key ordering, numeric precision | Parse and deep-compare |
| `ARRAY` | `ARRAY` | Element type coercion | Element-wise comparison |
| `UUID` | `VARCHAR(36)` | String representation | Case-insensitive match |
| `INET` | `VARCHAR` | Loses type validation | Regex validation on target |
| `HSTORE` | `VARIANT` | Key-value semantics preserved | Key count + value comparison |

### 8.3 Validation SQL for Common Coercions

**INT → BIGINT (detecting overflow before migration):**

```sql
-- Pre-migration: Check if any values exceed INT range
SELECT
    COUNT(*) AS total_rows,
    COUNT_IF(big_col > 2147483647 OR big_col < -2147483648) AS overflow_count,
    MIN(big_col) AS min_val,
    MAX(big_col) AS max_val
FROM source_table;
-- If overflow_count > 0, must use BIGINT in target
```

**VARCHAR → TEXT (detecting truncation):**

```sql
-- Pre-migration: Check if any values exceed target length
SELECT
    column_name,
    MAX(LENGTH(col_value)) AS max_length,
    COUNT_IF(LENGTH(col_value) > 255) AS exceeds_255,
    COUNT_IF(LENGTH(col_value) > 4000) AS exceeds_4000
FROM source_table;
```

**TIMESTAMP timezone-naive → timezone-aware:**

```sql
-- Post-migration validation: Ensure timezone conversion is correct
SELECT
    s.id,
    s.created_at AS source_naive,
    t.created_at AS target_aware,
    -- Source was stored as UTC (implicit)
    -- Target should be UTC explicit
    ABS(EXTRACT(EPOCH FROM t.created_at) -
        EXTRACT(EPOCH FROM s.created_at::TIMESTAMP AT TIME ZONE 'UTC'))
        AS seconds_diff
FROM source_table s
JOIN target_table t ON s.id = t.id
WHERE ABS(EXTRACT(EPOCH FROM t.created_at) -
          EXTRACT(EPOCH FROM s.created_at::TIMESTAMP AT TIME ZONE 'UTC')) > 1
LIMIT 100;
```

**JSON key ordering (cross-database):**

```python
import json

def normalize_json_for_comparison(json_str: str) -> str:
    """Normalize JSON for cross-database comparison.

    Different databases serialize JSON differently:
    - Snowflake: alphabetical key order, compact
    - PostgreSQL JSONB: alphabetical key order, compact (but different whitespace)
    - BigQuery JSON: insertion order, may have whitespace
    - MySQL JSON: alphabetical key order
    """
    try:
        parsed = json.loads(json_str)
        return json.dumps(parsed, sort_keys=True, separators=(',', ':'))
    except (json.JSONDecodeError, TypeError):
        return json_str
```

### 8.4 Automated Coercion Detection

```python
from dataclasses import dataclass
from enum import Enum

class CoercionRisk(Enum):
    SAFE = "safe"
    WARNING = "warning"
    DANGEROUS = "dangerous"
    UNSUPPORTED = "unsupported"

@dataclass
class CoercionAnalysis:
    source_type: str
    target_type: str
    risk: CoercionRisk
    check_sql: str
    description: str

COERCION_RULES: list[CoercionAnalysis] = [
    CoercionAnalysis(
        source_type="NUMBER(*,>0)",
        target_type="NUMBER(*,0)",
        risk=CoercionRisk.DANGEROUS,
        check_sql="SELECT COUNT_IF({col} != ROUND({col})) FROM {table}",
        description="Decimal places will be silently truncated",
    ),
    CoercionAnalysis(
        source_type="TIMESTAMP_TZ",
        target_type="TIMESTAMP_NTZ",
        risk=CoercionRisk.DANGEROUS,
        check_sql=(
            "SELECT COUNT(DISTINCT EXTRACT(TIMEZONE_HOUR FROM {col})) "
            "FROM {table}"
        ),
        description=(
            "Timezone info will be lost. "
            "If multiple timezones exist, data corruption."
        ),
    ),
    CoercionAnalysis(
        source_type="CHAR(*)",
        target_type="VARCHAR(*)",
        risk=CoercionRisk.WARNING,
        check_sql=(
            "SELECT COUNT_IF(RIGHT({col}, 1) = ' ') "
            "FROM {table}"
        ),
        description=(
            "Trailing spaces will be preserved in VARCHAR but may have been "
            "semantically ignored in CHAR comparisons"
        ),
    ),
    CoercionAnalysis(
        source_type="FLOAT/DOUBLE",
        target_type="NUMBER(*,*)",
        risk=CoercionRisk.WARNING,
        check_sql=(
            "SELECT COUNT_IF({col}::TEXT LIKE '%e%' OR {col}::TEXT LIKE '%E%') "
            "FROM {table}"
        ),
        description="Scientific notation values may round differently in NUMERIC",
    ),
]

def analyze_migration_coercions(
    source_schema: dict[str, str],
    target_schema: dict[str, str],
) -> list[CoercionAnalysis]:
    """Analyze type coercions between source and target schema."""
    findings = []
    for col, source_type in source_schema.items():
        target_type = target_schema.get(col)
        if target_type is None:
            findings.append(CoercionAnalysis(
                source_type=source_type,
                target_type="MISSING",
                risk=CoercionRisk.DANGEROUS,
                check_sql="",
                description=f"Column {col} missing from target schema",
            ))
            continue

        if source_type.upper() != target_type.upper():
            for rule in COERCION_RULES:
                if matches_type_pattern(source_type, rule.source_type) and \
                   matches_type_pattern(target_type, rule.target_type):
                    findings.append(rule)
                    break

    return findings
```

---

## 9. Rollback Decision Criteria

### 9.1 The Rollback Decision Framework

Rollback is the most consequential decision in a migration. Too trigger-happy, and the migration never completes. Too lenient, and corrupted data reaches production.

**The three-axis model:**

```
                    Severity
                       ↑
                       │
            ROLLBACK   │   ROLLBACK
            (many +    │   (any
             severe)   │    critical)
                       │
         ──────────────┼──────────────→ Breadth
                       │
            CONTINUE   │   INVESTIGATE
            (few +     │   (many but
             minor)    │    minor)
                       │
```

**Severity**: How bad are the individual mismatches?
- **Critical**: Financial amounts wrong, PII corrupted, referential integrity broken
- **Major**: Non-financial data wrong, timestamps shifted, encoding issues
- **Minor**: Trailing whitespace, case differences, JSON key ordering

**Breadth**: How many tables/rows are affected?
- **Isolated**: < 0.01% of rows in < 5% of tables
- **Moderate**: 0.01-1% of rows or 5-20% of tables
- **Widespread**: > 1% of rows or > 20% of tables

### 9.2 Quantitative Rollback Thresholds

Based on patterns from large migrations (Capital One, Stripe, Shopify, Netflix):

| Metric | Continue | Investigate | Rollback |
|--------|----------|-------------|----------|
| Row count delta (per table) | 0 | 1-100 | > 100 |
| Row count delta (percentage) | 0% | < 0.001% | > 0.001% |
| Hash mismatch (HASH_AGG) | 0 tables | 1-5 Tier 3 tables | Any Tier 1 table |
| Sample diff error rate | 0 | < 0.01% | > 0.01% |
| Full diff mismatched rows | 0 | < 100 (explainable) | > 100 or unexplainable |
| Schema differences | 0 | Expected coercions only | Unexpected type changes |
| NULL rate change | < 0.1% | 0.1-1% | > 1% |
| Distinct count change | < 2% (HLL error) | 2-5% | > 5% |
| Financial column SUM delta | $0.00 | < $0.01 (rounding) | > $0.01 |

### 9.3 Time-Bounded Decision Making

Validation has a time budget. If the validation itself runs over budget, that is a rollback signal.

```python
from datetime import datetime, timedelta, timezone

@dataclass
class RollbackPolicy:
    max_validation_duration: timedelta
    max_row_count_delta_pct: float
    max_sample_error_rate: float
    tier1_zero_tolerance: bool  # Any Tier 1 mismatch = rollback
    investigation_time_budget: timedelta  # Time allowed for investigating issues

    @staticmethod
    def strict() -> "RollbackPolicy":
        """For financial/compliance migrations."""
        return RollbackPolicy(
            max_validation_duration=timedelta(hours=4),
            max_row_count_delta_pct=0.0,
            max_sample_error_rate=0.0,
            tier1_zero_tolerance=True,
            investigation_time_budget=timedelta(hours=1),
        )

    @staticmethod
    def standard() -> "RollbackPolicy":
        """For analytics/reporting migrations."""
        return RollbackPolicy(
            max_validation_duration=timedelta(hours=12),
            max_row_count_delta_pct=0.001,
            max_sample_error_rate=0.0001,
            tier1_zero_tolerance=True,
            investigation_time_budget=timedelta(hours=2),
        )

    @staticmethod
    def lenient() -> "RollbackPolicy":
        """For development/staging refreshes."""
        return RollbackPolicy(
            max_validation_duration=timedelta(hours=24),
            max_row_count_delta_pct=0.01,
            max_sample_error_rate=0.001,
            tier1_zero_tolerance=False,
            investigation_time_budget=timedelta(hours=4),
        )


def make_rollback_decision(
    policy: RollbackPolicy,
    validation_results: list[dict],
    started_at: datetime,
) -> dict:
    """Evaluate validation results against rollback policy."""
    now = datetime.now(timezone.utc)
    elapsed = now - started_at

    # Time budget exceeded
    if elapsed > policy.max_validation_duration:
        return {
            "decision": "ROLLBACK",
            "reason": f"Validation exceeded time budget: "
                      f"{elapsed} > {policy.max_validation_duration}",
        }

    # Check each table
    issues = []
    for result in validation_results:
        table = result["table"]
        tier = result.get("tier", 3)

        # Tier 1 zero tolerance
        if tier == 1 and policy.tier1_zero_tolerance:
            if result.get("mismatches", 0) > 0:
                return {
                    "decision": "ROLLBACK",
                    "reason": f"Tier 1 table {table} has "
                              f"{result['mismatches']} mismatches "
                              f"(zero tolerance policy)",
                }

        # Row count delta
        delta_pct = result.get("row_count_delta_pct", 0)
        if abs(delta_pct) > policy.max_row_count_delta_pct:
            issues.append(
                f"{table}: row count delta {delta_pct:.4%} exceeds "
                f"{policy.max_row_count_delta_pct:.4%}"
            )

        # Sample error rate
        error_rate = result.get("sample_error_rate", 0)
        if error_rate > policy.max_sample_error_rate:
            issues.append(
                f"{table}: sample error rate {error_rate:.4%} exceeds "
                f"{policy.max_sample_error_rate:.4%}"
            )

    if issues:
        return {
            "decision": "ROLLBACK",
            "reason": f"{len(issues)} policy violations",
            "violations": issues,
        }

    return {
        "decision": "CONTINUE",
        "tables_validated": len(validation_results),
        "elapsed": str(elapsed),
    }
```

### 9.4 The "Explainability" Factor

Not all mismatches are equal. Some can be explained and accepted:

| Mismatch Type | Explainable? | Action |
|---------------|-------------|--------|
| Trailing whitespace in CHAR→VARCHAR | Yes | Accept with documented coercion rule |
| Timestamp microsecond vs nanosecond | Yes | Accept with tolerance parameter |
| `NaN` vs `NULL` for missing floats | Yes | Accept with explicit NULL mapping |
| 3 rows missing from a 1B row table | Maybe | Investigate — likely CDC timing |
| Financial amount off by $0.01 | No | Rollback — rounding error in ETL |
| 10% of rows have different values | No | Rollback — systematic transformation error |

**The investigation SLA**: When mismatches are found, the team has a fixed time budget (typically 1-2 hours) to explain them. If unexplained after the budget, rollback.

---

## 10. Cost Models

### 10.1 Snowflake Cost Model for Validation

Snowflake charges by **compute credits** (warehouse time) and **storage** (data scanned). Key numbers:

| Warehouse Size | Credits/Hour | $/Hour (On-Demand) | $/Hour (Capacity) |
|---------------|-------------|-------------------|-------------------|
| X-Small | 1 | $4.00 | $2.55 |
| Small | 2 | $8.00 | $5.10 |
| Medium | 4 | $16.00 | $10.20 |
| Large | 8 | $32.00 | $20.40 |
| X-Large | 16 | $64.00 | $40.80 |
| 2X-Large | 32 | $128.00 | $81.60 |
| 4X-Large | 128 | $512.00 | $326.40 |

**Critical cost factor**: Snowflake has a **60-second minimum** per warehouse resume. If your validation runs 10 separate queries of 5 seconds each, you pay for 10 × 60 = 600 seconds (10 minutes), not 50 seconds.

**Optimization**: Batch multiple validation queries into a single session:

```sql
-- BAD: 5 separate queries, 5 warehouse resumes = 5 minutes minimum
SELECT COUNT(*) FROM table_1;
-- warehouse suspends
SELECT COUNT(*) FROM table_2;
-- warehouse suspends
-- ... etc

-- GOOD: Single session, 1 warehouse resume = 1 minute minimum
SELECT 'table_1' AS tbl, COUNT(*) AS cnt FROM table_1
UNION ALL
SELECT 'table_2', COUNT(*) FROM table_2
UNION ALL
SELECT 'table_3', COUNT(*) FROM table_3
UNION ALL
SELECT 'table_4', COUNT(*) FROM table_4
UNION ALL
SELECT 'table_5', COUNT(*) FROM table_5;
```

### 10.2 Validation Cost Estimation Formula

```python
def estimate_snowflake_validation_cost(
    tables: list[dict],  # [{"name": "orders", "rows": 1e9, "size_gb": 500, "tier": 1}]
    warehouse_size: str = "MEDIUM",
    pricing: str = "on_demand",
) -> dict:
    """Estimate Snowflake validation cost using the progressive pyramid."""

    credits_per_hour = {
        "XSMALL": 1, "SMALL": 2, "MEDIUM": 4, "LARGE": 8,
        "XLARGE": 16, "2XLARGE": 32, "4XLARGE": 128,
    }
    price_per_credit = 4.00 if pricing == "on_demand" else 2.55
    cph = credits_per_hour[warehouse_size.upper().replace("-", "")]

    cost_breakdown = {
        "metadata": 0.0,
        "count": 0.0,
        "profile": 0.0,
        "hash": 0.0,
        "sample": 0.0,
        "full_diff": 0.0,
    }

    for table in tables:
        tier = table.get("tier", 3)
        size_gb = table["size_gb"]
        rows = table["rows"]

        # Level 0-1: Metadata + Schema (free, uses INFORMATION_SCHEMA)
        cost_breakdown["metadata"] += 0

        # Level 2: Count (near-free, metadata operation in Snowflake)
        # ~1 second per table, batch into groups of 50
        cost_breakdown["count"] += (1 / 3600) * cph * price_per_credit

        # Level 3: Profile (MIN/MAX/AVG/STDDEV/NULL counts)
        # ~5-30 seconds per table depending on size
        seconds = min(30, max(5, size_gb * 0.1))
        cost_breakdown["profile"] += (seconds / 3600) * cph * price_per_credit

        if tier <= 2:
            # Level 4: HASH_AGG (full scan, but fast)
            # ~10-120 seconds depending on size
            seconds = min(120, max(10, size_gb * 0.3))
            cost_breakdown["hash"] += (seconds / 3600) * cph * price_per_credit

        if tier <= 2:
            # Level 5: Sample diff (1% sample)
            # Cost = ~1% of full scan time
            seconds = min(60, max(5, size_gb * 0.003))
            cost_breakdown["sample"] += (seconds / 3600) * cph * price_per_credit

        if tier == 1:
            # Level 6: Full diff (HashDiff bisection)
            # ~15 rounds of hash queries, total ~3-5x single scan
            seconds = min(3600, max(60, size_gb * 1.5))
            cost_breakdown["full_diff"] += (seconds / 3600) * cph * price_per_credit

    # Apply 60-second minimum per warehouse resume
    # Assume validation batches queries into sessions of ~5 minutes each
    num_sessions = max(1, sum(1 for t in tables if t.get("tier", 3) <= 2))
    minimum_cost = (num_sessions * 60 / 3600) * cph * price_per_credit

    total = max(sum(cost_breakdown.values()), minimum_cost)

    return {
        "breakdown": cost_breakdown,
        "total_estimated": round(total, 2),
        "warehouse_size": warehouse_size,
        "pricing_model": pricing,
        "tables_count": len(tables),
    }

# Example: 500-table migration
tables = (
    [{"name": f"tier1_{i}", "rows": 1e9, "size_gb": 500, "tier": 1}
     for i in range(50)] +
    [{"name": f"tier2_{i}", "rows": 1e8, "size_gb": 50, "tier": 2}
     for i in range(150)] +
    [{"name": f"tier3_{i}", "rows": 1e7, "size_gb": 5, "tier": 3}
     for i in range(300)]
)

result = estimate_snowflake_validation_cost(tables, "LARGE", "on_demand")
# Typical result: ~$150-$300 for progressive validation
# vs ~$5,000-$15,000 for full diff on all 500 tables
```

### 10.3 BigQuery Cost Model

BigQuery charges by **bytes scanned** (on-demand) or **slot-hours** (capacity):

| Pricing Model | Rate | Best For |
|---------------|------|----------|
| On-Demand | $6.25 per TB scanned | Ad-hoc, infrequent validation |
| Capacity (Standard) | $0.04 per slot-hour | Large, frequent validation |
| Capacity (Enterprise) | $0.06 per slot-hour | Production workloads |

**Cost comparison for a 1 TB table:**

| Validation Level | Bytes Scanned | On-Demand Cost | Capacity Cost (100 slots, 1 min) |
|-----------------|--------------|----------------|--------------------------------|
| COUNT(*) | 0 (metadata) | $0.00 | $0.00 |
| Profile | ~100 GB (columnar) | $0.63 | $0.07 |
| Full scan hash | ~1 TB | $6.25 | $0.07 |
| Full diff (EXCEPT) | ~2 TB (both sides) | $12.50 | $0.13 |

**Key BigQuery optimization**: BigQuery is columnar. `SELECT COUNT(*)` scans zero bytes. `SELECT MIN(amount), MAX(amount)` scans only the `amount` column. Full row comparison (`SELECT *`) scans all columns. Choose columns wisely.

### 10.4 Databricks Cost Model

Databricks charges by **DBU (Databricks Unit)** per hour:

| Tier | DBU Rate | $/DBU (AWS) |
|------|----------|-------------|
| Jobs Light | Worker DBUs | $0.07 |
| Jobs Standard | Worker DBUs | $0.15 |
| SQL Serverless | Query DBUs | $0.22 |
| SQL Pro | Warehouse DBUs | $0.55 |

**Delta Lake optimization**: Because Delta stores data as Parquet files with Z-ordering, partition pruning can reduce scan costs by 10-100x. Validation queries should always include partition predicates.

### 10.5 Cost Comparison: Progressive vs Naive

For a representative 500-table migration with 10 TB total data:

| Approach | Snowflake (Large WH, On-Demand) | BigQuery (On-Demand) | Databricks (SQL Pro) |
|----------|------|------|------|
| **Naive: Full EXCEPT on all tables** | ~$2,400 | ~$125 | ~$550 |
| **Progressive: All levels as needed** | ~$180 | ~$15 | ~$65 |
| **Smart: Progressive + partition-aware** | ~$45 | ~$5 | ~$20 |
| **Savings vs naive** | **98%** | **96%** | **96%** |

The progressive approach is 10-50x cheaper because:
1. 60% of tables pass at Level 2 (count) — near-zero cost
2. 30% of tables pass at Level 4 (hash) — single-scan cost
3. Only 5-10% need Level 6 (full diff) — multi-scan cost
4. Partition-aware validation further reduces Level 6 cost by only scanning changed partitions

---

## 11. Tools Comparison

### 11.1 Migration Validation Tool Landscape

| Tool | Type | Cross-DB | Scale | Approach | Cost | Status |
|------|------|----------|-------|----------|------|--------|
| **AWS DMS Validation** | Managed | AWS sources → AWS targets | Medium | Row count + full row compare | Included with DMS | Active |
| **AWS SCT Data Validation** | Desktop | Any JDBC → Any JDBC | Medium | Row-by-row comparison | Free | Active |
| **GCP Datastream Validation** | Managed | Oracle/MySQL/PG → BigQuery | Medium | CDC-based validation | Included | Active |
| **Google DVT (Data Validation Tool)** | Open Source | Any → Any (30+ connectors) | Large | Hash-based row comparison | Free | Active |
| **Striim** | Commercial | Any → Any (200+ connectors) | Large | Real-time CDC validation | $$$ | Active |
| **Datafold Cloud** | SaaS | Cross-DB (Snowflake, BigQuery, etc.) | Medium | In-memory diff (capped ~10M) | $799+/mo | Active (pivoted) |
| **Datafold data-diff (OSS)** | Open Source | Cross-DB | Large | Bisection algorithm | Free | **Archived May 2024** |
| **Reladiff** | Open Source | Cross-DB (8+ connectors) | Large | HashDiff bisection + Cascade | Free | Active |
| **QuerySurge** | Commercial | Any JDBC → Any JDBC | Large | ETL testing platform | $$$ | Active |
| **iCEDQ** | Commercial | Any → Any | Large | Rule-based data testing | $$$ | Active |
| **BiG EVAL** | Commercial | 80+ connectors | Large | Enterprise data testing | $$$ | Active |
| **Great Expectations + custom** | Open Source | Single DB | Medium | Assertion-based | Free | Active |

### 11.2 AWS DMS Validation — Deep Dive

AWS Database Migration Service includes built-in validation:

**How it works:**
1. DMS task migrates data from source to target
2. Validation compares source rows with target rows in parallel
3. Reports: Validated, Mismatched, Pending, Failed

**Capabilities:**
- Row-level comparison (all columns)
- Handles ongoing replication (CDC mode)
- Reports mismatched rows with details
- Can be enabled per-table

**Limitations:**
- Only works with DMS migrations (not standalone)
- Performance impact: 10-20% slower migration with validation enabled
- No partial validation (all-or-nothing per table)
- No progressive escalation — always does full row comparison
- Limited to DMS-supported source/target pairs
- No hash-based shortcuts — always reads full rows
- No sampling option

```json
// DMS Task Settings for validation
{
    "ValidationSettings": {
        "EnableValidation": true,
        "ThreadCount": 5,
        "PartitionSize": 10000,
        "ValidationMode": "ROW_LEVEL",
        "FailureMaxCount": 10000,
        "HandleCollationDiff": "true",
        "RecordSuspendEnabled": "false",
        "MaxKeyColumnSize": 8096
    }
}
```

**DMS validation output table:**

```sql
SELECT * FROM awsdms_validation_failures_v1
WHERE TABLE_NAME = 'orders'
  AND FAILURE_TYPE = 'RECORD_DIFF';

-- Columns: TASK_NAME, TABLE_OWNER, TABLE_NAME, FAILURE_TIME,
--          KEY_TYPE, KEY, FAILURE_TYPE, DETAILS
```

### 11.3 Google Data Validation Tool (DVT) — Deep Dive

Open-source Python tool from Google Cloud. The most feature-rich open-source validation tool after Reladiff.

**Architecture:**
- Python CLI + Ibis for SQL generation
- Supports 30+ databases via JDBC/ODBC/native connectors
- Runs on GKE, Cloud Run, or locally
- State stored in BigQuery (results table)

**Validation types:**

```bash
# Column validation (aggregations)
data-validation validate column \
  --source-conn oracle_conn \
  --target-conn bigquery_conn \
  --tables-list schema.orders \
  --sum amount,quantity \
  --count '*' \
  --grouped-columns region,product_category

# Row validation (hash-based)
data-validation validate row \
  --source-conn oracle_conn \
  --target-conn bigquery_conn \
  --tables-list schema.orders \
  --primary-keys order_id \
  --hash '*' \
  --comparison-fields amount,status,created_at

# Schema validation
data-validation validate schema \
  --source-conn oracle_conn \
  --target-conn bigquery_conn \
  --tables-list schema.orders

# Custom query validation
data-validation validate custom-query \
  --source-conn oracle_conn \
  --target-conn bigquery_conn \
  --source-query "SELECT COUNT(*) FROM orders WHERE region = 'US'" \
  --target-query "SELECT COUNT(*) FROM orders WHERE region = 'US'"
```

**Strengths:**
- Broadest connector support in OSS
- Column-level aggregation comparison (SUM, COUNT, AVG)
- Row-level hash comparison
- BigQuery-native results storage and dashboarding
- Active development by Google Cloud team
- YAML-based configuration for repeatable validations

**Weaknesses:**
- No bisection algorithm — row validation reads *all* rows
- No progressive escalation — each validation type runs independently
- No partition-aware optimization
- GCP-centric documentation and defaults
- No streaming/CDC-aware validation
- Performance: 1B row validation can take hours (no divide-and-conquer)

### 11.4 Striim — Deep Dive

Enterprise real-time data integration and validation platform.

**Migration validation features:**
- Real-time data validation during CDC replication
- Compares source and target continuously, not as a batch job
- Dashboards showing validation status per table
- Automated remediation (re-sync mismatched rows)

**Unique capability**: Striim validates data *while it is being replicated*, not after. This means you know about mismatches within seconds of occurrence, not hours later.

**Pricing**: Enterprise-only, typically $100K+/year. Appropriate for large-scale migrations where the cost of data loss exceeds the tool cost by orders of magnitude.

### 11.5 Feature Comparison Matrix

| Feature | DMS Validation | Google DVT | Striim | Datafold Cloud | Reladiff |
|---------|---------------|------------|--------|---------------|----------|
| Row-level comparison | Full rows | Hash per row | Full rows | In-memory diff | HashDiff bisection |
| Progressive escalation | No | No | No | No | Cascade ✓ |
| Billion-row scale | Slow (hours) | Slow (hours) | Real-time | Capped ~10M | 5 min (bisection) |
| Cross-database | DMS pairs only | 30+ connectors | 200+ | 6 major clouds | 8+ connectors |
| Partition-aware | No | No | Yes | Yes | Planned |
| Sampling | No | No | No | Yes (auto) | Planned |
| Real-time CDC validation | During DMS only | No | Yes ✓ | No | No |
| Schema comparison | No | Yes | Yes | Yes | Yes |
| Open source | No | Yes | No | Archived | Yes ✓ |
| Cost | Included with DMS | Free | $$$$ | $799+/mo | Free |

---

## 12. Idempotent Re-Validation

### 12.1 Why Idempotency Matters

Validation runs may need to be re-executed because:
- A previous run timed out or was interrupted
- You want to verify that a fix actually resolved a mismatch
- Compliance requires periodic re-validation
- The validation itself may have had a bug

Re-running validation must not:
- Create duplicate entries in the validation results table
- Trigger false alerts (comparing stale cached results with fresh data)
- Consume unnecessary compute by re-scanning tables that haven't changed
- Leave partial state that confuses subsequent runs

### 12.2 Idempotent Validation State Machine

```python
from enum import Enum
from datetime import datetime, timezone
from typing import Optional
import hashlib
import json

class ValidationState(Enum):
    PENDING = "pending"
    RUNNING = "running"
    PASSED = "passed"
    FAILED = "failed"
    ERROR = "error"       # Validation itself errored (not a data mismatch)
    STALE = "stale"       # Data has changed since last validation
    SUPERSEDED = "superseded"  # A newer run exists

class IdempotentValidationTracker:
    """Track validation state with idempotent re-run support."""

    def __init__(self, results_store):
        self.store = results_store

    def run_key(self, table: str, source_conn: str,
                target_conn: str, level: int) -> str:
        """Deterministic key for a validation run configuration."""
        return hashlib.sha256(
            f"{table}|{source_conn}|{target_conn}|{level}".encode()
        ).hexdigest()[:16]

    def should_revalidate(
        self, table: str, source_conn: str,
        target_conn: str, level: int,
        max_age_hours: int = 24,
    ) -> tuple[bool, Optional[dict]]:
        """Check if revalidation is needed.

        Returns (should_run, previous_result).
        """
        key = self.run_key(table, source_conn, target_conn, level)
        previous = self.store.get_latest(key)

        if previous is None:
            return True, None

        # Always revalidate if previous run errored
        if previous["state"] == ValidationState.ERROR.value:
            return True, previous

        # Revalidate if data has changed (check metadata)
        if self._data_changed_since(table, previous["completed_at"]):
            self.store.mark_stale(key)
            return True, previous

        # Revalidate if result is older than max_age
        age = datetime.now(timezone.utc) - previous["completed_at"]
        if age.total_seconds() > max_age_hours * 3600:
            return True, previous

        # Previous result is fresh and valid
        return False, previous

    def begin_validation(
        self, table: str, source_conn: str,
        target_conn: str, level: int,
    ) -> str:
        """Mark validation as running. Returns run_id."""
        key = self.run_key(table, source_conn, target_conn, level)
        run_id = f"{key}_{int(datetime.now(timezone.utc).timestamp())}"

        self.store.upsert(key, {
            "run_id": run_id,
            "state": ValidationState.RUNNING.value,
            "started_at": datetime.now(timezone.utc),
            "table": table,
            "level": level,
        })

        return run_id

    def complete_validation(
        self, run_id: str, result: dict,
    ):
        """Record validation completion. Idempotent — last write wins."""
        key = run_id.rsplit("_", 1)[0]

        state = ValidationState.PASSED if result.get("match") else \
                ValidationState.FAILED

        self.store.upsert(key, {
            "run_id": run_id,
            "state": state.value,
            "completed_at": datetime.now(timezone.utc),
            "result": result,
        })

    def _data_changed_since(self, table: str, since: datetime) -> bool:
        """Check if the table has been modified since the given time."""
        # Implementation depends on database:
        # Snowflake: Check TABLE_STORAGE_METRICS
        # BigQuery: Check INFORMATION_SCHEMA.TABLE_OPTIONS
        # Delta Lake: DESCRIBE HISTORY
        raise NotImplementedError
```

### 12.3 Incremental Re-Validation

When re-running validation after fixing issues, you only need to re-validate the parts that failed:

```sql
-- Get previously failed partitions
SELECT partition_value, status, mismatch_details
FROM validation_results
WHERE table_name = 'orders'
  AND status = 'FAILED'
  AND run_id = (SELECT MAX(run_id) FROM validation_results
                WHERE table_name = 'orders');

-- Re-validate only those partitions
-- (not all 365 days — only the 3 that failed)
```

### 12.4 Validation Result Deduplication

```sql
-- ClickHouse: ReplacingMergeTree for validation results
CREATE TABLE validation_results (
    run_key     String,
    run_id      String,
    table_name  String,
    level       UInt8,
    state       String,
    started_at  DateTime64(3),
    completed_at DateTime64(3),
    result      String,  -- JSON
    _version    UInt64 DEFAULT toUnixTimestamp64Milli(now64())
)
ENGINE = ReplacingMergeTree(_version)
ORDER BY (run_key)
SETTINGS index_granularity = 8192;

-- Insert is idempotent: same run_key → newer _version wins after OPTIMIZE
INSERT INTO validation_results (run_key, run_id, table_name, level, state, ...)
VALUES (...);

-- Force dedup
OPTIMIZE TABLE validation_results FINAL;
```

---

## 13. Real-World Migration Stories

### 13.1 Capital One: Teradata → Snowflake (2020-2023)

**Scale**: ~1,000 databases, petabytes of data, thousands of ETL jobs

**Validation approach**:
- Custom Python framework comparing row counts, checksums, and samples
- Tiered validation: financial data (full diff), analytics (hash + sample), disposable (count only)
- Automated regression testing: run the same business queries against old and new systems, compare results

**Key lessons learned**:
1. **Type coercion was the #1 issue**: Teradata `DECIMAL(18,2)` to Snowflake `NUMBER(38,2)` — lossless. But Teradata `BYTEINT` (signed 1-byte integer) has no direct Snowflake equivalent; mapped to `NUMBER(3,0)`.
2. **Date/time conversion consumed 40% of validation effort**: Teradata stores dates as integers internally. Timezone handling differs. `TIMESTAMP(6)` (microseconds) vs `TIMESTAMP(0)` (seconds) across tables.
3. **Character encoding**: Teradata used `LATIN` character set in some tables, `UNICODE` in others. Snowflake is UTF-8 only. Characters outside UTF-8 were silently replaced with `?`.
4. **Validation was 30% of total migration effort**. Not planned for initially, causing a 6-month delay.

**Quote from Capital One engineering blog**: "We underestimated validation by an order of magnitude. The migration itself was straightforward. Proving it was correct nearly killed the project."

### 13.2 Netflix: Oracle → CockroachDB/MySQL (Multiple Migrations)

**Context**: Netflix has executed multiple major database migrations over the years.

**Validation innovations**:
- **Shadow traffic at scale**: Netflix routes a copy of all read traffic to the new database and compares responses. They process millions of shadow comparisons per second.
- **Custom comparison semantics**: Not byte-for-byte comparison. Application-level semantic comparison — "does the response produce the same UI rendering?"
- **Automated rollback**: If shadow mismatch rate exceeds 0.01% for 5 consecutive minutes, automated rollback triggers.

**Key metric**: Netflix requires 99.99% shadow match rate sustained for 7 days before cutover.

### 13.3 Shopify: MySQL → Vitess (Sharding Migration)

**Scale**: Single large MySQL database → sharded Vitess cluster

**Validation challenge**: Data is being *split* across shards, not just copied. A row in `orders` goes to shard N based on `shop_id % shard_count`. Validation must verify:
1. Every row exists in exactly one shard
2. No row exists in zero shards (lost)
3. No row exists in multiple shards (duplicated)
4. The shard assignment is correct (based on sharding key)

**Approach**:
- Global aggregation: `SUM(amount)` across all shards must equal source
- Per-shard validation: each shard's rows must match the source filtered by shard key
- Cross-shard uniqueness: primary keys must be globally unique

```sql
-- Cross-shard uniqueness check
SELECT order_id, COUNT(*) AS shard_count
FROM (
    SELECT order_id FROM shard_0.orders
    UNION ALL
    SELECT order_id FROM shard_1.orders
    UNION ALL
    SELECT order_id FROM shard_2.orders
    UNION ALL
    SELECT order_id FROM shard_3.orders
) all_shards
GROUP BY order_id
HAVING COUNT(*) > 1;
-- Must return zero rows
```

### 13.4 Airbnb: Hive → Spark/Delta Lake

**Scale**: Petabytes of analytical data, 50,000+ datasets

**Validation innovation**: Airbnb's **Midas certification** system:
1. **Spec Review**: Data model and migration plan reviewed by data platform team
2. **Data Review**: Automated comparison of old vs new pipeline output
3. **Code Review**: ETL logic reviewed
4. **Minerva Review**: Semantic layer (metrics definitions) validated

**Automated data review** compares:
- Row counts per partition
- Column-level statistics (null rate, distinct count, value distribution)
- Top-K frequent values (catch dimension changes)
- Percentile distributions (catch numerical drift)

**Key learning**: "The most dangerous migrations are the ones that look correct on row counts but have subtle value-level issues. We found 15% of migrations had at least one column with a distribution shift that counts alone would never catch."

### 13.5 LinkedIn: Espresso → Venice (Real-Time Data Platform)

**Validation approach**: LinkedIn's **ValiData** framework:
- Continuous comparison between old and new data serving layers
- Statistical validation: KS test on value distributions
- Latency comparison: are queries faster or slower on the new system?
- Correctness: do the same queries return the same results?

**Quantified result**: ValiData reduced manual validation effort by 85%+ and caught 3 critical data issues that would have reached production.

### 13.6 Anti-Pattern: The "Trust the Tool" Migration

A mid-size fintech company migrated from PostgreSQL to Snowflake using a commercial ETL tool. They validated by:
1. Checking row counts (matched)
2. Running 10 hand-picked queries (matched)
3. Declaring success

Six weeks later, they discovered:
- 12% of `NUMERIC(20,4)` values had been silently truncated to `NUMBER(38,0)` (integer)
- All `TIMESTAMPTZ` values had been converted to UTC but stored as `TIMESTAMP_NTZ`, losing the original timezone
- `JSONB` columns had been serialized with different key ordering, breaking downstream consumers that parsed JSON with positional logic (a separate bug, but exposed by the migration)
- `BOOLEAN` columns had been converted from `t/f` to `1/0`, breaking application code that compared string values

**Total cost of the failed validation**: $2.3M in engineering time, customer impact, and regulatory penalties.

**Lesson**: Row counts are necessary but laughably insufficient. Type coercion validation is not optional.

---

## 14. Reladiff Engine Positioning

### 14.1 Reladiff's Two Algorithms

Reladiff provides two core algorithms, each mapping to different migration scenarios:

**HashDiff (Bisection Algorithm)**

The bisection approach inherited from the original data-diff project. It divides the key space into segments, computes an aggregate hash per segment on both source and target, compares hashes, and recursively subdivides mismatched segments until individual differing rows are found.

```
Round 1: Hash entire key space
  Source: HASH([1..1B]) = 0xABCD
  Target: HASH([1..1B]) = 0xABCE  ← Mismatch!

Round 2: Split into 2 segments
  Source: HASH([1..500M]) = 0x1234    Target: HASH([1..500M]) = 0x1234  ← Match ✓
  Source: HASH([500M+1..1B]) = 0x5678 Target: HASH([500M+1..1B]) = 0x5679 ← Mismatch!

Round 3: Split mismatched segment
  Source: HASH([500M+1..750M]) = 0xAAAA Target: HASH([500M+1..750M]) = 0xAAAA ← Match ✓
  Source: HASH([750M+1..1B]) = 0xBBBB  Target: HASH([750M+1..1B]) = 0xBBBC  ← Mismatch!

... ~15 rounds later ...

Round 15: Individual row
  Source: row 823456789 = {order_id: 823456789, amount: 100.50}
  Target: row 823456789 = {order_id: 823456789, amount: 100.00}  ← Found it!
```

**Migration applicability:**
- Post-migration full validation of Tier 1 tables
- Finding the needle in a billion-row haystack
- Cross-database validation (each side runs hash queries independently)
- Minimal data transfer (only hashes cross the network until row-level diff)

**Cascade (Progressive Validation)**

Cascade implements the validation pyramid within Reladiff: count → profile → content comparison, stopping at the first level that either passes or finds issues.

**Migration applicability:**
- Tier 2 and Tier 3 tables where full diff is not justified
- Initial quick-scan of all tables to triage which need deeper investigation
- Continuous monitoring during migration (run Cascade every hour)
- Cost optimization — 90%+ of tables pass at count or profile level

### 14.2 The Reladiff State Machine Architecture

From the engine code, Reladiff uses a cooperative state machine pattern:

```
Application (Python)          Reladiff Engine (Rust)
        │                              │
        │──── create session ─────────►│
        │                              │
        │◄──── ExecuteSql{tasks} ──────│
        │                              │
        │──── step(sql_results) ──────►│
        │                              │
        │◄──── ExecuteSql{tasks} ──────│  (loop)
        │                              │
        │──── step(sql_results) ──────►│
        │                              │
        │◄──── Done{outcome} ─────────│
```

This architecture is uniquely suited for migration validation because:

1. **Database-agnostic**: The engine generates SQL; the application executes it against any database. Source and target can be completely different databases.
2. **No data movement**: Hashes are computed in the database. Only hash values (8 bytes per segment) cross the network.
3. **Resumable**: The state machine can be serialized and resumed, supporting long-running validations across maintenance windows.
4. **Parallelizable**: Multiple sessions can run concurrently for different tables or partitions.

### 14.3 Migration Scenario Mapping

| Migration Scenario | Recommended Reladiff Approach | Why |
|-------------------|------------------------------|-----|
| **Teradata → Snowflake (full)** | Cascade on all tables → HashDiff on Tier 1 | Progressive triage saves 95% cost |
| **Oracle → PostgreSQL (lift-and-shift)** | HashDiff with type coercion rules | Cross-database type differences need row-level verification |
| **Snowflake → Snowflake (account migration)** | HASH_AGG pre-check → HashDiff on mismatches | Same engine = HASH_AGG works cross-account |
| **MySQL → Vitess (sharding)** | HashDiff per shard + cross-shard uniqueness | Shard-aware validation |
| **Daily incremental sync validation** | Cascade (count + profile) with partition filter | Fast, cheap, catches >95% of issues |
| **Compliance re-validation** | HashDiff on full table | Zero-tolerance requires exhaustive check |
| **Schema refactor (same DB)** | Cascade (schema level) + sample diff | Schema changes are the primary risk |
| **Version upgrade (PG 14 → 16)** | HASH_AGG pre/post upgrade | Same engine, same data, should be identical |

### 14.4 Gaps and Opportunities for Reladiff in Migration

Based on the analysis across this research:

**Currently supported:**
- HashDiff bisection for billion-row cross-database diff
- Cascade for progressive validation
- Multi-database connectors (Snowflake, BigQuery, PostgreSQL, DuckDB, MySQL, ClickHouse, Databricks, Redshift)
- Cooperative state machine for database-agnostic execution

**High-value additions for migration use cases:**

| Feature | Migration Value | Effort | Priority |
|---------|----------------|--------|----------|
| **Partition-aware HashDiff** | 10-100x cost reduction on partitioned tables | Medium | P0 |
| **HASH_AGG pre-flight** | Near-zero cost "tables match" verification | Low | P0 |
| **Validation contract YAML** | Define tier, tolerance, rollback rules per table | Medium | P1 |
| **Batch query mode** | Amortize Snowflake 60-second warehouse minimum | Low | P1 |
| **Progress reporting** | Migration teams need visibility during long runs | Low | P1 |
| **Type coercion warnings** | Surface coercion risks before diffing | Medium | P1 |
| **Sampling integration** | Statistical validation at 1% cost | Medium | P1 |
| **Time-travel coordination** | Use Snowflake AT() for consistent comparison | Low | P2 |
| **Validation watermarks** | Track which partitions have been validated | Medium | P2 |
| **Rollback decision engine** | Automated pass/fail based on policy | Medium | P2 |

### 14.5 Competitive Positioning for Migration

```
                     Billion-Row Scale
                          ↑
                          │
              Reladiff    │    Striim
              (HashDiff)  │    ($$$, real-time)
                          │
         ─────────────────┼──────────────────→ Breadth of
              Google DVT  │    Datafold Cloud    Connectors
              (GCP-centric)│   (archived OSS,
                          │    capped at ~10M)
                          │
              DMS Valid.  │    iCEDQ, QuerySurge
              (AWS only)  │    ($$, legacy)
                          │
```

Reladiff occupies a unique position: **open-source, billion-row scale, cross-database, with progressive escalation**. No other tool in the market offers all four.

The migration validation market specifically values:
1. Cross-database support (migrations are inherently cross-database)
2. Scale (migrations involve the largest tables)
3. Cost efficiency (validation is "overhead" — it must be cheap)
4. Speed (validation has a time budget bounded by the maintenance window)

Reladiff's HashDiff bisection is the only open-source algorithm that addresses all four simultaneously.

---

## 15. References

### Academic Papers

1. Eltabakh, M.Y., et al. "CoHadoop: Flexible Data Placement and Its Exploitation in Hadoop." *VLDB Endowment*, 2011. — Discusses data co-location strategies relevant to partition-aware validation.

2. Alagiannis, I., et al. "NoDB: Efficient Query Execution on Raw Data Files." *ACM SIGMOD*, 2012. — Raw file comparison techniques applicable to migration validation.

3. Goodman, E.L., et al. "Invertible Bloom Lookup Tables." *IEEE Allerton Conference*, 2011. — IBLT theory for set difference computation, foundational to efficient diff algorithms.

4. Wald, A. "Sequential Tests of Statistical Hypotheses." *Annals of Mathematical Statistics*, 1945. — The SPRT methodology applied in Section 4.4 for sequential sampling.

5. Vitter, J.S. "Random Sampling with a Reservoir." *ACM TOMS*, 1985. — Reservoir sampling algorithm used in streaming validation.

### Industry Blog Posts and Case Studies

6. Datafold Engineering Blog. "How data-diff Works." 2022. — Bisection algorithm description that HashDiff builds on.

7. Capital One Tech Blog. "Moving to the Cloud: Lessons Learned from Migrating to Snowflake." 2022. — Teradata to Snowflake migration validation patterns.

8. Shopify Engineering. "Sharding Shopify's Core Database." 2023. — MySQL to Vitess migration with cross-shard validation.

9. Stripe Engineering. "Online Migrations at Scale." 2017. — Four-phase migration framework with shadow read validation.

10. GitHub Engineering. "Move Fast and Fix Things — The GitHub Scientist Approach." 2016. — Shadow comparison library for zero-downtime migrations.

11. Netflix Technology Blog. "Data Migration Confidence Building." 2021. — Shadow traffic validation at millions of comparisons per second.

12. LinkedIn Engineering. "ValiData: Automated Data Validation at Scale." 2023. — Statistical validation framework reducing manual effort by 85%.

13. Airbnb Engineering. "Data Quality at Airbnb." 2020. — Midas certification system for data pipeline migrations.

14. Uber Engineering. "Uber's Data Quality Monitoring System." 2022. — UDQ system detecting ~90% of data incidents across 2,000+ datasets.

### Tool Documentation

15. AWS DMS Validation Documentation. https://docs.aws.amazon.com/dms/latest/userguide/CHAP_Validating.html

16. Google DVT (Data Validation Tool). https://github.com/GoogleCloudPlatform/professional-services-data-validator

17. Snowflake TIME TRAVEL Documentation. https://docs.snowflake.com/en/user-guide/data-time-travel

18. BigQuery Time Travel Documentation. https://cloud.google.com/bigquery/docs/time-travel

19. Delta Lake Time Travel. https://docs.delta.io/latest/delta-batch.html#query-an-older-snapshot-of-a-table-time-travel

20. Striim Migration Validation. https://www.striim.com/docs/

### Related Reladiff Research Themes

- **Theme A**: Cost-effective validation — the progressive pyramid and HASH_AGG primitive
- **Theme B**: Type coercion — the #1 source of false positives in cross-database diffing
- **Theme E**: Statistical validation — sampling theory, KS tests, distribution comparison
- **Theme F**: Failure modes — hash format normalization, NaN handling, floating-point non-reproducibility
- **Theme G**: Replay and idempotency — the data-diff/reladiff bisection algorithm description
- **Theme H**: Tool landscape — Datafold sunset, market vacuum, competitive positioning
- **Theme J**: Multi-database orchestration — cross-database connector architecture
- **Theme M**: Governance and compliance — audit trails, GDPR validation requirements
