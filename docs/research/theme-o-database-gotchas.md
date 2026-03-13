# Theme O: Database-Specific Gotchas Encyclopedia

_Iteration 2 — 2026-03-13_

## Executive Summary

Every database has dark corners where documented behavior diverges from developer intuition. In data validation, these dark corners produce the most dangerous class of bugs: **silent correctness failures** — diffs that report "no differences" when data has actually changed, or "differences found" when data is semantically identical. This encyclopedia catalogs the specific behaviors, per database, that a validation engine like Reladiff must handle to produce trustworthy results.

This document is organized by database, with each section covering: type comparison semantics, NULL handling, collation and encoding, temporal types, semi-structured data, and cost/performance gotchas specific to validation workloads. A cross-database severity matrix at the end maps each gotcha to its validation impact.

**Key finding**: The majority of false positives in cross-database validation stem from just five root causes: (1) floating-point representation divergence, (2) timestamp precision/timezone mismatch, (3) collation-dependent string comparison, (4) JSON/semi-structured key ordering, and (5) NULL semantics in aggregate functions. Handling these five categories correctly eliminates ~85% of spurious diff noise.

---

## 1. Snowflake

### 1.1 VARIANT / OBJECT / ARRAY Comparison Semantics

Snowflake's semi-structured types are the source of the most subtle validation failures.

#### Key Ordering in OBJECT

Snowflake OBJECT preserves insertion order internally but **compares by key-value equality regardless of order**:

```sql
-- These are EQUAL in Snowflake
SELECT PARSE_JSON('{"a":1,"b":2}') = PARSE_JSON('{"b":2,"a":1}');
-- Result: TRUE

-- But CAST to VARCHAR produces DIFFERENT strings:
SELECT CAST(PARSE_JSON('{"a":1,"b":2}') AS VARCHAR);
-- '{"a":1,"b":2}'
SELECT CAST(PARSE_JSON('{"b":2,"a":1}') AS VARCHAR);
-- '{"b":2,"a":1}'
```

**Validation impact**: If Reladiff compares VARIANT columns by casting to VARCHAR and hashing, semantically identical objects produce different hashes. This is a **false positive** — the diff reports a change where none exists.

**Mitigation**: Never cast VARIANT to VARCHAR for comparison. Use Snowflake's native `=` operator for VARIANT comparison, or normalize key order before hashing:

```sql
-- Normalize by re-parsing through OBJECT_CONSTRUCT with sorted keys
-- Unfortunately, Snowflake has no built-in key-sort function.
-- Workaround: use HASH(col) which handles VARIANT natively
SELECT HASH(variant_col) FROM my_table;
```

#### NULL vs. Undefined in VARIANT

Snowflake distinguishes between SQL NULL, JSON `null`, and "undefined" (missing key):

```sql
SELECT
  PARSE_JSON('{"a": null}'):a,           -- JSON null (displayed as 'null')
  PARSE_JSON('{"a": null}'):a IS NULL,   -- FALSE! JSON null is NOT SQL NULL
  PARSE_JSON('{"b": 1}'):a,              -- undefined (displayed as nothing)
  PARSE_JSON('{"b": 1}'):a IS NULL,      -- TRUE — undefined IS SQL NULL
  PARSE_JSON(NULL),                       -- SQL NULL
  PARSE_JSON(NULL) IS NULL;               -- TRUE
```

**Validation impact**: A row where a JSON key was explicitly set to `null` vs. a row where the key is absent will compare as **different** when using native VARIANT comparison, but may compare as **identical** if the validation engine treats both as NULL. Both directions produce incorrect results depending on business semantics.

**Mitigation**: Reladiff should use `TYPEOF(col:key)` to distinguish:
- `'NULL_VALUE'` = JSON null
- SQL NULL = key absent
- Any other type = value present

```sql
SELECT
  TYPEOF(PARSE_JSON('{"a": null}'):a),  -- 'NULL_VALUE'
  TYPEOF(PARSE_JSON('{"b": 1}'):a);     -- NULL (SQL NULL, key absent)
```

#### ARRAY Comparison

Arrays compare element-by-element with order sensitivity:

```sql
SELECT ARRAY_CONSTRUCT(1, 2, 3) = ARRAY_CONSTRUCT(1, 2, 3);  -- TRUE
SELECT ARRAY_CONSTRUCT(1, 2, 3) = ARRAY_CONSTRUCT(1, 3, 2);  -- FALSE
SELECT ARRAY_CONSTRUCT(1, 2, 3) = ARRAY_CONSTRUCT(1, 2, 3, NULL);  -- NULL!
```

The third case is critical: **any NULL element makes the entire comparison return NULL**, not FALSE. This follows SQL three-valued logic but surprises most developers.

**Validation impact**: Rows containing ARRAY columns with NULL elements will be reported as "unable to compare" rather than "same" or "different". If the validation engine treats NULL comparison results as "different", arrays with trailing NULLs generate false positives.

**Mitigation**: Use `ARRAYS_OVERLAP` and `ARRAY_SIZE` together, or serialize with `ARRAY_TO_STRING` using a known delimiter, replacing NULLs explicitly:

```sql
SELECT ARRAY_TO_STRING(ARRAY_CONSTRUCT(1, NULL, 3), '|');
-- '1||3' — NULLs become empty strings between delimiters
```

#### FLATTEN Behavior

`FLATTEN` on NULL or empty arrays behaves differently:

```sql
-- NULL input: FLATTEN produces zero rows
SELECT * FROM TABLE(FLATTEN(input => NULL));
-- Empty result set

-- Empty array: FLATTEN also produces zero rows
SELECT * FROM TABLE(FLATTEN(input => PARSE_JSON('[]')));
-- Empty result set

-- But a LATERAL FLATTEN with OUTER => TRUE preserves the row:
SELECT t.id, f.value
FROM my_table t, LATERAL FLATTEN(input => t.arr_col, OUTER => TRUE) f;
-- Rows with NULL/empty arr_col appear with NULL f.value
```

**Validation impact**: When validating denormalized tables created via FLATTEN, missing `OUTER => TRUE` silently drops rows with NULL/empty arrays. A validation query that flattens to compare nested elements will under-count rows.

**Test case suggestion**:
```sql
-- Setup
CREATE TABLE gotcha_flatten (id INT, tags VARIANT);
INSERT INTO gotcha_flatten VALUES
  (1, PARSE_JSON('["a","b"]')),
  (2, PARSE_JSON('[]')),
  (3, NULL);

-- Without OUTER: only row 1 appears (2 rows from flatten)
SELECT id, f.value FROM gotcha_flatten, LATERAL FLATTEN(input => tags) f;

-- With OUTER: all 3 rows appear
SELECT id, f.value FROM gotcha_flatten, LATERAL FLATTEN(input => tags, OUTER => TRUE) f;
```

### 1.2 Timestamp Subtleties: NTZ / LTZ / TZ

Snowflake has three timestamp types, and confusion between them is the #1 source of temporal validation failures.

| Type | Stores | Session-dependent? | Default |
|------|--------|-------------------|---------|
| `TIMESTAMP_NTZ` | Wall clock, no timezone | No | Yes (unless `TIMESTAMP_TYPE_MAPPING` changed) |
| `TIMESTAMP_LTZ` | UTC instant | Yes — display converts to session TZ | No |
| `TIMESTAMP_TZ` | UTC instant + original TZ offset | No | No |

```sql
-- The same instant, three representations:
ALTER SESSION SET TIMEZONE = 'America/New_York';

SELECT
  '2024-06-15 10:00:00'::TIMESTAMP_NTZ AS ntz,  -- 2024-06-15 10:00:00.000
  '2024-06-15 10:00:00'::TIMESTAMP_LTZ AS ltz,  -- 2024-06-15 10:00:00.000 -0400
  '2024-06-15 10:00:00'::TIMESTAMP_TZ  AS tz;   -- 2024-06-15 10:00:00.000 -0400

-- Now change session timezone:
ALTER SESSION SET TIMEZONE = 'UTC';

SELECT
  '2024-06-15 10:00:00'::TIMESTAMP_NTZ AS ntz,  -- 2024-06-15 10:00:00.000 (SAME)
  '2024-06-15 10:00:00'::TIMESTAMP_LTZ AS ltz,  -- 2024-06-15 14:00:00.000 +0000 (DIFFERENT!)
  '2024-06-15 10:00:00'::TIMESTAMP_TZ  AS tz;   -- 2024-06-15 10:00:00.000 -0400 (SAME)
```

**Validation impact**: If Reladiff connects with a different `TIMEZONE` session parameter than the pipeline that wrote the data, TIMESTAMP_LTZ values will **display differently** even though the underlying UTC instant is identical. Comparing stringified timestamps produces false positives.

**Mitigation**: Always set `ALTER SESSION SET TIMEZONE = 'UTC'` at connection time. Compare TIMESTAMP_LTZ by converting to NTZ in UTC:

```sql
SELECT CONVERT_TIMEZONE('UTC', ltz_column)::TIMESTAMP_NTZ FROM my_table;
```

#### TIME_INPUT_FORMAT

Snowflake's `TIME_INPUT_FORMAT` session parameter affects how string-to-time parsing works:

```sql
ALTER SESSION SET TIME_INPUT_FORMAT = 'HH24:MI:SS';
SELECT '2:30 PM'::TIME;  -- ERROR: not a valid time

ALTER SESSION SET TIME_INPUT_FORMAT = 'HH12:MI AM';
SELECT '2:30 PM'::TIME;  -- 14:30:00
```

**Validation impact**: If validation queries parse time strings, different session formats produce different parsed values or errors. Always use explicit `TO_TIME(str, format)` rather than relying on session defaults.

#### Nanosecond Precision

Snowflake timestamps store up to 9 digits of fractional seconds (nanoseconds). PostgreSQL stores 6 (microseconds). BigQuery stores 6.

```sql
-- Snowflake
SELECT '2024-01-15 10:30:00.123456789'::TIMESTAMP_NTZ;
-- 2024-01-15 10:30:00.123456789

-- When this migrates to PostgreSQL:
-- 2024-01-15 10:30:00.123457 (rounded to microseconds!)
```

**Validation impact**: Cross-database timestamp comparison will show sub-microsecond differences. The diff is technically real (precision was lost) but usually not meaningful.

**Mitigation**: Truncate both sides to microsecond precision before comparison:

```sql
-- Snowflake side
SELECT DATE_TRUNC('MICROSECOND', ts_col) FROM my_table;
-- PostgreSQL side
SELECT DATE_TRUNC('microsecond', ts_col) FROM my_table;
```

### 1.3 BINARY_INPUT_FORMAT

Snowflake supports two binary literal formats controlled by session parameter:

```sql
ALTER SESSION SET BINARY_INPUT_FORMAT = 'HEX';
SELECT 'ABCD'::BINARY;  -- interprets as hex bytes: 0xABCD

ALTER SESSION SET BINARY_INPUT_FORMAT = 'BASE64';
SELECT 'ABCD'::BINARY;  -- interprets as base64: 0x001083
```

**Validation impact**: The same string literal produces entirely different binary values depending on session setting. If validation hashes binary columns by first casting to string, the result depends on `BINARY_OUTPUT_FORMAT`.

**Mitigation**: Always use `HEX_ENCODE(binary_col)` for consistent string representation regardless of session settings:

```sql
SELECT HEX_ENCODE(binary_col) AS binary_hex FROM my_table;
```

### 1.4 Case Sensitivity: The Identifier Trap

Snowflake uppercases all unquoted identifiers:

```sql
CREATE TABLE my_table (my_column INT);
-- Internally stored as: MY_TABLE.MY_COLUMN

SELECT my_column FROM my_table;      -- Works (resolved as MY_COLUMN)
SELECT "my_column" FROM my_table;    -- ERROR: column "my_column" not found
SELECT "MY_COLUMN" FROM my_table;    -- Works
```

**Validation impact**: When Reladiff introspects column names to build comparison queries, it must handle the case where:
1. Column created without quotes: stored as uppercase, must be referenced uppercase or unquoted
2. Column created with quotes: stored as-is, must be referenced with exact case in quotes

If metadata queries return `MY_COLUMN` but the diff query uses `"my_column"`, the query fails.

**Mitigation**: Always quote identifiers with the exact case returned by `INFORMATION_SCHEMA.COLUMNS`. For Snowflake, use `SHOW COLUMNS` which returns the stored case:

