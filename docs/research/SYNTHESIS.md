# Reladiff Research Synthesis

_Consolidated from 15 research documents (Themes A-M + Iteration 1). Last updated: 2026-03-13._

This document distills ~500KB of research into a prioritized implementation roadmap. Every finding is traceable to the source theme documents.

---

## 1. Executive Summary

1. **Progressive validation is 60-600x cheaper than naive full comparison.** A 100-table pipeline costs $0.50-$2.00 with Level 1-3 checks (count + profile + HASH_AGG) vs $300-$3,000 with full MINUS on every table. Only ~5% of tables typically need a full diff (Theme A).

2. **Datafold's open-source sunset creates a market vacuum.** Datafold archived data-diff on May 17, 2024 and pivoted away from the bisection algorithm to in-memory diffing capped at ~10M rows. Reladiff is the only remaining open-source tool with billion-row cross-database diffing capability (Theme H).

3. **Type coercion is the #1 source of false positives in cross-database diffing.** Snowflake `NUMBER(38,0)` silently truncates decimals. Timestamp nano-vs-micro precision creates phantom diffs. Boolean representations differ across every database. JSON key ordering is non-deterministic in most databases (Theme B).

4. **Schema validation before data diffing saves compute and provides actionable diagnostics.** Running a pre-flight schema check (column presence, type compatibility, constraint differences) costs near-zero and prevents wasted full-diff compute on tables that can't possibly match (Theme D).

5. **No tool today combines contract validation with row-level diffing.** dbt contracts validate schema at build time. Great Expectations validates quality assertions. Soda validates checks. None of them diff source vs target. Reladiff + contract awareness fills a gap no competitor occupies (Theme I).

6. **Floating-point SUM() is non-reproducible across databases by design.** Parallel execution changes accumulation order, producing different results on identical data. Comparing SUM checksums of float columns across systems produces false diffs (Theme F).

7. **HASH_AGG is the killer primitive for fast table-level equality checks.** Returns an answer in seconds on billion-row tables, costs comparable to COUNT(*), collision probability ~1.8 x 10^-19 per pair. Every validation workflow should start here (Theme A).

8. **Cross-database validation is the hardest unsolved problem in data engineering.** 83% of data migration projects fail or exceed budgets. Most tools work within a single database. The moment you need Snowflake vs BigQuery, options shrink to Reladiff, Google DVT, and Datafold Cloud (Theme H, Theme J).

9. **Statistical tests must be chosen by dataset size.** KS test is oversensitive at >1,000 rows and produces false alarms. Use Wasserstein for numerical and Jensen-Shannon for categorical features on large datasets. PSI only with established thresholds from historical data (Theme E, Theme K).

10. **The data contracts standard has converged on ODCS v3.1.0.** The competing Data Contract Specification is deprecated. ODCS under the LF AI & Data Foundation is the unified industry standard, with YAML-first design and SQL escape hatches (Theme I).

---

## 2. Critical Gaps in Reladiff

### P0: Must-Have for Launch (Incorrect Results if Missing)

| Gap | Impact | Source |
|-----|--------|--------|
| **Timestamp precision auto-alignment** | Snowflake nanoseconds (9) vs PostgreSQL microseconds (6) creates phantom diffs on every row. Current tolerance must be manually configured. | Theme B, Theme F |
| **NaN/Infinity handling** | `NaN = NaN` is TRUE in PostgreSQL and Snowflake but FALSE per IEEE 754. Inconsistent handling causes false match/mismatch depending on the database pair. | Theme F |
| **Empty string vs NULL (Oracle compat)** | Oracle treats `''` as NULL. Migrating Oracle to Snowflake/PostgreSQL creates mismatches on every row with empty strings. This is the #1 Oracle migration issue. | Theme F |
| **CHAR padding normalization** | PostgreSQL `CHAR(10)` pads with spaces and ignores trailing spaces in comparison. Snowflake `CHAR` is just `VARCHAR` — no padding. Cross-database string comparison breaks on every CHAR column. | Theme B |
| **Hash format normalization in HashDiff** | MD5 output is hex in Snowflake/PostgreSQL but base64 in BigQuery. HashDiff checksums will never match cross-database without normalization. | Theme F |
| **Identifier case normalization** | Snowflake uppercases unquoted identifiers. PostgreSQL lowercases them. Column name `MyCol` becomes `MYCOL` in Snowflake and `mycol` in PostgreSQL. Cross-database column matching fails. | Theme F |

