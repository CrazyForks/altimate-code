# Theme O: Database-Specific Gotchas for Cross-Database Data Validation

> **The Definitive Reference for Cross-Database Validation Tool Builders**
>
> Every gotcha documented here has been verified against official documentation,
> bug reports, or reproducible SQL examples. When databases disagree on how to
> store, compare, or return data, your validation tool must account for the
> difference or produce false positives.

---

## Table of Contents

1. [PostgreSQL <-> Snowflake Gotchas](#1-postgresql--snowflake-gotchas)
2. [PostgreSQL <-> BigQuery Gotchas](#2-postgresql--bigquery-gotchas)
3. [PostgreSQL <-> MySQL Gotchas](#3-postgresql--mysql-gotchas)
4. [PostgreSQL <-> DuckDB Gotchas](#4-postgresql--duckdb-gotchas)
5. [Snowflake <-> BigQuery Gotchas](#5-snowflake--bigquery-gotchas)
6. [Oracle <-> PostgreSQL Gotchas](#6-oracle--postgresql-gotchas)
7. [Cross-Cutting Gotchas (All Database Pairs)](#7-cross-cutting-gotchas-all-database-pairs)

---

## 1. PostgreSQL <-> Snowflake Gotchas

### 1.1 `SERIAL`/`IDENTITY` Column Behavior Differences

**What happens:** PostgreSQL `SERIAL` creates a sequence that generates strictly sequential values within a single session. Snowflake `AUTOINCREMENT`/`IDENTITY` columns use distributed sequence generation with caching, producing non-sequential values with gaps even in single-session inserts. As of BCR 2024_01, Snowflake defaults new sequences to `NOORDER`, meaning values are not guaranteed to be monotonically increasing across concurrent inserts.

**SQL example showing the discrepancy:**

```sql
-- PostgreSQL: Sequential, gap-free within a session
CREATE TABLE pg_test (id SERIAL PRIMARY KEY, name TEXT);
INSERT INTO pg_test (name) VALUES ('a'), ('b'), ('c');
SELECT * FROM pg_test;
-- id | name
--  1 | a
--  2 | b
--  3 | c

-- Snowflake: Gaps possible, order not guaranteed with NOORDER
CREATE TABLE sf_test (id INT AUTOINCREMENT, name VARCHAR);
INSERT INTO sf_test (name) VALUES ('a'), ('b'), ('c');
SELECT * FROM sf_test;
-- id | name
--  1 | a       -- Could also be 1001, 2001, etc. depending on node caching
--  2 | b
--  3 | c
```

**How to detect during validation:** Compare row counts and check whether auto-generated IDs match. If validating by primary key, expect ID mismatches when data was inserted concurrently or after sequence cache invalidation.

**How to handle in a diff tool:** Never compare auto-increment columns by value across databases. Use natural keys or content hashing for row matching. Flag identity columns and exclude them from value comparison by default.

**References:**
- [Snowflake BCR 2024_01: NOORDER default](https://docs.snowflake.com/en/release-notes/bcr-bundles/2024_01/bcr-1483)
- [PostgreSQL Identity Columns documentation](https://www.postgresql.org/docs/current/ddl-identity-columns.html)
- [Snowflake IDENTITY & AUTOINCREMENT](https://www.secoda.co/learn/snowflake-identity)

---

### 1.2 `NUMERIC` vs `NUMBER(38,0)` Default Scale Trap

**What happens:** PostgreSQL `NUMERIC` without precision/scale stores arbitrary precision decimal values faithfully. Snowflake `NUMBER` without arguments defaults to `NUMBER(38,0)` -- scale zero -- silently truncating all decimal places. This is the single most common data loss gotcha in PostgreSQL-to-Snowflake migrations.

**SQL example showing the discrepancy:**

```sql
-- PostgreSQL: Stores full decimal precision
CREATE TABLE pg_nums (val NUMERIC);
INSERT INTO pg_nums VALUES (123.456789);
SELECT val FROM pg_nums;
-- 123.456789

-- Snowflake: NUMBER without scale defaults to NUMBER(38,0)
CREATE TABLE sf_nums (val NUMBER);
INSERT INTO sf_nums VALUES (123.456789);
SELECT val FROM sf_nums;
-- 123  (decimals silently truncated!)
```

**How to detect during validation:** Compare decimal values with an epsilon tolerance. Any column declared as `NUMERIC`/`NUMBER` without explicit scale should be flagged as a potential truncation risk. Compute `ABS(pg_value - sf_value)` and report if it exceeds a configurable threshold.

**How to handle in a diff tool:** When schema metadata shows `NUMBER(38,0)` on Snowflake but unbounded `NUMERIC` on PostgreSQL, emit a schema-level warning before row comparison. Optionally truncate PostgreSQL values to match Snowflake's declared scale for comparison purposes, but always report the schema mismatch.

**References:**
- [Snowflake Numeric Data Types](https://docs.snowflake.com/en/sql-reference/data-types-numeric) -- "If precision is not specified, the default is 38. If scale is not specified, the default is 0."
- [PostgreSQL Numeric Types](https://www.postgresql.org/docs/current/datatype-numeric.html) -- "without any precision or scale creates an 'unconstrained numeric' column"
- [PostgreSQL to Snowflake Migration](https://medium.com/@vithakota/postgresql-to-snowflake-migration-2-50bcc6952c85)

---

### 1.3 `TIMESTAMPTZ` Storage Semantics

**What happens:** PostgreSQL converts all `TIMESTAMPTZ` inputs to UTC for internal storage and discards the original time zone. On output, it converts back to the session's `TimeZone` setting. Snowflake's `TIMESTAMP_TZ` stores the UTC value *plus* the offset at the time of insertion, but this offset is a fixed number (e.g., `-08:00`), not a named time zone. This means DST-aware arithmetic fails: adding 6 months to a winter timestamp retains the winter offset even if summer DST applies.

**SQL example showing the discrepancy:**

```sql
-- PostgreSQL: Stores UTC internally, displays in session TZ
SET timezone = 'America/Los_Angeles';
SELECT '2024-01-15 10:00:00-08'::timestamptz;
-- 2024-01-15 10:00:00-08  (stored as 2024-01-15 18:00:00 UTC)

SELECT '2024-01-15 10:00:00-08'::timestamptz + INTERVAL '6 months';
-- 2024-07-15 10:00:00-07  (correctly applies PDT offset -07)

-- Snowflake: Stores offset, not timezone name
ALTER SESSION SET TIMEZONE = 'America/Los_Angeles';
SELECT '2024-01-15 10:00:00-08'::TIMESTAMP_TZ;
-- 2024-01-15 10:00:00-08

SELECT DATEADD(month, 6, '2024-01-15 10:00:00-08'::TIMESTAMP_TZ);
-- 2024-07-15 10:00:00-08  (WRONG: retains -08 instead of -07 PDT)
```

**How to detect during validation:** Convert all timestamps to UTC epoch (seconds since 1970-01-01 00:00:00 UTC) on both sides before comparison. If UTC epochs match but formatted strings differ, it is a display/offset issue, not a data issue. If UTC epochs differ, flag it.

**How to handle in a diff tool:** Always normalize to UTC for comparison. Provide a configuration option for timestamp tolerance (e.g., ignore sub-second differences). Report DST-boundary discrepancies as warnings with the specific offset mismatch.

**References:**
- [PostgreSQL Date/Time Types](https://www.postgresql.org/docs/current/datatype-datetime.html) -- "For timestamp with time zone, the internally stored value is always in UTC"
- [Snowflake TIMESTAMP_TZ docs](https://docs.snowflake.com/en/sql-reference/data-types-datetime) -- "TIMESTAMP_TZ internally stores UTC time together with an associated time zone offset"
- [Timestamps in Snowflake: NTZ vs LTZ vs TZ](https://acheron.cloud/snowflake/timestamps-in-snowflake-ntz-vs-ltz-vs-tz/)

---

### 1.4 `JSONB` Key Ordering vs `VARIANT` Key Ordering

**What happens:** PostgreSQL `JSONB` does not preserve insertion order of object keys. Keys are stored in a normalized binary format; the output order is deterministic per PostgreSQL version but not alphabetical and not insertion-order. Snowflake `VARIANT` (via `OBJECT_CONSTRUCT`) also does not preserve key order, and its output order may differ from PostgreSQL's. Comparing JSON strings directly will produce false diffs.

**SQL example showing the discrepancy:**

```sql
-- PostgreSQL: JSONB normalizes key order
SELECT '{"z":1, "a":2, "m":3}'::jsonb;
-- {"a": 2, "m": 3, "z": 1}  (alphabetical in most PG versions)

-- Snowflake: VARIANT key order is implementation-defined
SELECT OBJECT_CONSTRUCT('z', 1, 'a', 2, 'm', 3);
-- {"a": 2, "m": 3, "z": 1}  (may or may not be alphabetical)
```

**How to detect during validation:** Parse JSON on both sides into a language-native dictionary/map structure and compare structurally, not as strings. Recursively sort keys before string comparison if string-level diff is needed.

**How to handle in a diff tool:** Implement JSON-aware comparison that ignores key order. Provide options for: (a) structural equality (default), (b) exact string match (opt-in). For nested arrays within JSON, preserve array element order since arrays are ordered.

**References:**
- [PostgreSQL JSON Types](https://www.postgresql.org/docs/current/datatype-json.html) -- "jsonb does not preserve... the order of object keys"
- [Snowflake OBJECT_CONSTRUCT](https://docs.snowflake.com/en/sql-reference/functions/object_construct) -- "The constructed object does not necessarily preserve the original order of the key-value pairs"

---

### 1.5 `BYTEA` Hex Format vs Snowflake `BINARY`

**What happens:** PostgreSQL `BYTEA` outputs binary data in hex format with a `\x` prefix by default (e.g., `\x48656c6c6f`). Snowflake `BINARY` outputs as bare hex without prefix (e.g., `48656C6C6F`) and uses uppercase hex digits. String comparison of binary column outputs will always differ.

**SQL example showing the discrepancy:**

```sql
-- PostgreSQL: bytea with \x prefix, lowercase hex
SELECT 'Hello'::bytea;
-- \x48656c6c6f

-- Snowflake: BINARY without prefix, uppercase hex
SELECT TO_BINARY('Hello', 'UTF-8');
-- 48656C6C6F
```

**How to detect during validation:** Strip the `\x` prefix from PostgreSQL values and normalize both sides to the same case (upper or lower) before comparison. Better yet, compare decoded byte arrays rather than hex string representations.

**How to handle in a diff tool:** Implement a binary-aware comparator that normalizes hex representations. Configuration: `binary_comparison_mode: bytes | hex_normalized | raw_string`.

**References:**
- [PostgreSQL Binary Data Types](https://www.postgresql.org/docs/current/datatype-binary.html) -- "The 'hex' format encodes binary data as 2 hexadecimal digits per byte... preceded by the sequence \x"
- [Snowflake Binary Data Type docs](https://docs.snowflake.com/en/sql-reference/data-types-text#binary)

---

### 1.6 `CHAR` Padding and Trailing Space Comparison

**What happens:** PostgreSQL `CHAR(n)` pads values with spaces to the declared length and *ignores trailing spaces in comparisons*. Snowflake treats `CHAR` as an alias for `VARCHAR` -- no padding occurs, and trailing spaces are significant in comparisons. This means `'abc'` in a `CHAR(10)` column equals `'abc       '` in PostgreSQL but not in Snowflake.

**SQL example showing the discrepancy:**

```sql
-- PostgreSQL: CHAR pads and ignores trailing spaces in comparison
CREATE TABLE pg_char_test (val CHAR(10));
INSERT INTO pg_char_test VALUES ('abc');
SELECT val = 'abc' FROM pg_char_test;
-- true  (trailing spaces ignored)
SELECT LENGTH(val) FROM pg_char_test;
-- 3  (LENGTH trims trailing spaces in CHAR)

-- Snowflake: CHAR = VARCHAR, no padding
CREATE TABLE sf_char_test (val CHAR(10));
INSERT INTO sf_char_test VALUES ('abc');
SELECT val = 'abc' FROM sf_char_test;
-- true  (no padding was added)
SELECT val = 'abc       ' FROM sf_char_test;
-- false  (trailing spaces matter)
```

**How to detect during validation:** Apply `RTRIM()` to both sides before comparison for `CHAR`-type columns. Alternatively, detect `CHAR` columns from schema metadata and auto-trim.

**How to handle in a diff tool:** When source schema has `CHAR(n)`, always `RTRIM` before comparison. Emit a warning that CHAR padding semantics differ. Provide config: `char_comparison: trimmed | exact`.

**References:**
- [PostgreSQL Character Types](https://www.postgresql.org/docs/current/datatype-character.html) -- "Values of type character are physically padded with spaces... trailing spaces are treated as semantically insignificant"
- [Snowflake SnowConvert: PostgreSQL String Comparison](https://docs.snowflake.com/en/migrations/snowconvert-docs/translation-references/postgres/postgresql-string-comparison) -- "In Snowflake... 'water ' is not considered equal to 'water'"

---

### 1.7 Identifier Quoting and Case Folding

**What happens:** PostgreSQL folds unquoted identifiers to **lowercase**. Snowflake folds unquoted identifiers to **UPPERCASE**. Double-quoting preserves exact case in both. This means the same DDL `CREATE TABLE MyTable (MyCol INT)` creates `mytable.mycol` in PostgreSQL but `MYTABLE.MYCOL` in Snowflake.

**SQL example showing the discrepancy:**

```sql
-- PostgreSQL: unquoted -> lowercase
CREATE TABLE MyTable (MyCol INT);
SELECT column_name FROM information_schema.columns WHERE table_name = 'mytable';
-- mycol

-- Snowflake: unquoted -> UPPERCASE
CREATE TABLE MyTable (MyCol INT);
SELECT column_name FROM information_schema.columns WHERE table_name = 'MYTABLE';
-- MYCOL
```

**How to detect during validation:** When comparing schemas or matching columns between databases, normalize identifiers to a common case. Use `LOWER()` on both sides as the default normalization strategy.

**How to handle in a diff tool:** Implement case-insensitive column matching by default. Provide a `case_sensitive_identifiers: true` option for environments that use quoted identifiers deliberately. Log which identifiers required case normalization.

**References:**
- [PostgreSQL: Case Sensitivity](https://www.bytebase.com/blog/postgres-case-sensitivity/) -- "unquoted identifiers are folded to lowercase"
- [Snowflake: Identifier Requirements](https://docs.snowflake.com/en/sql-reference/identifiers-syntax) -- "unquoted identifiers are stored and resolved as uppercase"
- [Understanding Snowflake Identifiers](https://www.sambobb.com/posts/snowflake-identifiers/)

---

### 1.8 `ARRAY` Types: Native vs VARIANT-wrapped

**What happens:** PostgreSQL has native typed arrays (`INT[]`, `TEXT[]`, etc.) where all elements must match the declared type. Snowflake's semi-structured `ARRAY` type wraps every element as `VARIANT`, meaning elements can be mixed types. Structured typed arrays (`ARRAY(INT)`) are a newer Snowflake feature (GA mid-2025) but are not yet universally used.

**SQL example showing the discrepancy:**

```sql
-- PostgreSQL: Typed array, rejects type mismatches
SELECT ARRAY[1, 2, 3]::INT[];
-- {1,2,3}
SELECT ARRAY[1, 'two', 3]::INT[];
-- ERROR: invalid input syntax for type integer: "two"

-- Snowflake: ARRAY of VARIANT, allows mixed types
SELECT ARRAY_CONSTRUCT(1, 'two', 3);
-- [1, "two", 3]  (mixed types allowed)
```

**How to detect during validation:** For array columns, compare element-by-element after type normalization. A Snowflake VARIANT element `1` (integer) should match PostgreSQL array element `1`. Watch for string-vs-number mismatches in VARIANT arrays.

**How to handle in a diff tool:** Implement array-aware comparison that: (a) compares element count, (b) compares elements positionally, (c) handles type coercion for VARIANT elements. Provide option for order-sensitive vs order-insensitive array comparison.

**References:**
- [PostgreSQL Array Types](https://www.postgresql.org/docs/current/arrays.html)
- [Snowflake Semi-structured Data Types](https://docs.snowflake.com/en/sql-reference/data-types-semistructured)
- [Snowflake Structured Data Types](https://docs.snowflake.com/en/sql-reference/data-types-structured)

---

### 1.9 `INTERVAL` Type Support

**What happens:** PostgreSQL has a rich native `INTERVAL` type supporting complex interval arithmetic (`INTERVAL '1 year 2 months 3 days 4 hours'`). Snowflake supports `INTERVAL` as a keyword in expressions (e.g., `DATEADD(day, 3, ts)` or `ts + INTERVAL '3 days'`) but does not have a storable `INTERVAL` column type. You cannot create a column of type `INTERVAL` in Snowflake.

**SQL example showing the discrepancy:**

```sql
-- PostgreSQL: INTERVAL is a first-class storable type
CREATE TABLE pg_intervals (duration INTERVAL);
INSERT INTO pg_intervals VALUES ('1 year 2 months 3 days');
SELECT duration FROM pg_intervals;
-- 1 year 2 mons 3 days

-- Snowflake: INTERVAL is not a column type
CREATE TABLE sf_intervals (duration INTERVAL);
-- ERROR: Unsupported data type 'INTERVAL'.
```

**How to detect during validation:** Flag any PostgreSQL `INTERVAL` columns during schema comparison as incompatible with Snowflake. These columns require conversion to a string or numeric representation for storage in Snowflake.

**How to handle in a diff tool:** When source has `INTERVAL` columns, convert to a canonical string representation (ISO 8601 duration format `P1Y2M3D`) or total seconds for comparison. Document the conversion strategy in diff output.

**References:**
- [PostgreSQL Date/Time Types](https://www.postgresql.org/docs/current/datatype-datetime.html)
- [Snowflake Interval usage](https://dwgeek.com/snowflake-interval-data-types-and-conversion-examples.html/)

---

### 1.10 Regex Syntax Differences

**What happens:** PostgreSQL uses the `~` operator for POSIX regex matching (`~` case-sensitive, `~*` case-insensitive). Snowflake uses `REGEXP_LIKE()` function or `RLIKE` operator, with different backslash escaping rules. In Snowflake, the string parser treats backslashes as escape characters, so regex patterns need double-escaping unless using `$$` dollar-quoting.

**SQL example showing the discrepancy:**

```sql
-- PostgreSQL: ~ operator with single backslash in E-string
SELECT 'abc123' ~ '\d+';
-- true

-- Snowflake: REGEXP_LIKE with double backslash (string parser escaping)
SELECT REGEXP_LIKE('abc123', '\\d+');
-- true

-- Snowflake: or use $$ to avoid double-escaping
SELECT REGEXP_LIKE('abc123', $$\d+$$);
-- true
```

**How to detect during validation:** This is primarily a query-level concern, not a data-level concern. However, if validation queries use regex-based filters, ensure the syntax is adapted per database.

**How to handle in a diff tool:** Provide database-specific regex adapters. When generating validation SQL, translate regex syntax automatically. Use `REGEXP_LIKE()` for Snowflake and `~` for PostgreSQL.

**References:**
- [PostgreSQL Pattern Matching](https://www.postgresql.org/docs/current/functions-matching.html)
- [Snowflake REGEXP_LIKE](https://docs.snowflake.com/en/sql-reference/functions/regexp_like)
- [Snowflake String Functions (Regular Expressions)](https://docs.snowflake.com/en/sql-reference/functions-regexp)

---

### 1.11 Collation Defaults

**What happens:** PostgreSQL collation is OS-dependent by default, determined by the `LC_COLLATE` setting at database creation time (e.g., `en_US.UTF-8` on Linux, which uses glibc). Different OS versions or glibc updates can change sort order for the same collation name. Starting with PostgreSQL 15, a built-in `C.UTF-8` collation provider is available. Snowflake always uses UTF-8 and compares strings by Unicode code point values by default.

**SQL example showing the discrepancy:**

```sql
-- PostgreSQL (depends on OS locale): string ordering may be locale-aware
-- With en_US.UTF-8, accented characters sort linguistically
SELECT * FROM (VALUES ('cafe'), ('caff'), ('cafe')) t(word) ORDER BY word;
-- Ordering depends on OS locale

-- Snowflake: always UTF-8 code point ordering
SELECT * FROM (VALUES ('cafe'), ('caff'), ('cafe')) t(word) ORDER BY word;
-- Consistent Unicode code point ordering
```

**How to detect during validation:** When comparing sorted results across databases, be aware that sort order may differ for strings with accented characters, mixed case, or non-ASCII content. Compare data sets using unordered comparison (set equality) rather than ordered comparison.

**How to handle in a diff tool:** Default to unordered row comparison. If ordered comparison is needed, use a deterministic sort key (e.g., `MD5` hash of row content). Warn when collation-sensitive columns are used in ORDER BY.

**References:**
- [PostgreSQL Collation Support](https://www.postgresql.org/docs/current/collation.html) -- "The available locales... platform-dependent"
- [Snowflake Collation Support](https://docs.snowflake.com/en/sql-reference/collation) -- "strings are compared according to the Unicode codes"

---

### 1.12 Transaction Isolation Semantics

**What happens:** Both PostgreSQL and Snowflake default to READ COMMITTED isolation, but the semantics differ subtly. PostgreSQL uses MVCC (Multi-Version Concurrency Control) where readers never block writers. Snowflake's READ COMMITTED allows successive statements in the same transaction to see different committed data from concurrent transactions. Snowflake does not support REPEATABLE READ or SERIALIZABLE isolation levels.

**How to detect during validation:** If validation reads span multiple queries (e.g., reading chunks), concurrent writes on either side can cause inconsistent snapshots. Use `BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ` on PostgreSQL for consistent reads. On Snowflake, use Time Travel with `AT(STATEMENT => ...)` instead.

**How to handle in a diff tool:** Always capture a consistent snapshot before comparison. On PostgreSQL, use `REPEATABLE READ` transactions. On Snowflake, use Time Travel (`SELECT ... AT(TIMESTAMP => '...')`) to pin a point-in-time. Document the snapshot strategy.

**References:**
- [PostgreSQL Transaction Isolation](https://www.postgresql.org/docs/current/transaction-iso.html)
- [Snowflake Transactions](https://docs.snowflake.com/en/sql-reference/transactions) -- "READ COMMITTED is the only isolation level currently supported"

---

### 1.13 NULL Ordering in ORDER BY

**What happens:** PostgreSQL treats NULLs as larger than any non-NULL value by default: `ORDER BY col ASC` puts NULLs last, `ORDER BY col DESC` puts NULLs first. Snowflake's behavior is configurable via the `DEFAULT_NULL_ORDERING` session parameter (default: `LAST` for ASC). While the defaults currently align, Snowflake's is a session parameter that can be changed at account, user, or session level.

**SQL example showing the discrepancy:**

```sql
-- PostgreSQL: NULLs last for ASC (not configurable globally)
SELECT val FROM (VALUES (1), (NULL), (2)) t(val) ORDER BY val ASC;
-- 1, 2, NULL

-- Snowflake: same default, but configurable
ALTER SESSION SET DEFAULT_NULL_ORDERING = 'FIRST';
SELECT val FROM (VALUES (1), (NULL), (2)) t(val) ORDER BY val ASC;
-- NULL, 1, 2  (now NULLs first!)
```

**How to detect during validation:** When comparing ordered results, always use explicit `NULLS FIRST` or `NULLS LAST` in both databases. Never rely on default NULL ordering.

**How to handle in a diff tool:** Generate ORDER BY clauses with explicit NULL ordering. Prefer unordered comparison (hash-based row matching) over ordered comparison to avoid this class of issues entirely.

**References:**
- [PostgreSQL ORDER BY](https://www.postgresql.org/docs/current/queries-order.html) -- "null values sort as if larger than any non-null value"
- [Snowflake ORDER BY](https://docs.snowflake.com/en/sql-reference/constructs/order-by)
- [Snowflake DEFAULT_NULL_ORDERING](https://snowflakechronicles.medium.com/mastering-null-values-in-snowflake-a-complete-guide-to-default-null-ordering-0dd5a74fd94e)

---

## 2. PostgreSQL <-> BigQuery Gotchas

### 2.1 DML Limitations and Quota Constraints

**What happens:** BigQuery supports `UPDATE`, `DELETE`, and `MERGE` statements in Standard SQL, but with significant constraints. DML operations have quota limits (e.g., maximum number of DML statements per table per day). Rows inserted via streaming (`tabledata.insertAll`) cannot be modified by DML for up to 90 minutes. PostgreSQL has no such limitations -- DML is fully transactional with no quotas.

**SQL example showing the discrepancy:**

```sql
-- PostgreSQL: Unlimited DML operations, fully transactional
BEGIN;
UPDATE large_table SET status = 'processed' WHERE created_at < '2024-01-01';
DELETE FROM large_table WHERE status = 'deleted';
COMMIT;  -- Atomic, no quotas

-- BigQuery: Subject to quotas and streaming buffer delays
UPDATE `project.dataset.large_table`
SET status = 'processed'
WHERE created_at < '2024-01-01';
-- May fail with: "Exceeded rate limits: too many table update operations"
-- Rows in streaming buffer cannot be modified
```

**How to detect during validation:** After DML operations on BigQuery, wait for the streaming buffer to flush before validation queries. Check `INFORMATION_SCHEMA.TABLE_STORAGE` for streaming buffer presence.

**How to handle in a diff tool:** When validating BigQuery data after writes, implement a configurable delay or streaming buffer check. Warn users about potential stale data from streaming inserts.

**References:**
- [BigQuery DML Statements](https://docs.cloud.google.com/bigquery/docs/reference/standard-sql/dml-syntax)
- [BigQuery Quotas and Limits](https://docs.cloud.google.com/bigquery/quotas)
- [BigQuery DML without limits announcement](https://cloud.google.com/blog/products/data-analytics/dml-without-limits-now-in-bigquery)

---

### 2.2 `INT64` as the Only Integer Type

**What happens:** BigQuery has a single integer type: `INT64` (64-bit signed integer). Aliases like `INT`, `SMALLINT`, `INTEGER`, `BIGINT`, `TINYINT`, and `BYTEINT` all map to `INT64`. PostgreSQL has `SMALLINT` (2 bytes), `INTEGER` (4 bytes), and `BIGINT` (8 bytes) with different ranges. Data that fits in PostgreSQL's `SMALLINT` will always fit in BigQuery's `INT64`, but schema comparison will show type mismatches.

**SQL example showing the discrepancy:**

```sql
-- PostgreSQL: Distinct integer types with different ranges
CREATE TABLE pg_ints (
    small_val SMALLINT,    -- -32768 to 32767
    int_val INTEGER,       -- -2147483648 to 2147483647
    big_val BIGINT         -- -9223372036854775808 to 9223372036854775807
);

-- BigQuery: Everything is INT64
CREATE TABLE dataset.bq_ints (
    small_val INT64,       -- All three are INT64
    int_val INT64,
    big_val INT64
);
```

**How to detect during validation:** Schema comparison will show type differences. For data comparison, values will match since INT64 encompasses all PostgreSQL integer ranges. Flag the schema difference as informational, not as an error.

**How to handle in a diff tool:** Implement integer type equivalence mapping: `{SMALLINT, INTEGER, BIGINT}` all map to `INT64`. Compare values numerically, not by type name.

**References:**
- [BigQuery Data Types](https://cloud.google.com/bigquery/docs/reference/standard-sql/data-types) -- "INT, SMALLINT, INTEGER, BIGINT, TINYINT, BYTEINT: Aliases for INT64"
- [PostgreSQL Numeric Types](https://www.postgresql.org/docs/current/datatype-numeric.html)

---

### 2.3 `NUMERIC(38,9)` Default Scale

**What happens:** BigQuery `NUMERIC` has a fixed precision of 38 and a default scale of 9 (i.e., `NUMERIC(38,9)`). BigQuery also offers `BIGNUMERIC` with precision 76 and scale 38. PostgreSQL `NUMERIC` without parameters has arbitrary precision and scale. This means BigQuery silently rounds to 9 decimal places, while PostgreSQL preserves all decimal places.

**SQL example showing the discrepancy:**

```sql
-- PostgreSQL: Preserves all decimal places
SELECT 1.123456789012345::NUMERIC;
-- 1.123456789012345

-- BigQuery: Rounds to 9 decimal places
SELECT CAST(1.123456789012345 AS NUMERIC);
-- 1.123456789  (truncated to 9 decimal places)
```

**How to detect during validation:** Compare NUMERIC values with awareness of BigQuery's 9-digit scale limit. Compute the difference and check if it falls within `10^-9`.

**How to handle in a diff tool:** When comparing NUMERIC columns between PostgreSQL and BigQuery, round PostgreSQL values to 9 decimal places before comparison. Flag columns where PostgreSQL data exceeds 9 decimal places as potential precision loss candidates.

**References:**
- [BigQuery Data Types: NUMERIC](https://cloud.google.com/bigquery/docs/reference/standard-sql/data-types) -- "NUMERIC can store up to 29 digits before the decimal point and up to 9 digits after"

---

### 2.4 `TIMESTAMP` in BigQuery is UTC Only

**What happens:** BigQuery `TIMESTAMP` always represents an absolute point in time in UTC. There is no timezone metadata stored. BigQuery also has `DATETIME` which is timezone-naive (wall clock time). PostgreSQL has `TIMESTAMP` (without TZ, timezone-naive) and `TIMESTAMPTZ` (with TZ, stored as UTC). The mapping is non-obvious: BigQuery `TIMESTAMP` aligns with PostgreSQL `TIMESTAMPTZ`, and BigQuery `DATETIME` aligns with PostgreSQL `TIMESTAMP`.

**SQL example showing the discrepancy:**

```sql
-- PostgreSQL: TIMESTAMPTZ stores in UTC, displays in session TZ
SET timezone = 'America/New_York';
SELECT '2024-01-15 10:00:00-05'::TIMESTAMPTZ;
-- 2024-01-15 10:00:00-05  (stored as 15:00 UTC)

-- BigQuery: TIMESTAMP is always UTC
SELECT TIMESTAMP '2024-01-15 10:00:00-05:00';
-- 2024-01-15 15:00:00 UTC  (displayed in UTC)

-- BigQuery: DATETIME is wall clock, no timezone
SELECT DATETIME '2024-01-15 10:00:00';
-- 2024-01-15T10:00:00  (no timezone, like PG TIMESTAMP)
```

**How to detect during validation:** Always convert to UTC epoch for comparison. Be aware that BigQuery displays TIMESTAMP in UTC while PostgreSQL displays TIMESTAMPTZ in the session timezone.

**How to handle in a diff tool:** Normalize all timestamp comparisons to UTC epoch milliseconds. Map PostgreSQL `TIMESTAMPTZ` to BigQuery `TIMESTAMP`, and PostgreSQL `TIMESTAMP` to BigQuery `DATETIME`.

**References:**
- [BigQuery Timestamp Functions](https://cloud.google.com/bigquery/docs/reference/standard-sql/timestamp_functions)
- [BigQuery: DATETIME vs TIMESTAMP](https://medium.com/data-engineers-notes/datetime-vs-timestamp-in-bigquery-e09dff06e245)

---

### 2.5 `STRUCT` vs PostgreSQL Composite Types

**What happens:** BigQuery `STRUCT` (also called `RECORD`) is a first-class column type with named, typed fields. PostgreSQL has composite types created via `CREATE TYPE`, but they are rarely used as column types compared to BigQuery's pervasive use of STRUCT in denormalized schemas. The access syntax differs: BigQuery uses dot notation (`struct_col.field`), while PostgreSQL uses parenthesized notation (`(composite_col).field`).

**SQL example showing the discrepancy:**

```sql
-- BigQuery: STRUCT as column type with dot notation
SELECT STRUCT('John' AS name, 30 AS age) AS person;
-- {"name": "John", "age": 30}
SELECT person.name FROM (SELECT STRUCT('John' AS name, 30 AS age) AS person);
-- John

-- PostgreSQL: Composite type with parenthesized notation
CREATE TYPE person_type AS (name TEXT, age INT);
SELECT ROW('John', 30)::person_type AS person;
-- (John,30)
SELECT (person).name FROM (SELECT ROW('John', 30)::person_type AS person) t;
-- John
```

**How to detect during validation:** Flatten STRUCT/composite columns to individual scalar values for comparison. Compare field-by-field rather than comparing the composite as a single value.

**How to handle in a diff tool:** Implement STRUCT/composite-aware comparison that: (a) extracts fields by name, (b) compares field values individually, (c) handles nested STRUCTs recursively.

**References:**
- [BigQuery Data Types: STRUCT](https://cloud.google.com/bigquery/docs/reference/standard-sql/data-types)
- [PostgreSQL Composite Types](https://www.postgresql.org/docs/current/rowtypes.html)

---

### 2.6 `REPEATED` Fields (Arrays) Cannot Contain NULLs

**What happens:** BigQuery `ARRAY` (REPEATED mode in schema) cannot contain NULL elements. Attempting to insert a NULL into an array raises an error. PostgreSQL arrays freely allow NULL elements. This is a fundamental constraint that can cause data loss or insertion failures during migration.

**SQL example showing the discrepancy:**

```sql
-- PostgreSQL: Arrays with NULLs are fine
SELECT ARRAY[1, NULL, 3];
-- {1,NULL,3}

-- BigQuery: Arrays cannot contain NULLs
SELECT [1, NULL, 3];
-- ERROR: Array cannot have a null element
```

**How to detect during validation:** Before comparison, check PostgreSQL array columns for NULL elements. If found, flag them as incompatible with BigQuery and report the count of affected rows.

**How to handle in a diff tool:** When validating array columns, filter out NULL elements from PostgreSQL arrays before comparison (with a warning). Alternatively, report NULL-containing arrays as validation failures with a clear explanation.

**References:**
- [BigQuery Data Types: ARRAY](https://cloud.google.com/bigquery/docs/reference/standard-sql/data-types) -- "NULLs within ARRAYs are not allowed"

---

### 2.7 `DATE` Range Differences

**What happens:** BigQuery `DATE` supports the range `0001-01-01` to `9999-12-31`. PostgreSQL `DATE` supports `4713 BC` to `5874897 AD`. Historical dates before year 0001 that are valid in PostgreSQL will fail in BigQuery. Far-future dates beyond `9999-12-31` valid in PostgreSQL will also fail.

**How to detect during validation:** Check for DATE values outside BigQuery's range in PostgreSQL data before migration. Query: `SELECT COUNT(*) FROM table WHERE date_col < '0001-01-01' OR date_col > '9999-12-31'`.

**How to handle in a diff tool:** Flag out-of-range dates during schema analysis. For data within valid range on both sides, compare as ISO 8601 strings.

**References:**
- [BigQuery DATE type](https://cloud.google.com/bigquery/docs/reference/standard-sql/data-types)
- [PostgreSQL Date/Time Types](https://www.postgresql.org/docs/current/datatype-datetime.html)

---

### 2.8 Case Sensitivity of Identifiers

**What happens:** BigQuery preserves the case of identifiers (table names, column names) and treats them as case-sensitive in most contexts. Table and dataset names are case-sensitive by default (unless `is_case_insensitive` is set on the dataset). PostgreSQL folds unquoted identifiers to lowercase. This creates a three-way mismatch: PostgreSQL lowercases, Snowflake uppercases, BigQuery preserves.

**SQL example showing the discrepancy:**

```sql
-- PostgreSQL: unquoted identifiers become lowercase
CREATE TABLE MyTable (MyColumn INT);
-- Stored as: mytable(mycolumn)

-- BigQuery: identifiers preserve case
CREATE TABLE `project.dataset.MyTable` (MyColumn INT64);
-- Stored as: MyTable(MyColumn)
```

**How to detect during validation:** Use case-insensitive matching for column names. For table names, check both original case and lowercase.

**How to handle in a diff tool:** Default to case-insensitive identifier matching. Provide a `case_sensitive_identifiers` config option.

**References:**
- [BigQuery Lexical Structure](https://cloud.google.com/bigquery/docs/reference/standard-sql/lexical)
- [PostgreSQL Case Sensitivity](https://www.bytebase.com/blog/postgres-case-sensitivity/)

---

## 3. PostgreSQL <-> MySQL Gotchas

### 3.1 Empty String vs NULL Confusion

**What happens:** In standard MySQL (with strict SQL mode enabled), empty strings and NULLs are distinct, like PostgreSQL. However, MySQL's `ENUM` type inserts an empty string (with index 0) when an invalid value is provided in non-strict mode, creating a special "error" empty string that behaves differently from a normal empty string. Additionally, older MySQL configurations without `STRICT_TRANS_TABLES` in `sql_mode` may silently coerce invalid values in surprising ways.

**SQL example showing the discrepancy:**

```sql
-- MySQL (non-strict mode): ENUM with invalid value inserts empty string
CREATE TABLE mysql_enum (status ENUM('active', 'inactive'));
INSERT INTO mysql_enum VALUES ('invalid');
-- Inserts '' (empty string with index 0) -- no error in non-strict mode!

-- PostgreSQL: Strict enum enforcement
CREATE TYPE status_type AS ENUM ('active', 'inactive');
CREATE TABLE pg_enum (status status_type);
INSERT INTO pg_enum VALUES ('invalid');
-- ERROR: invalid input value for enum status_type: "invalid"
```

**How to detect during validation:** Check for ENUM columns with index-0 values in MySQL (empty string error values). These have no PostgreSQL equivalent and indicate data quality issues.

**How to handle in a diff tool:** For ENUM columns, validate that all values exist in the enum definition. Flag MySQL index-0 empty strings as anomalies. Compare enum values as strings, not indices.

**References:**
- [MySQL ENUM Type](https://dev.mysql.com/doc/refman/8.0/en/enum.html) -- "If you insert an invalid value... the empty string is inserted instead as a special error value"
- [MySQL Bug #57298: ENUMs do not obey strict sql_mode](https://bugs.mysql.com/bug.php?id=57298)

---

### 3.2 `ENUM` Type Differences

**What happens:** MySQL `ENUM` is a string type with a defined set of allowed values, stored internally as integers (1-indexed). PostgreSQL `ENUM` is a custom type created via `CREATE TYPE ... AS ENUM(...)`. Key differences: MySQL ENUM values are compared case-insensitively by default, MySQL ENUM ordering is by definition order (not alphabetical), and MySQL allows the error empty-string value (index 0).

**SQL example showing the discrepancy:**

```sql
-- MySQL: ENUM ordering is by definition order
CREATE TABLE mysql_priority (level ENUM('low', 'medium', 'high'));
INSERT INTO mysql_priority VALUES ('medium'), ('low'), ('high');
SELECT * FROM mysql_priority ORDER BY level;
-- low, medium, high  (definition order, not alphabetical)

-- PostgreSQL: ENUM ordering is by creation order
CREATE TYPE priority AS ENUM ('low', 'medium', 'high');
CREATE TABLE pg_priority (level priority);
INSERT INTO pg_priority VALUES ('medium'), ('low'), ('high');
SELECT * FROM pg_priority ORDER BY level;
-- low, medium, high  (creation order -- same in this case)
```

**How to detect during validation:** Compare enum values as strings, ignoring internal storage representation. Verify both databases define the same set of valid values.

**How to handle in a diff tool:** Map ENUM columns to their string representations for comparison. Validate that enum definitions match across databases.

**References:**
- [MySQL ENUM Type](https://dev.mysql.com/doc/refman/8.0/en/enum.html)
- [PostgreSQL ENUM Types](https://www.postgresql.org/docs/current/datatype-enum.html)

---

### 3.3 `TINYINT(1)` as Boolean

**What happens:** MySQL has no true `BOOLEAN` type. `BOOLEAN` is an alias for `TINYINT(1)`, where `0` = FALSE and `1` = TRUE. However, `TINYINT(1)` can actually store values -128 to 127, not just 0 and 1. The `(1)` is a display width hint, not a constraint. PostgreSQL has a true `BOOLEAN` type that only accepts `TRUE`, `FALSE`, and `NULL`. Many ORMs treat MySQL `TINYINT(1)` as boolean, but raw data can contain values like 2, -1, etc.

**SQL example showing the discrepancy:**

```sql
-- MySQL: TINYINT(1) accepts non-boolean values
CREATE TABLE mysql_bools (flag TINYINT(1));
INSERT INTO mysql_bools VALUES (0), (1), (2), (-1);
SELECT flag, IF(flag, 'truthy', 'falsy') FROM mysql_bools;
-- 0: falsy, 1: truthy, 2: truthy, -1: truthy

-- PostgreSQL: TRUE/FALSE only
CREATE TABLE pg_bools (flag BOOLEAN);
INSERT INTO pg_bools VALUES (TRUE), (FALSE);
INSERT INTO pg_bools VALUES (2);
-- ERROR: column "flag" is of type boolean but expression is of type integer
```

**How to detect during validation:** Check MySQL `TINYINT(1)` columns for values other than 0 and 1. These will fail if cast to PostgreSQL `BOOLEAN`.

**How to handle in a diff tool:** When comparing `TINYINT(1)` (MySQL) to `BOOLEAN` (PostgreSQL), treat 0 as FALSE and any non-zero value as TRUE. Report non-0/1 values as warnings.

**References:**
- [MySQL Numeric Types](https://dev.mysql.com/doc/refman/8.0/en/numeric-type-syntax.html) -- "BOOL, BOOLEAN: These types are synonyms for TINYINT(1)"

---

### 3.4 `AUTO_INCREMENT` vs `SERIAL`

**What happens:** MySQL `AUTO_INCREMENT` and PostgreSQL `SERIAL`/`IDENTITY` both generate auto-incrementing values, but with different behaviors on rollback and gaps. MySQL `AUTO_INCREMENT` values are not rolled back on transaction rollback (gaps are permanent). PostgreSQL sequences also do not roll back, but the `SERIAL` mechanism creates a named sequence object that can be inspected and manipulated independently.

**How to detect during validation:** Same guidance as section 1.1 -- never compare auto-increment values across databases.

**How to handle in a diff tool:** Exclude auto-increment/serial columns from value comparison by default. Use natural keys for row matching.

---

### 3.5 `DATETIME` vs `TIMESTAMP` (MySQL 2038 Limit)

**What happens:** MySQL has two datetime types with fundamentally different ranges and behaviors. `TIMESTAMP` stores as 32-bit UTC seconds with range `1970-01-01 00:00:01` to `2038-01-19 03:14:07` and auto-converts to/from UTC based on session timezone. `DATETIME` stores as a date+time literal with range `1000-01-01` to `9999-12-31` and has no timezone conversion. PostgreSQL `TIMESTAMP` has microsecond precision and range from `4713 BC` to `294276 AD`.

**SQL example showing the discrepancy:**

```sql
-- MySQL: TIMESTAMP has 2038 limit
CREATE TABLE mysql_ts (ts TIMESTAMP);
INSERT INTO mysql_ts VALUES ('2038-01-20 00:00:00');
-- ERROR: Incorrect datetime value (or silently truncated depending on sql_mode)

-- MySQL: DATETIME has no such limit
CREATE TABLE mysql_dt (dt DATETIME);
INSERT INTO mysql_dt VALUES ('2038-01-20 00:00:00');
-- OK

-- PostgreSQL: No 2038 problem
CREATE TABLE pg_ts (ts TIMESTAMP);
INSERT INTO pg_ts VALUES ('2038-01-20 00:00:00');
-- OK
```

**How to detect during validation:** Check MySQL `TIMESTAMP` columns for values near the 2038 boundary. Flag any dates after `2038-01-19 03:14:07 UTC` as at-risk.

**How to handle in a diff tool:** Map MySQL `DATETIME` to PostgreSQL `TIMESTAMP` and MySQL `TIMESTAMP` to PostgreSQL `TIMESTAMPTZ`. When comparing, be aware of the timezone conversion that MySQL `TIMESTAMP` performs.

**References:**
- [MySQL DATETIME and TIMESTAMP Types](https://dev.mysql.com/doc/refman/8.0/en/datetime.html)
- [MySQL 2038 problem](https://dev.to/xinecraft/did-you-know-mysql-timestamp-column-cant-go-beyond-2038-01-19-031407-29a8)
- [MySQL Bug #12654: 64-bit unix timestamp not supported](https://bugs.mysql.com/bug.php?id=12654)

---

### 3.6 Default Collation: `utf8mb4_0900_ai_ci` vs OS-dependent

**What happens:** MySQL 8.0+ defaults to `utf8mb4_0900_ai_ci` (Unicode 9.0, accent-insensitive, case-insensitive). This means `'cafe' = 'CAFE'` and `'cafe' = 'cafe'` are both TRUE in MySQL. PostgreSQL's default collation depends on the OS locale (typically `en_US.UTF-8`), which is case-sensitive and accent-sensitive. String comparisons that match in MySQL may fail in PostgreSQL.

**SQL example showing the discrepancy:**

```sql
-- MySQL (utf8mb4_0900_ai_ci): case and accent insensitive
SELECT 'cafe' = 'CAFE';  -- 1 (true)
SELECT 'cafe' = 'cafe';  -- 1 (true, accent insensitive)

-- PostgreSQL (en_US.UTF-8): case and accent sensitive
SELECT 'cafe' = 'CAFE';  -- false
SELECT 'cafe' = 'cafe';  -- false
```

**How to detect during validation:** When comparing string values that are identical in MySQL but different in PostgreSQL, check if the MySQL table uses a case/accent-insensitive collation. Run comparisons using explicit `LOWER()` or collation-aware comparison.

**How to handle in a diff tool:** Detect MySQL collations and warn about case/accent insensitivity. Provide option to compare strings case-insensitively to match MySQL behavior. Config: `string_comparison: exact | case_insensitive | collation_aware`.

**References:**
- [MySQL utf8mb4_0900_ai_ci collation](https://www.monolune.com/articles/what-is-the-utf8mb4_0900_ai_ci-collation/)
- [MySQL Collation Naming Conventions](https://dev.mysql.com/doc/refman/8.0/en/charset-collation-names.html)

---

### 3.7 `GROUP BY` Strictness

**What happens:** MySQL historically (and still with `ONLY_FULL_GROUP_BY` disabled) allows SELECT columns that are not in the GROUP BY clause and not aggregated. The returned value for such columns is indeterminate -- MySQL picks an arbitrary value from the group. PostgreSQL always requires columns in SELECT to be either in GROUP BY or used in an aggregate function.

**SQL example showing the discrepancy:**

```sql
-- MySQL (ONLY_FULL_GROUP_BY disabled): non-aggregated column allowed
SELECT department, name, MAX(salary)
FROM employees
GROUP BY department;
-- name is arbitrary -- could be any employee in the department!

-- PostgreSQL: strict GROUP BY enforcement
SELECT department, name, MAX(salary)
FROM employees
GROUP BY department;
-- ERROR: column "employees.name" must appear in the GROUP BY clause
-- or be used in an aggregate function
```

**How to detect during validation:** This is primarily a query correctness issue. If validation queries use GROUP BY, ensure they are standards-compliant. Check MySQL's `sql_mode` for `ONLY_FULL_GROUP_BY`.

**How to handle in a diff tool:** Always generate standards-compliant GROUP BY queries. When analyzing MySQL source data produced by loose GROUP BY queries, flag that results may be non-deterministic.

**References:**
- [MySQL GROUP BY handling](https://dev.mysql.com/doc/refman/8.0/en/group-by-handling.html)
- [Hidden Danger of GROUP BY in MySQL](https://programmerzero.medium.com/the-hidden-danger-of-group-by-in-mysql-how-postgresql-saves-you-1cc59c81d899)

---

### 3.8 `MEDIUMINT`, `MEDIUMTEXT`, `MEDIUMBLOB` (No PG Equivalent)

**What happens:** MySQL has `MEDIUMINT` (3 bytes, range -8388608 to 8388607), `MEDIUMTEXT` (up to 16MB), and `MEDIUMBLOB` (up to 16MB). PostgreSQL has no direct equivalents -- `INTEGER` (4 bytes) covers `MEDIUMINT`'s range, `TEXT` covers `MEDIUMTEXT` (up to 1GB), and `BYTEA` covers `MEDIUMBLOB` (up to 1GB).

**How to detect during validation:** During schema comparison, map MySQL-specific types to PostgreSQL equivalents: `MEDIUMINT` -> `INTEGER`, `MEDIUMTEXT` -> `TEXT`, `MEDIUMBLOB` -> `BYTEA`. Values will be compatible; only the schema metadata differs.

**How to handle in a diff tool:** Implement a type mapping table for schema comparison. Report these as equivalent types, not mismatches.

**References:**
- [MySQL BLOB and TEXT Types](https://dev.mysql.com/doc/refman/8.0/en/blob.html)
- [MySQL Workbench: PostgreSQL Type Mapping](https://dev.mysql.com/doc/workbench/en/wb-migration-database-postgresql-typemapping.html)

---

### 3.9 Integer Division Behavior

**What happens:** PostgreSQL performs integer division when both operands are integers: `5 / 2 = 2`. MySQL performs floating-point division even with integer operands: `5 / 2 = 2.5000`. This affects computed columns and validation queries that use division.

**SQL example showing the discrepancy:**

```sql
-- PostgreSQL: integer division
SELECT 5 / 2;
-- 2

-- MySQL: floating-point division
SELECT 5 / 2;
-- 2.5000

-- MySQL integer division requires DIV operator
SELECT 5 DIV 2;
-- 2
```

**How to detect during validation:** If validation queries use division, ensure consistent behavior by explicitly casting to FLOAT/DECIMAL or using the appropriate integer division operator.

**How to handle in a diff tool:** When generating validation queries with division, always cast at least one operand to DECIMAL/FLOAT for consistent results: `CAST(a AS DECIMAL) / b`.

**References:**
- [PostgreSQL Division](https://datacomy.com/sql/postgresql/division/) -- "When dividing two integers... only handles the integer part"

---

### 3.10 Boolean: TRUE = 1, FALSE = 0 (Not Actual Booleans)

**What happens:** MySQL `TRUE` evaluates to `1` and `FALSE` evaluates to `0`. These are integer constants, not a separate boolean type. You can use them in arithmetic: `SELECT TRUE + TRUE` returns `2`. PostgreSQL `TRUE` and `FALSE` are actual boolean values that cannot participate in arithmetic without explicit casting.

**SQL example showing the discrepancy:**

```sql
-- MySQL: booleans are integers
SELECT TRUE + TRUE;
-- 2
SELECT TRUE * 10;
-- 10

-- PostgreSQL: booleans are not integers
SELECT TRUE + TRUE;
-- ERROR: operator does not exist: boolean + boolean
SELECT TRUE::INT + TRUE::INT;
-- 2  (explicit cast required)
```

**How to detect during validation:** When comparing boolean columns, ensure MySQL `1`/`0` maps to PostgreSQL `TRUE`/`FALSE`. Check for non-standard boolean values (2, -1, etc.) in MySQL.

**How to handle in a diff tool:** Implement boolean normalization: MySQL `0` = `FALSE`, MySQL non-zero = `TRUE`. Compare as boolean categories, not raw values.

---

## 4. PostgreSQL <-> DuckDB Gotchas

### 4.1 DuckDB `HUGEINT` (128-bit) -- No PG Equivalent

**What happens:** DuckDB supports `HUGEINT`, a 128-bit signed integer type with range approximately -1.7e38 to 1.7e38. PostgreSQL's largest native integer is `BIGINT` (64-bit). DuckDB also uses `HUGEINT` internally for UUID representation. Values exceeding BIGINT range will overflow or error in PostgreSQL.

**SQL example showing the discrepancy:**

```sql
-- DuckDB: HUGEINT supports massive values
SELECT 170141183460469231731687303715884105727::HUGEINT;
-- 170141183460469231731687303715884105727

-- PostgreSQL: BIGINT maxes out at 9223372036854775807
SELECT 170141183460469231731687303715884105727::BIGINT;
-- ERROR: bigint out of range

-- PostgreSQL: Must use NUMERIC for large integers
SELECT 170141183460469231731687303715884105727::NUMERIC;
-- 170141183460469231731687303715884105727  (works but is NUMERIC, not integer)
```

**How to detect during validation:** Check DuckDB `HUGEINT` columns for values exceeding PostgreSQL's BIGINT range (`> 9223372036854775807` or `< -9223372036854775808`).

**How to handle in a diff tool:** Map DuckDB `HUGEINT` to PostgreSQL `NUMERIC` for comparison. Compare as strings or arbitrary-precision numbers, not as fixed-width integers.

**References:**
- [DuckDB Numeric Types](https://duckdb.org/docs/stable/sql/data_types/numeric) -- "HUGEINT: signed sixteen-byte integer"

---

### 4.2 DuckDB `LIST` vs PostgreSQL `ARRAY`

**What happens:** DuckDB uses `LIST` as its array type (e.g., `LIST(INT)`), while PostgreSQL uses `ARRAY` (e.g., `INT[]`). The syntax for creating and accessing arrays differs. DuckDB uses `list_value()` or `[...]` syntax, PostgreSQL uses `ARRAY[...]` or `'{...}'` syntax. DuckDB `LIST` allows heterogeneous nesting via `UNION` types, while PostgreSQL arrays are strictly homogeneous.

**SQL example showing the discrepancy:**

```sql
-- DuckDB: LIST syntax with brackets
SELECT [1, 2, 3];
-- [1, 2, 3]
SELECT list_value(1, 2, 3);
-- [1, 2, 3]

-- PostgreSQL: ARRAY syntax with curly braces in text form
SELECT ARRAY[1, 2, 3];
-- {1,2,3}
SELECT '{1,2,3}'::INT[];
-- {1,2,3}
```

**How to detect during validation:** Parse array representations from both databases and compare element-by-element. Normalize the different textual representations (`[1,2,3]` vs `{1,2,3}`).

**How to handle in a diff tool:** Implement array parser for both DuckDB list format and PostgreSQL array format. Compare elements positionally after type normalization.

**References:**
- [DuckDB List Type](https://duckdb.org/docs/stable/sql/data_types/list)
- [PostgreSQL Arrays](https://www.postgresql.org/docs/current/arrays.html)

---

### 4.3 DuckDB `:memory:` vs File Mode Connection Behavior

**What happens:** DuckDB in `:memory:` mode creates a fresh database per connection. Data is lost when the connection closes. In file mode, data persists but concurrent write access is limited (single writer at a time). This affects validation tool design: you cannot run parallel validation queries against a `:memory:` DuckDB, and file-mode DuckDB may block concurrent reads during writes.

**How to detect during validation:** Check the DuckDB connection string to determine mode. For `:memory:` databases, ensure all validation happens within a single connection/session.

**How to handle in a diff tool:** Support both modes. For `:memory:`, serialize all validation queries. For file mode, use read-only connections for validation to avoid blocking writes.

---

### 4.4 DuckDB's Liberal Type Coercion

**What happens:** DuckDB performs implicit type coercion more liberally than PostgreSQL, especially in comparisons and set operations. DuckDB will implicitly cast strings to numbers and booleans in equality checks via its "Combination Casting" system, which is designed for interactive querying convenience but diverges from PostgreSQL's strict type checking.

**SQL example showing the discrepancy:**

```sql
-- DuckDB: implicit string-to-number comparison
SELECT '42' = 42;
-- true  (implicit cast)

-- PostgreSQL: strict type checking
SELECT '42' = 42;
-- ERROR: operator does not exist: text = integer

-- PostgreSQL: requires explicit cast
SELECT '42'::INT = 42;
-- true
```

**How to detect during validation:** When generating comparison queries, always use explicit casts. Do not rely on implicit coercion matching between databases.

**How to handle in a diff tool:** Use explicit CAST expressions in all generated SQL. Apply consistent type coercion rules regardless of target database.

**References:**
- [DuckDB PostgreSQL Compatibility](https://duckdb.org/docs/stable/sql/dialect/postgresql_compatibility)
- [DuckDB Typecasting](https://duckdb.org/docs/stable/sql/data_types/typecasting) -- "DuckDB performs Combination Casting... often not compatible with PostgreSQL's behavior"

---

### 4.5 `TIMESTAMP_NS` (Nanosecond) vs `TIMESTAMP` (Microsecond)

**What happens:** DuckDB supports `TIMESTAMP_NS` with nanosecond precision (9 decimal places). PostgreSQL `TIMESTAMP` has microsecond precision (6 decimal places). When reading Parquet files with nanosecond timestamps in DuckDB, the full precision is preserved. Exporting to PostgreSQL loses the last 3 digits of sub-microsecond data.

**SQL example showing the discrepancy:**

```sql
-- DuckDB: nanosecond precision
SELECT TIMESTAMP_NS '2024-01-15 10:30:00.123456789';
-- 2024-01-15 10:30:00.123456789

-- PostgreSQL: microsecond precision (max 6 decimal places)
SELECT '2024-01-15 10:30:00.123456789'::TIMESTAMP;
-- 2024-01-15 10:30:00.123457  (rounded to microseconds!)
```

**How to detect during validation:** Check DuckDB timestamp columns for nanosecond precision (more than 6 decimal places). Compare at microsecond precision by truncating DuckDB values.

**How to handle in a diff tool:** Truncate all timestamps to microsecond precision (6 decimal places) for cross-database comparison. Report precision loss as an informational warning.

**References:**
- [DuckDB Timestamp Types](https://duckdb.org/docs/stable/sql/data_types/timestamp) -- "TIMESTAMP_NS: timestamps with nanosecond precision"

---

### 4.6 CSV/Parquet Type Inference Surprises

**What happens:** DuckDB's CSV reader auto-detects column types by sampling the first 2048 rows by default. If early rows contain integers but later rows contain strings, the inferred type (INT) will cause casting errors. When reading multiple CSV files with glob patterns, empty files or files with empty columns are inferred as VARCHAR, causing schema mismatch errors with other files in the same glob.

**SQL example showing the discrepancy:**

```sql
-- DuckDB: Type inference from CSV can fail mid-file
-- File: data.csv (first 2048 rows have integers, row 3000 has 'N/A')
SELECT * FROM read_csv_auto('data.csv');
-- ERROR: Could not convert string 'N/A' to INT64

-- Fix: Increase sample size or specify types
SELECT * FROM read_csv('data.csv', sample_size=10000);
-- or
SELECT * FROM read_csv('data.csv', columns={'id': 'VARCHAR', 'value': 'VARCHAR'});
```

**How to detect during validation:** When loading data via DuckDB CSV reader, always verify row counts and check for casting errors. Compare schema inferred by DuckDB against the expected schema.

**How to handle in a diff tool:** Specify explicit column types when reading CSV through DuckDB rather than relying on auto-detection. Use large sample sizes or full-file scanning for type inference.

**References:**
- [DuckDB CSV Auto Detection](https://duckdb.org/docs/stable/data/csv/auto_detection) -- "type detection works by operating on a sample of the file"
- [DuckDB CSV Sniffer](https://duckdb.org/2023/10/27/csv-sniffer)
- [DuckDB Issue #14166: Empty rows auto-inferred as VARCHAR](https://github.com/duckdb/duckdb/issues/14166)

---

### 4.7 DuckDB `MAP` Type -- No PG Equivalent

**What happens:** DuckDB has a native `MAP` type for key-value pairs where all keys share one type and all values share one type. PostgreSQL has no direct `MAP` type -- the closest equivalents are `HSTORE` (extension, string-to-string only) or `JSONB` (flexible but different semantics).

**SQL example showing the discrepancy:**

```sql
-- DuckDB: MAP type
SELECT MAP {'key1': 1, 'key2': 2};
-- {key1=1, key2=2}

-- PostgreSQL: No MAP, use HSTORE or JSONB
CREATE EXTENSION IF NOT EXISTS hstore;
SELECT 'key1=>1, key2=>2'::hstore;
-- "key1"=>"1", "key2"=>"2"  (values are always strings!)

SELECT '{"key1": 1, "key2": 2}'::jsonb;
-- {"key1": 1, "key2": 2}  (typed values preserved)
```

**How to detect during validation:** Flag DuckDB MAP columns during schema comparison. Convert to JSONB representation for comparison with PostgreSQL.

**How to handle in a diff tool:** Serialize MAP values to sorted JSON objects for comparison. When comparing with PostgreSQL HSTORE, be aware that HSTORE values are always strings.

**References:**
- [DuckDB MAP Type](https://duckdb.org/docs/stable/sql/data_types/map)

---

### 4.8 DuckDB String Function Subtleties

**What happens:** While DuckDB aims for PostgreSQL compatibility, some string functions have subtle differences. DuckDB's `regexp_matches` returns a list of match groups (similar but not identical to PostgreSQL's set-returning version). DuckDB also provides some functions not in PostgreSQL (e.g., `list_aggregate`, `string_split_regex`). The `||` concatenation operator has the same NULL-propagation as PostgreSQL.

**How to detect during validation:** This primarily affects validation queries rather than data. When writing cross-database validation SQL, test string function behavior on both sides.

**How to handle in a diff tool:** Use the common subset of string functions. Prefer simple operations (`LOWER()`, `UPPER()`, `LENGTH()`, `SUBSTRING()`) that behave identically across both databases.

**References:**
- [DuckDB PostgreSQL Compatibility](https://duckdb.org/docs/stable/sql/dialect/postgresql_compatibility)

---

## 5. Snowflake <-> BigQuery Gotchas

### 5.1 `VARIANT` vs `JSON` vs `STRUCT` -- Different Type Systems

**What happens:** Snowflake uses `VARIANT` as a universal semi-structured container that can hold any JSON value, array, or object. BigQuery has `JSON` (a string-based type with JSON functions), `STRUCT` (typed record with named fields), and `ARRAY` (typed list). The access patterns are fundamentally different: Snowflake uses `:` (colon) notation for first-level object traversal, BigQuery uses dot notation for STRUCTs and function-based access for JSON.

**SQL example showing the discrepancy:**

```sql
-- Snowflake: VARIANT with colon notation
SELECT data:customer:name::STRING
FROM events
WHERE data:customer:age::INT > 30;

-- BigQuery: STRUCT with dot notation
SELECT data.customer.name
FROM events
WHERE data.customer.age > 30;

-- BigQuery: JSON type with function-based access
SELECT JSON_VALUE(data, '$.customer.name')
FROM events
WHERE CAST(JSON_VALUE(data, '$.customer.age') AS INT64) > 30;
```

**How to detect during validation:** When comparing semi-structured data, flatten to scalar values and compare field-by-field. The internal representation will differ, but the logical content should match.

**How to handle in a diff tool:** Implement database-specific JSON/semi-structured data extractors. Normalize to a common intermediate representation (e.g., Python dict) before comparison. Handle type differences in extracted values (Snowflake VARIANT returns VARIANT-typed scalars that need explicit casting).

**References:**
- [Snowflake Querying Semi-structured Data](https://docs.snowflake.com/en/user-guide/querying-semistructured)
- [BigQuery Semi-structured data](https://medium.com/orange-business/mastering-semi-structured-data-in-bigquery-json-vs-structs-arrays-fce63b86b819)

---

### 5.2 `NUMBER(38,0)` vs `INT64` Default Integer Semantics

**What happens:** Snowflake's default integer type is `NUMBER(38,0)` -- a 38-digit decimal with no fractional part. BigQuery's integer type is `INT64` -- a 64-bit signed integer limited to approximately 19 digits. `NUMBER(38,0)` can represent values far larger than `INT64`'s maximum of `9223372036854775807`. If Snowflake stores integers larger than 19 digits, they will not fit in BigQuery `INT64` and must use `NUMERIC` or `BIGNUMERIC`.

**How to detect during validation:** Check Snowflake NUMBER columns for values exceeding INT64 range. Report out-of-range values with specific row identifiers.

**How to handle in a diff tool:** Map Snowflake `NUMBER(38,0)` to BigQuery `INT64` for values within range, or `NUMERIC` for larger values. Compare as strings or arbitrary-precision numbers when values may exceed INT64.

**References:**
- [Snowflake Numeric Data Types](https://docs.snowflake.com/en/sql-reference/data-types-numeric)
- [BigQuery Data Types](https://cloud.google.com/bigquery/docs/reference/standard-sql/data-types)

---

### 5.3 Semi-structured Data Access Notation

**What happens:** Snowflake uses colon (`:`) for the first-level key and dot (`.`) for subsequent levels: `col:key1.key2[0]`. BigQuery uses dot notation for STRUCTs (`col.key1.key2`) and bracket notation or functions for JSON (`JSON_VALUE(col, '$.key1.key2')`). Array access in Snowflake uses `[0]` (0-indexed), BigQuery uses `OFFSET(0)` for 0-indexed or `ORDINAL(1)` for 1-indexed access.

**SQL example showing the discrepancy:**

```sql
-- Snowflake: colon notation, 0-indexed arrays
SELECT data:items[0]:name::STRING FROM orders;

-- BigQuery (STRUCT): dot notation, OFFSET for 0-indexed arrays
SELECT data.items[OFFSET(0)].name FROM orders;

-- BigQuery (JSON): function-based access
SELECT JSON_VALUE(data, '$.items[0].name') FROM orders;
```

**How to detect during validation:** This affects query generation, not data comparison. Ensure the validation tool generates the correct access syntax per database.

**How to handle in a diff tool:** Implement database-specific query generators for semi-structured field access. Use metadata to determine whether BigQuery columns are STRUCT or JSON type.

---

### 5.4 `TIMESTAMP_LTZ` vs BigQuery `TIMESTAMP` (UTC Only)

**What happens:** Snowflake `TIMESTAMP_LTZ` (Local Time Zone) stores UTC internally but displays in the session's timezone. BigQuery `TIMESTAMP` also stores UTC internally but always displays in UTC. When comparing displayed values, the same underlying instant may show different times depending on Snowflake's session timezone.

**SQL example showing the discrepancy:**

```sql
-- Snowflake: TIMESTAMP_LTZ displays in session timezone
ALTER SESSION SET TIMEZONE = 'America/New_York';
SELECT '2024-06-15 12:00:00 UTC'::TIMESTAMP_LTZ;
-- 2024-06-15 08:00:00.000 -0400  (displayed in Eastern time)

-- BigQuery: TIMESTAMP always displays in UTC
SELECT TIMESTAMP '2024-06-15 12:00:00 UTC';
-- 2024-06-15 12:00:00.000000 UTC
```

**How to detect during validation:** Extract UTC epoch values from both databases. Do not compare formatted timestamp strings directly.

**How to handle in a diff tool:** Always use epoch extraction or `CONVERT_TIMEZONE('UTC', ...)` on Snowflake before comparison. Normalize all values to UTC.

**References:**
- [Snowflake Date/Time Data Types](https://docs.snowflake.com/en/sql-reference/data-types-datetime)
- [BigQuery Timestamp Functions](https://cloud.google.com/bigquery/docs/reference/standard-sql/timestamp_functions)

---

### 5.5 `GEOGRAPHY` Type Differences

**What happens:** Both Snowflake and BigQuery support `GEOGRAPHY` types for geospatial data, but with different function libraries, precision characteristics, and geodesic calculation algorithms. Snowflake uses `ST_DISTANCE` (returns meters on a sphere), BigQuery also uses `ST_DISTANCE` (returns meters on a spheroid by default). The different Earth models (sphere vs. spheroid) produce slightly different distance calculations.

**How to detect during validation:** Compare geography values as GeoJSON or WKT text. Distance calculations may differ by small amounts due to different geodesic algorithms.

**How to handle in a diff tool:** Compare GEOGRAPHY values as WKT (Well-Known Text), with configurable coordinate precision tolerance (e.g., 6 decimal places). For distance-derived columns, use a tolerance of a few meters.

---

### 5.6 `QUALIFY` Clause Availability

**What happens:** Both Snowflake and BigQuery support the `QUALIFY` clause for filtering window function results. DuckDB also supports it. However, PostgreSQL, MySQL, and Oracle do not have `QUALIFY`. This matters when the diff tool generates queries that filter on window function results (e.g., finding the latest row per group).

**SQL example:**

```sql
-- Snowflake and BigQuery: QUALIFY supported
SELECT *, ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY order_date DESC) AS rn
FROM orders
QUALIFY rn = 1;

-- PostgreSQL: Must use subquery
SELECT * FROM (
    SELECT *, ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY order_date DESC) AS rn
    FROM orders
) t WHERE rn = 1;
```

**How to handle in a diff tool:** When generating validation SQL, use subqueries for `QUALIFY`-equivalent logic when the target database does not support it. Detect database capabilities and generate appropriate syntax.

---

### 5.7 Clustering vs Partitioning Semantics

**What happens:** Snowflake uses automatic micro-partitioning (users do not define partitions) with optional clustering keys for query optimization. BigQuery requires explicit partition definitions (typically on a DATE/TIMESTAMP column) and optional clustering. This difference does not affect data values but affects how validation queries should be structured for performance -- BigQuery queries without partition filters scan entire tables and incur cost.

**How to handle in a diff tool:** When scanning large tables, use partition-aware query generation for BigQuery (filter by partition column). This is a performance and cost concern, not a correctness concern.

---

### 5.8 External Table Format Differences

**What happens:** Both Snowflake and BigQuery support external tables backed by cloud storage (S3, GCS), but with different format support, metadata handling, and query capabilities. Snowflake external tables use stages and file formats; BigQuery external tables use source URIs and schema auto-detection. Column type inference from Parquet/CSV files may produce different types on each platform.

**How to detect during validation:** When comparing external table data, verify that schema inference produced compatible types on both platforms. Explicitly define schemas rather than relying on auto-detection.

**How to handle in a diff tool:** Treat external table schema mismatches as a separate category from regular table mismatches. Warn about potential type inference differences.

---

### 5.9 JavaScript UDFs (Snowflake) vs SQL/Python UDFs (BigQuery)

**What happens:** Snowflake supports UDFs in SQL, JavaScript, Python, and Java. BigQuery supports UDFs in SQL and JavaScript (with Python in preview). If validation logic requires custom UDFs, the implementation language may need to change between platforms.

**How to handle in a diff tool:** Prefer SQL-based validation logic for maximum portability. If UDFs are needed, implement them in SQL or JavaScript (supported by both platforms). Avoid platform-specific UDF features.

---

## 6. Oracle <-> PostgreSQL Gotchas

### 6.1 Empty String Equals NULL (The Oracle Trap)

**What happens:** Oracle treats empty strings (`''`) as `NULL`. This is the single most impactful gotcha in Oracle-to-PostgreSQL migrations. In PostgreSQL, `''` and `NULL` are entirely different values. This affects comparisons, concatenation, NOT NULL constraints, and COUNT/aggregation behavior. Oracle's `||` operator returns the non-NULL operand when one side is NULL (because NULL = empty string). PostgreSQL's `||` returns NULL when either operand is NULL.

**SQL example showing the discrepancy:**

```sql
-- Oracle: '' IS NULL
SELECT CASE WHEN '' IS NULL THEN 'YES' ELSE 'NO' END FROM DUAL;
-- YES

-- PostgreSQL: '' IS NOT NULL
SELECT CASE WHEN '' IS NULL THEN 'YES' ELSE 'NO' END;
-- NO

-- Oracle: concatenation ignores NULL (since NULL = '')
SELECT 'Hello' || NULL || ' World' FROM DUAL;
-- Hello World

-- PostgreSQL: concatenation with NULL yields NULL
SELECT 'Hello' || NULL || ' World';
-- NULL  (entire expression is NULL!)

-- Oracle: NOT NULL column rejects empty string
CREATE TABLE ora_test (name VARCHAR2(100) NOT NULL);
INSERT INTO ora_test VALUES ('');
-- ORA-01400: cannot insert NULL into ("SCHEMA"."ORA_TEST"."NAME")

-- PostgreSQL: NOT NULL column accepts empty string
CREATE TABLE pg_test (name VARCHAR(100) NOT NULL);
INSERT INTO pg_test VALUES ('');
-- OK (empty string is not NULL)
```

**How to detect during validation:** Count NULLs and empty strings separately on both sides. In Oracle, `SELECT COUNT(*) WHERE col IS NULL` includes empty strings. In PostgreSQL, count `WHERE col IS NULL` and `WHERE col = ''` separately. Their sum should match Oracle's NULL count.

**How to handle in a diff tool:** Provide an `oracle_null_mode: true` configuration that treats empty strings and NULLs as equivalent during comparison. In this mode, both `NULL` and `''` are considered "null" for comparison purposes. Emit a warning showing how many values fall into this ambiguity zone.

**References:**
- [AWS: Handle empty strings migrating Oracle to PostgreSQL](https://aws.amazon.com/blogs/database/handle-empty-strings-when-migrating-from-oracle-to-postgresql/)
- [EDB: NULL and empty strings in PostgreSQL vs Oracle](https://www.enterprisedb.com/postgres-tutorials/how-null-and-empty-strings-are-treated-postgresql-vs-oracle)
- [ABCloudz: Handling null and empty string differences](https://abcloudz.com/blog/handling-null-and-empty-string-differences-in-oracle-and-postgresql/)

---

### 6.2 `VARCHAR2` vs `VARCHAR`

**What happens:** Oracle's `VARCHAR2(n)` measures length in bytes by default (or characters with `VARCHAR2(n CHAR)`). PostgreSQL's `VARCHAR(n)` always measures in characters. A `VARCHAR2(100)` column in Oracle might hold only 25 four-byte UTF-8 characters, while PostgreSQL's `VARCHAR(100)` holds 100 characters regardless of byte length. Oracle `VARCHAR2` has a maximum of 4000 bytes (or 32767 with `MAX_STRING_SIZE = EXTENDED`), while PostgreSQL `VARCHAR` can hold up to approximately 1GB.

**How to detect during validation:** Check for string values that fit Oracle's byte-length limit but may exceed character counts differently in PostgreSQL. In practice, PostgreSQL's limits are always larger, so data loss during migration is unlikely in this direction.

**How to handle in a diff tool:** Compare string values directly. Note length semantics differences in schema comparison reports. Flag `VARCHAR2(n BYTE)` vs `VARCHAR2(n CHAR)` distinction.

**References:**
- [SQLines: Oracle VARCHAR2 to PostgreSQL](https://www.sqlines.com/oracle-to-postgresql/varchar2)
- [Cybertec: Mapping Oracle datatypes to PostgreSQL](https://www.cybertec-postgresql.com/en/mapping-oracle-datatypes-to-postgresql/)

---

### 6.3 `NUMBER` Without Precision

**What happens:** Oracle `NUMBER` without precision or scale can store any numeric value with up to 38 digits of precision -- it is essentially arbitrary-precision. PostgreSQL `NUMERIC` without parameters is also arbitrary-precision. However, the common migration practice of mapping Oracle `NUMBER` to PostgreSQL `DOUBLE PRECISION` (for performance) introduces precision loss for values with more than 15 significant digits, because `DOUBLE PRECISION` is IEEE 754 with only 15-17 significant digits.

**SQL example showing the discrepancy:**

```sql
-- Oracle: NUMBER stores arbitrary precision
SELECT CAST(12345678901234567890.12345 AS NUMBER) FROM DUAL;
-- 12345678901234567890.12345  (full precision)

-- PostgreSQL NUMERIC: Also arbitrary precision (safe mapping)
SELECT 12345678901234567890.12345::NUMERIC;
-- 12345678901234567890.12345

-- PostgreSQL DOUBLE PRECISION: Only ~15 significant digits (unsafe mapping!)
SELECT 12345678901234567890.12345::DOUBLE PRECISION;
-- 12345678901234600000  (precision loss!)
```

**How to detect during validation:** Check for values with more than 15 significant digits in Oracle NUMBER columns. If mapped to DOUBLE PRECISION, these will lose precision.

**How to handle in a diff tool:** Map Oracle `NUMBER` to PostgreSQL `NUMERIC` for comparison, not `DOUBLE PRECISION`. When comparing float values, use epsilon-based comparison with configurable tolerance.

**References:**
- [AWS: Convert NUMBER from Oracle to PostgreSQL Part 1](https://aws.amazon.com/blogs/database/convert-the-number-data-type-from-oracle-to-postgresql-part-1/)
- [AWS: Convert NUMBER from Oracle to PostgreSQL Part 2](https://aws.amazon.com/blogs/database/convert-the-number-data-type-from-oracle-to-postgresql-part-2/)

---

### 6.4 `ROWID`/`ROWNUM` vs `ctid`/`ROW_NUMBER()`

**What happens:** Oracle `ROWID` is a stable physical address of a row that persists across queries and transactions (until the row is physically moved by operations like table reorganization). Oracle `ROWNUM` is a pseudo-column that assigns sequential numbers to result rows during query execution. PostgreSQL `ctid` is the physical row location but is NOT stable -- it changes after `UPDATE` or `VACUUM`. PostgreSQL uses `ROW_NUMBER() OVER()` for sequential numbering.

**SQL example showing the discrepancy:**

```sql
-- Oracle: ROWID is stable across queries
SELECT ROWID, name FROM employees WHERE ROWNUM <= 5;
-- ROWID values persist until physical row movement

-- PostgreSQL: ctid is NOT stable across VACUUM/UPDATE
SELECT ctid, name FROM employees LIMIT 5;
-- ctid may change after UPDATE or VACUUM!

-- PostgreSQL: ROW_NUMBER for sequential numbering
SELECT ROW_NUMBER() OVER () AS rn, name FROM employees LIMIT 5;
```

**How to detect during validation:** Never use physical row identifiers (ROWID, ctid) for cross-database row matching. They are implementation-specific and not comparable.

**How to handle in a diff tool:** Use primary keys or natural keys for row matching. Never reference ROWID or ctid in cross-database comparison logic.

**References:**
- [EDB: Oracle ROWNUM and ROWID to PostgreSQL](https://www.enterprisedb.com/blog/oracle-postgresql-rownum-and-rowid)
- [AWS: Migrate Oracle ROWID to PostgreSQL](https://docs.aws.amazon.com/prescriptive-guidance/latest/patterns/migrate-oracle-rowid-functionality-to-postgresql-on-aws.html)

---

### 6.5 `SYSDATE` vs `NOW()`

**What happens:** Oracle `SYSDATE` returns the operating system's current date and time (server local time) with second precision. It is unaffected by session timezone settings and changes within a transaction (each call returns the actual clock time). PostgreSQL `NOW()` and `CURRENT_TIMESTAMP` return the timestamp at the *start* of the current transaction, not the wall clock time. They do not change within a transaction. `clock_timestamp()` in PostgreSQL returns the actual current time (changes within a transaction), making it the closest equivalent to `SYSDATE`.

**SQL example showing the discrepancy:**

```sql
-- Oracle: SYSDATE changes within a transaction
BEGIN
    INSERT INTO log VALUES (SYSDATE, 'step 1');
    DBMS_LOCK.SLEEP(2);
    INSERT INTO log VALUES (SYSDATE, 'step 2');
END;
-- step 1 and step 2 have DIFFERENT timestamps (2 seconds apart)

-- PostgreSQL: NOW() returns same value throughout transaction
BEGIN;
    INSERT INTO log VALUES (NOW(), 'step 1');
    SELECT pg_sleep(2);
    INSERT INTO log VALUES (NOW(), 'step 2');
COMMIT;
-- step 1 and step 2 have the SAME timestamp!

-- PostgreSQL: clock_timestamp() changes within transaction (like SYSDATE)
BEGIN;
    INSERT INTO log VALUES (clock_timestamp(), 'step 1');
    SELECT pg_sleep(2);
    INSERT INTO log VALUES (clock_timestamp(), 'step 2');
COMMIT;
-- step 1 and step 2 have DIFFERENT timestamps
```

**How to detect during validation:** Timestamps generated by SYSDATE/NOW() will differ depending on transaction boundaries. Do not compare system-generated timestamps across databases.

**How to handle in a diff tool:** Exclude system-generated timestamp columns from validation when values were independently generated on each database. Detect columns named `created_at`, `updated_at`, etc. and offer to skip them.

**References:**
- [AWS: Converting SYSDATE from Oracle to PostgreSQL](https://aws.amazon.com/blogs/database/converting-the-sysdate-function-from-oracle-to-postgresql/)
- [PostgreSQL SYSDATE Equivalent](https://www.commandprompt.com/education/sysdate-equivalent-in-postgresql/)

---

### 6.6 `DUAL` Table

**What happens:** Oracle requires `FROM DUAL` for `SELECT` statements that do not reference a table. PostgreSQL allows `SELECT` without `FROM`. The `DUAL` table does not exist in PostgreSQL by default (though some compatibility layers create it).

```sql
-- Oracle: FROM DUAL required
SELECT 1 + 1 FROM DUAL;
-- PostgreSQL: No FROM needed
SELECT 1 + 1;
```

**How to handle in a diff tool:** Generate database-specific SQL. Omit `FROM DUAL` for PostgreSQL. This is a syntax issue, not a data issue.

**References:**
- [PostgreSQL Wiki: Oracle to Postgres Conversion](https://wiki.postgresql.org/wiki/Oracle_to_Postgres_Conversion)

---

### 6.7 PL/SQL vs PL/pgSQL Exception Handling and Transaction Behavior

**What happens:** In PL/pgSQL, when an exception is caught by an `EXCEPTION` clause, all database changes since the block's `BEGIN` are automatically rolled back (PostgreSQL uses an implicit savepoint). In Oracle PL/SQL, exceptions do NOT automatically roll back the transaction -- only an explicit `ROLLBACK` does. This means stored procedures that handle exceptions may leave different data states in each database.

**SQL example showing the discrepancy:**

```sql
-- Oracle PL/SQL: Exception does NOT rollback prior DML
BEGIN
    INSERT INTO t VALUES (1);  -- This persists even if exception occurs below
    INSERT INTO t VALUES (1/0);  -- Division by zero
EXCEPTION
    WHEN OTHERS THEN
        DBMS_OUTPUT.PUT_LINE('Error caught');
        -- Row with value 1 is STILL inserted!
END;

-- PostgreSQL PL/pgSQL: Exception ROLLS BACK the entire block
BEGIN
    INSERT INTO t VALUES (1);  -- This is rolled back!
    INSERT INTO t VALUES (1/0);  -- Division by zero
EXCEPTION
    WHEN OTHERS THEN
        RAISE NOTICE 'Error caught';
        -- Row with value 1 is NOT inserted (rolled back)
END;
```

**How to detect during validation:** If validation involves stored procedures, be aware that exception handling may leave different data states. Verify data directly rather than relying on procedure semantics.

**How to handle in a diff tool:** Do not call stored procedures as part of validation. Compare data tables directly.

**References:**
- [DEV.to: Exceptions and Commit in PL/pgSQL vs PL/SQL](https://dev.to/aws-heroes/exceptions-and-commit-in-postgresql-plpgsql-vs-oracle-plsql-1nk8)
- [Stormatics: PL/SQL vs PL/pgSQL](https://stormatics.tech/blogs/transitioning-from-oracle-to-postgresql-pl-sql-vs-pl-pgsql)

---

### 6.8 `CONNECT BY` vs Recursive CTEs

**What happens:** Oracle uses proprietary `CONNECT BY PRIOR` syntax for hierarchical queries with built-in pseudo-columns (`LEVEL`, `SYS_CONNECT_BY_PATH`, `CONNECT_BY_ISLEAF`, `CONNECT_BY_ROOT`). PostgreSQL uses standard SQL recursive CTEs (`WITH RECURSIVE`). The result ordering differs: Oracle `CONNECT BY` with `ORDER SIBLINGS BY` has no direct equivalent in recursive CTEs. Each Oracle pseudo-column requires manual implementation in the CTE.

**SQL example showing the discrepancy:**

```sql
-- Oracle: CONNECT BY with built-in pseudo-columns
SELECT LEVEL, employee_id, manager_id, SYS_CONNECT_BY_PATH(name, '/')
FROM employees
START WITH manager_id IS NULL
CONNECT BY PRIOR employee_id = manager_id
ORDER SIBLINGS BY name;

-- PostgreSQL: Recursive CTE (manual LEVEL and PATH)
WITH RECURSIVE emp_tree AS (
    SELECT 1 AS level, employee_id, manager_id, '/' || name AS path
    FROM employees WHERE manager_id IS NULL
    UNION ALL
    SELECT t.level + 1, e.employee_id, e.manager_id, t.path || '/' || e.name
    FROM employees e JOIN emp_tree t ON e.manager_id = t.employee_id
)
SELECT * FROM emp_tree ORDER BY path;
```

**How to detect during validation:** This affects query results, not stored data. If validating hierarchical query results, ensure both queries produce the same logical tree structure.

**How to handle in a diff tool:** Compare hierarchical results as tree structures, not ordered lists. Match by primary key and verify parent-child relationships independently of traversal order.

**References:**
- [EDB: Oracle CONNECT BY to PostgreSQL](https://www.enterprisedb.com/blog/oracle-postgresql-start-withconnect)
- [AWS: Migrate Oracle hierarchical queries](https://aws.amazon.com/blogs/database/migrate-oracle-hierarchical-queries-to-amazon-aurora-postgresql/)

---

### 6.9 `MERGE` Statement Differences

**What happens:** Oracle `MERGE` is a powerful UPSERT statement that can INSERT, UPDATE, and DELETE in a single atomic operation. PostgreSQL traditionally uses `INSERT ... ON CONFLICT DO UPDATE` (since 9.5) and added full `MERGE` support in PostgreSQL 15. Critical difference: PostgreSQL's `ON CONFLICT` increments sequences even for rows that go to the UPDATE path, causing sequence gaps. Oracle's `MERGE` does not advance sequences for UPDATE operations.

**SQL example showing the discrepancy:**

```sql
-- PostgreSQL: ON CONFLICT advances sequence even on UPDATE path
INSERT INTO target (name) VALUES ('test')
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;
-- Sequence is incremented regardless of INSERT or UPDATE path
-- Next INSERT after 100 updates: id might jump by 100

-- Oracle: MERGE does not advance sequence on UPDATE
MERGE INTO target t USING source s ON (t.id = s.id)
WHEN MATCHED THEN UPDATE SET t.name = s.name
WHEN NOT MATCHED THEN INSERT (id, name) VALUES (seq.NEXTVAL, s.name);
-- Sequence only advances for actual INSERTs
```

**How to detect during validation:** After MERGE/UPSERT operations, auto-increment values may differ between databases. Do not compare sequence-generated values.

**How to handle in a diff tool:** Compare data by natural keys, not auto-generated IDs. Skip sequence/identity columns in value comparison.

**References:**
- [Vlad Mihalcea: UPSERT and MERGE across databases](https://vladmihalcea.com/how-do-upsert-and-merge-work-in-oracle-sql-server-postgresql-and-mysql/)
- [PostgreSQL MERGE and Sequences](https://jacobswanner.com/development/2022/postgresql-merge-and-sequences/)

---

### 6.10 Sequence Behavior (Oracle Shared Cache vs PostgreSQL Per-Session Cache)

**What happens:** Oracle sequence caching is shared across all sessions -- all sessions draw from the same pool of cached values. PostgreSQL caches sequences per-session -- each session gets its own independent cache block. After any PostgreSQL shutdown, cached but unused sequence values are permanently lost, creating gaps. Oracle loses cached values only on instance crash (not on normal shutdown), and the shared nature means less overall waste.

**How to detect during validation:** Sequence-generated values will differ between databases. Gaps in sequences are normal for both databases but the size and pattern of gaps differs.

**How to handle in a diff tool:** Never compare sequence-generated values directly across databases. Use natural keys or content-based row matching.

**References:**
- [Sequence Caching: Oracle vs PostgreSQL](https://seiler.us/2018-10-02-sequence-caching-oracle-vs-postgresql/) -- "In Oracle, when a sequence cache is generated, all sessions access the same cache. However in PostgreSQL, each session gets its own cache."
- [AWS: Oracle and PostgreSQL sequences](https://docs.aws.amazon.com/dms/latest/oracle-to-aurora-postgresql-migration-playbook/chap-oracle-aurora-pg.sql.sequences.html)

---

## 7. Cross-Cutting Gotchas (All Database Pairs)

### 7.1 Floating-Point SUM Non-Reproducibility Across Parallel Workers

**What happens:** Floating-point addition is not associative: `(a + b) + c` may not equal `a + (b + c)` due to IEEE 754 rounding. When databases execute `SUM()` across parallel workers, different partitioning of data across workers produces different summation orders, yielding different results. The same query on the same data can return different values on successive runs if the degree of parallelism changes. This is not a bug -- it is inherent to floating-point arithmetic.

**SQL example showing the discrepancy:**

```sql
-- Demonstrating non-associativity of floating-point addition
SELECT (1e20 + -1e20) + 1.0;   -- = 1.0  (correct)
SELECT 1e20 + (-1e20 + 1.0);   -- = 0.0  (1.0 lost to precision!)

-- In practice: SUM(float_col) on a table with millions of rows
-- Run 1 (2 parallel workers): 1234567.890123456
-- Run 2 (4 parallel workers): 1234567.890123457  (last digit differs!)
-- Run on a different database entirely: 1234567.890123455
```

**How to detect during validation:** Compare floating-point SUMs with a relative tolerance (e.g., `|a - b| / max(|a|, |b|) < 1e-9`). Never compare for exact equality.

**How to handle in a diff tool:** Implement configurable floating-point tolerance for aggregate comparisons. Default to relative epsilon of `1e-9`. For exact results, cast to `DECIMAL`/`NUMERIC` before aggregation on both sides. Report the actual difference alongside the tolerance result.

**References:**
- [Reproducible Floating-Point Aggregation in RDBMSs](https://arxiv.org/pdf/1802.09883)
- [Berkeley: Parallel Reproducible Summation](https://aspire.eecs.berkeley.edu/wp/wp-content/uploads/2014/07/Parallel-Reproducible-Summation.pdf)
- [Impacts of floating-point non-associativity on reproducibility](https://arxiv.org/html/2408.05148v3)

---

### 7.2 `ORDER BY` Without Deterministic Tiebreaker

**What happens:** When `ORDER BY` does not uniquely determine row order (i.e., multiple rows have the same value in the sort column), the order of tied rows is implementation-defined and may vary between databases, between runs, and even between different query plans on the same database. Comparing ordered results across databases without a unique tiebreaker will produce false diffs every time ties exist.

**SQL example showing the discrepancy:**

```sql
-- Both databases: Non-deterministic order for tied values
SELECT name, department FROM employees ORDER BY department;
-- Employees A and B both in 'Engineering' -- who comes first?
-- Database 1: A, B  (by internal physical order)
-- Database 2: B, A  (different physical layout)
-- Both are correct per SQL standard

-- Fix: Add tiebreaker that guarantees unique ordering
SELECT name, department FROM employees ORDER BY department, name, employee_id;
```

**How to detect during validation:** Check if ORDER BY columns uniquely identify each row (i.e., form a superkey). If not, the comparison is inherently non-deterministic.

**How to handle in a diff tool:** Always append the primary key to ORDER BY clauses to ensure deterministic ordering. Better yet, use unordered (hash-based, set-based) comparison as the default validation strategy.

---

### 7.3 `DISTINCT` on Floating-Point Columns

**What happens:** `DISTINCT` on floating-point columns may produce unexpected results because values that appear identical when displayed may differ in their binary IEEE 754 representation. For example, `0.1 + 0.2` may not produce the same bits as `0.3`, so `DISTINCT` may consider them as two separate values even though they display the same. This behavior is consistent across databases but can cause row count mismatches when comparing DISTINCT results from different computation paths.

**SQL example showing the discrepancy:**

```sql
-- Floating-point DISTINCT surprise (behavior consistent across databases)
SELECT DISTINCT val FROM (
    SELECT 0.1 + 0.2 AS val
    UNION ALL
    SELECT 0.3 AS val
) t;
-- May return TWO rows if binary representations differ:
-- 0.30000000000000004  (0.1 + 0.2 in IEEE 754)
-- 0.3                  (literal 0.3 in IEEE 754)
```

**How to detect during validation:** When DISTINCT counts differ between databases, check for floating-point columns. Round before DISTINCT to eliminate representation differences.

**How to handle in a diff tool:** Warn when DISTINCT is used on FLOAT/DOUBLE columns. Offer option to round to N decimal places before applying DISTINCT. Default rounding precision: 10 decimal places.

---

### 7.4 `UNION` vs `UNION ALL` Implicit Dedup Behavior

**What happens:** `UNION` performs implicit `DISTINCT`, removing duplicate rows from the combined result set. `UNION ALL` preserves all rows including duplicates. The dedup behavior is standard across all databases, but the performance implications differ. An important subtlety: `UNION`'s dedup treats NULLs as equal to each other (following `DISTINCT` semantics: `NULL IS NOT DISTINCT FROM NULL`), even though `NULL = NULL` evaluates to `NULL` (not TRUE) in normal comparisons.

**How to detect during validation:** This is a query semantics issue. Ensure validation queries use `UNION ALL` unless dedup is explicitly intended. If `UNION` is used, be aware of the NULL-equality semantics.

**How to handle in a diff tool:** Always use `UNION ALL` in generated queries. Implement dedup explicitly if needed, using a deterministic column set.

---

### 7.5 `IN` vs `EXISTS` with NULLs

**What happens:** `NOT IN` with a subquery that returns any NULL value produces an empty result set for ALL rows. This is because `x NOT IN (1, NULL)` evaluates to `x <> 1 AND x <> NULL`, and `x <> NULL` is always `UNKNOWN`, making the entire AND expression `UNKNOWN`. `NOT EXISTS` handles NULLs correctly because it tests for row existence, not value equality. This behavior is consistent across all SQL databases but is one of the most common sources of cross-database validation bugs.

**SQL example showing the discrepancy:**

```sql
-- NOT IN with NULLs: returns NOTHING (unexpected!)
-- Assume table_b has a row where id IS NULL
SELECT * FROM table_a
WHERE id NOT IN (SELECT id FROM table_b);
-- Returns 0 rows, even for table_a rows not in table_b!

-- NOT EXISTS with NULLs: works correctly
SELECT * FROM table_a a
WHERE NOT EXISTS (SELECT 1 FROM table_b b WHERE b.id = a.id);
-- Returns rows from table_a not matched in table_b (correct)
```

**How to detect during validation:** When using `NOT IN` for finding rows present in one database but not the other, check for NULLs in the comparison column. If NULLs exist, `NOT IN` will silently return wrong results.

**How to handle in a diff tool:** Always use `NOT EXISTS` or `LEFT JOIN ... WHERE b.key IS NULL` instead of `NOT IN` for row difference detection. This is universally safer across all databases.

**References:**
- [TechRepublic: NULLs affect IN and EXISTS](https://www.techrepublic.com/article/oracle-tip-understand-how-nulls-affect-in-and-exists/)
- [Stanford CS: Behavior of NULLs in SQL](http://www-cs-students.stanford.edu/~wlam/compsci/sqlnulls)

---

### 7.6 Window Function Frame Defaults

**What happens:** When a window function has an `ORDER BY` clause but no explicit frame specification, the SQL standard default frame is `RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW`. Without `ORDER BY`, the default is `ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING`. The critical subtlety: the default uses `RANGE` (not `ROWS`), and `RANGE CURRENT ROW` includes all *peers* (rows with the same ORDER BY value), not just the current physical row. This means `SUM(...) OVER (ORDER BY col)` computes a "running sum including ties," which produces duplicate intermediate sums for tied values.

**SQL example showing the discrepancy:**

```sql
-- Default RANGE frame: peers get the same running sum
SELECT val, SUM(val) OVER (ORDER BY val) AS running_sum
FROM (VALUES (1), (2), (2), (3)) t(val);
-- val | running_sum
--   1 | 1
--   2 | 5  (includes BOTH 2s because they are RANGE peers)
--   2 | 5  (same -- both peers see sum including all peers)
--   3 | 8

-- Explicit ROWS frame: each physical row is separate
SELECT val, SUM(val) OVER (ORDER BY val ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
FROM (VALUES (1), (2), (2), (3)) t(val);
-- val | running_sum
--   1 | 1
--   2 | 3  (only first 2)
--   2 | 5  (both 2s)
--   3 | 8
```

**How to detect during validation:** This behavior is consistent across databases (it is the SQL standard), but it can produce unexpected results when comparing window function outputs. Always use explicit `ROWS` or `RANGE` to avoid ambiguity.

**How to handle in a diff tool:** Always specify explicit window frames in generated SQL. Default to `ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW` for deterministic, row-by-row behavior.

**References:**
- [MySQL Window Function Frame Specification](https://dev.mysql.com/doc/refman/8.0/en/window-functions-frames.html)
- [Snowflake Window Function Syntax](https://docs.snowflake.com/en/sql-reference/functions-window-syntax)
- [jOOQ: Window Function Frame Clauses](https://www.jooq.org/doc/latest/manual/sql-building/column-expressions/window-functions/window-frame/)

---

### 7.7 String Concatenation with NULL

**What happens:** The behavior of `string || NULL` varies across databases. This is one of the most common cross-database portability issues:

| Database   | `'Hello' \|\| NULL` result | `CONCAT('Hello', NULL)` result |
|-----------|---------------------------|-------------------------------|
| PostgreSQL | `NULL`                    | `Hello`                       |
| Oracle     | `Hello`                   | `Hello`                       |
| MySQL      | N/A (no `\|\|` concat)   | `Hello`                       |
| SQL Server | `NULL` (with `+`)         | `Hello`                       |
| Snowflake  | `NULL`                    | `Hello`                       |
| BigQuery   | N/A                       | `Hello`                       |
| DuckDB     | `NULL`                    | `Hello`                       |

Oracle is the outlier with `||` because Oracle treats NULL as empty string. The `CONCAT()` function treats NULLs as empty strings in most databases.

**How to detect during validation:** When comparing string columns that were constructed via concatenation, check for NULLs in the component columns. Results will differ between Oracle and other databases when using `||`.

**How to handle in a diff tool:** Use `CONCAT()` or `COALESCE(col, '')` for concatenation in generated SQL to ensure consistent NULL handling. When comparing existing data, apply `oracle_null_mode` if source is Oracle.

**References:**
- [Baeldung: Concatenate with NULL Values in SQL](https://www.baeldung.com/sql/concatenate-null)
- [EDB: NULL and empty strings in PostgreSQL vs Oracle](https://www.enterprisedb.com/postgres-tutorials/how-null-and-empty-strings-are-treated-postgresql-vs-oracle)

---

### 7.8 `LIKE` Pattern Escaping

**What happens:** The `LIKE` operator uses `%` and `_` as wildcards. To match literal `%` or `_`, an escape character is needed. The default escape character varies across databases: MySQL uses `\` (backslash) as the default escape character. PostgreSQL, Oracle, Snowflake, and BigQuery have no default escape character -- you must specify one with the `ESCAPE` clause. DuckDB follows PostgreSQL behavior.

**SQL example showing the discrepancy:**

```sql
-- MySQL: backslash is default escape character
SELECT 'abc%def' LIKE 'abc\%def';
-- 1 (true -- backslash escapes the %)

-- PostgreSQL: no default escape character
SELECT 'abc%def' LIKE 'abc\%def';
-- false (backslash is literal, not an escape)

-- PostgreSQL: must use ESCAPE clause explicitly
SELECT 'abc%def' LIKE 'abc!%def' ESCAPE '!';
-- true (! escapes the %)

-- Works on all databases: explicit ESCAPE clause
SELECT col LIKE '%10!%%' ESCAPE '!'
-- Matches strings containing '10%' anywhere
```

**How to detect during validation:** If validation queries use LIKE patterns with literal `%` or `_`, ensure the correct escape syntax for each database.

**How to handle in a diff tool:** Always use the `ESCAPE` clause explicitly when generating LIKE patterns. Use a consistent escape character (e.g., `!`) across all databases.

**References:**
- [SQL wildcard operators and escaping](https://engineering.monstar-lab.com/en/post/2023/04/06/SQL-wildcard-operators-and-how-to-escape-them/)
- [Progress: ESCAPE clause in LIKE operator](https://docs.progress.com/bundle/datadirect-openaccess/page/topics/sqlref/escape-clause-in-like-operator.html)

---

### 7.9 Date Arithmetic Syntax Variations

**What happens:** Adding days/months/intervals to dates uses completely different syntax across databases. There is no standard, portable way to do date arithmetic. Every database has its own preferred function or operator.

| Database   | Add 7 days to a date                               |
|-----------|-----------------------------------------------------|
| PostgreSQL | `date_col + INTERVAL '7 days'`                     |
| MySQL      | `DATE_ADD(date_col, INTERVAL 7 DAY)`               |
| Oracle     | `date_col + 7` (direct integer addition)            |
| Snowflake  | `DATEADD(day, 7, date_col)`                         |
| BigQuery   | `DATE_ADD(date_col, INTERVAL 7 DAY)`               |
| DuckDB     | `date_col + INTERVAL 7 DAY`                         |
| SQL Server | `DATEADD(day, 7, date_col)`                         |

**How to detect during validation:** This affects generated SQL, not stored data. Ensure the validation tool generates correct date arithmetic syntax for each target database.

**How to handle in a diff tool:** Implement database-specific date arithmetic generators. Use a common internal API (e.g., `add_days(col, n)`) that emits the correct SQL per database dialect.

**References:**
- [dbt: DATEADD SQL Function Across Data Warehouses](https://docs.getdbt.com/blog/sql-dateadd) -- "there is no standardized function... each DBMS usually provides custom methods"
- [PostgreSQL Date/Time Functions](https://www.postgresql.org/docs/current/functions-datetime.html)

---

### 7.10 `COALESCE` vs `NVL` vs `IFNULL` vs `ISNULL`

**What happens:** Multiple functions handle NULL substitution across databases, but they have subtly different semantics around type handling and argument count:

| Function     | Databases              | Args | Type behavior                                        |
|-------------|------------------------|------|------------------------------------------------------|
| `COALESCE`  | All (SQL standard)     | N    | Returns type of highest-precedence argument          |
| `NVL`       | Oracle, Snowflake      | 2    | Returns type of first argument                        |
| `IFNULL`    | MySQL, SQLite, BigQuery| 2    | Returns type of first argument                        |
| `ISNULL`    | SQL Server             | 2    | Returns type of first argument (**may truncate!**)   |

The critical trap: SQL Server's `ISNULL` uses the data type and length of the *first* argument. If the first argument is `CHAR(5)` and NULL, the replacement value is silently truncated to 5 characters.

**SQL example showing the discrepancy:**

```sql
-- SQL Server ISNULL: truncates replacement to first arg's type/length
DECLARE @x CHAR(5) = NULL;
SELECT ISNULL(@x, 'this is a long string');
-- 'this '  (truncated to 5 characters!)

-- SQL Standard COALESCE: uses widest compatible type
SELECT COALESCE(CAST(NULL AS CHAR(5)), 'this is a long string');
-- 'this is a long string'  (full string preserved)
```

**How to handle in a diff tool:** Always use `COALESCE` in generated SQL for portability and correctness. When comparing data produced by database-specific NULL functions, be aware of potential type truncation.

**References:**
- [W3Schools: SQL COALESCE/IFNULL/ISNULL/NVL](https://www.w3schools.com/sql/sql_isnull.asp)
- [Joseph Scott: NVL, ISNULL, IFNULL and COALESCE](https://blog.josephscott.org/2006/03/15/nvl-isnull-ifnull-and-coalesce/)

---

### 7.11 `CURRENT_TIMESTAMP` Precision Varies

**What happens:** The precision of `CURRENT_TIMESTAMP` (number of fractional second digits) differs across databases, affecting timestamp comparison:

| Database   | Default precision                | Max precision           |
|-----------|----------------------------------|-------------------------|
| PostgreSQL | Microseconds (6 digits)         | Microseconds (6)        |
| MySQL      | Seconds (0 digits)              | Microseconds (6)        |
| Oracle     | Seconds (SYSDATE) / Nanoseconds (SYSTIMESTAMP) | Nanoseconds (9) |
| Snowflake  | Nanoseconds (9 digits)          | Nanoseconds (9)         |
| BigQuery   | Microseconds (6 digits)         | Microseconds (6)        |
| DuckDB     | Microseconds (6 digits)         | Nanoseconds (9, TIMESTAMP_NS) |
| SQL Server | 3.33ms (~7 digits but not precise) | 100ns (7 digits, datetime2) |

**How to detect during validation:** When comparing timestamps generated independently on each database, expect precision differences. A value of `10:30:45.000000` (PostgreSQL) may correspond to `10:30:45` (MySQL default) or `10:30:45.000000000` (Snowflake).

**How to handle in a diff tool:** Truncate timestamps to the lowest common precision before comparison. Default to seconds for conservative comparison, or microseconds for databases that support it. Make precision configurable.

---

## Appendix A: Quick Reference -- Type Mapping Matrix

| PostgreSQL         | Snowflake          | BigQuery           | MySQL              | DuckDB             | Oracle             |
|--------------------|--------------------|--------------------|--------------------|--------------------|--------------------|
| `SMALLINT`         | `NUMBER(38,0)`     | `INT64`            | `SMALLINT`         | `SMALLINT`         | `NUMBER(5)`        |
| `INTEGER`          | `NUMBER(38,0)`     | `INT64`            | `INT`              | `INTEGER`          | `NUMBER(10)`       |
| `BIGINT`           | `NUMBER(38,0)`     | `INT64`            | `BIGINT`           | `BIGINT`           | `NUMBER(19)`       |
| `NUMERIC`          | `NUMBER(38,0)`(!!) | `NUMERIC(38,9)`    | `DECIMAL`          | `DECIMAL`          | `NUMBER`           |
| `REAL`             | `FLOAT`            | `FLOAT64`          | `FLOAT`            | `FLOAT`            | `BINARY_FLOAT`     |
| `DOUBLE PRECISION` | `FLOAT`            | `FLOAT64`          | `DOUBLE`           | `DOUBLE`           | `BINARY_DOUBLE`    |
| `BOOLEAN`          | `BOOLEAN`          | `BOOL`             | `TINYINT(1)`       | `BOOLEAN`          | `NUMBER(1)` (!)    |
| `TEXT`             | `VARCHAR`          | `STRING`           | `TEXT`/`LONGTEXT`  | `VARCHAR`          | `CLOB`             |
| `VARCHAR(n)`       | `VARCHAR(n)`       | `STRING`           | `VARCHAR(n)`       | `VARCHAR(n)`       | `VARCHAR2(n)`      |
| `CHAR(n)` (padded) | `CHAR(n)` (=VARCHAR)| `STRING`          | `CHAR(n)` (padded) | `VARCHAR(n)`       | `CHAR(n)` (padded) |
| `BYTEA`            | `BINARY`           | `BYTES`            | `BLOB`             | `BLOB`             | `RAW`/`BLOB`       |
| `TIMESTAMPTZ`      | `TIMESTAMP_TZ`     | `TIMESTAMP`        | `TIMESTAMP`        | `TIMESTAMPTZ`      | `TIMESTAMP WITH TZ`|
| `TIMESTAMP`        | `TIMESTAMP_NTZ`    | `DATETIME`         | `DATETIME`         | `TIMESTAMP`        | `TIMESTAMP`        |
| `DATE`             | `DATE`             | `DATE`             | `DATE`             | `DATE`             | `DATE`             |
| `INTERVAL`         | N/A (expression)   | N/A                | N/A                | `INTERVAL`         | `INTERVAL` (PL/SQL)|
| `JSONB`            | `VARIANT`          | `JSON`/`STRING`    | `JSON`             | `JSON` (alias)     | `JSON` (21c+)      |
| `INT[]`            | `ARRAY` (VARIANT)  | `ARRAY<INT64>`     | `JSON` (workaround)| `LIST(INT)`        | `VARRAY`/nested tbl|
| `UUID`             | `VARCHAR`          | `STRING`           | `CHAR(36)`         | `UUID` (HUGEINT)   | `RAW(16)`          |
| N/A                | N/A                | `STRUCT`           | N/A                | `STRUCT`           | N/A                |
| `HSTORE`           | N/A                | N/A                | N/A                | `MAP`              | N/A                |
| N/A                | `NUMBER(38,0)`     | N/A                | `MEDIUMINT`        | `HUGEINT`          | N/A                |

**(!!)** Critical trap: Snowflake `NUMBER` without explicit scale defaults to scale 0, silently truncating all decimal places.

**(!)** Oracle has no native BOOLEAN type (until 23c). `NUMBER(1)` with 0/1 values is the conventional substitute.

---

## Appendix B: Validation Strategy Decision Tree

```
For each column pair (source_col, target_col):

1. Are types equivalent? (use Appendix A mapping matrix)
   NO  -> Report schema mismatch; check if types are compatible
   YES -> Continue

2. Is the column auto-generated? (SERIAL, IDENTITY, AUTOINCREMENT, AUTO_INCREMENT)
   YES -> Skip value comparison; compare row counts only
   NO  -> Continue

3. Is the column type floating-point? (FLOAT, DOUBLE, REAL, FLOAT64)
   YES -> Use epsilon comparison (default: relative_epsilon=1e-9)
   NO  -> Continue

4. Is the column type NUMERIC/DECIMAL?
   YES -> Check scale compatibility:
          - Snowflake NUMBER(38,0) vs PG NUMERIC? -> Warn about truncation
          - BigQuery NUMERIC(38,9)? -> Round PG values to 9 decimal places
          - Oracle NUMBER vs PG DOUBLE PRECISION? -> Warn about precision loss
   NO  -> Continue

5. Is the column type TIMESTAMP/TIMESTAMPTZ?
   YES -> Normalize to UTC epoch for comparison
          - Check precision compatibility (truncate to common precision)
          - Snowflake TIMESTAMP_TZ: extract UTC, ignore stored offset
          - BigQuery TIMESTAMP: already UTC, compare directly
   NO  -> Continue

6. Is the column type CHAR (fixed-width)?
   YES -> RTRIM both sides before comparison
   NO  -> Continue

7. Is the column type JSON/VARIANT/JSONB?
   YES -> Parse and compare structurally (ignore key order)
   NO  -> Continue

8. Is the column type ARRAY/LIST/REPEATED?
   YES -> Compare element-by-element with type normalization
          - BigQuery: check for NULL elements (disallowed)
          - Snowflake: VARIANT elements need type coercion
   NO  -> Continue

9. Is the column type BINARY/BYTEA/BLOB/BYTES?
   YES -> Normalize hex representation (strip \x prefix, normalize case)
   NO  -> Continue

10. Is the column type BOOLEAN?
    YES -> Normalize: 0/FALSE/false -> FALSE, non-zero/TRUE/true -> TRUE
    NO  -> Continue

11. Is source Oracle and column is VARCHAR/CHAR?
    YES -> Apply oracle_null_mode (treat '' and NULL as equivalent)
    NO  -> Continue

12. Default: Compare values with exact string/numeric equality
```

---

## Appendix C: Common False Positive Patterns and Mitigations

| False Positive Pattern | Root Cause | Mitigation |
|----------------------|------------|------------|
| Timestamp strings differ but values match | Different timezone display settings | Compare as UTC epoch |
| NUMERIC values differ by small amounts | Scale truncation (SF) or rounding (BQ) | Tolerance-based comparison |
| JSON strings differ | Different key ordering | Parse and compare structurally |
| CHAR columns have trailing space differences | Padding semantics differ | RTRIM before comparison |
| Binary hex strings differ | `\x` prefix and case differences | Normalize hex representation |
| Row order differs | Non-deterministic ORDER BY (ties) | Add PK tiebreaker or use unordered comparison |
| Boolean values differ | TRUE/FALSE vs 1/0 representation | Normalize to boolean categories |
| NULL counts differ (Oracle source) | Oracle `'' = NULL` conflation | Enable oracle_null_mode |
| Aggregate float sums differ slightly | IEEE 754 non-associativity in parallel exec | Relative tolerance comparison |
| Auto-increment IDs differ | Different sequence generation strategies | Skip auto-increment columns |
| Column names case differs | PG lowercases, SF uppercases, BQ preserves | Case-insensitive identifier matching |
| Array values differ | NULL elements in PG arrays but not BQ | Filter NULLs or report as expected |
| Date values fail validation | Out-of-range dates (PG allows 4713 BC, BQ requires >= 0001) | Pre-filter date ranges |
| ENUM values differ | MySQL error empty strings (index 0) | Validate enum membership |
| Division results differ | PG integer division vs MySQL float division | Explicit CAST in queries |
| Concatenated strings differ | NULL propagation in `\|\|` operator | Use COALESCE or CONCAT() |

---

## Appendix D: Sources and Further Reading

### Official Documentation
- [PostgreSQL Data Types](https://www.postgresql.org/docs/current/datatype.html)
- [Snowflake Data Types](https://docs.snowflake.com/en/sql-reference/data-types)
- [BigQuery Data Types](https://cloud.google.com/bigquery/docs/reference/standard-sql/data-types)
- [MySQL Data Types](https://dev.mysql.com/doc/refman/8.0/en/data-types.html)
- [DuckDB Data Types](https://duckdb.org/docs/stable/sql/data_types/overview)
- [Oracle Data Types](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/Data-Types.html)

### Migration Guides
- [AWS: Oracle to Aurora PostgreSQL Migration Playbook](https://docs.aws.amazon.com/dms/latest/oracle-to-aurora-postgresql-migration-playbook/)
- [Google Cloud: Snowflake SQL Translation Guide](https://cloud.google.com/bigquery/docs/migration/snowflake-sql)
- [EDB: Porting between Oracle and PostgreSQL](https://www.enterprisedb.com/postgres-tutorials/porting-between-oracle-and-postgresql)
- [PostgreSQL Wiki: Oracle to Postgres Conversion](https://wiki.postgresql.org/wiki/Oracle_to_Postgres_Conversion)
- [DuckDB: PostgreSQL Compatibility](https://duckdb.org/docs/stable/sql/dialect/postgresql_compatibility)
- [Snowflake SnowConvert: PostgreSQL String Comparison](https://docs.snowflake.com/en/migrations/snowconvert-docs/translation-references/postgres/postgresql-string-comparison)

### Research Papers
- [Reproducible Floating-Point Aggregation in RDBMSs (Bosshard et al., 2018)](https://arxiv.org/pdf/1802.09883)
- [Impacts of floating-point non-associativity on reproducibility (2024)](https://arxiv.org/html/2408.05148v3)
- [Parallel Reproducible Summation (UC Berkeley)](https://aspire.eecs.berkeley.edu/wp/wp-content/uploads/2014/07/Parallel-Reproducible-Summation.pdf)

### Bug Reports and Known Issues
- [MySQL Bug #12654: 64-bit unix timestamp not supported](https://bugs.mysql.com/bug.php?id=12654)
- [MySQL Bug #57298: ENUMs do not obey strict sql_mode](https://bugs.mysql.com/bug.php?id=57298)
- [MySQL WL#1872: Extend TIMESTAMP beyond 2038](https://dev.mysql.com/worklog/task/?id=1872)
- [DuckDB Issue #14166: Empty rows auto-inferred as VARCHAR](https://github.com/duckdb/duckdb/issues/14166)
- [DuckDB Issue #15076: Empty column inferred as VARCHAR](https://github.com/duckdb/duckdb/issues/15076)
- [DuckDB Issue #2752: Improper casting from parquet map](https://github.com/duckdb/duckdb/issues/2752)
- [DuckDB Issue #15512: Timestamps rough around the edges](https://github.com/duckdb/duckdb/issues/15512)