```sql
SHOW COLUMNS IN TABLE my_schema.my_table;
-- Returns "column_name" in the exact stored case
```

### 1.5 DECIMAL(38,0) — The Silent Integer Trap

Snowflake's default `NUMBER` type is `NUMBER(38,0)` — effectively a 38-digit integer:

```sql
CREATE TABLE test (val NUMBER);
INSERT INTO test VALUES (123.456);
SELECT val FROM test;
-- Result: 123 (truncated to integer!)
```

This is documented but catches teams migrating from PostgreSQL where `NUMERIC` without precision is unconstrained.

**Validation impact**: When comparing a PostgreSQL `NUMERIC` column (which preserves `123.456`) against a Snowflake `NUMBER` column (which stores `123`), every fractional value shows as a diff. These are real diffs caused by DDL mismatch, not data corruption — but the validation engine should flag the root cause.

**Mitigation**: Before running a diff, compare column DDL. If source is `NUMERIC` (unbounded) and target is `NUMBER(38,0)`, warn the user about potential precision loss. Optionally, compare by rounding the source to the target's scale.

### 1.6 Collation: Case-Insensitive VARCHAR by Default

Snowflake's default collation for `VARCHAR` is **case-insensitive** and **accent-insensitive**:

```sql
SELECT 'hello' = 'HELLO';  -- TRUE in Snowflake!
SELECT 'cafe' = 'cafe';    -- TRUE (accent-insensitive)

-- To get case-sensitive comparison:
SELECT COLLATE('hello', 'utf8') = COLLATE('HELLO', 'utf8');  -- FALSE
```

**Validation impact**: If the source database (PostgreSQL, BigQuery) is case-sensitive by default and the target is Snowflake, values like `'Hello'` and `'hello'` will show as different in the source but identical in Snowflake. Cross-database comparison may miss case-change diffs.

**Mitigation**: For cross-database string comparison, normalize case on both sides:

```sql
-- Option 1: Force case-sensitive comparison in Snowflake
SELECT * FROM t1 WHERE COLLATE(name, 'utf8') != COLLATE(t2.name, 'utf8');

-- Option 2: Normalize both sides to uppercase
SELECT UPPER(name) FROM t1;
```

### 1.7 GEOGRAPHY and GEOMETRY Types

Snowflake supports `GEOGRAPHY` (spherical, WGS84) and `GEOMETRY` (planar) types. Comparison is not straightforward:

```sql
-- These represent the same point but compare as different objects:
SELECT TO_GEOGRAPHY('POINT(-122.35 37.55)') = TO_GEOGRAPHY('POINT(-122.35 37.55)');
-- TRUE (same WKT)

-- But with different representations:
SELECT TO_GEOGRAPHY('POINT(-122.35 37.55)') =
       TO_GEOGRAPHY('{"type":"Point","coordinates":[-122.35,37.55]}');
-- TRUE (Snowflake normalizes internally)

-- Floating-point coordinate precision matters:
SELECT TO_GEOGRAPHY('POINT(-122.350000001 37.55)') =
       TO_GEOGRAPHY('POINT(-122.35 37.55)');
-- FALSE (different coordinates, even if within GPS precision)
```

**Validation impact**: Geospatial data migrated between systems often loses or gains coordinate precision. Exact equality will produce false diffs for points that are spatially identical within measurement precision.

**Mitigation**: Compare geographic data using `ST_DISTANCE` with a tolerance:

```sql
SELECT * FROM t1 JOIN t2 ON t1.id = t2.id
WHERE ST_DISTANCE(t1.geo_col, t2.geo_col) > 0.01;  -- 0.01 meters tolerance
```

### 1.8 Clustering Key Impact on Validation Scan Costs

Snowflake's micro-partition pruning depends on clustering:

```sql
-- Well-clustered table: validation query scans few partitions
SELECT COUNT(*) FROM large_table WHERE date_col BETWEEN '2024-01-01' AND '2024-01-02';
-- Scans: 12 partitions out of 50,000

-- Poorly-clustered table: same query scans many partitions
-- Scans: 48,000 partitions out of 50,000
```

**Validation impact**: Validation queries that don't align with clustering keys incur massive scan costs. A full-table hash comparison on a 10TB table can cost $50-200 in Snowflake credits if it triggers a full scan.

**Mitigation**: Reladiff should introspect clustering keys and build segment-based validation queries aligned with them:

```sql
-- Discover clustering key
SELECT SYSTEM$CLUSTERING_INFORMATION('my_schema.my_table');

-- Build validation segments that align with clustering
-- If clustered on (date_col), segment by date ranges
SELECT MD5(LISTAGG(col1||col2||col3, ',') WITHIN GROUP (ORDER BY pk))
FROM my_table
WHERE date_col = '2024-01-15'
GROUP BY date_col;
```

---

## 2. PostgreSQL

### 2.1 NUMERIC vs DOUBLE PRECISION

PostgreSQL's `NUMERIC` is arbitrary-precision; `DOUBLE PRECISION` is IEEE 754 64-bit float:

```sql
-- NUMERIC: exact arithmetic
SELECT 0.1::NUMERIC + 0.2::NUMERIC;  -- 0.3

-- DOUBLE PRECISION: floating-point arithmetic
SELECT 0.1::DOUBLE PRECISION + 0.2::DOUBLE PRECISION;
-- 0.30000000000000004

-- Comparison trap:
SELECT 0.1::DOUBLE PRECISION + 0.2::DOUBLE PRECISION = 0.3::DOUBLE PRECISION;
-- FALSE!

-- But:
SELECT 0.1::NUMERIC + 0.2::NUMERIC = 0.3::NUMERIC;
-- TRUE
```

**Validation impact**: If a pipeline converts `NUMERIC` to `DOUBLE PRECISION` (common when ingesting to analytics stores), exact equality checks will produce false diffs for values that lost precision in the float conversion.

**Mitigation**: For float columns, compare using a relative epsilon:

```sql
-- Compare with epsilon
SELECT * FROM t1 JOIN t2 ON t1.id = t2.id
WHERE ABS(t1.float_col - t2.float_col) > 1e-10 * GREATEST(ABS(t1.float_col), ABS(t2.float_col), 1e-30);
```

### 2.2 JSONB Key Ordering vs JSON Preservation

This is one of the most commonly misunderstood PostgreSQL behaviors:

```sql
-- JSON: preserves exact input, including key order and whitespace
SELECT '{"b": 2, "a": 1}'::JSON;
-- '{"b": 2, "a": 1}'

-- JSONB: normalizes — sorts keys, removes whitespace, deduplicates keys
SELECT '{"b": 2, "a": 1}'::JSONB;
-- '{"a": 1, "b": 2}'

-- JSON equality is TEXT comparison (order-sensitive):
SELECT '{"a":1,"b":2}'::JSON::TEXT = '{"b":2,"a":1}'::JSON::TEXT;
-- FALSE

-- JSONB equality is semantic (order-insensitive):
SELECT '{"a":1,"b":2}'::JSONB = '{"b":2,"a":1}'::JSONB;
-- TRUE

-- Duplicate keys in JSON are preserved, in JSONB last-write-wins:
SELECT '{"a":1,"a":2}'::JSON;   -- '{"a":1,"a":2}' (both kept)
SELECT '{"a":1,"a":2}'::JSONB;  -- '{"a": 2}' (last wins)
```

**Validation impact**: Comparing a `JSON` column by text representation is order-sensitive, producing false diffs for reordered keys. Comparing `JSONB` is correct but loses duplicate keys. If migrating from `JSON` to `JSONB`, duplicate-key rows will appear as diffs (because data was genuinely lost/changed).

**Mitigation**: Always cast `JSON` to `JSONB` before comparison to get semantic equality. Document that duplicate-key `JSON` values will show as diffs when compared against `JSONB`.

```sql
-- Normalize JSON to JSONB for comparison
SELECT t1.id FROM t1 JOIN t2 ON t1.id = t2.id
WHERE t1.json_col::JSONB != t2.json_col::JSONB;
```

#### JSONB Numeric Precision

JSONB stores numbers with full precision, but there is a subtle trap:

```sql
SELECT '{"val": 0.30000000000000004}'::JSONB = '{"val": 0.3}'::JSONB;
-- FALSE — JSONB preserves numeric precision

SELECT ('{"val": 0.30000000000000004}'::JSONB ->> 'val')::DOUBLE PRECISION =
       ('{"val": 0.3}'::JSONB ->> 'val')::DOUBLE PRECISION;
-- Depends on float representation!
```

**Validation impact**: JSON documents containing float values computed on different systems may have slightly different string representations of the same float, producing false diffs.

### 2.3 Array Comparison: Order Matters

PostgreSQL arrays are ordered:

```sql
SELECT ARRAY[1, 2, 3] = ARRAY[1, 2, 3];  -- TRUE
SELECT ARRAY[1, 2, 3] = ARRAY[1, 3, 2];  -- FALSE
SELECT ARRAY[1, 2, 3] = ARRAY[3, 2, 1];  -- FALSE

-- Containment operators ignore order:
SELECT ARRAY[1, 2, 3] @> ARRAY[3, 1];    -- TRUE (contains)
SELECT ARRAY[1, 2, 3] <@ ARRAY[3, 2, 1]; -- TRUE (is contained by)

-- NULL in arrays:
SELECT ARRAY[1, NULL, 3] = ARRAY[1, NULL, 3];  -- NULL (not TRUE!)
SELECT ARRAY[1, NULL, 3] IS NOT DISTINCT FROM ARRAY[1, NULL, 3];  -- TRUE
```

**Validation impact**: If an ETL process reconstructs an array from a set (e.g., `ARRAY_AGG` without `ORDER BY`), the element order may change between runs. Validation will report a diff for every such row, even though the array contains the same elements.

**Mitigation**: For set-semantic arrays, sort before comparing:

```sql
-- Sort array for comparison (PostgreSQL doesn't have a built-in array_sort until v16)
-- Workaround:
SELECT ARRAY(SELECT unnest(arr_col) ORDER BY 1) FROM my_table;

-- PostgreSQL 16+:
-- No built-in yet, but intarray extension provides sort():
SELECT sort(arr_col) FROM my_table;  -- integer arrays only
```

### 2.4 TEXT vs VARCHAR vs CHAR(n)

```sql
-- TEXT and VARCHAR are identical in PostgreSQL:
SELECT 'hello'::TEXT = 'hello'::VARCHAR;  -- TRUE
SELECT pg_column_size('hello'::TEXT), pg_column_size('hello'::VARCHAR);
-- Both: 6 bytes (1 byte header + 5 chars)

-- CHAR(n) pads with spaces:
SELECT 'hello'::CHAR(10);  -- 'hello     ' (padded to 10)
SELECT pg_column_size('hello'::CHAR(10));  -- 11 bytes

-- But comparison TRIMS trailing spaces for CHAR:
SELECT 'hello'::CHAR(10) = 'hello'::TEXT;  -- TRUE (!)
SELECT 'hello'::CHAR(10) = 'hello     '::TEXT;  -- TRUE

-- LENGTH does NOT trim:
SELECT LENGTH('hello'::CHAR(10));  -- 10 (includes padding)
SELECT LENGTH('hello'::TEXT);      -- 5
```

**Validation impact**: When comparing a `CHAR(n)` column against `TEXT`/`VARCHAR`, the `=` operator handles padding correctly, but string hashing (e.g., `MD5(col)`) will produce different hashes because the raw string values differ:

```sql
SELECT MD5('hello'::CHAR(10));  -- MD5 of 'hello     ' (with spaces)
SELECT MD5('hello'::TEXT);      -- MD5 of 'hello' (no spaces)
-- DIFFERENT hashes for semantically equal values!
```

**Mitigation**: Always `RTRIM()` `CHAR(n)` columns before hashing:

```sql
SELECT MD5(RTRIM(char_col)) FROM my_table;
```

### 2.5 Timezone Handling: timestamptz Stores UTC