### P1: High-Value (Dramatically Improve Cost or UX)

| Gap | Impact | Source |
|-----|--------|--------|
| **HASH_AGG fingerprint pre-check** | Near-zero cost table equality test. Catches 95% of "tables are identical" cases in seconds, avoiding expensive full diffs. | Theme A |
| **Pre-flight schema compatibility check** | Query `INFORMATION_SCHEMA` before diffing. Surface type mismatches, missing columns, and constraint differences. Saves compute on tables that can't match. | Theme D |
| **Progressive auto-escalation** | Count -> Profile -> HASH_AGG -> Sample -> Full Diff. Stop at first pass level. Currently Cascade exists but lacks HASH_AGG and sampling levels. | Theme A |
| **TABLESAMPLE integration** | 99% confidence at 1% margin on 100M rows requires only 16,600 samples (0.017%). Use SYSTEM sampling for >10M rows to actually reduce scan cost. | Theme A |
| **Boolean normalization** | PostgreSQL outputs `t`/`f`, Snowflake `true`/`false`, MySQL `1`/`0`. All mean the same thing but compare as different strings. | Theme B |
| **Type coercion warnings** | Warn before diffing: "Snowflake NUMBER(38,0) is integer-only. If source has decimals, they were truncated." Prevents hours of debugging false diffs. | Theme B, Theme D |
| **Partition-level checksums** | Only diff changed partitions, skip unchanged. A date-partitioned 10TB table filtered to today scans 30GB — a 300x cost reduction. | Theme A |
| **Query batching** | Snowflake bills per-second with 60-second minimum on warehouse resume. Bundle 10 count queries into one session to amortize the minimum. | Theme A |

### P2: Differentiators (Set Us Apart from Competition)

