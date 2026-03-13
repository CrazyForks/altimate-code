# Iteration 1: Data Validation Landscape Research

_Date: 2026-03-12_

## Key Findings

### Cost Optimization Strategy Hierarchy (cheapest → most expensive)

1. **Metadata-only** — `SHOW TABLES`, `read_metadata()`, `iceberg_snapshots()`, `HASH_AGG`, Delta `DESCRIBE DETAIL` — near-zero cost
2. **Sketch comparison** — `HLL_COMBINE`, `MINHASH`, T-Digest state comparison — O(1) after accumulation
3. **Partition/filter-scoped** — DMFs on specific date ranges, dbt `state:modified+`, incremental Dataplex scans — cost proportional to change volume
4. **Statistical sampling** — `TABLESAMPLE (10000 ROWS)`, reservoir/stratified sampling — fixed cost regardless of table size
5. **CDC-based incremental** — Delta CDF, Hudi incremental, Iceberg snapshot diff — cost proportional to change volume
6. **Full table** — `COUNT(*)`, `HASH_AGG` without index, full distribution checks — cost proportional to table size

### Probabilistic Data Structures

- **HyperLogLog**: Every major warehouse has native HLL (~1.6% error cardinality estimation, 100x cheaper than `COUNT(DISTINCT)`)
  - Snowflake: `HLL()`, `HLL_ACCUMULATE()`, `HLL_COMBINE()`, `HLL_EXPORT()`/`HLL_IMPORT()`
  - ClickHouse: `uniqHLL12`, `uniqCombined`
  - Pattern: pre-accumulate HLL states per partition during ingestion; at validation time compare combined states

- **MinHash / Jaccard similarity**: Snowflake `MINHASH()` + `APPROXIMATE_SIMILARITY()` — compute signatures on both tables, estimate row overlap. 0.99+ = ~99% match. Natural replacement for `pt-table-checksum` in cloud warehouses.

- **T-Digest for distribution comparison**: Accumulate per-partition percentile sketches, compare p50/p90/p99 across source/target.

- **HASH_AGG for table fingerprinting**: Snowflake's `HASH_AGG(*)` — single 64-bit hash of all rows. Fastest possible "did anything change?" check.

### Native Warehouse Sampling

- **Snowflake**: `BERNOULLI (N ROWS)` (exact), `SYSTEM (p PERCENT)` (block-level), `SEED(n)` for deterministic
- **BigQuery**: `TABLESAMPLE SYSTEM (n PERCENT)` — block-based, costs only sampled fraction
- **Databricks**: `TABLESAMPLE (n PERCENT) REPEATABLE(seed)` — deterministic re-runs
- **Stratified sampling**: `ROW_NUMBER() OVER (PARTITION BY strata ORDER BY RANDOM()) <= N` — guarantees proportional representation

### Metadata-Based Validation (Zero Data Scan)

- **Parquet/Iceberg/Delta file statistics**: Per-file or per-row-group column stats (min, max, null_count, distinct_count) in metadata files
- **Iceberg Puffin files**: HLL NDV sketches stored alongside data — answer `COUNT(DISTINCT)` from metadata
- **Snowflake**: `SHOW TABLES` / `information_schema.tables` has `row_count`, `bytes`, `last_altered` — no warehouse credit

### CDC / Incremental Validation

- **Delta Lake Change Data Feed**: `table_changes('t', startVersion, endVersion)` returns only changed rows
- **Apache Hudi**: `_hoodie_commit_time` column for time-bounded incremental reads
- **dbt Slim CI**: `--state:modified+` builds/tests only changed models and downstream deps

### Cross-Database Validation Tools

- **Google DVT**: Uses Ibis for query abstraction → 15+ dialects. Three types: column aggregates, row-level hash joins, schema comparison. Partition strategy with parallel execution.
- **Ibis**: Same Python expression compiles to each backend's native SQL — natural for cross-database validation
- **Fugue**: Pandas validation functions execute on Spark/DuckDB/Ray/Polars unchanged
- **SQLGlot AST diff**: `sqlglot.diff(expr1, expr2)` for semantic SQL comparison across 31 dialects

### DuckDB as Local Validation Engine

- `ATTACH ... AS pg (TYPE POSTGRES)` / `ATTACH ... AS mysql (TYPE MYSQL)` for direct multi-database querying
- `httpfs` for direct S3/GCS Parquet/Iceberg/Delta reads — local validation, only S3 egress costs
- **ADBC**: Arrow zero-copy columnar transfer, 20-50x faster than ODBC for bulk retrieval

### Statistical Distribution Validation

- **Evidently AI**: 20+ statistical tests (PSI, KS-test, Jensen-Shannon, Wasserstein) — treat source as "reference", target as "current"
- **dbt-expectations**: `expect_table_aggregation_to_equal_other_table` with configurable `tolerance_percent`
- **Whylogs**: Mergeable streaming statistical profiles (~KB) — compare profiles across systems without data transfer

### PR-Scoped Validation

- **Recce**: PR-review-focused — lineage diff, Profile Diff, Value Diff, Top-K Diff between dev and prod environments

## Implications for Reladiff Engine

### Already implemented
- JoinDiff (FULL OUTER JOIN)
- HashDiff (bisection with checksums)
- Profile (column statistics)
- Cascade (progressive count → profile → content)
- Per-table WHERE clauses
- Numeric/timestamp tolerance

### Potential additions (priority order)
1. **HASH_AGG fingerprint** as a fast pre-check before full diff (near-zero cost)
2. **Sampling mode** — `TABLESAMPLE` or `LIMIT` with `ORDER BY RANDOM()` for quick confidence check
3. **HLL-based cardinality comparison** — approximate distinct counts without full scan
4. **Distribution comparison** — KS-test or percentile comparison using aggregate queries
5. **Incremental validation** — only diff rows changed since last validation (requires timestamp column)
6. **DuckDB multi-attach** for cross-database without data movement