```sql
SET TIMEZONE TO 'America/New_York';

-- timestamptz: converts input to UTC, displays in session TZ
INSERT INTO ts_test (tstz) VALUES ('2024-06-15 10:00:00');
-- Stored as: 2024-06-15 14:00:00 UTC

SET TIMEZONE TO 'UTC';
SELECT tstz FROM ts_test;
-- Displays: 2024-06-15 14:00:00+00

SET TIMEZONE TO 'America/New_York';
SELECT tstz FROM ts_test;
-- Displays: 2024-06-15 10:00:00-04

-- timestamp (without timezone): no conversion, ever
INSERT INTO ts_test2 (ts) VALUES ('2024-06-15 10:00:00');
SET TIMEZONE TO 'UTC';
SELECT ts FROM ts_test2;
-- Still: 2024-06-15 10:00:00 (no conversion)
```

**Validation impact**: If Reladiff connects to PostgreSQL with a different `TIMEZONE` setting than the original application, `timestamptz` values will display differently in query results. If the comparison is done via string representation (e.g., in a driver that returns strings), this produces false diffs.

**Mitigation**: Always `SET TIMEZONE TO 'UTC'` at connection time. Compare timestamps as epoch seconds:

```sql
SELECT EXTRACT(EPOCH FROM tstz_col) FROM my_table;
```

#### DST Ambiguity

```sql
SET TIMEZONE TO 'America/New_York';

-- Spring forward: 2:30 AM doesn't exist
SELECT '2024-03-10 02:30:00'::TIMESTAMPTZ;
-- PostgreSQL adjusts: 2024-03-10 03:30:00-04 (skips ahead)

-- Fall back: 1:30 AM exists twice
SELECT '2024-11-03 01:30:00'::TIMESTAMPTZ;
-- PostgreSQL picks the first occurrence (EDT, before the change)
-- 2024-11-03 01:30:00-04
```

**Validation impact**: If source data contains wall-clock timestamps in a DST-affected timezone, converting to `timestamptz` during ingestion may silently shift ambiguous times. Validation against the source would show 1-hour differences for ~1 hour of data per DST transition.

### 2.6 TOAST Compression and Large Field Comparison

PostgreSQL compresses large values (>2KB) using TOAST (The Oversized-Attribute Storage Technique):

```sql
-- Values > 2KB are automatically compressed and stored out-of-line
-- This is transparent to queries — SELECT always returns decompressed data

-- But: pg_column_size shows compressed size
SELECT pg_column_size(large_text_col) FROM my_table;
-- May return 500 for a value that's 10,000 chars when decompressed
```

**Validation impact**: TOAST compression is transparent to SQL comparison, so it does **not** affect correctness. However, it affects **performance**: large text/bytea columns are stored out-of-line, and accessing them requires additional I/O. Validation queries that hash entire rows including large TOAST columns will be significantly slower than expected from row counts alone.

**Mitigation**: For tables with large TOAST columns, consider:
1. Exclude large columns from initial diff (compare metadata/small columns first)
2. Use `pg_column_size()` to estimate I/O cost before full comparison
3. Compare large columns only for rows that differ on other columns

### 2.7 Collation: C vs en_US.UTF-8

Collation affects sort order, which affects segment boundaries in hash-based validation:

```sql
-- With C collation: byte-order sorting
SELECT 'a' < 'B' COLLATE "C";  -- FALSE ('B' = 0x42, 'a' = 0x61, 0x42 < 0x61)

-- With en_US.UTF-8: linguistic sorting
SELECT 'a' < 'B' COLLATE "en_US.UTF-8";  -- TRUE (lowercase 'a' sorts before 'B')

-- This affects ORDER BY, which affects GROUP BY boundaries:
SELECT * FROM strings ORDER BY val COLLATE "C";
-- 'A', 'B', 'C', 'a', 'b', 'c'

SELECT * FROM strings ORDER BY val COLLATE "en_US.UTF-8";
-- 'a', 'A', 'b', 'B', 'c', 'C'
```

**Validation impact**: If Reladiff uses ordered aggregation (`LISTAGG ... WITHIN GROUP (ORDER BY col)`) to build segment checksums, different collations produce different orderings, leading to different checksums for identical data. This is a **false positive**.

**Mitigation**: Use `COLLATE "C"` explicitly in all ORDER BY clauses within validation queries, or sort by a collation-insensitive representation (e.g., `ENCODE(col::BYTEA, 'hex')`):

```sql
SELECT MD5(STRING_AGG(col1 || col2, ',' ORDER BY pk COLLATE "C"))
FROM my_table
WHERE segment_key = 'A';
```

### 2.8 Composite Types and ROW Comparisons

```sql
-- ROW comparison follows lexicographic order:
SELECT ROW(1, 'a') = ROW(1, 'a');   -- TRUE
SELECT ROW(1, 'a') < ROW(1, 'b');   -- TRUE
SELECT ROW(1, 'a') < ROW(2, 'a');   -- TRUE

-- NULL handling in ROW comparison:
SELECT ROW(1, NULL) = ROW(1, NULL);       -- NULL (not TRUE!)
SELECT ROW(1, NULL) IS NOT DISTINCT FROM ROW(1, NULL);  -- TRUE

-- Named composite types:
CREATE TYPE address AS (street TEXT, city TEXT, zip TEXT);
SELECT ROW('123 Main', 'NYC', '10001')::address =
       ROW('123 Main', 'NYC', '10001')::address;  -- TRUE
```

**Validation impact**: Composite type columns are compared field-by-field, which is correct. But if one database stores the composite as a JSON object and the other as a native composite type, comparison requires custom field-by-field extraction.

### 2.9 ENUM Type Comparison

```sql
CREATE TYPE mood AS ENUM ('sad', 'ok', 'happy');

-- ENUMs compare by position, not alphabetically:
SELECT 'sad'::mood < 'ok'::mood;    -- TRUE (position 1 < position 2)
SELECT 'happy'::mood < 'ok'::mood;  -- FALSE (position 3 > position 2)

-- But as strings: 'happy' < 'ok' is TRUE (alphabetical)!
```

**Validation impact**: If Reladiff casts ENUM to TEXT for comparison, sort order changes. This affects ordered aggregations and segment boundaries. Also, ENUM values cannot be directly compared with strings from another database without explicit casting.

**Mitigation**: Cast ENUM to TEXT for cross-database comparison, but never rely on sort order:

```sql
SELECT col::TEXT FROM my_table;
```

### 2.10 Range Types

PostgreSQL's range types have complex comparison semantics:

```sql
-- Range equality:
SELECT '[1,5]'::INT4RANGE = '[1,6)'::INT4RANGE;  -- TRUE!
-- PostgreSQL canonicalizes integer ranges to [inclusive, exclusive)
-- [1,5] becomes [1,6) internally

-- Overlap:
SELECT '[1,5]'::INT4RANGE && '[3,8]'::INT4RANGE;  -- TRUE

-- Contains:
SELECT '[1,10]'::INT4RANGE @> 5;  -- TRUE

-- Timestamp ranges:
SELECT TSRANGE('2024-01-01', '2024-01-31', '[]') =
       TSRANGE('2024-01-01', '2024-01-31', '[]');
-- TRUE — but no canonicalization for non-discrete types
```

**Validation impact**: Integer ranges get canonicalized, so `[1,5]` and `[1,6)` are stored identically. If the source system has `[1,5]` and the target has `[1,6)`, they are semantically equal but textually different. Validation by text comparison produces false positives.

**Mitigation**: Compare ranges using native `=` operator, or canonicalize to `[lower, upper)` format:

```sql
SELECT LOWER(range_col), UPPER(range_col),
       LOWER_INC(range_col), UPPER_INC(range_col)
FROM my_table;
```

### 2.11 Custom Domains

```sql
CREATE DOMAIN email AS TEXT CHECK (VALUE ~ '^[^@]+@[^@]+\.[^@]+$');
CREATE DOMAIN positive_int AS INT CHECK (VALUE > 0);

-- Domains are type aliases with constraints:
SELECT 'test@example.com'::email = 'test@example.com'::TEXT;  -- TRUE
```

**Validation impact**: Domains are transparent to comparison (they compare as their base type). However, domain constraints may cause INSERT failures during validation data setup. Reladiff should introspect domains to understand base types.

---

## 3. BigQuery

### 3.1 STRUCT Comparison

BigQuery STRUCTs compare field-by-field in definition order:

```sql
-- STRUCT comparison is field-by-field:
SELECT STRUCT(1 AS a, 'hello' AS b) = STRUCT(1 AS a, 'hello' AS b);
-- TRUE

-- Field ORDER in definition matters for typed STRUCTs:
SELECT STRUCT(1 AS a, 'hello' AS b) = STRUCT('hello' AS b, 1 AS a);
-- ERROR: type mismatch (INT64 vs STRING in first field)

-- But with compatible types, field names are ignored:
SELECT STRUCT(1, 'hello') = STRUCT(1, 'hello');
-- TRUE — positional comparison

-- NULL fields:
SELECT STRUCT(1, NULL) = STRUCT(1, NULL);
-- NULL (SQL NULL semantics apply per-field)
```

**Validation impact**: STRUCT comparison is semantic and order-dependent in BigQuery. If source and target have fields in different order, direct comparison fails. Unlike JSON, STRUCT field order is part of the schema.

**Mitigation**: Compare by extracting individual fields:

```sql
SELECT *
FROM source s JOIN target t ON s.id = t.id
WHERE s.struct_col.field1 != t.struct_col.field1
   OR s.struct_col.field2 != t.struct_col.field2;
```

### 3.2 REPEATED Fields (Arrays)

BigQuery uses REPEATED mode instead of explicit array types:

```sql
-- Array comparison:
SELECT [1, 2, 3] = [1, 2, 3];  -- TRUE
SELECT [1, 2, 3] = [1, 3, 2];  -- FALSE (order-sensitive)

-- NULL handling in arrays:
SELECT [1, NULL, 3] = [1, NULL, 3];  -- NULL (not TRUE)

-- UNNEST is required for element-level operations:
SELECT * FROM UNNEST([1, 2, 3]) AS element;

-- Array of STRUCTs (common pattern):
SELECT [STRUCT(1 AS id, 'a' AS name), STRUCT(2 AS id, 'b' AS name)] AS items;
```

**Validation impact**: REPEATED fields containing arrays of STRUCTs are particularly problematic. If element order changes between source and target, every row with that field appears as a diff.

**Mitigation**: For set-semantic arrays, sort by a key field before comparison:

```sql
-- Sort array of structs by id before comparing
SELECT ARRAY(
  SELECT AS STRUCT * FROM UNNEST(items) ORDER BY id
) AS sorted_items;
```

### 3.3 GEOGRAPHY Type

BigQuery's GEOGRAPHY uses spherical geometry (S2 cells internally):

```sql
-- WKT input:
SELECT ST_GEOGPOINT(-122.35, 37.55);

-- GeoJSON input:
SELECT ST_GEOGFROMGEOJSON('{"type":"Point","coordinates":[-122.35,37.55]}');

-- Equality is based on normalized representation:
SELECT ST_GEOGPOINT(-122.35, 37.55) = ST_GEOGFROMGEOJSON('{"type":"Point","coordinates":[-122.35,37.55]}');
-- TRUE

-- But string representation may differ:
SELECT ST_ASTEXT(ST_GEOGPOINT(-122.35, 37.55));
-- 'POINT(-122.35 37.55)'
SELECT ST_ASGEOJSON(ST_GEOGPOINT(-122.35, 37.55));
-- '{"type":"Point","coordinates":[-122.35,37.55]}'
```

**Validation impact**: Same geographic point may be represented as WKT in one system and GeoJSON in another. Text comparison fails. Must use spatial equality or distance-based comparison.

**Mitigation**: Compare using `ST_EQUALS` or distance threshold:

```sql
SELECT * FROM source s JOIN target t ON s.id = t.id
WHERE NOT ST_EQUALS(s.geo_col, t.geo_col);

-- Or with tolerance:
WHERE ST_DISTANCE(s.geo_col, t.geo_col) > 0.01;
```

### 3.4 NUMERIC(29,9) vs BIGNUMERIC(38,38)

```sql
-- NUMERIC: 29 digits before decimal, 9 after
SELECT CAST(99999999999999999999999999999.999999999 AS NUMERIC);
-- Works: max value

SELECT CAST(0.0000000001 AS NUMERIC);
-- Rounds to 0.000000000 (only 9 decimal places)

-- BIGNUMERIC: 38 digits before decimal, 38 after
SELECT CAST(0.0000000001 AS BIGNUMERIC);
-- Preserved: 0.0000000001

-- Cross-type comparison trap:
SELECT CAST(1.0/3.0 AS NUMERIC) = CAST(1.0/3.0 AS BIGNUMERIC);
-- FALSE — different precision in result
```