| Gap | Impact | Source |
|-----|--------|--------|
| **Contract-aware diffing** | Consume ODCS/Soda/dbt contract YAML. Pre-diff: validate schema, constraints, freshness. Post-diff: validate diffs against contract rules. No competitor does both contract validation and row-level diffing. | Theme I |
| **JSON canonical comparison** | Parse and compare structurally instead of as strings. Handle key reordering (Snowflake/BigQuery don't preserve order), JSON null vs SQL NULL vs missing key trichotomy, and integers >2^53 that lose precision in BigQuery. | Theme B, Theme F |
| **DuckDB multi-attach bridge** | DuckDB can simultaneously attach PostgreSQL, MySQL, Snowflake, and read S3 Parquet. Use as local validation engine for cross-database comparison without data movement. | Theme J |
| **Schema drift detection** | Track schema fingerprints between runs. Detect column additions, removals, type changes. Classify as breaking/non-breaking/data-loss. | Theme D |
| **Distribution comparison (PSI/Wasserstein)** | Compare distributions without row-level diff. PSI < 0.1 = stable, 0.1-0.25 = investigate, >= 0.25 = action required. Complements aggregate profile checks. | Theme E |
| **Incremental validation** | Snowflake Streams (`SYSTEM$STREAM_HAS_DATA()`) and Delta CDF (`table_changes()`) enable validating only changed rows. Cost proportional to change rate, not table size. | Theme A, Theme C |
| **Column mapping suggestions** | When columns exist in source but not target, suggest mappings based on name similarity + type compatibility + statistics. Handles renamed columns during migration. | Theme D |

### P3: Nice-to-Have (Future Enhancements)

| Gap | Impact | Source |
|-----|--------|--------|
| **HLL cardinality pre-check** | Approximate distinct count comparison using native HLL functions. 2% error, 100x cheaper than COUNT(DISTINCT). | Theme A |
| **Bloom filter / IBLT set difference** | Find missing rows without full scan. IBLTs compute symmetric difference with space proportional to difference size, not table size. Not yet adopted in data migration tools — opportunity. | Theme A |
| **whylogs profile export** | Generate whylogs-compatible profiles from profile results. Enables integration with ML monitoring ecosystems. | Theme E, Theme K |
| **Zero-width character stripping** | U+200B-U+200F and U+FEFF cause invisible mismatches in string keys and JOINs. Option to strip before comparison. | Theme F |
| **BOM detection** | UTF-8 BOM (`EF BB BF`) corrupts first column name in CSV imports. Warn when detected. | Theme F |
| **Unicode NFC/NFD normalization** | macOS stores filenames in NFD, Linux in NFC. Same characters, different bytes. Option to normalize before comparison. | Theme F |
| **Collation-aware comparison** | Case-insensitive and accent-insensitive comparison modes for cross-database string matching. | Theme F |
| **Spatial data tolerance** | GEOGRAPHY/GEOMETRY comparison with configurable vertex-coordinate epsilon for floating-point vertex differences. | Theme B |
| **Replay/idempotency testing** | Run pipeline twice, compare outputs via Reladiff to verify idempotency. Integration with time-travel for deterministic replay. | Theme G |

---

## 3. Competitive Positioning

### Market Landscape After Datafold's Open-Source Sunset

Datafold archived data-diff on May 17, 2024. The commercial Datafold Cloud pivoted away from the bisection algorithm to in-memory diffing, efficiently handling up to ~10M rows with sampling for larger datasets. This creates a clear gap:

```
                    Cross-Database ──────────── Same-Database
                         │                           │
  Row-Level    Reladiff ─┤                 ┌── dbt-audit-helper
  Diffing      Google DVT┤                 ├── DataComPy (in-memory)
               Datafold $┤                 ├── Dolt (versioned DB)
                         │                 │
  Aggregate    SodaCL ───┤                 ├── SQLMesh audits
  Validation   GX ───────┤                 ├── Elementary
                         │                 ├── DQOps
                         │                 │
  Observability Monte Carlo ($100K+/yr)    ├── Bigeye
  (ML-based)   Anomalo                     └── Metaplane
```

### Reladiff's Unique Position

**The only open-source tool with all three properties:**
1. Cross-database (12+ databases)
2. Row-level diffing (not just aggregates)
3. Billion-row scale (bisection algorithm, ~5 min for 1B rows)

No competitor matches this combination:
- **Google DVT**: Cross-database, row-level hash, but no bisection — brute-force parallelization via GKE/Cloud Run. GCP-centric.
- **dbt-audit-helper**: Same-database only, no row-level diff output, full table scans.
- **DataComPy**: In-memory only, no cross-database pushdown, OOM on large tables.
- **SodaCL**: Aggregate-level only, no row-level diff. Reconciliation requires paid Soda Library.
- **Datafold Cloud**: $799+/month, pivoted away from bisection, capped at ~10M rows for cross-database.

### Value Proposition

**For migration teams:** "Validate your 5,000-table Redshift-to-Snowflake migration with the same bisection algorithm Datafold used, at zero license cost. 1B rows in 5 minutes."

**For dbt teams:** "Progressive validation that costs pennies instead of dollars. HASH_AGG fingerprint -> sample diff -> full diff only when needed."

**For platform teams:** "Contract-aware data diffing. Validate that your data meets its ODCS contract AND matches across environments in one tool."

---

## 4. Cost Model

### Progressive Escalation Pyramid

```
Level 0: Metadata    — Schema match, column types, nullable flags     [~0 credits]
Level 1: Count       — Row counts per table, per partition            [~0.001 credits]
Level 2: Profile     — MIN/MAX/AVG/STDDEV, NULL counts, HLL distinct  [~0.01 credits]
Level 3: Checksum    — HASH_AGG(*) per table or per partition         [~0.01 credits]
Level 4: Sample Diff — TABLESAMPLE 1% + row-level comparison          [~0.1 credits]
Level 5: Full Diff   — Bisection algorithm or MINUS                   [~1-10 credits]
```

### Snowflake Credit Pricing

| Edition | On-Demand ($/credit) | Prepaid ($/credit) |
|---------|---------------------|-------------------|
| Standard | ~$2.00 | ~$1.20-1.70 |
| Enterprise | ~$3.00 | ~$1.80-2.50 |
| Business Critical | ~$4.00 | ~$2.40-3.40 |

### Warehouse Size for Validation

| Size | Credits/Hour | Best For |
|------|-------------|----------|
| X-Small | 1 | Most validation queries (I/O-bound) |
| Small | 2 | Medium tables |
| Medium | 4 | Large profile scans |
| Large | 8 | Billion-row full diffs |

**60-second minimum trap:** Each warehouse resume bills for at least 60 seconds. A 5-second query costs 0.0167 credits (1/60th hour). Bundle validation queries to amortize.

### Real Cost Estimates for 100-Table Pipeline (Snowflake Enterprise)

| Approach | Estimated Cost | Time |
|----------|---------------|------|
| Naive: MINUS on all 100 tables | $300-3,000 | Hours |
| Level 1-3 only (count + profile + HASH_AGG) | $0.50-2.00 | 5-10 min |
| Level 1-3 + Level 4 sampling on flagged | $1.00-5.00 | 10-20 min |
| Level 1-5 progressive (full diff on ~5 tables) | $5.00-20.00 | 20-45 min |
| Incremental (stream-aware, delta-only) | $0.10-1.00 | 1-5 min |

### BigQuery Cost Model

| Metric | Value |
|--------|-------|
| On-demand | $6.25/TB scanned |
| Free tier | 1 TB/month |
| `--dry_run` | Free (estimates bytes) |
| Cached result | Free |
| `APPROX_COUNT_DISTINCT` vs exact | 93% cost reduction (DoiT case study) |

**BigQuery optimization**: Column selection matters. `SELECT col1, col2` scans far less than `SELECT *`. On a 100-column table, selecting 5 columns reduces scan cost by ~95%.

### Key Cost Optimization Techniques

1. **Snowflake result cache**: Re-running same HASH_AGG query = zero credits for 24h. Makes continuous validation nearly free for stable tables.
2. **Partition pruning**: Filter on clustering keys. A 4.7TB table went from 300K micro-partitions/21 min to same results in 2 seconds.
3. **XS warehouse**: Validation is I/O-bound. XS (1 credit/hour) is sufficient for most queries.
4. **Auto-suspend**: 60 seconds for validation warehouses.
5. **BigQuery `maximum_bytes_billed`**: Hard cap per query to prevent runaway costs.

---

## 5. Type Coercion Matrix

### The Most Dangerous Coercions (Silent Data Loss)

| Source Type | Target Type | What Happens | Detection |
|------------|------------|--------------|-----------|
| BigQuery `BIGNUMERIC(76,38)` | Snowflake `NUMBER(38,0)` | 76 decimal digits truncated to 38, decimals dropped entirely | Compare precision metadata before diff |
| Snowflake `NUMBER(38,0)` | Any `DECIMAL` with scale > 0 | Snowflake NUMBER without explicit scale = **integer only**. `123.456` becomes `123`. | Check `numeric_scale` in INFORMATION_SCHEMA |
| Snowflake `TIMESTAMP_NTZ(9)` | PostgreSQL `TIMESTAMP(6)` | Last 3 digits (nanoseconds) truncated. `10:30:45.123456789` becomes `10:30:45.123457` (rounded!) | Auto-truncate to min(source_precision, target_precision) |
| MySQL `TINYINT(1)` | PostgreSQL `BOOLEAN` | If source stores 0-9 (not just 0/1), all non-zero become TRUE. **Data loss.** | Sample source values before migration |
| `FLOAT`/`REAL` (any) | `DECIMAL`/`NUMERIC` (any) | `0.2` stored as 32-bit float reads back as `0.20000000298023224`. Round-trip precision loss. | Use tolerance-based comparison, never exact |
| Oracle `NUMBER` (no precision) | Snowflake `NUMBER(38,0)` | Oracle stores any numeric; Snowflake truncates to integer | Check if source column contains non-integer values |
| Any JSON (BigQuery) | JSON integers > 2^53 | BigQuery uses FLOAT64 internally. `9007199254740993` becomes `9007199254740992`. Silent off-by-one. | Compare as strings for large integers |
| PostgreSQL `JSONB` | Snowflake `VARIANT` | JSONB reorders keys alphabetically. VARIANT output order "not predictable." String comparison fails. | Parse and compare structurally |
| Any array | BigQuery `ARRAY` | BigQuery arrays cannot contain NULLs. `[1, NULL, 3]` is an error. | Pre-check for NULL array elements |
| PostgreSQL `''` (empty string) | Oracle `NULL` | Oracle treats empty string as NULL. Every empty string becomes NULL. | Oracle-specific empty-string-as-NULL mode |

### Cross-Database Type Equivalence (Condensed)

| Concept | PostgreSQL | Snowflake | BigQuery | DuckDB | MySQL |
|---------|-----------|-----------|----------|--------|-------|
| Integer | `INTEGER` (32-bit) | `NUMBER(10,0)` | `INT64` (64-bit only) | `INTEGER` (32-bit) | `INT` (32-bit) |
| Exact decimal | `NUMERIC(p,s)` | `NUMBER(p,s)` [default s=0!] | `NUMERIC(38,9)` [default s=9] | `DECIMAL(p,s)` | `DECIMAL(p,s)` |
| Float | `REAL` (32-bit) | `FLOAT` (64-bit always!) | `FLOAT64` (64-bit) | `FLOAT` (32-bit) | `FLOAT` (32-bit) |
| Boolean | `BOOLEAN` (t/f) | `BOOLEAN` (true/false) | `BOOL` | `BOOLEAN` | `TINYINT(1)` (0/1) |
| Timestamp no TZ | `TIMESTAMP` (6) | `TIMESTAMP_NTZ` (9) | No equivalent | `TIMESTAMP` (6) | `DATETIME` (6) |
| Timestamp UTC | `TIMESTAMPTZ` (6) | `TIMESTAMP_TZ` (9) | `TIMESTAMP` (6) | `TIMESTAMPTZ` (6) | `TIMESTAMP` (6) |
| JSON | `JSONB` (reorders keys) | `VARIANT` (unpredictable order) | `JSON` (no order preserved) | `JSON` (VARCHAR) | `JSON` |
| Array | `ARRAY` (NULLs OK) | `ARRAY` (NULLs OK) | `ARRAY<T>` (NO NULLs!) | `LIST` | `JSON` |
| Binary | `BYTEA` (hex, `\x` prefix) | `BINARY` (hex, no prefix) | `BYTES` (base64) | `BLOB` | `BLOB` |
| UUID | `UUID` (native) | `VARCHAR` | `STRING` | `UUID` (native) | `CHAR(36)` |

**Critical notes:**
- Snowflake `FLOAT` is always 64-bit. PostgreSQL `REAL` (32-bit) values gain phantom precision when migrated.
- BigQuery `INT64` is the only integer type. All integer widths widen to 64-bit.
- DuckDB `HUGEINT` (128-bit) has no equivalent in any other database.

---

## 6. Failure Mode Checklist

The top failure modes any data validation tool MUST handle, ranked by frequency and severity.

| # | Failure Mode | Severity | What Happens | Reladiff Status |
|---|-------------|----------|--------------|-----------------|
| 1 | **Floating-point SUM non-reproducibility** | High | Same data, different aggregation order = different SUM result across databases. False diff on identical data. | Partial: numeric tolerance exists. Gap: no warning about FP aggregation non-determinism. |
| 2 | **Timestamp precision mismatch** | High | Snowflake nano (9) vs PostgreSQL micro (6). Every timestamp row shows as different. | Partial: timestamp tolerance exists. Gap: no auto-detection of precision mismatch. |
| 3 | **NULL semantics (NOT IN trap)** | Critical | `WHERE id NOT IN (subquery)` returns zero rows if subquery contains ANY NULL. Validation query silently returns wrong answer. | Handled: JoinDiff uses IS NOT DISTINCT FROM. Not documented as guidance. |
| 4 | **JSON key ordering** | High | PostgreSQL JSONB reorders alphabetically, Snowflake VARIANT order "not predictable." String comparison of JSON always fails cross-database. | Not handled. Must parse and compare structurally. |
| 5 | **Boolean representation** | Medium | `t` vs `true` vs `1` for the same logical value. String-based comparison across databases fails. | Not handled. Must normalize to canonical form. |
| 6 | **Oracle empty string = NULL** | High | Only Oracle treats `''` as NULL. Every other database preserves empty strings. Migration creates mismatches on every empty-string column. | Not handled. Need configurable empty-string-as-NULL mode. |
| 7 | **CHAR padding** | Medium | PostgreSQL CHAR pads with spaces and ignores in comparison. Snowflake treats CHAR as VARCHAR (no padding). `'hello' != 'hello     '` in Snowflake. | Not handled. Must trim trailing spaces for CHAR columns. |
| 8 | **Collation differences** | Medium | glibc 2.28 changed ASCII sort order, causing silent PostgreSQL index corruption. MySQL default collation is Swedish. String comparisons differ across environments. | Not handled. Guidance: use C locale or ICU for cross-database. |
| 9 | **Undeterministic query order** | Medium | Without ORDER BY, result order is undefined. Hash-based comparison of ordered results fails intermittently. ROW_NUMBER() with duplicate ORDER BY values swaps between runs. | Partially handled by bisection design. ROW_NUMBER dedup not addressed. |
| 10 | **Silent VARCHAR truncation** | High | SQL Server with ANSI_WARNINGS OFF silently truncates. `CAST(x AS VARCHAR)` without length defaults to 30 chars in some databases. Data silently corrupted. | Not handled. Need length validation in pre-flight schema check. |

### Real-World Post-Mortems That Validate These Failure Modes

- **GitLab (2017)**: Five backup mechanisms silently failed for months. Periodic backup validation (row count comparison) would have caught it.
- **Meta (2021)**: Faulty CPUs caused missing rows in databases at rates of several per thousand CPUs. Cross-system validation detects what single-system checksums cannot.
- **Knight Capital (2012)**: $440M lost in 45 minutes. Post-deployment binary hash comparison would have caught the version mismatch across servers.
- **CrowdStrike (2024)**: Schema mismatch (21 fields defined, 20 provided) crashed 8.5M machines. Schema drift detection would have caught it.
- **Zillow (2021)**: $881M loss from stale/incorrect property attributes feeding ML model. Input data quality checks would have surfaced issues.

---

## 7. Test Coverage Gaps

Based on all research themes, the following scenarios should be tested but are likely not covered today.

### Cross-Database Type Coercion Tests

| Test Case | Why It Matters |
|-----------|----------------|
| Snowflake `NUMBER(38,0)` vs PostgreSQL `NUMERIC(10,2)` — insert `123.456`, compare | Verifies decimal truncation detection |
| Snowflake `TIMESTAMP_NTZ(9)` vs PostgreSQL `TIMESTAMP(6)` — insert value with nanoseconds, compare | Verifies auto-precision alignment |
| MySQL `TINYINT(1)` with values {0, 1, 2, 5} vs PostgreSQL `BOOLEAN` | Verifies boolean collapse detection |
| BigQuery `ARRAY<INT64>` with vs without NULL elements vs PostgreSQL `ARRAY` | Verifies NULL-in-array handling |
| PostgreSQL `JSONB` vs Snowflake `VARIANT` with same logical JSON, different key order | Verifies structural JSON comparison |
| Any database `FLOAT` column: insert `0.1 + 0.2`, compare with `0.3` | Verifies numeric tolerance applies to FP arithmetic results |
| Oracle empty string `''` vs Snowflake empty string `''` | Verifies Oracle compatibility mode |
| PostgreSQL `CHAR(10)` value `'hello'` vs Snowflake `CHAR(10)` value `'hello'` | Verifies trailing space normalization |

### Edge Case Tests

| Test Case | Why It Matters |
|-----------|----------------|
| NaN values in float columns across two databases | Verifies NaN = NaN consistency |
| Infinity values in float columns | Verifies special float handling |
| Timestamps during DST spring-forward gap (e.g., 2:30 AM that doesn't exist) | Verifies DST handling |
| Timestamps during DST fall-back overlap (1:30 AM that occurs twice) | Verifies DST handling |
| Zero-width Unicode characters (U+200B) in primary key column | Verifies invisible character handling |
| BOM (EF BB BF) as first bytes of first column name | Verifies BOM detection |
| JSON with integer > 2^53 (e.g., `9007199254740993`) | Verifies large integer precision |
| Snowflake VARIANT: SQL NULL vs JSON null vs missing key | Verifies triple-NULL distinction |
| Table with zero rows (source) vs table with zero rows (target) | Verifies empty table comparison |
| Table with all NULL values in compared columns | Verifies NULL-heavy comparison |

### Performance and Cost Tests

| Test Case | Why It Matters |
|-----------|----------------|
| 1B row table, zero differences, measure query count and time | Baseline for bisection efficiency |
| 1B row table, 0.01% differences, measure convergence | Sparse diff performance |
| 100-table batch validation, measure total warehouse cost | Validates query batching optimization |
| TABLESAMPLE SYSTEM vs BERNOULLI on 100M rows, compare accuracy | Validates sampling strategy selection |
| Snowflake result cache hit on repeated HASH_AGG query | Validates cache exploitation |
| BigQuery dry_run cost estimate vs actual cost | Validates cost prediction |

### Schema Validation Tests

| Test Case | Why It Matters |
|-----------|----------------|
| Source has column, target doesn't | Pre-flight schema check |
| Same column name, different types (INT vs VARCHAR) | Type mismatch detection |
| Column renamed between source and target | Column mapping suggestion |
| Snowflake uppercase vs PostgreSQL lowercase identifiers | Identifier normalization |
| NOT NULL in source, NULLABLE in target | Constraint mismatch detection |
| Snowflake PK (metadata-only, not enforced) vs PostgreSQL PK (enforced) | Constraint enforcement awareness |

### Contract Validation Tests

| Test Case | Why It Matters |
|-----------|----------------|
| ODCS YAML with `required: true` column missing from target | Contract violation detection |
| ODCS YAML with `freshness: 24h` and data older than 24h | SLA violation detection |
| ODCS YAML with `pii: true` column in diff output | PII masking in diff results |
| Contract with `primaryKey: true` and duplicates in target | Constraint violation detection |

---

## 8. Developer Experience Priorities (Theme L)

### CLI Design Principles

1. **Summary-first output**: Show pass/fail counts first, details on demand (`--verbose`/`--json`)
2. **Progressive disclosure**: `reladiff validate` shows table-level results → `reladiff diff <table>` shows row-level → `--json` for programmatic
3. **Three-file config**: `connections.yml` (credentials), `validation.yml` (what to validate), `output.yml` (how to report)
4. **Cost guard rails**: `--dry-run` estimates cost before execution, `--max-cost` aborts if estimate exceeds threshold
5. **CI-native output**: `--format github-pr-comment` generates Markdown summary with collapsible `<details>` for PR comments

### Output Format Hierarchy

```
Level 1 (default):  ✓ users (match)  ✗ orders (3 diffs)  ✓ products (match)
Level 2 (--verbose): Column-level match rates per table
Level 3 (--json):    Full machine-readable output with diff_rows, stats, metadata
Level 4 (--html):    Visual report for stakeholder review
```

### Key Gaps Identified

| Gap | Priority | Source |
|-----|----------|--------|
| No `--dry-run` cost estimation | P1 | Theme L |
| No PR comment integration | P1 | Theme L |
| No progress indicator for long runs | P1 | Theme L |
| No MCP server tool definitions | P2 | Theme L |
| No Jupyter inline display | P2 | Theme L |
| No run history / SQLite persistence | P2 | Theme L |

---

## 9. Governance & Compliance Priorities (Theme M)

### Regulatory Requirements Matrix

| Regulation | Key Requirement | Reladiff Relevance |
|-----------|----------------|-------------------|
| **SOX Section 404** | Data accuracy controls, 7-year audit retention | Validation results as ITGC evidence |
| **GDPR Article 5(1)(d)** | Personal data accuracy obligation | Diff results prove data accuracy across systems |
| **HIPAA** | Data integrity controls (checksums, signatures) | Cross-system validation for healthcare data |
| **BCBS 239** | Risk data accuracy, completeness, timeliness | Bank migration validation evidence |
| **PCI DSS** | Cardholder data integrity (Req 10/11) | Validate cardholder data processing pipelines |

### Audit Trail Requirements

Every validation run should produce an immutable record containing:
- **Run metadata**: timestamp, user, source/target, algorithm, parameters
- **Results**: pass/fail, row counts, diff counts, column match rates
- **Evidence**: hash of full results (for tamper detection), execution cost
- **Lineage**: which pipeline/DAG triggered the validation

### Key Gaps for Compliance

| Gap | Priority | Impact |
|-----|----------|--------|
| No immutable audit log output format | P1 | SOX/HIPAA require tamper-evident records |
| No PII masking in diff output | P1 | GDPR: diff output may expose personal data |
| No right-to-erasure verification mode | P2 | GDPR Article 17: prove data was deleted |
| No data classification awareness | P2 | PCI DSS: different handling for cardholder data |
| No validation result retention/export | P2 | SOX 7-year retention requirement |
| No role-based access to diff results | P3 | Prevent validation as data exfiltration vector |

### Strategic Position

**No open-source data-diff tool addresses governance comprehensively.** This is a clear differentiation opportunity. Even commercial tools (Datafold, Monte Carlo) focus on data quality, not regulatory compliance. A governance-aware validation layer would be a first-mover advantage.

---

## Appendix: Key Tool Versions and Links

| Tool | Version/Status | Link |
|------|---------------|------|
| Reladiff | v0.6.0 (March 2025) | [github.com/erezsh/reladiff](https://github.com/erezsh/reladiff) |
| Datafold data-diff | Archived (May 2024) | [github.com/datafold/data-diff](https://github.com/datafold/data-diff) |
| Google DVT | Active | [GitHub](https://github.com/GoogleCloudPlatform/professional-services-data-validator) |
| ODCS | v3.1.0 | [GitHub](https://github.com/bitol-io/open-data-contract-standard) |
| datacontract-cli | Active | [GitHub](https://github.com/datacontract/datacontract-cli) |
| Soda Core | Active | [GitHub](https://github.com/sodadata/soda-core) |
| DuckDB | Active | [duckdb.org](https://duckdb.org/) |
| Apache DataSketches | Active | [datasketches.apache.org](https://datasketches.apache.org/) |
| Evidently AI | Active | [GitHub](https://github.com/evidentlyai/evidently) |
| whylogs | Community-only (WhyLabs acquired by Apple, 2025) | [GitHub](https://github.com/whylabs/whylogs) |

## Appendix: Research Document Index

| Theme | File | Size | Topic |
|-------|------|------|-------|
| Iteration 1 | `iteration-1-landscape.md` | 5KB | Initial broad landscape survey |
| A | `theme-a-cost-effective.md` | 30KB | Progressive validation, HASH_AGG, sampling |
| B | `theme-b-type-coercion.md` | 33KB | Cross-DB type mapping, coercion matrix |
| C | `theme-c-streaming-cdc.md` | 52KB | Snowflake STREAMS, partition checksums |
| D | `theme-d-schema-evolution.md` | 39KB | Schema fingerprinting, drift detection |
| E | `theme-e-statistical-validation.md` | 27KB | KS, PSI, Wasserstein, DataSketches |
| F | `theme-f-failure-modes.md` | 39KB | Post-mortems, zero-width chars, collation |
| G | `theme-g-replay-idempotency.md` | 70KB | Time-travel, Stripe Scientist, dbt unit tests |
| H | `theme-h-tool-landscape.md` | 52KB | Datafold sunset, competitive positioning |
| I | `theme-i-data-contracts.md` | 38KB | ODCS v3.1.0, contract-validated diffing |
| J | `theme-j-multi-db-orchestration.md` | 50KB | DuckDB bridge, AWS DMS, Iceberg |
| K | `theme-k-ml-data-validation.md` | 41KB | TFDV, Evidently, WhyLabs, Timefence |
| L | `theme-l-developer-experience.md` | 73KB | CLI patterns, output formats, CI/CD, IDE |
| M | `theme-m-governance-compliance.md` | ~40KB | SOX, GDPR, HIPAA, audit trails, PII |