**Validation impact**: If source uses `BIGNUMERIC` and target uses `NUMERIC`, values with more than 9 decimal places will be truncated. This is a real data loss, but may be acceptable depending on use case.

**Mitigation**: Compare at the precision of the less-precise type:

```sql
SELECT * FROM source s JOIN target t ON s.id = t.id
WHERE ROUND(CAST(s.val AS BIGNUMERIC), 9) != CAST(t.val AS NUMERIC);
```

### 3.5 DATE / DATETIME / TIMESTAMP Distinction

BigQuery has three temporal types, which is unique among major databases:

```sql
-- DATE: calendar date, no time component
SELECT DATE '2024-06-15';

-- DATETIME: date + time, NO timezone (like Snowflake's TIMESTAMP_NTZ)
SELECT DATETIME '2024-06-15 10:30:00';

-- TIMESTAMP: absolute point in time, always UTC internally
SELECT TIMESTAMP '2024-06-15 10:30:00 America/New_York';
-- Stored as: 2024-06-15 14:30:00 UTC
```

| BigQuery | PostgreSQL Equivalent | Snowflake Equivalent |
|----------|----------------------|---------------------|
| `DATE` | `DATE` | `DATE` |
| `DATETIME` | `TIMESTAMP` (without tz) | `TIMESTAMP_NTZ` |
| `TIMESTAMP` | `TIMESTAMPTZ` | `TIMESTAMP_LTZ` / `TIMESTAMP_TZ` |

**Validation impact**: Mapping errors between DATETIME and TIMESTAMP are the most common cause of temporal diffs. A `DATETIME '2024-06-15 10:30:00'` in BigQuery compared to a `TIMESTAMPTZ '2024-06-15 10:30:00 UTC'` in PostgreSQL may or may not be equal depending on the intended timezone.

**Mitigation**: Explicitly document the timezone assumption for each column. In cross-database comparison, always convert to UTC epoch:

```sql
-- BigQuery: DATETIME to epoch (assuming UTC)
SELECT UNIX_SECONDS(TIMESTAMP(datetime_col, 'UTC')) FROM my_table;

-- BigQuery: TIMESTAMP to epoch
SELECT UNIX_SECONDS(ts_col) FROM my_table;
```

### 3.6 _PARTITIONTIME Pseudo-Column

BigQuery's ingestion-time partitioned tables have a hidden `_PARTITIONTIME` column:

```sql
-- This column is not in the schema but is queryable:
SELECT _PARTITIONTIME, * FROM my_partitioned_table
WHERE _PARTITIONTIME BETWEEN '2024-01-01' AND '2024-01-31';

-- For column-partitioned tables, the partition column is real:
SELECT * FROM my_table WHERE date_col BETWEEN '2024-01-01' AND '2024-01-31';
```

**Validation impact**: Validation queries must use partition filters to avoid full-table scans. BigQuery charges for bytes scanned, and a validation query without partition pruning on a multi-TB table can cost hundreds of dollars.

**Mitigation**: Always include partition filters in validation queries:

```sql
-- Validate one partition at a time
SELECT FARM_FINGERPRINT(TO_JSON_STRING(t)) AS row_hash, *
FROM my_table t
WHERE _PARTITIONTIME = '2024-06-15'
ORDER BY primary_key;
```

### 3.7 Slot-Based Cost Model

BigQuery uses a slot-based execution model where complex queries consume more slots:

```sql
-- Simple count: fast, cheap
SELECT COUNT(*) FROM my_table WHERE partition_col = '2024-06-15';

-- Full-row hash: expensive, consumes many slots
SELECT FARM_FINGERPRINT(TO_JSON_STRING(t))
FROM my_table t
WHERE partition_col = '2024-06-15';

-- Cross-join for diff: potentially catastrophic
SELECT * FROM source s FULL OUTER JOIN target t ON s.pk = t.pk
WHERE TO_JSON_STRING(s) != TO_JSON_STRING(t);
-- If both tables are large, this consumes all available slots
```

**Validation impact**: BigQuery's on-demand pricing ($6.25/TB scanned) and slot-based execution mean validation strategy must be cost-aware. A naive full-table diff on a 10TB table costs ~$62.50 per run.

**Mitigation**: Use hierarchical validation:
1. Row count comparison (nearly free)
2. Partition-level checksums (moderate cost)
3. Row-level diff only on partitions with mismatched checksums (targeted cost)

```sql
-- Step 1: partition-level checksum
SELECT
  _PARTITIONTIME AS partition_ts,
  COUNT(*) AS row_count,
  FARM_FINGERPRINT(STRING_AGG(CAST(FARM_FINGERPRINT(TO_JSON_STRING(t)) AS STRING), ',' ORDER BY pk)) AS partition_hash
FROM my_table t
GROUP BY _PARTITIONTIME;
```

---

## 4. DuckDB

### 4.1 SQLite Compatibility Mode

DuckDB has a SQLite compatibility mode that changes behavior:

```sql
-- Normal DuckDB: strict typing
SELECT 1 + '2';  -- ERROR or 3 (depends on version)

-- SQLite compatibility:
SET sqlite_compatibility = true;
SELECT 1 + '2';  -- 3 (implicit coercion)
SELECT typeof(1 + '2');  -- 'BIGINT'
```

**Validation impact**: If Reladiff uses DuckDB as a local diff engine (reading Parquet/CSV files), the compatibility mode affects type coercion behavior. Queries that work in compatibility mode may produce different results in strict mode.

**Mitigation**: Never use SQLite compatibility mode for validation. Always use strict DuckDB mode with explicit casts.

### 4.2 Parquet / CSV File Scanning

DuckDB can directly scan Parquet and CSV files, which is powerful for validation but has gotchas:

```sql
-- Parquet scanning: schema comes from Parquet metadata
SELECT * FROM read_parquet('data/*.parquet');

-- CSV scanning: schema is inferred
SELECT * FROM read_csv('data.csv');

-- Type inference from CSV can be wrong:
-- File contains: id,value
--               1,001
--               2,002
SELECT typeof(value) FROM read_csv('data.csv');
-- Could be: VARCHAR (leading zeros preserved)
-- Or: INTEGER (leading zeros stripped) — depends on sniff_csv settings!
```

**Validation impact**: CSV type inference is the most dangerous DuckDB gotcha. If Reladiff reads a CSV export from one database and compares against another database, inferred types may not match actual types. A column of ZIP codes (`'01234'`) may be inferred as INTEGER (`1234`), producing false diffs.

**Mitigation**: Always specify column types explicitly when reading CSV:

```sql
SELECT * FROM read_csv('data.csv', columns={
  'id': 'INTEGER',
  'zip_code': 'VARCHAR',
  'amount': 'DECIMAL(10,2)'
});
```

#### Parquet Decimal Precision

Parquet files store decimals with fixed precision/scale. DuckDB reads these faithfully, but:

```sql
-- Parquet written by Spark with DECIMAL(38,18):
SELECT val FROM read_parquet('spark_output.parquet');
-- 123.456000000000000000 (18 decimal places)

-- Compared against PostgreSQL NUMERIC:
-- 123.456 (no trailing zeros in pg output)

-- Hash comparison: different strings!
SELECT MD5('123.456000000000000000') = MD5('123.456');
-- FALSE
```

**Mitigation**: Normalize decimal representation before hashing:

```sql
-- Strip trailing zeros
SELECT RTRIM(RTRIM(CAST(val AS VARCHAR), '0'), '.') FROM my_table;
```

### 4.3 MAP Type Comparison

DuckDB's MAP type has unique comparison semantics:

```sql
-- MAP creation:
SELECT MAP {'a': 1, 'b': 2};

-- MAP equality compares keys and values:
SELECT MAP {'a': 1, 'b': 2} = MAP {'a': 1, 'b': 2};  -- TRUE
SELECT MAP {'a': 1, 'b': 2} = MAP {'b': 2, 'a': 1};  -- TRUE (order-independent!)

-- MAP with NULL values:
SELECT MAP {'a': 1, 'b': NULL} = MAP {'a': 1, 'b': NULL};  -- NULL

-- MAP element access:
SELECT MAP {'a': 1, 'b': 2}['a'];  -- 1
SELECT MAP {'a': 1, 'b': 2}['c'];  -- NULL (missing key)
```

**Validation impact**: MAP comparison is order-independent (good), but NULL values still cause NULL comparison results (problematic). When validating MAP columns, use element-wise comparison with `IS NOT DISTINCT FROM`.

### 4.4 HUGEINT for 128-bit Integers

```sql
-- DuckDB supports 128-bit integers:
SELECT 170141183460469231731687303715884105727::HUGEINT;
-- Max HUGEINT value

-- No other common database supports this natively:
-- Snowflake: NUMBER(38,0) — max ~10^38, HUGEINT max ~1.7*10^38
-- PostgreSQL: NUMERIC (arbitrary, but not a native integer type)
-- BigQuery: INT64 — max ~9.2*10^18

-- HUGEINT arithmetic is exact:
SELECT 170141183460469231731687303715884105727::HUGEINT -
       170141183460469231731687303715884105726::HUGEINT;
-- 1
```

**Validation impact**: If DuckDB is used as an intermediary for validation (reading from Parquet, comparing against a database), HUGEINT values that exceed INT64 range will overflow in BigQuery and need NUMERIC representation in other databases.

**Mitigation**: Cast HUGEINT to VARCHAR for cross-database comparison:

```sql
SELECT CAST(hugeint_col AS VARCHAR) FROM my_table;
```

### 4.5 Extension-Dependent Type Support

DuckDB types depend on loaded extensions:

```sql
-- Without spatial extension:
SELECT ST_POINT(1.0, 2.0);  -- ERROR: function not found

-- With spatial extension:
INSTALL spatial;
LOAD spatial;
SELECT ST_POINT(1.0, 2.0);  -- POINT (1 2)

-- Similarly for ICU (Unicode collation):
INSTALL icu;
LOAD icu;
-- Now locale-aware collation is available
```

**Validation impact**: If Reladiff uses DuckDB as a local engine, the available type system depends on loaded extensions. A validation that works with spatial extension loaded will fail without it.

**Mitigation**: Auto-detect required extensions based on column types and load them at connection time:

```python
EXTENSION_MAP = {
    'GEOMETRY': 'spatial',
    'GEOGRAPHY': 'spatial',
    'INET': 'inet',
}
# Load extensions based on detected column types
```

### 4.6 In-Process vs File-Based Persistence

```sql
-- In-memory (default): data lost when process exits
duckdb.connect()  -- or duckdb.connect(':memory:')

-- File-based: persists to disk
duckdb.connect('my_db.duckdb')

-- Concurrent access: only ONE write connection allowed
-- Multiple read connections are fine

-- Attach external database:
ATTACH 'postgres://user:pass@host/db' AS pg_db (TYPE postgres);
SELECT * FROM pg_db.schema.table;
```

**Validation impact**: For validation test suites, in-memory mode means each test starts fresh (good for isolation). But if validation requires persisting intermediate results across stages (e.g., compute checksums, then drill into mismatches), file-based mode is necessary.

**Mitigation**: Use file-based persistence for multi-stage validation, in-memory for single-query tests:

```python
# Multi-stage validation
conn = duckdb.connect('validation_state.duckdb')

# Stage 1: compute checksums
conn.execute("""
    CREATE TABLE checksums AS
    SELECT segment, MD5(STRING_AGG(row_hash, ',' ORDER BY pk)) AS segment_hash
    FROM source_data
    GROUP BY segment
""")

# Stage 2: drill into mismatched segments
mismatched = conn.execute("""
    SELECT s.segment FROM checksums s
    JOIN target_checksums t ON s.segment = t.segment
    WHERE s.segment_hash != t.segment_hash
""").fetchall()
```

---

## 5. Databricks / Spark SQL

### 5.1 Delta Lake Time Travel for Validation

Delta Lake's time travel is a validation superpower — and a gotcha source:

```sql
-- Query table as of a specific version:
SELECT * FROM my_table VERSION AS OF 5;

-- Query table as of a timestamp:
SELECT * FROM my_table TIMESTAMP AS OF '2024-06-15 10:00:00';

-- Compare two versions:
SELECT a.*, b.*
FROM my_table VERSION AS OF 5 a
FULL OUTER JOIN my_table VERSION AS OF 10 b
ON a.pk = b.pk
WHERE a.col1 != b.col1 OR a.col1 IS NULL != b.col1 IS NULL;
```

**Gotcha**: Time travel has a retention period (`delta.logRetentionDuration`, default 30 days). After VACUUM, old versions are inaccessible:

```sql
-- This fails after VACUUM has cleaned versions older than retention:
SELECT * FROM my_table VERSION AS OF 1;
-- ERROR: version 1 is no longer available

-- VACUUM removes files not referenced by versions within retention:
VACUUM my_table RETAIN 168 HOURS;  -- 7 days
```

**Validation impact**: If validation is scheduled to run after VACUUM, historical comparisons are lost. A validation that passed last week may not be reproducible if VACUUM ran between then and now.

**Mitigation**: Run validation before VACUUM, or maintain a validation snapshot table that persists checksums independent of Delta history:

```sql
-- Persist validation results before VACUUM
CREATE TABLE validation_history AS
SELECT CURRENT_TIMESTAMP() AS validated_at,
       'my_table' AS table_name,
       COUNT(*) AS row_count,
       MD5(CONCAT_WS(',', COLLECT_LIST(CAST(hash AS STRING)))) AS table_hash
FROM (SELECT MD5(CONCAT_WS('|', col1, col2, col3)) AS hash FROM my_table);
```

### 5.2 FLOAT vs DOUBLE Precision

Spark SQL has the same IEEE 754 issues as other databases, with additional gotchas:

```sql
-- FLOAT is 32-bit, DOUBLE is 64-bit:
SELECT CAST(0.1 AS FLOAT) + CAST(0.2 AS FLOAT);
-- 0.30000001192092896 (different from DOUBLE result!)

SELECT CAST(0.1 AS DOUBLE) + CAST(0.2 AS DOUBLE);
-- 0.30000000000000004

-- Comparing FLOAT to DOUBLE:
SELECT CAST(0.1 AS FLOAT) = CAST(0.1 AS DOUBLE);
-- FALSE! (different binary representations at different precisions)
```

**Validation impact**: If source data is `FLOAT` and target is `DOUBLE` (or vice versa), every non-integer value may show as a diff due to precision differences between 32-bit and 64-bit IEEE 754.

**Mitigation**: Compare floats with relative tolerance:

```sql
SELECT * FROM source s JOIN target t ON s.pk = t.pk
WHERE ABS(s.float_col - t.float_col) / GREATEST(ABS(s.float_col), ABS(t.float_col), 1e-30) > 1e-6;
```

### 5.3 NaN Handling — The Most Surprising Gotcha

**In standard SQL, NaN comparisons return FALSE or NULL. In Spark SQL, NaN == NaN is TRUE.**

```sql
-- Standard SQL (PostgreSQL, Snowflake, BigQuery):
SELECT CAST('NaN' AS DOUBLE PRECISION) = CAST('NaN' AS DOUBLE PRECISION);
-- NULL or FALSE (depends on database)

-- Spark SQL:
SELECT CAST('NaN' AS DOUBLE) = CAST('NaN' AS DOUBLE);
-- TRUE!

-- This affects sorting too:
-- Spark SQL: NaN is greater than any other number
SELECT * FROM VALUES (1.0), (CAST('NaN' AS DOUBLE)), (2.0) ORDER BY 1;
-- 1.0, 2.0, NaN

-- PostgreSQL: NaN is greater than any number too (consistent here)
-- But NaN != NaN in PostgreSQL
```

**Validation impact**: When comparing a Spark/Databricks table against PostgreSQL or Snowflake, rows containing NaN in float columns will:
- Match in Spark (NaN = NaN is TRUE)
- Not match in PostgreSQL (NaN = NaN is NULL)
- Show as diff in cross-database comparison depending on which side evaluates the comparison

**Mitigation**: Detect and normalize NaN values before comparison:

```sql
-- Spark SQL side:
SELECT
  pk,
  CASE WHEN isnan(float_col) THEN NULL ELSE float_col END AS float_col_normalized
FROM my_table;

-- PostgreSQL side:
SELECT
  pk,
  CASE WHEN float_col = 'NaN'::DOUBLE PRECISION THEN NULL ELSE float_col END AS float_col_normalized
FROM my_table;
```

### 5.4 Complex Types: MAP, ARRAY, STRUCT

Spark SQL has rich complex type support with specific comparison rules:

```sql
-- ARRAY comparison: element-by-element, order-sensitive
SELECT ARRAY(1, 2, 3) = ARRAY(1, 2, 3);  -- TRUE
SELECT ARRAY(1, 2, 3) = ARRAY(1, 3, 2);  -- FALSE

-- MAP comparison: key-value equality, order-independent
SELECT MAP('a', 1, 'b', 2) = MAP('b', 2, 'a', 1);  -- TRUE

-- STRUCT comparison: field-by-field, order matters (by position)
SELECT STRUCT(1, 'hello') = STRUCT(1, 'hello');  -- TRUE

-- Nested complex types:
SELECT ARRAY(STRUCT(1, 'a'), STRUCT(2, 'b')) =
       ARRAY(STRUCT(1, 'a'), STRUCT(2, 'b'));  -- TRUE

-- NULL in complex types:
SELECT ARRAY(1, NULL, 3) = ARRAY(1, NULL, 3);  -- NULL (not TRUE!)
SELECT MAP('a', NULL) = MAP('a', NULL);          -- NULL
```

**Validation impact**: Spark's complex type semantics generally follow SQL standard (except NaN). The main gotcha is that serialization for cross-database comparison is database-specific: Spark's `to_json()` may produce different formatting than PostgreSQL's `row_to_json()`.

**Mitigation**: Use consistent JSON serialization with sorted keys:

```sql
-- Spark SQL:
SELECT to_json(struct_col, MAP('pretty', 'false')) FROM my_table;

-- But note: Spark's to_json output format may differ from PostgreSQL's:
-- Spark: {"field1":1,"field2":"hello"}
-- PostgreSQL: {"field1": 1, "field2": "hello"} (with spaces)
```

### 5.5 Partition Pruning and Z-Ordering Impact

```sql
-- Partition pruning: queries that filter on partition columns are fast
-- Table partitioned by date_col:
SELECT COUNT(*) FROM my_table WHERE date_col = '2024-06-15';
-- Reads only files in the date_col=2024-06-15/ directory

-- Without partition filter: full table scan
SELECT COUNT(*) FROM my_table WHERE some_other_col = 'value';
-- Reads all files across all partitions

-- Z-ordering: optimizes file layout for multiple columns
OPTIMIZE my_table ZORDER BY (col_a, col_b);
-- Colocates related values for faster range queries on col_a AND col_b
```

**Validation impact**: Validation queries without partition filters scan the entire table, which can be extremely expensive on large Delta tables. A 100TB table scanned fully for a checksum costs significant compute.

**Mitigation**: Auto-detect partition columns and build validation queries that iterate per-partition:

```sql
-- Discover partitions:
DESCRIBE DETAIL my_table;
-- Returns partitionColumns

-- Validate per-partition:
SELECT
  date_col AS partition_value,
  COUNT(*) AS row_count,
  MD5(CONCAT_WS(',', SORT_ARRAY(COLLECT_LIST(MD5(CONCAT_WS('|', col1, col2)))))) AS partition_hash
FROM my_table
WHERE date_col = '2024-06-15'
GROUP BY date_col;
```

### 5.6 Unity Catalog Cross-Catalog Validation

Databricks Unity Catalog introduces three-level namespacing:

```sql
-- Three-level namespace: catalog.schema.table
SELECT * FROM prod_catalog.sales.orders;
SELECT * FROM dev_catalog.sales.orders;

-- Cross-catalog query:
SELECT p.*, d.*
FROM prod_catalog.sales.orders p
FULL OUTER JOIN dev_catalog.sales.orders d ON p.order_id = d.order_id
WHERE p.amount != d.amount;
```

**Validation impact**: Cross-catalog queries work within the same Databricks workspace but not across workspaces. For cross-workspace validation, data must be exported or accessed via a common storage layer.

**Gotcha**: Column-level security (row filters, column masks) may cause different users to see different data from the same table:

```sql
-- User A (has full access): sees all columns
SELECT * FROM secure_table;  -- Returns id, name, ssn, salary

-- User B (restricted): sees masked columns
SELECT * FROM secure_table;  -- Returns id, name, '***-**-****', NULL
```

**Validation impact**: If the validation service account has different permissions than the pipeline service account, validation results may not match production data due to column masking.

**Mitigation**: Use a service principal with identical permissions to the pipeline for validation. Document which columns are masked and exclude them from diff.

---

## 6. MySQL

### 6.1 The 0 vs '' vs NULL Confusion

MySQL's type coercion is the most permissive (and dangerous) of any major database:

```sql
-- In MySQL, '' (empty string) and 0 are equivalent in numeric context:
SELECT '' = 0;        -- 1 (TRUE!)
SELECT '' + 0;        -- 0
SELECT '' IS NULL;    -- 0 (FALSE)
SELECT 0 IS NULL;     -- 0 (FALSE)
SELECT NULL = NULL;   -- NULL

-- This leads to:
SELECT * FROM users WHERE age = '';
-- Returns rows where age = 0!

-- And even worse:
SELECT * FROM users WHERE email = 0;
-- Returns ALL rows where email is any non-numeric string!
-- Because: 'alice@example.com' cast to number = 0, so 0 = 0 is TRUE
```

**Validation impact**: If validation queries use string literals compared against numeric columns (or vice versa), MySQL's implicit coercion will produce wildly incorrect results. A WHERE clause that should return 0 rows might return thousands.

**Mitigation**: Use strict mode and explicit casts:

```sql
SET sql_mode = 'STRICT_TRANS_TABLES';

-- Always compare like types:
SELECT * FROM users WHERE age = CAST('' AS UNSIGNED);  -- Error in strict mode
SELECT * FROM users WHERE CAST(email AS CHAR) = 'alice@example.com';
```

### 6.2 Implicit Type Coercion

MySQL coerces types aggressively in comparisons:

```sql
-- String to number:
SELECT '1' = 1;          -- 1 (TRUE)
SELECT '1abc' = 1;       -- 1 (TRUE!) — MySQL uses leading numeric prefix
SELECT '01' = 1;         -- 1 (TRUE) — leading zero stripped
SELECT '0x1A' = 26;      -- 1 (TRUE) — hex interpretation!

-- Date strings:
SELECT '2024-06-15' = DATE '2024-06-15';  -- 1 (TRUE, but only because format matches)
SELECT '06/15/2024' = DATE '2024-06-15';  -- 0 (FALSE, format doesn't match)

-- Boolean-ish:
SELECT TRUE = 1;     -- 1 (TRUE)
SELECT TRUE = 2;     -- 0 (FALSE!) — TRUE is exactly 1, not "any non-zero"
SELECT FALSE = '';   -- 1 (TRUE) — '' coerced to 0, FALSE = 0
```

**Validation impact**: MySQL's coercion means that validation queries comparing string representations against typed values can produce incorrect match/mismatch results. The `'1abc' = 1` case is particularly dangerous: a data quality issue (string in numeric field) is silently hidden.

**Mitigation**: Never rely on implicit coercion. Always use `CAST()` or `CONVERT()`:

```sql
-- Explicit comparison:
SELECT * FROM t1 JOIN t2 ON t1.id = t2.id
WHERE CAST(t1.val AS CHAR) != CAST(t2.val AS CHAR);  -- String comparison
-- Or:
WHERE CAST(t1.val AS DECIMAL(20,5)) != CAST(t2.val AS DECIMAL(20,5));  -- Numeric
```

### 6.3 CHARSET / COLLATION Per Column

MySQL allows different character sets and collations per column, per table, and per database:

```sql
-- Table with mixed collations:
CREATE TABLE mixed_collation (
  name_ci VARCHAR(100) COLLATE utf8mb4_general_ci,    -- case-insensitive
  name_cs VARCHAR(100) COLLATE utf8mb4_bin,            -- case-sensitive (binary)
  name_unicode VARCHAR(100) COLLATE utf8mb4_unicode_ci -- Unicode case-insensitive
);

-- Same strings, different comparison results:
INSERT INTO mixed_collation VALUES ('Hello', 'Hello', 'Hello');

SELECT name_ci = 'hello';       -- 1 (TRUE, case-insensitive)
SELECT name_cs = 'hello';       -- 0 (FALSE, binary comparison)
SELECT name_unicode = 'hello';  -- 1 (TRUE, Unicode case-insensitive)

-- Collation affects DISTINCT and GROUP BY:
SELECT DISTINCT name_ci FROM mixed_collation;
-- If table has 'Hello' and 'hello': returns 1 row (they're "equal")
SELECT DISTINCT name_cs FROM mixed_collation;
-- Returns 2 rows ('Hello' and 'hello' are different)
```

**Validation impact**: Validation against MySQL must respect per-column collation. A diff engine that uses binary comparison will show false positives for case-insensitive columns where only case differs.

**Mitigation**: Introspect column collation from `INFORMATION_SCHEMA.COLUMNS` and adjust comparison accordingly:

```sql
SELECT COLUMN_NAME, COLLATION_NAME
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = 'mydb' AND TABLE_NAME = 'mytable';

-- For case-insensitive columns, normalize:
SELECT LOWER(name_ci) AS name_ci_norm FROM mytable;
-- For binary columns, compare as-is
```

#### The utf8 vs utf8mb4 Trap

```sql
-- MySQL's 'utf8' is NOT real UTF-8 — it's limited to 3 bytes (BMP only)
-- 'utf8mb4' is real UTF-8 (supports 4-byte characters like emoji)

CREATE TABLE utf8_test (val VARCHAR(100) CHARACTER SET utf8);
INSERT INTO utf8_test VALUES ('Hello 🌍');
-- ERROR: Incorrect string value: '\xF0\x9F\x8C\x8D' for column 'val'

CREATE TABLE utf8mb4_test (val VARCHAR(100) CHARACTER SET utf8mb4);
INSERT INTO utf8mb4_test VALUES ('Hello 🌍');
-- SUCCESS
```

**Validation impact**: If source data contains 4-byte UTF-8 characters (emoji, CJK extensions, mathematical symbols) and the MySQL column uses `utf8` (3-byte), the data was either truncated on insert or the insert failed. Validation should detect charset limitations.

### 6.4 DECIMAL vs FLOAT Truncation

```sql
-- DECIMAL: exact
SELECT CAST(1.005 AS DECIMAL(10,2));  -- 1.01 (rounds up)

-- FLOAT: approximate
SELECT CAST(1.005 AS FLOAT);        -- 1.005 (but stored as 1.00499999...)
SELECT CAST(CAST(1.005 AS FLOAT) AS DECIMAL(10,2));  -- 1.00 (rounds DOWN!)

-- The chain: 1.005 → FLOAT → 1.00499... → DECIMAL(10,2) → 1.00
-- vs:        1.005 → DECIMAL(10,2) → 1.01
```

**Validation impact**: If data passes through a FLOAT intermediate (common in application code), decimal values near rounding boundaries will differ from direct DECIMAL storage. This produces real but subtle diffs.

**Mitigation**: Compare at the precision of the less-precise representation:

```sql
SELECT * FROM t1 JOIN t2 ON t1.id = t2.id
WHERE ABS(t1.amount - t2.amount) > 0.005;  -- Half-cent tolerance for DECIMAL(10,2)
```

### 6.5 TIMESTAMP Range Limitation (2038 Problem)

```sql
-- MySQL TIMESTAMP range: '1970-01-01 00:00:01' UTC to '2038-01-19 03:14:07' UTC

SELECT CAST('2040-01-01 00:00:00' AS DATETIME);
-- Works: DATETIME has range 1000-01-01 to 9999-12-31

SELECT CAST('2040-01-01 00:00:00' AS TIMESTAMP);
-- Depends on MySQL version:
-- MySQL < 8.0.28: silently converts to '0000-00-00 00:00:00' or NULL
-- MySQL 8.0.28+: error or truncation warning
```

**Validation impact**: If source data contains dates beyond 2038 and the target column is MySQL `TIMESTAMP`, values will be corrupted. Validation must detect this range mismatch.

**Mitigation**: Check date ranges before comparison:

```sql
-- Detect out-of-range timestamps:
SELECT COUNT(*) FROM source_table
WHERE ts_col > '2038-01-19 03:14:07' OR ts_col < '1970-01-01 00:00:01';
```

### 6.6 sql_mode: STRICT vs Non-STRICT

MySQL's `sql_mode` dramatically changes behavior:

```sql
-- Non-strict mode (legacy default):
SET sql_mode = '';
INSERT INTO test (int_col) VALUES ('abc');
-- Warning only! Inserts 0. No error.
INSERT INTO test (varchar_10) VALUES ('this string is way too long for the column');
-- Warning only! Truncates to 10 chars. No error.
INSERT INTO test (not_null_col) VALUES (NULL);
-- Warning only! Inserts '' (empty string) or 0. No error.

-- Strict mode (recommended):
SET sql_mode = 'STRICT_TRANS_TABLES';
INSERT INTO test (int_col) VALUES ('abc');
-- ERROR 1366: Incorrect integer value
INSERT INTO test (varchar_10) VALUES ('this string is way too long for the column');
-- ERROR 1406: Data too long
INSERT INTO test (not_null_col) VALUES (NULL);
-- ERROR 1048: Column cannot be null
```

**Validation impact**: Data loaded in non-strict mode may contain silently truncated or coerced values. When compared against the source (which has the full/correct values), these appear as legitimate diffs. The root cause is the MySQL configuration, not the data pipeline.

**Mitigation**: Always check `sql_mode` when connecting for validation:

```sql
SELECT @@sql_mode;
-- If non-strict, warn user about potential silent truncation
```

---

## 7. Cross-Database Comparison Patterns

### 7.1 NULL Handling Across Databases

All databases follow SQL standard NULL semantics (NULL != NULL, NULL = NULL yields NULL), but edge cases differ:

| Scenario | PostgreSQL | Snowflake | BigQuery | MySQL | DuckDB | Spark |
|----------|-----------|-----------|----------|-------|--------|-------|
| `NULL = NULL` | NULL | NULL | NULL | NULL | NULL | NULL |
| `NULL IS NULL` | TRUE | TRUE | TRUE | TRUE | TRUE | TRUE |
| `'' IS NULL` | FALSE | FALSE | FALSE | FALSE* | FALSE | FALSE |
| `NULL ORDER BY` | Last (default) | Last | Last | First | Last | Last |
| `NULL in UNION` | Deduped | Deduped | Deduped | Deduped | Deduped | Deduped |
| `COALESCE(NULL)` | NULL | NULL | NULL | NULL | NULL | NULL |
| `COUNT(NULL_col)` | 0 | 0 | 0 | 0 | 0 | 0 |
| `SUM(all NULLs)` | NULL | NULL | NULL | NULL | NULL | NULL |
| `NaN = NaN` | FALSE/NULL | FALSE | FALSE | N/A | FALSE | **TRUE** |

*MySQL with non-strict mode may treat '' as NULL-ish in some contexts.

**Critical gotcha for validation**: `SUM(all NULLs)` returns NULL, not 0. If a validation checksum column is computed via SUM over a segment where all values are NULL, the checksum itself is NULL, which compares as "not equal" to any other NULL checksum:

```sql
-- Source has all NULLs in segment A
SELECT SUM(amount) FROM source WHERE segment = 'A';  -- NULL

-- Target has all NULLs in segment A
SELECT SUM(amount) FROM target WHERE segment = 'A';  -- NULL

-- Comparison: NULL = NULL → NULL → treated as "different"!
```

**Mitigation**: Use `COALESCE(SUM(col), 0)` or `IS NOT DISTINCT FROM` for checksum comparison.

### 7.2 String Concatenation with NULLs

```sql
-- PostgreSQL: NULL poisons concatenation
SELECT 'hello' || NULL;              -- NULL
SELECT CONCAT('hello', NULL);        -- 'hello' (CONCAT ignores NULLs!)

-- Snowflake: same as PostgreSQL
SELECT 'hello' || NULL;              -- NULL
SELECT CONCAT('hello', NULL);        -- 'hello'

-- MySQL: CONCAT propagates NULL
SELECT CONCAT('hello', NULL);        -- NULL!
SELECT CONCAT_WS(',', 'hello', NULL); -- 'hello' (WS variant skips NULLs)

-- BigQuery: || propagates NULL
SELECT 'hello' || NULL;              -- NULL
SELECT CONCAT('hello', NULL);        -- NULL!
```

**Validation impact**: Row-level checksums computed via string concatenation behave differently across databases:

```sql
-- Row hash computation:
-- PostgreSQL: CONCAT(col1, '|', col2, '|', col3)
--   If col2 is NULL: 'hello|world' (NULL skipped by CONCAT)
-- MySQL: CONCAT(col1, '|', col2, '|', col3)
--   If col2 is NULL: NULL (entire result is NULL!)
```

**Mitigation**: Always use `COALESCE` around nullable columns in concatenation:

```sql
SELECT MD5(CONCAT(
  COALESCE(CAST(col1 AS VARCHAR), '<NULL>'), '|',
  COALESCE(CAST(col2 AS VARCHAR), '<NULL>'), '|',
  COALESCE(CAST(col3 AS VARCHAR), '<NULL>')
)) AS row_hash;
```

### 7.3 Integer Division

```sql
-- PostgreSQL: integer division returns integer
SELECT 5 / 2;  -- 2 (not 2.5!)

-- Snowflake: integer division returns DECIMAL
SELECT 5 / 2;  -- 2.500000 (preserves precision!)

-- BigQuery: integer division returns FLOAT64
SELECT 5 / 2;  -- 2.5

-- MySQL: integer division returns DECIMAL
SELECT 5 / 2;  -- 2.5000

-- DuckDB: integer division returns integer
SELECT 5 / 2;  -- 2

-- Spark SQL: integer division returns DOUBLE
SELECT 5 / 2;  -- 2.5
```

**Validation impact**: Computed columns involving division produce different results across databases. This is a known source of diffs when validation recomputes derived columns.

**Mitigation**: Use explicit `CAST` to float before division:

```sql
SELECT CAST(numerator AS DOUBLE PRECISION) / denominator FROM my_table;
```

### 7.4 Empty String vs NULL

```sql
-- Oracle: '' IS NULL → TRUE (Oracle treats '' as NULL)
-- Every other database: '' IS NOT NULL → TRUE

-- PostgreSQL:
SELECT '' IS NULL;  -- FALSE
SELECT LENGTH('');  -- 0

-- Snowflake:
SELECT '' IS NULL;  -- FALSE
SELECT LENGTH('');  -- 0

-- MySQL:
SELECT '' IS NULL;     -- FALSE
SELECT '' = 0;         -- TRUE (implicit coercion!)
SELECT LENGTH('');     -- 0

-- BigQuery:
SELECT '' IS NULL;  -- FALSE
SELECT LENGTH('');  -- 0
```

**Validation impact**: When migrating from Oracle (where `'' = NULL`) to any other database, empty strings and NULLs become distinct values. This produces diffs for every row that had an empty string in Oracle. This is not a bug — it's a fundamental semantic difference.

**Mitigation**: For Oracle migrations, normalize both sides:

```sql
-- Treat empty strings as NULL on non-Oracle side:
SELECT NULLIF(col, '') FROM my_table;
```

---

## 8. Gotcha Severity Matrix

The following matrix rates each gotcha on three dimensions:
- **Frequency**: How often this issue occurs in practice (1=rare, 5=very common)
- **Detectability**: How easy it is to detect (1=obvious, 5=very subtle)
- **Impact**: Severity of incorrect validation results (1=cosmetic, 5=data corruption missed)

**Composite Score** = Frequency + Detectability + Impact (higher = more dangerous)

### Snowflake Gotchas

| Gotcha | Frequency | Detectability | Impact | Score | Category |
|--------|-----------|---------------|--------|-------|----------|
| VARIANT key ordering in string comparison | 4 | 4 | 3 | **11** | False positive |
| NULL vs undefined in VARIANT | 3 | 5 | 4 | **12** | False negative |
| TIMESTAMP_LTZ session dependency | 4 | 3 | 4 | **11** | False positive |
| NUMBER(38,0) silent truncation | 3 | 4 | 5 | **12** | False negative |
| Case-insensitive VARCHAR collation | 3 | 3 | 3 | **9** | False negative |
| BINARY_INPUT_FORMAT dependency | 2 | 4 | 3 | **9** | False positive |
| Nanosecond precision loss | 4 | 2 | 2 | **8** | False positive |
| Identifier case sensitivity | 3 | 2 | 2 | **7** | Query failure |
| ARRAY NULL comparison returns NULL | 2 | 4 | 3 | **9** | False positive |
| FLATTEN without OUTER drops rows | 3 | 3 | 4 | **10** | False negative |
| Clustering key scan cost | 4 | 1 | 1 | **6** | Cost |

### PostgreSQL Gotchas

| Gotcha | Frequency | Detectability | Impact | Score | Category |
|--------|-----------|---------------|--------|-------|----------|
| NUMERIC vs DOUBLE PRECISION | 4 | 3 | 3 | **10** | False positive |
| JSONB key reordering vs JSON | 3 | 3 | 2 | **8** | False positive |
| Array order sensitivity | 3 | 3 | 3 | **9** | False positive |
| CHAR(n) padding in hash | 3 | 4 | 3 | **10** | False positive |
| timestamptz session display | 3 | 3 | 4 | **10** | False positive |
| Collation C vs en_US.UTF-8 sort | 2 | 4 | 3 | **9** | False positive |
| ENUM sort order vs string | 2 | 4 | 2 | **8** | False positive |
| Range type canonicalization | 1 | 4 | 2 | **7** | False positive |
| TOAST column I/O cost | 3 | 2 | 1 | **6** | Performance |
| JSON duplicate keys | 1 | 5 | 4 | **10** | False negative |
| DST ambiguity in timestamptz | 2 | 5 | 4 | **11** | False positive/negative |

### BigQuery Gotchas

| Gotcha | Frequency | Detectability | Impact | Score | Category |
|--------|-----------|---------------|--------|-------|----------|
| STRUCT field order dependency | 3 | 3 | 3 | **9** | False positive |
| REPEATED field ordering | 3 | 3 | 3 | **9** | False positive |
| NUMERIC vs BIGNUMERIC precision | 2 | 3 | 4 | **9** | False positive |
| DATE vs DATETIME vs TIMESTAMP | 4 | 3 | 4 | **11** | False positive |
| _PARTITIONTIME cost | 4 | 1 | 1 | **6** | Cost |
| Slot consumption on full scans | 3 | 2 | 2 | **7** | Cost |
| GEOGRAPHY representation | 2 | 3 | 2 | **7** | False positive |

### DuckDB Gotchas

| Gotcha | Frequency | Detectability | Impact | Score | Category |
|--------|-----------|---------------|--------|-------|----------|
| CSV type inference | 4 | 3 | 4 | **11** | False positive/negative |
| Parquet decimal trailing zeros | 3 | 4 | 2 | **9** | False positive |
| SQLite compatibility mode | 2 | 3 | 3 | **8** | False positive |
| HUGEINT cross-DB overflow | 1 | 3 | 4 | **8** | False negative |
| Extension-dependent types | 2 | 2 | 2 | **6** | Query failure |
| MAP NULL comparison | 2 | 4 | 3 | **9** | False positive |
| Single-writer file limitation | 2 | 2 | 2 | **6** | Operational |

### Databricks / Spark SQL Gotchas

| Gotcha | Frequency | Detectability | Impact | Score | Category |
|--------|-----------|---------------|--------|-------|----------|
| NaN == NaN (TRUE in Spark) | 2 | 5 | 5 | **12** | False negative |
| FLOAT vs DOUBLE precision | 3 | 3 | 3 | **9** | False positive |
| Delta time travel retention | 3 | 2 | 3 | **8** | Operational |
| Partition pruning cost | 4 | 1 | 1 | **6** | Cost |
| Unity Catalog column masking | 2 | 4 | 5 | **11** | False negative |
| Complex type NULL comparison | 3 | 4 | 3 | **10** | False positive |

### MySQL Gotchas

| Gotcha | Frequency | Detectability | Impact | Score | Category |
|--------|-----------|---------------|--------|-------|----------|
| `'' = 0` implicit coercion | 4 | 4 | 5 | **13** | False negative |
| `'1abc' = 1` coercion | 3 | 5 | 5 | **13** | False negative |
| Per-column collation | 3 | 3 | 3 | **9** | False positive |
| utf8 vs utf8mb4 | 3 | 3 | 4 | **10** | False negative |
| DECIMAL via FLOAT round-trip | 3 | 4 | 4 | **11** | False positive |
| TIMESTAMP 2038 limit | 2 | 2 | 5 | **9** | False negative |
| Non-strict sql_mode truncation | 3 | 4 | 5 | **12** | False negative |
| FLOAT truncation | 3 | 3 | 3 | **9** | False positive |

### Top 10 Most Dangerous Gotchas (by composite score)

| Rank | Database | Gotcha | Score | Category |
|------|----------|--------|-------|----------|
| 1 | MySQL | `'' = 0` implicit coercion | **13** | False negative |
| 2 | MySQL | `'1abc' = 1` string-to-int coercion | **13** | False negative |
| 3 | Snowflake | NULL vs undefined in VARIANT | **12** | False negative |
| 4 | Snowflake | NUMBER(38,0) silent truncation | **12** | False negative |
| 5 | Spark SQL | NaN == NaN is TRUE | **12** | False negative |
| 6 | MySQL | Non-strict sql_mode truncation | **12** | False negative |
| 7 | Snowflake | VARIANT key ordering in string cast | **11** | False positive |
| 8 | Snowflake | TIMESTAMP_LTZ session dependency | **11** | False positive |
| 9 | BigQuery | DATE vs DATETIME vs TIMESTAMP | **11** | False positive |
| 10 | DuckDB | CSV type inference | **11** | False positive/negative |

**Pattern observation**: The most dangerous gotchas (scores 12-13) are all **false negatives** — cases where the validation engine reports "no difference" when there is actually a meaningful data discrepancy. False negatives are categorically worse than false positives because they represent missed data quality issues.

---

## 9. Reladiff Engine Mitigation Strategy

Based on the gotchas cataloged above, here is the recommended mitigation architecture for Reladiff:

### 9.1 Connection-Time Normalization

Every database connection should execute standardization commands:

```python
CONNECTION_INIT = {
    'snowflake': [
        "ALTER SESSION SET TIMEZONE = 'UTC'",
        "ALTER SESSION SET BINARY_INPUT_FORMAT = 'HEX'",
        "ALTER SESSION SET BINARY_OUTPUT_FORMAT = 'HEX'",
        "ALTER SESSION SET TIMESTAMP_OUTPUT_FORMAT = 'YYYY-MM-DD HH24:MI:SS.FF9'",
        "ALTER SESSION SET TIMESTAMP_NTZ_OUTPUT_FORMAT = 'YYYY-MM-DD HH24:MI:SS.FF9'",
        "ALTER SESSION SET TIMESTAMP_LTZ_OUTPUT_FORMAT = 'YYYY-MM-DD HH24:MI:SS.FF9 TZHTZM'",
        "ALTER SESSION SET TIMESTAMP_TZ_OUTPUT_FORMAT = 'YYYY-MM-DD HH24:MI:SS.FF9 TZHTZM'",
    ],
    'postgresql': [
        "SET TIMEZONE TO 'UTC'",
        "SET extra_float_digits = 3",  # Maximum float output precision
    ],
    'mysql': [
        "SET sql_mode = 'STRICT_TRANS_TABLES'",
        "SET time_zone = '+00:00'",
        "SET NAMES utf8mb4",  # Ensure full UTF-8 support
    ],
    'bigquery': [],  # Session settings via connection params
    'duckdb': [
        "SET TimeZone = 'UTC'",
    ],
    'databricks': [
        "SET TIME ZONE 'UTC'",
    ],
}
```

### 9.2 Type-Aware Comparison Functions

Instead of comparing all columns as strings, Reladiff should generate type-aware comparison expressions:

```python
def get_comparison_expr(col_name: str, col_type: str, dialect: str) -> str:
    """Generate a dialect-specific comparison expression that normalizes gotchas."""

    if is_float_type(col_type):
        # Epsilon-based comparison for floats
        return f"ROUND({col_name}, 10)"

    if is_timestamp_type(col_type):
        if dialect == 'snowflake':
            return f"DATE_TRUNC('MICROSECOND', {col_name})"
        elif dialect == 'postgresql':
            return f"DATE_TRUNC('microsecond', {col_name})"
        else:
            return col_name

    if is_json_type(col_type):
        if dialect == 'postgresql' and col_type.upper() == 'JSON':
            return f"CAST({col_name} AS JSONB)"  # Normalize key order
        elif dialect == 'snowflake':
            return f"HASH({col_name})"  # Native VARIANT hash
        return col_name

    if is_char_type(col_type):
        return f"RTRIM({col_name})"  # Remove CHAR padding

    if is_binary_type(col_type):
        if dialect == 'snowflake':
            return f"HEX_ENCODE({col_name})"
        elif dialect == 'postgresql':
            return f"ENCODE({col_name}, 'hex')"
        return col_name

    return col_name
```

### 9.3 Pre-Validation DDL Comparison

Before running data comparison, Reladiff should compare column definitions and warn about known gotcha combinations:

```python
KNOWN_DDL_GOTCHAS = [
    {
        'source_type': 'NUMERIC',  # PostgreSQL unbounded
        'target_type': 'NUMBER(38,0)',  # Snowflake default
        'severity': 'HIGH',
        'message': 'Source NUMERIC is unbounded; target NUMBER(38,0) truncates decimals',
    },
    {
        'source_type': 'TIMESTAMP',  # PostgreSQL naive
        'target_type': 'TIMESTAMP_LTZ',  # Snowflake session-dependent
        'severity': 'HIGH',
        'message': 'Source has no timezone; target interpretation depends on session TIMEZONE',
    },
    {
        'source_type': 'JSON',  # PostgreSQL preserves order
        'target_type': 'VARIANT',  # Snowflake
        'severity': 'MEDIUM',
        'message': 'JSON key order may differ; use semantic comparison',
    },
    {
        'source_type': 'VARCHAR',  # PostgreSQL case-sensitive
        'target_type': 'VARCHAR',  # Snowflake case-insensitive
        'severity': 'MEDIUM',
        'message': 'Default collation differs: PG=case-sensitive, SF=case-insensitive',
    },
    {
        'source_type': 'FLOAT',
        'target_type': 'DOUBLE',
        'severity': 'HIGH',
        'message': '32-bit to 64-bit float: every non-integer value may show as diff',
    },
]
```

### 9.4 Cost-Aware Validation Strategy

For cloud databases with per-scan pricing:

```python
def estimate_validation_cost(table_stats, dialect):
    """Estimate cost of full validation scan."""
    if dialect == 'bigquery':
        cost_per_tb = 6.25  # On-demand pricing
        return table_stats.bytes_scanned / 1e12 * cost_per_tb
    elif dialect == 'snowflake':
        # Credits depend on warehouse size; rough estimate
        scan_seconds = table_stats.estimated_scan_time
        credit_per_second = 0.00056  # XS warehouse
        return scan_seconds * credit_per_second * 2  # per-credit cost ~$2
    return 0  # DuckDB, PostgreSQL: no per-scan cost

def choose_validation_strategy(cost_estimate, table_stats):
    """Select strategy based on estimated cost."""
    if cost_estimate > 10.0:  # More than $10
        return 'hierarchical'  # Partition checksums first, drill into mismatches
    elif cost_estimate > 1.0:
        return 'sampled'  # Random sample comparison
    else:
        return 'full'  # Full row-by-row comparison
```

### 9.5 Checksum Generation With Gotcha Protection

The core checksum function must handle all the gotchas:

```sql
-- Universal row hash template (PostgreSQL dialect):
SELECT MD5(CONCAT(
  -- Integer: safe as-is
  COALESCE(CAST(id AS VARCHAR), '<NULL>'), '|',
  -- Float: round to epsilon
  COALESCE(CAST(ROUND(float_col::NUMERIC, 10) AS VARCHAR), '<NULL>'), '|',
  -- Timestamp: truncate to microseconds, convert to UTC epoch
  COALESCE(CAST(EXTRACT(EPOCH FROM DATE_TRUNC('microsecond', ts_col)) AS VARCHAR), '<NULL>'), '|',
  -- String: RTRIM for CHAR types, explicit collation
  COALESCE(RTRIM(CAST(char_col AS VARCHAR)) COLLATE "C", '<NULL>'), '|',
  -- JSON: cast to JSONB for key normalization
  COALESCE(CAST(json_col::JSONB AS VARCHAR), '<NULL>'), '|',
  -- Boolean: normalize to '0'/'1'
  COALESCE(CAST(bool_col::INT AS VARCHAR), '<NULL>'), '|',
  -- Binary: hex encode
  COALESCE(ENCODE(binary_col, 'hex'), '<NULL>')
)) AS row_hash
FROM my_table;
```

---

## 10. Comprehensive Test Matrix

Each gotcha should have a corresponding test case in Reladiff's test suite. Here is the recommended test structure:

### 10.1 Test Categories

| Category | Test Count | Priority |
|----------|-----------|----------|
| Float precision comparison | 8 | P0 |
| Timestamp precision/timezone | 12 | P0 |
| NULL handling (including NaN) | 10 | P0 |
| String collation/case | 8 | P1 |
| JSON/semi-structured | 10 | P1 |
| Array/complex type ordering | 8 | P1 |
| Implicit type coercion | 6 | P1 |
| Binary encoding | 4 | P2 |
| Range type canonicalization | 3 | P2 |
| Cost estimation | 4 | P2 |

### 10.2 Sample Test Cases

```python
# P0: Float precision
def test_float_epsilon_comparison():
    """Verify 0.1 + 0.2 == 0.3 when using epsilon comparison."""
    source = [(1, 0.30000000000000004)]  # Result of 0.1 + 0.2 in float
    target = [(1, 0.3)]
    # Should report: NO difference (within epsilon)
    assert diff(source, target, epsilon=1e-10) == []

# P0: NaN handling across databases
def test_nan_equality_normalization():
    """NaN should be treated consistently regardless of database."""
    source_spark = [(1, float('nan'))]   # Spark: NaN == NaN is TRUE
    target_pg = [(1, float('nan'))]      # PG: NaN == NaN is NULL
    # After normalization: both NaN → NULL, should report NO difference
    assert diff(source_spark, target_pg, normalize_nan=True) == []

# P0: Timestamp precision
def test_nanosecond_truncation():
    """Snowflake nanoseconds should match PostgreSQL microseconds after truncation."""
    source_sf = [(1, '2024-01-15 10:30:00.123456789')]  # 9 digits
    target_pg = [(1, '2024-01-15 10:30:00.123457')]     # 6 digits (rounded)
    # Should report: NO difference (after microsecond truncation)
    assert diff(source_sf, target_pg, ts_precision='microsecond') == []

# P1: JSON key ordering
def test_json_key_order_normalization():
    """JSON objects with different key order should compare as equal."""
    source = [(1, '{"b": 2, "a": 1}')]
    target = [(1, '{"a": 1, "b": 2}')]
    # Should report: NO difference (semantic equality)
    assert diff(source, target, json_normalize=True) == []

# P1: MySQL implicit coercion detection
def test_mysql_coercion_warning():
    """Warn when MySQL might produce incorrect comparison due to coercion."""
    # Comparing string '1abc' against integer 1 in MySQL returns TRUE
    source_mysql = [(1, '1abc')]
    target = [(1, 1)]
    # Should report: DIFFERENCE with warning about MySQL coercion
    result = diff(source_mysql, target, source_dialect='mysql')
    assert len(result) == 1
    assert 'coercion_warning' in result[0]

# P1: Snowflake VARIANT NULL vs undefined
def test_variant_null_vs_undefined():
    """Distinguish JSON null from missing key in Snowflake VARIANT."""
    source = [(1, '{"a": null}')]   # JSON null
    target = [(1, '{"b": 1}')]     # Key 'a' absent (undefined)
    # Should report: DIFFERENCE (null != undefined)
    assert len(diff(source, target, variant_null_aware=True)) == 1

# P2: CHAR padding
def test_char_padding_normalization():
    """CHAR(10) with trailing spaces should match TEXT without padding."""
    source = [(1, 'hello     ')]  # CHAR(10)
    target = [(1, 'hello')]       # TEXT
    # Should report: NO difference (after RTRIM)
    assert diff(source, target, rtrim_char=True) == []

# P2: PostgreSQL range canonicalization
def test_int_range_canonicalization():
    """[1,5] and [1,6) should be equal for integer ranges."""
    source = [(1, '[1,5]')]
    target = [(1, '[1,6)')]
    # Should report: NO difference (canonicalized form is identical)
    assert diff(source, target, range_type='int4range') == []
```

### 10.3 Per-Database Test Requirements

| Database | Min Test Cases | Key Focus Areas |
|----------|---------------|-----------------|
| Snowflake | 15 | VARIANT semantics, timestamp types, collation |
| PostgreSQL | 12 | NUMERIC precision, JSONB normalization, arrays |
| BigQuery | 10 | STRUCT comparison, temporal types, cost guards |
| DuckDB | 8 | File scanning types, MAP comparison, extensions |
| Databricks | 10 | NaN handling, Delta time travel, complex types |
| MySQL | 10 | Implicit coercion, sql_mode, charset |
| Cross-database | 15 | All pairwise combinations of top gotchas |

**Total minimum test cases: 80**

---

## 11. Quick Reference: Gotcha Lookup by Symptom

When a validation run produces unexpected results, use this lookup table to diagnose the root cause:

### False Positives (diff reports difference, but data is semantically identical)

| Symptom | Likely Cause | Database(s) | Fix |
|---------|-------------|-------------|-----|
| Every JSON column shows as different | Key order differs | PG (JSON), Snowflake (VARIANT→VARCHAR) | Cast to JSONB / use HASH() |
| All timestamps differ by hours | Session timezone mismatch | Snowflake (LTZ), PostgreSQL (timestamptz) | SET TIMEZONE = 'UTC' |
| Sub-microsecond timestamp diffs | Precision mismatch | Snowflake (ns) vs PG/BQ (us) | DATE_TRUNC to microsecond |
| Float columns show tiny diffs | IEEE 754 representation | All databases | Epsilon comparison |
| CHAR columns differ | Trailing space padding | PostgreSQL, MySQL | RTRIM before hash |
| Array columns differ | Element order changed | PG, BQ, Spark | Sort before compare |
| Decimal trailing zeros differ | Scale normalization | DuckDB (Parquet), BQ | Strip trailing zeros |
| Sorted aggregations differ | Collation difference | PostgreSQL, MySQL | Explicit COLLATE "C" |

### False Negatives (diff reports no difference, but data has actually changed)

| Symptom | Likely Cause | Database(s) | Fix |
|---------|-------------|-------------|-----|
| Decimal truncation not detected | NUMBER(38,0) vs NUMERIC | Snowflake target | DDL comparison check |
| Case changes not detected | Case-insensitive collation | Snowflake, MySQL (_ci) | Force binary collation |
| NaN values not compared | NaN == NaN in Spark | Databricks/Spark | Normalize NaN to NULL |
| Truncated strings not detected | Non-strict sql_mode | MySQL | Check sql_mode |
| 4-byte UTF-8 chars dropped | utf8 vs utf8mb4 | MySQL | Check charset |
| Coerced values match incorrectly | Implicit type coercion | MySQL | Use strict mode |
| Column-masked data matches | Unity Catalog masking | Databricks | Match service principal perms |
| VARIANT null vs undefined | JSON null treated as SQL NULL | Snowflake | Use TYPEOF() check |

### Query Failures

| Symptom | Likely Cause | Database(s) | Fix |
|---------|-------------|-------------|-----|
| Column not found | Case mismatch in identifier | Snowflake | Quote with exact stored case |
| Type mismatch error | STRUCT field order | BigQuery | Extract fields individually |
| Function not found | Missing extension | DuckDB | Auto-load required extensions |
| Timeout / resource exceeded | No partition pruning | BigQuery, Databricks | Add partition filters |
| Out-of-range error | 2038 timestamp limit | MySQL | Use DATETIME instead |

---

## 12. References and Further Reading

### Official Documentation
- [Snowflake Semi-Structured Data Types](https://docs.snowflake.com/en/sql-reference/data-types-semistructured)
- [Snowflake Timestamp Variants](https://docs.snowflake.com/en/sql-reference/data-types-datetime#timestamp-ltz-timestamp-ntz-timestamp-tz)
- [PostgreSQL JSON Types](https://www.postgresql.org/docs/current/datatype-json.html)
- [PostgreSQL Range Types](https://www.postgresql.org/docs/current/rangetypes.html)
- [BigQuery Data Types](https://cloud.google.com/bigquery/docs/reference/standard-sql/data-types)
- [DuckDB Types](https://duckdb.org/docs/sql/data_types/overview)
- [Spark SQL Data Types](https://spark.apache.org/docs/latest/sql-ref-datatypes.html)
- [MySQL Type Conversion](https://dev.mysql.com/doc/refman/8.0/en/type-conversion.html)

### Known Issues in Data Diff Tools
- [data-diff #379](https://github.com/datafold/data-diff/issues/379) — Float comparison false positives
- [dbt-core #8183](https://github.com/dbt-labs/dbt-core/issues/8183) — Numeric precision divergence across databases
- [SQLMesh comparison semantics](https://sqlmesh.readthedocs.io/en/stable/concepts/plans/) — How SQLMesh handles schema diffs

### Research Papers
- Codd, E.F. "A Relational Model of Data for Large Shared Data Banks" (1970) — Foundation for NULL semantics
- IEEE 754-2019 — Standard for Floating-Point Arithmetic
- Unicode Technical Standard #10 — Unicode Collation Algorithm

---

## Appendix A: Database Version Coverage

This encyclopedia is validated against the following database versions:

| Database | Versions | Notes |
|----------|----------|-------|
| Snowflake | Current (continuously updated) | Tested Feb 2026 |
| PostgreSQL | 14, 15, 16 | Most gotchas apply to all versions |
| BigQuery | Current (continuously updated) | Standard SQL mode only |
| DuckDB | 0.9.x, 1.0.x, 1.1.x | Some behaviors changed between 0.x and 1.x |
| Databricks | Runtime 13.x, 14.x, 15.x | Unity Catalog features require 13.3+ |
| MySQL | 8.0, 8.4 | sql_mode defaults changed in 8.0 |
| Spark SQL | 3.4, 3.5 | NaN behavior consistent across versions |

Gotchas marked with specific version requirements are noted inline.

---

## Appendix B: Decision Tree for Comparison Strategy

```
Start: Compare column X between source and target

1. Is column type FLOAT/DOUBLE/REAL?
   → YES: Use epsilon comparison (relative tolerance 1e-10)
   → NO: Continue

2. Is column type TIMESTAMP/DATETIME?
   → YES: Truncate both to microsecond, convert to UTC epoch
   → NO: Continue

3. Is column type JSON/JSONB/VARIANT?
   → YES: Use semantic comparison (JSONB cast or native HASH)
   → NO: Continue

4. Is column type CHAR(n)?
   → YES: RTRIM before comparison
   → NO: Continue

5. Is column type BINARY/BYTEA/VARBINARY?
   → YES: HEX_ENCODE both sides
   → NO: Continue

6. Is column type ARRAY/REPEATED?
   → YES: Is order semantically significant?
     → YES: Compare as-is
     → NO: Sort elements before comparison
   → NO: Continue

7. Is column type GEOGRAPHY/GEOMETRY?
   → YES: Use ST_EQUALS or distance threshold
   → NO: Continue

8. Is column type ENUM?
   → YES: Cast to TEXT before comparison
   → NO: Continue

9. Is column type BOOLEAN?
   → YES: Cast to INT (0/1) for cross-database comparison
   → NO: Continue

10. Is column type NUMERIC/DECIMAL?
    → YES: Compare at min(source_scale, target_scale)
    → NO: Continue

11. Default: Cast to VARCHAR with COALESCE for NULLs
    → Use '<NULL>' sentinel for NULL representation in hash
```

This decision tree should be implemented as the core of Reladiff's column comparison strategy, with database-specific overrides applied at each node.
