# Theme Z: Cross-Database Numeric, String & Encoding Semantics

## Executive Summary

Data validation across heterogeneous databases is fundamentally a problem of **semantic translation**. The same logical concept — a number, a string, a timestamp, a null — can have radically different physical representations, comparison rules, and edge-case behaviors depending on which database engine stores it. A cross-database validation engine like Reladiff must contend with dozens of subtle incompatibilities that can turn a simple "are these two tables the same?" into a minefield of false positives and false negatives.

This document is an exhaustive catalog of every known semantic difference in numeric, string, encoding, NULL, temporal, boolean, JSON, binary, and complex type handling across the six databases Reladiff supports: **DuckDB, PostgreSQL, Snowflake, BigQuery, Databricks, and MySQL**. For each category, we provide concrete SQL examples demonstrating the differences, comparison tables per database, real-world war stories from production systems, and practical mitigation strategies for a validation engine.

The core thesis: **there is no "correct" behavior — only the behavior of each specific database**. A validation engine must either normalize to a canonical representation before comparison, or expose configurable tolerance and comparison modes that account for these differences.

---

## Table of Contents

1. [Numeric Precision Nightmares](#1-numeric-precision-nightmares)
2. [String Comparison Gotchas](#2-string-comparison-gotchas)
3. [Character Encoding Issues](#3-character-encoding-issues)
4. [NULL Semantics Variations](#4-null-semantics-variations)
5. [Date/Time Semantic Differences](#5-datetime-semantic-differences)
6. [Boolean Representation](#6-boolean-representation)
7. [JSON/Semi-Structured Data](#7-jsonsemi-structured-data)
8. [Binary Data](#8-binary-data)
9. [Array and Complex Types](#9-array-and-complex-types)
10. [Practical Mitigation Strategies](#10-practical-mitigation-strategies)

---

## 1. Numeric Precision Nightmares

### 1.1 IEEE 754: The Fundamental Problem

Every database that supports floating-point numbers inherits the fundamental limitation of IEEE 754 binary floating-point: **decimal fractions cannot be exactly represented in binary**. The canonical example:

```sql
-- PostgreSQL
SELECT 0.1::double precision + 0.2::double precision = 0.3::double precision;
-- Result: false

SELECT 0.1::double precision + 0.2::double precision;
-- Result: 0.30000000000000004

-- DuckDB
SELECT 0.1::DOUBLE + 0.2::DOUBLE;
-- Result: 0.30000000000000004

-- Snowflake
SELECT 0.1::DOUBLE + 0.2::DOUBLE;
-- Result: 0.30000000000000004

-- MySQL
SELECT 0.1e0 + 0.2e0;
-- Result: 0.30000000000000004
```

The number 0.1 in binary is a repeating fraction (like 1/3 in decimal). IEEE 754 double precision provides approximately 15-17 significant decimal digits of precision. The stored value for 0.1 is actually `0.1000000000000000055511151231257827021181583404541015625`.

**Reladiff Implication**: Any hash-based comparison (HashDiff) that operates on the raw floating-point representation will detect differences between databases even when the *intended* values are identical. A tolerance-based comparison is essential for float columns.

#### The Epsilon Problem

Different databases have different internal floating-point representations for the *same* decimal input:

```sql
-- PostgreSQL: double precision
SELECT '0.1'::double precision::text;
-- Result: '0.1' (display rounded, but stored as binary approximation)

-- BigQuery
SELECT CAST(0.1 AS FLOAT64);
-- Result: 0.1 (display rounded)

-- The actual stored bytes may differ slightly between implementations
-- even though both follow IEEE 754, because of compiler/platform differences
```

### 1.2 DECIMAL vs NUMERIC vs FLOAT vs DOUBLE vs REAL — Per-Database Semantics

The naming of numeric types is one of the most confusing areas in SQL. The same name means different things in different databases.

#### Type Mapping Table

| Type Name | PostgreSQL | Snowflake | BigQuery | MySQL | DuckDB | Databricks |
|-----------|-----------|-----------|----------|-------|--------|------------|
| `NUMERIC` | Exact, arbitrary precision | Synonym for `NUMBER`, exact, up to 38 digits | Fixed-point, 29 digits + 9 decimal (NUMERIC), or 38+38 (BIGNUMERIC) | Synonym for `DECIMAL`, exact | Exact, arbitrary precision | Synonym for `DECIMAL` |
| `DECIMAL` | Synonym for `NUMERIC` | Synonym for `NUMBER` | Synonym for `NUMERIC` | Exact, up to 65 digits | Synonym for `NUMERIC` | Exact, up to 38 digits |
| `FLOAT` | 4-byte IEEE 754 (alias: `REAL`) | 8-byte IEEE 754 double | 8-byte IEEE 754 (`FLOAT64`) | 4-byte IEEE 754 | 4-byte IEEE 754 | 4-byte IEEE 754 |
| `DOUBLE` | 8-byte IEEE 754 (`DOUBLE PRECISION`) | Synonym for `FLOAT` (always 8-byte!) | Synonym for `FLOAT64` | 8-byte IEEE 754 | 8-byte IEEE 754 | 8-byte IEEE 754 |
| `REAL` | 4-byte IEEE 754 | Not supported | Not supported | Synonym for `DOUBLE` (!) | 4-byte IEEE 754 | Not supported |
| `INT` / `INTEGER` | 4-byte signed (-2^31 to 2^31-1) | Synonym for `NUMBER(38,0)` | 8-byte signed (`INT64`) | 4-byte signed | 4-byte signed | 4-byte signed |
| `BIGINT` | 8-byte signed | Synonym for `NUMBER(38,0)` | Not a type (use `INT64`) | 8-byte signed | 8-byte signed | 8-byte signed |
| `HUGEINT` | Not supported | Not supported | Not supported | Not supported | 16-byte signed (INT128) | Not supported |

**Critical Traps:**

1. **Snowflake's FLOAT is always DOUBLE**: Unlike PostgreSQL where `FLOAT` is 4-byte and `DOUBLE PRECISION` is 8-byte, Snowflake's `FLOAT` is always 8-byte double precision. This means migrating a table schema from PostgreSQL to Snowflake can *silently increase precision*.

2. **MySQL's REAL is DOUBLE**: In MySQL, `REAL` is a synonym for `DOUBLE`, not `FLOAT`. This is the opposite of PostgreSQL where `REAL` = `FLOAT` (4-byte).

3. **Snowflake's INTEGER is NUMBER(38,0)**: Snowflake stores all integers as `NUMBER(38,0)`, which is a 128-bit fixed-point number. A PostgreSQL `INTEGER` is 4 bytes. Comparing hash values across these is guaranteed to differ in representation.

4. **BigQuery has only INT64**: There is no 32-bit integer in BigQuery. Everything is 64-bit. This means an `INT` column from PostgreSQL or MySQL maps to `INT64` in BigQuery, which changes the byte representation.

### 1.3 Snowflake NUMBER(38,0) vs PostgreSQL NUMERIC vs BigQuery NUMERIC(29,9)

Each database has a different "default" numeric type with different precision and scale:

```sql
-- PostgreSQL: NUMERIC without precision/scale is arbitrary precision
CREATE TABLE pg_test (val NUMERIC);
INSERT INTO pg_test VALUES (123456789012345678901234567890.123456789);
SELECT val FROM pg_test;
-- Result: 123456789012345678901234567890.123456789 (all digits preserved)

-- Snowflake: NUMBER without precision/scale defaults to NUMBER(38,0)
CREATE TABLE sf_test (val NUMBER);
INSERT INTO sf_test VALUES (123456789012345678901234567890.123456789);
SELECT val FROM sf_test;
-- Result: 123456789012345678901234567890 (decimal part TRUNCATED!)

-- BigQuery: NUMERIC is NUMERIC(29,9) — 29 digits before decimal, 9 after
SELECT CAST(123456789012345678901234567890.123456789 AS NUMERIC);
-- Error: NUMERIC overflow (exceeds 29 pre-decimal digits)

-- BigQuery: BIGNUMERIC is NUMERIC(38,38) — 38 digits total, up to 38 decimal
SELECT CAST(12345678901234567890.123456789012345678 AS BIGNUMERIC);
-- Result: 12345678901234567890.123456789012345678
```

**Precision Capacity Comparison:**

| Database | Default Numeric | Max Precision | Max Scale | Storage |
|----------|----------------|---------------|-----------|---------|
| PostgreSQL | NUMERIC (unbounded) | 131,072 digits before decimal | 16,383 after decimal | Variable |
| Snowflake | NUMBER(38,0) | 38 digits total | 37 | Compressed, precision-independent |
| BigQuery | NUMERIC(29,9) | 29+9=38 digits | 9 | 16 bytes |
| BigQuery | BIGNUMERIC(38,38) | 76 digits total | 38 | 32 bytes |
| MySQL | DECIMAL(10,0) default | 65 digits | 30 | Variable |
| DuckDB | DECIMAL(18,3) default | 38 digits | 38 | 2/4/8/16 bytes |
| Databricks | DECIMAL(10,0) default | 38 digits | 38 | Variable |

**Real-World War Story — PostgreSQL to Snowflake Migration:**

A documented migration issue from Venkat Ithakota's experience: When migrating from PostgreSQL (default NUMERIC precision 19,0) to Snowflake (default NUMBER 38,0), the difference in default precision caused rounding of values in tables. The solution was to explicitly use `DECIMAL(19,0)` in Snowflake to match the PostgreSQL source.

Another war story from the data-diff GitHub issues (Issue #379): Users reported diffs when comparing float columns between PostgreSQL and Snowflake. PostgreSQL's `double precision` has float precision of 13 significant digits, while Snowflake's `FLOAT` (which is actually double precision) can show different trailing digits for the same source value due to different parsing and formatting implementations.

### 1.4 MySQL FLOAT(M,D) — Deprecation and Silent Truncation

MySQL's `FLOAT(M,D)` syntax (where M is total digits and D is decimal places) is a nonstandard extension that has been **deprecated since MySQL 8.0.17**:

```sql
-- MySQL (deprecated syntax)
CREATE TABLE float_test (val FLOAT(7,4));
INSERT INTO float_test VALUES (999.00009);
SELECT val FROM float_test;
-- Result: 999.0001 (silently rounded!)

-- Even worse with high scale values:
CREATE TABLE float_bad (val FLOAT(10,30));
INSERT INTO float_bad VALUES (123.456);
-- Warning: Data truncated; out of range for column 'val'
-- Value clamped to +10 or -10 (!!)
```

**The Silent Truncation Problem**: In non-strict SQL mode (the MySQL default for many years), inserting a value that exceeds the specified precision generates only a warning, not an error. Applications that don't check warnings will silently lose data. This is a documented MySQL bug (#7361) that has existed for decades.

**Reladiff Implication**: When comparing a MySQL source with `FLOAT(M,D)` columns against another database, the MySQL side may have already lost precision before the comparison even begins. Reladiff should warn users about deprecated `FLOAT(M,D)` columns in MySQL sources.

### 1.5 Financial Calculations: DECIMAL(19,4) and Banker's Rounding

The standard recommendation for storing monetary values is `DECIMAL(19,4)`:
- 19 total digits can hold values up to 999,999,999,999,999.9999
- 4 decimal places handle sub-cent calculations (useful for tax, interest, FX rates)
- The SQL standard's `DECIMAL` type guarantees exact arithmetic

However, **rounding behavior differs across databases**:

```sql
-- PostgreSQL: NUMERIC rounds ties AWAY FROM ZERO
SELECT ROUND(2.5::numeric);  -- Result: 3
SELECT ROUND(3.5::numeric);  -- Result: 4
SELECT ROUND(-2.5::numeric); -- Result: -3

-- PostgreSQL: DOUBLE PRECISION rounds ties TO NEAREST EVEN (banker's rounding)
SELECT ROUND(2.5::double precision);  -- Result: 2
SELECT ROUND(3.5::double precision);  -- Result: 4
SELECT ROUND(-2.5::double precision); -- Result: -2

-- Snowflake: Default is HALF_AWAY_FROM_ZERO for decimals
SELECT ROUND(2.5);  -- Result: 3
SELECT ROUND(3.5);  -- Result: 4

-- Snowflake: Supports banker's rounding via parameter
SELECT ROUND(2.5, 0, 'HALF_TO_EVEN');  -- Result: 2
SELECT ROUND(3.5, 0, 'HALF_TO_EVEN');  -- Result: 4

-- MySQL: Uses ROUND HALF AWAY FROM ZERO for exact types
SELECT ROUND(2.5);  -- Result: 3
SELECT ROUND(3.5);  -- Result: 4

-- BigQuery: ROUND_HALF_EVEN available for parameterized NUMERIC
SELECT ROUND(2.5);  -- Result: 3 (default: half away from zero)
```

**Rounding Behavior Comparison:**

| Database | NUMERIC/DECIMAL Rounding | FLOAT/DOUBLE Rounding |
|----------|-------------------------|----------------------|
| PostgreSQL | Half away from zero | Half to even (platform-dependent) |
| Snowflake | Half away from zero (configurable) | Half to even |
| BigQuery | Half away from zero (configurable) | Half to even |
| MySQL | Half away from zero | Platform-dependent |
| DuckDB | Half away from zero | Half to even |
| Databricks | Half to even | Half to even |

**Reladiff Implication**: When comparing aggregated or computed values across databases, rounding differences can cause legitimate discrepancies. For example, computing `ROUND(SUM(price * quantity), 2)` across a million rows can yield different totals due to rounding at each intermediate step. Reladiff should allow configurable rounding tolerance for financial comparisons.

### 1.6 Integer Overflow: INT32 vs INT64 vs INT128

Integer range differences create silent data corruption during cross-database operations:

| Type | Range | Databases |
|------|-------|-----------|
| INT16 (SMALLINT) | -32,768 to 32,767 | All |
| INT32 (INTEGER) | -2,147,483,648 to 2,147,483,647 | PG, MySQL, DuckDB, Databricks |
| INT64 (BIGINT) | -9.2×10^18 to 9.2×10^18 | All |
| INT128 (HUGEINT) | -1.7×10^38 to 1.7×10^38 | DuckDB only |
| NUMBER(38,0) | -10^38 to 10^38 | Snowflake (all integer types) |

```sql
-- DuckDB: HUGEINT can hold values impossible in other databases
SELECT 170141183460469231731687303715884105727::HUGEINT;
-- This value overflows INT64

-- BigQuery: Only has INT64, this value would fail
SELECT CAST(170141183460469231731687303715884105727 AS INT64);
-- Error: INT64 overflow

-- Snowflake: NUMBER(38,0) can hold it
SELECT 170141183460469231731687303715884105727::NUMBER(38,0);
-- Works fine
```

**Overflow Behavior:**

| Database | Overflow Behavior |
|----------|------------------|
| PostgreSQL | Error: integer out of range |
| Snowflake | Error: numeric value out of range |
| BigQuery | Error: INT64 overflow |
| MySQL (strict mode) | Error: Out of range |
| MySQL (non-strict) | **Silently clamps to max/min value!** |
| DuckDB | Error: overflow |
| Databricks | Wraps around (Java-style overflow) |

**MySQL Non-Strict Mode Horror Story**: In non-strict SQL mode, MySQL silently clamps overflowing integers to the column's maximum value. Inserting `3000000000` into an `INT` column (max 2,147,483,647) silently stores `2147483647`. This was the default behavior for many MySQL versions and is a notorious source of data corruption.

### 1.7 Division Behavior: Integer vs Float Division

One of the most insidious cross-database differences is how the `/` operator handles integer operands:

```sql
-- PostgreSQL: Integer division returns integer (truncates)
SELECT 5 / 2;           -- Result: 2 (not 2.5!)
SELECT 7 / 3;           -- Result: 2
SELECT -7 / 2;          -- Result: -3 (truncates toward zero)

-- MySQL: Division always returns float
SELECT 5 / 2;           -- Result: 2.5000
SELECT 7 / 3;           -- Result: 2.3333

-- Snowflake: Division always returns float
SELECT 5 / 2;           -- Result: 2.500000
SELECT 7 / 3;           -- Result: 2.333333

-- BigQuery: Division always returns float
SELECT 5 / 2;           -- Result: 2.5
SELECT 7 / 3;           -- Result: 2.3333333333333335

-- DuckDB: Integer division returns integer (like PostgreSQL)
SELECT 5 / 2;           -- Result: 2
SELECT 7 / 3;           -- Result: 2

-- Databricks: Integer division returns integer
SELECT 5 / 2;           -- Result: 2
```

**Division Behavior Summary:**

| Database | `5/2` Result | Type of Result | Division by Zero |
|----------|-------------|----------------|-----------------|
| PostgreSQL | 2 | INTEGER | Error |
| MySQL | 2.5000 | DOUBLE | NULL |
| Snowflake | 2.500000 | DECIMAL | Error (use `DIV0` for 0, `DIV0NULL` for NULL) |
| BigQuery | 2.5 | FLOAT64 | Error |
| DuckDB | 2 | INTEGER | Error (IEEE 754 for floats: Inf) |
| Databricks | 2 | INTEGER | NULL |

**Division by Zero — A Special Mess:**

```sql
-- PostgreSQL: ERROR
SELECT 1 / 0;  -- ERROR: division by zero

-- MySQL: Returns NULL
SELECT 1 / 0;  -- Result: NULL

-- Snowflake: ERROR (but has helper functions)
SELECT 1 / 0;          -- ERROR: Division by zero
SELECT DIV0(1, 0);     -- Result: 0
SELECT DIV0NULL(1, 0); -- Result: 0

-- DuckDB: ERROR for integers, Infinity for floats
SELECT 1 / 0;              -- ERROR: division by zero
SELECT 1.0 / 0.0;          -- Result: Infinity (IEEE 754)

-- BigQuery: ERROR
SELECT 1 / 0;  -- ERROR: division by zero
```

### 1.8 NaN, Infinity, -0.0 Handling

IEEE 754 defines special values that databases handle very differently:

```sql
-- PostgreSQL: Full support for NaN, Infinity, -Infinity
SELECT 'NaN'::double precision;           -- NaN
SELECT 'Infinity'::double precision;      -- Infinity
SELECT '-Infinity'::double precision;     -- -Infinity
SELECT 'NaN'::numeric;                    -- NaN (numeric also supports it!)

-- PostgreSQL NaN comparison (nonstandard but useful):
SELECT 'NaN'::double precision = 'NaN'::double precision;  -- true (!)
SELECT 'NaN'::double precision > 1000000;                   -- true (!)
-- PostgreSQL treats NaN as EQUAL to NaN and GREATER than all non-NaN values

-- DuckDB: IEEE 754 special values supported
SELECT 1.0 / 0.0;      -- Infinity
SELECT -1.0 / 0.0;     -- -Infinity
SELECT 0.0 / 0.0;      -- NaN
-- DuckDB also treats NaN = NaN as true (deviation from IEEE 754)

-- Snowflake: Does NOT support NaN or Infinity for FLOAT
SELECT 'NaN'::FLOAT;       -- Error
SELECT 'Infinity'::FLOAT;  -- Error
-- Division by zero is an error, not Infinity

-- BigQuery: Limited support
SELECT IEEE_DIVIDE(0, 0);     -- NaN
SELECT IEEE_DIVIDE(1, 0);     -- Infinity
SELECT IEEE_DIVIDE(-1, 0);    -- -Infinity
-- But CAST('NaN' AS FLOAT64) works

-- MySQL: No support for NaN or Infinity as values
SELECT 'NaN' + 0;  -- Result: 0 (string to number conversion)
```

**Special Value Support Matrix:**

| Feature | PostgreSQL | Snowflake | BigQuery | MySQL | DuckDB | Databricks |
|---------|-----------|-----------|----------|-------|--------|------------|
| NaN in FLOAT | Yes | No | Yes | No | Yes | Yes |
| Infinity in FLOAT | Yes | No | Yes | No | Yes | Yes |
| NaN in NUMERIC | Yes | No | No | No | No | No |
| NaN = NaN | true | N/A | true | N/A | true | true |
| NaN > any number | true | N/A | true | N/A | true | true |
| -0.0 = +0.0 | true | N/A | true | true | true | true |

**Reladiff Implication**: When comparing columns that might contain NaN or Infinity, Reladiff must handle the case where one database supports these values and another doesn't. A PostgreSQL column might contain `NaN` rows that have no equivalent representation in Snowflake.

### 1.9 The PostgreSQL MONEY Type — Why It's Harmful

PostgreSQL's `MONEY` type is widely considered an anti-pattern:

```sql
-- PostgreSQL MONEY type problems

-- 1. Locale-dependent formatting
SET lc_monetary = 'en_US.UTF-8';
SELECT '1234.56'::money;  -- Result: $1,234.56

SET lc_monetary = 'de_DE.UTF-8';
SELECT '1234.56'::money;  -- Result: 1.234,56 €

-- 2. Division truncation
SELECT '10.00'::money / 3;
-- Result: $3.33 (not $3.3333... — truncated, not rounded!)

-- 3. Cannot multiply two money values
SELECT '10.00'::money * '2.00'::money;
-- ERROR: operator does not exist: money * money

-- 4. Portability disaster
-- Dumping a database with MONEY columns in one locale
-- and restoring in another locale will corrupt the data
```

**The Expert Consensus**: Use `NUMERIC(19,4)` or `NUMERIC(15,2)` instead of `MONEY`. The `MONEY` type cannot handle fractional cents, its formatting depends on server locale settings (making dumps/restores locale-sensitive), and its division behavior silently truncates rather than rounding.

**Reladiff Implication**: If Reladiff encounters a `MONEY` column in PostgreSQL, it should cast to `NUMERIC` before comparison and warn the user about locale sensitivity.

---

## 2. String Comparison Gotchas

### 2.1 Collation Differences

String comparison behavior is governed by **collation** — the rules for ordering and equality of characters. Different databases have radically different defaults:

```sql
-- MySQL: Default collation is case-insensitive (utf8mb4_0900_ai_ci or utf8_general_ci)
SELECT 'Hello' = 'hello';  -- Result: 1 (true!)
SELECT 'café' = 'cafe';    -- Result: 1 (true! accent-insensitive with _ai_ collation)

-- PostgreSQL: Default collation is OS-dependent, typically case-sensitive
SELECT 'Hello' = 'hello';  -- Result: false
SELECT 'café' = 'cafe';    -- Result: false

-- Snowflake: Case-sensitive by default for string comparisons
SELECT 'Hello' = 'hello';  -- Result: false
-- But identifiers (table/column names) are case-INSENSITIVE by default!

-- BigQuery: Case-sensitive by default
SELECT 'Hello' = 'hello';  -- Result: false

-- DuckDB: Case-sensitive by default (C locale)
SELECT 'Hello' = 'hello';  -- Result: false
```

**Collation Default Summary:**

| Database | Default String Comparison | Case-Sensitive | Accent-Sensitive | Configurable |
|----------|--------------------------|----------------|-------------------|-------------|
| PostgreSQL | OS locale (typically C or en_US) | Yes | Yes | Per column, per query |
| MySQL | utf8mb4_0900_ai_ci (8.0+) | **No** | **No** | Per column, per table, per query |
| Snowflake | Binary (case-sensitive) | Yes | Yes | Per query (COLLATE function) |
| BigQuery | Binary (case-sensitive) | Yes | Yes | Not configurable |
| DuckDB | C locale | Yes | Yes | Limited |
| Databricks | Binary | Yes | Yes | Limited |

**The MySQL Trap**: MySQL's case-insensitive default is the single most common source of cross-database comparison failures. Consider:

```sql
-- MySQL
CREATE TABLE users (email VARCHAR(255) UNIQUE);
INSERT INTO users VALUES ('User@Example.com');
INSERT INTO users VALUES ('user@example.com');
-- ERROR: Duplicate entry 'user@example.com' for key 'email'

-- PostgreSQL
CREATE TABLE users (email VARCHAR(255) UNIQUE);
INSERT INTO users VALUES ('User@Example.com');
INSERT INTO users VALUES ('user@example.com');
-- SUCCESS: These are different values in PostgreSQL
```

**Snowflake Collation Subtleties**: Snowflake supports a `COLLATE` function and collation specifications, but with important limitations:

```sql
-- Snowflake: Case-insensitive comparison
SELECT COLLATE('Hello', 'en-ci') = COLLATE('hello', 'en-ci');
-- Result: true

-- Snowflake: Case-insensitive with 'upper' collation (recommended for performance)
SELECT COLLATE('Hello', 'upper') = COLLATE('hello', 'upper');
-- Result: true

-- IMPORTANT: Collation only affects simple comparison operators
-- Many string functions (LIKE, CONTAINS, etc.) may not honor collation
```

### 2.2 Trailing Space Handling: CHAR vs VARCHAR

The SQL standard specifies that `CHAR(n)` values are right-padded with spaces to the specified length, and that comparisons should ignore trailing spaces. However, reality is more complex:

```sql
-- MySQL (with PAD SPACE collation — the default for traditional collations):
SELECT 'abc' = 'abc   ';    -- Result: 1 (true! trailing spaces ignored)
SELECT 'abc' LIKE 'abc   '; -- Result: 0 (false! LIKE does NOT pad)
-- This = vs LIKE inconsistency is a major gotcha

-- MySQL UNIQUE constraint with trailing spaces:
CREATE TABLE t (val VARCHAR(50) UNIQUE) COLLATE utf8mb4_general_ci;
INSERT INTO t VALUES ('hello');
INSERT INTO t VALUES ('hello   ');
-- ERROR: Duplicate entry 'hello   ' — trailing spaces are ignored for uniqueness!

-- PostgreSQL: Trailing spaces are significant in VARCHAR comparisons
SELECT 'abc' = 'abc   ';    -- Result: false
SELECT 'abc'::char(6) = 'abc   '::char(6);  -- Result: true (CHAR pads both to 6)

-- Snowflake: Trailing spaces are significant
SELECT 'abc' = 'abc   ';    -- Result: false

-- BigQuery: Trailing spaces are significant
SELECT 'abc' = 'abc   ';    -- Result: false

-- DuckDB: Trailing spaces are significant
SELECT 'abc' = 'abc   ';    -- Result: false
```

**Trailing Space Behavior Summary:**

| Database | VARCHAR `=` ignores trailing spaces? | CHAR pads? | LIKE ignores trailing spaces? |
|----------|-------------------------------------|-----------|------------------------------|
| PostgreSQL | No | Yes | No |
| MySQL (PAD SPACE) | **Yes** | Yes | **No** |
| MySQL (NO PAD) | No | Yes | No |
| Snowflake | No | Yes | No |
| BigQuery | No | N/A (no CHAR) | No |
| DuckDB | No | Yes | No |

**MySQL 8.0 Collation Change**: MySQL 8.0 introduced Unicode 9.0 collations (like `utf8mb4_0900_ai_ci`) which use `NO PAD` semantics. Older collations (`utf8_general_ci`, `utf8mb4_general_ci`) use `PAD SPACE`. Upgrading MySQL can change comparison behavior!

```sql
-- MySQL 5.7 / old collation:
SELECT 'a' = 'a ';  -- true (PAD SPACE)

-- MySQL 8.0 / new collation (utf8mb4_0900_ai_ci):
SELECT 'a' = 'a ';  -- false (NO PAD)
```

**Reladiff Implication**: When comparing MySQL sources with PAD SPACE collations against other databases, Reladiff should offer a `trim_trailing_spaces` option that applies `RTRIM()` to string values before comparison.

### 2.3 Unicode Normalization: NFC vs NFD

The same visual character can have multiple valid byte representations in Unicode:

```
Character: é (e with acute accent)
NFC (composed):   U+00E9 (single code point)         — 2 bytes in UTF-8
NFD (decomposed): U+0065 U+0301 (e + combining accent) — 3 bytes in UTF-8
```

Both forms look identical to humans but produce different bytes, different hashes, and different comparison results:

```sql
-- PostgreSQL: Does NOT normalize Unicode
-- If 'é' is stored as NFC in one row and NFD in another:
SELECT E'\u00E9' = E'\u0065\u0301';  -- Result: false (different bytes)

-- Snowflake: Does NOT normalize Unicode
SELECT '\u00E9' = '\u0065\u0301';    -- Result: false

-- MySQL: Comparison depends on collation
-- utf8mb4_general_ci treats NFC and NFD as equal for some collations
-- but binary comparison would differ

-- BigQuery: Does NOT normalize Unicode
SELECT '\u00E9' = '\u0065\u0301';    -- Result: false
```

**Real-World Impact**: macOS's HFS+ filesystem uses NFD normalization for filenames, while Linux uses NFC. When data originating from macOS filenames is loaded into a database, it may be in NFD form, while the same data from Linux would be NFC. A documented case from the Navidrome project (GitHub issue #4663) showed that playlist imports failed in production because the database contained NFD-normalized filenames from Netatalk (an AFP file server), while the application searched for NFC-normalized names.

**Databases and Normalization:**

| Database | Automatic Normalization? | Notes |
|----------|------------------------|-------|
| PostgreSQL | No | Stores bytes as-is |
| MySQL | Partial (collation-dependent) | Some collations treat NFC/NFD as equivalent |
| Snowflake | No | Stores bytes as-is |
| BigQuery | No | Stores bytes as-is |
| DuckDB | No | Stores bytes as-is |
| Databricks | No | Stores bytes as-is |

**Reladiff Implication**: Reladiff should offer a Unicode normalization option (normalize to NFC before comparison) for string columns, as this is a common source of false positives in cross-database comparisons.

### 2.4 Zero-Width Characters and Invisible Characters

Invisible Unicode characters can create strings that look identical to humans but differ in their byte representation:

| Character | Code Point | Name | Effect |
|-----------|-----------|------|--------|
| ​ | U+200B | Zero Width Space | Invisible but present in string |
| ‌ | U+200C | Zero Width Non-Joiner | Affects ligature behavior |
| ‍ | U+200D | Zero Width Joiner | Joins characters (used in emoji sequences) |
| ­ | U+00AD | Soft Hyphen | Invisible unless line break needed |
| ﻿ | U+FEFF | Byte Order Mark (BOM) | Invisible, appears at string start |
| ‎ | U+200E | Left-to-Right Mark | Invisible directional control |

```sql
-- Two strings that LOOK identical but aren't:
-- 'hello' (5 bytes) vs 'hel​lo' (8 bytes, contains U+200B)
SELECT LENGTH('hello'), LENGTH('hel' || E'\u200B' || 'lo');
-- PostgreSQL: 5, 6

-- This breaks UNIQUE constraints, JOINs, and comparisons:
SELECT 'hello' = 'hel' || E'\u200B' || 'lo';
-- Result: false (in all databases)
```

**Production War Story**: Zero-width characters commonly appear in data copied from web pages, PDFs, or Word documents. A customer's product catalog had invisible zero-width spaces in product names, causing JOIN failures between the catalog table and the orders table — the names looked identical in every tool but never matched.

**Reladiff Implication**: Reladiff should offer a `strip_invisible_characters` option that removes zero-width characters and other invisible Unicode control characters before comparison.

### 2.5 Empty String vs NULL

This is one of the oldest and most consequential differences in SQL databases:

```sql
-- Oracle (for context): Treats '' as NULL
INSERT INTO t VALUES ('');
SELECT val IS NULL FROM t;  -- Result: TRUE (!)

-- PostgreSQL: '' and NULL are DISTINCT
INSERT INTO t VALUES ('');
INSERT INTO t VALUES (NULL);
SELECT val IS NULL FROM t WHERE val = '';  -- Result: false
SELECT COUNT(*) FROM t WHERE val = '';     -- Result: 1
SELECT COUNT(*) FROM t WHERE val IS NULL;  -- Result: 1

-- MySQL: '' and NULL are DISTINCT
-- Same behavior as PostgreSQL

-- Snowflake: '' and NULL are DISTINCT
-- Same behavior as PostgreSQL

-- BigQuery: '' and NULL are DISTINCT
-- Same behavior as PostgreSQL
```

While none of Reladiff's six supported databases treat `''` as NULL, this matters in practice because data often originates from Oracle or passes through ETL tools that may convert empty strings to NULLs or vice versa.

**Concatenation with NULL — Another Trap:**

```sql
-- PostgreSQL: 'hello' || NULL = NULL
SELECT 'hello' || NULL;  -- Result: NULL

-- MySQL: CONCAT('hello', NULL) = NULL
SELECT CONCAT('hello', NULL);  -- Result: NULL

-- Snowflake: 'hello' || NULL = NULL
SELECT 'hello' || NULL;  -- Result: NULL

-- Oracle (for context): 'hello' || NULL = 'hello'
-- This Oracle behavior often leaks into data that was originally in Oracle
```

### 2.6 Maximum String Length

Maximum string lengths vary enormously and can cause silent truncation:

| Database | VARCHAR Max | TEXT/STRING Max | Notes |
|----------|-----------|----------------|-------|
| PostgreSQL | 10,485,760 chars (with length) / 1 GB (without) | 1 GB | TEXT and VARCHAR(no limit) are equivalent |
| MySQL | 65,535 bytes (row limit shared!) | 4 GB (LONGTEXT) | VARCHAR max depends on character set and row |
| Snowflake | 16,777,216 chars (16 MB default) / 128 MB max | Same | All strings are VARCHAR |
| BigQuery | N/A | 2 MB | STRING type only |
| DuckDB | Unlimited | Unlimited | No length enforcement |
| Databricks | Unlimited (STRING) | Unlimited | No length enforcement |

**The MySQL Row Size Trap**: MySQL's VARCHAR maximum of 65,535 bytes is shared across ALL columns in a row. With `utf8mb4` (4 bytes per character), a single `VARCHAR(16383)` column would consume the entire row limit, making it impossible to have other VARCHAR columns.

---

## 3. Character Encoding Issues

### 3.1 UTF-8 vs UTF-16 vs Latin-1

Modern databases standardize on UTF-8, but legacy data and ETL pipelines create encoding mismatches:

| Database | Internal Encoding | Configurable? | Notes |
|----------|-------------------|--------------|-------|
| PostgreSQL | Configurable per database | Yes | UTF-8, LATIN1, WIN1252, etc. |
| MySQL | Configurable per column | Yes | utf8mb4, utf8 (3-byte!), latin1, etc. |
| Snowflake | Always UTF-8 | No | Source data may not be UTF-8 |
| BigQuery | Always UTF-8 | No | |
| DuckDB | Always UTF-8 | No | |
| Databricks | Always UTF-8 | No | |

### 3.2 Mojibake: The Encoding Mismatch Nightmare

Mojibake occurs when data is encoded in one character set but interpreted as another:

```
Original text:     "Jörg Müller"
Stored as Latin-1:  4A F6 72 67 20 4D FC 6C 6C 65 72
Read as UTF-8:      "J�rg M�ller" (invalid UTF-8 sequences)
```

The reverse is more common and more insidious:

```
Original text:     "Jörg" (UTF-8: 4A C3 B6 72 67)
Read as Latin-1:   "JÃ¶rg" (each UTF-8 byte interpreted as Latin-1)
```

**Common Mojibake Patterns** (useful for detection):

| Original | Mojibake (UTF-8 read as Latin-1) | Bytes |
|----------|--------------------------------|-------|
| ö | Ã¶ | C3 B6 |
| ü | Ã¼ | C3 BC |
| é | Ã© | C3 A9 |
| — (em dash) | â€" | E2 80 94 |
| " (smart quote) | â€œ | E2 80 9C |

**Reladiff Implication**: If Reladiff detects the mojibake patterns above in string data, it should warn the user about potential encoding issues in the source data.

### 3.3 MySQL utf8 vs utf8mb4 — The 4-Byte UTF-8 Disaster

This is one of the most well-documented data loss issues in database history:

```sql
-- MySQL: 'utf8' character set only supports 1-3 bytes per character
-- This means it CANNOT store characters requiring 4 bytes of UTF-8:
-- - Emoji (😊, 🚀, ❤️)
-- - Some CJK ideographs (supplementary planes)
-- - Musical symbols, mathematical symbols

-- MySQL with utf8 (broken):
CREATE TABLE t (val VARCHAR(255)) CHARACTER SET utf8;
INSERT INTO t VALUES ('Hello 🚀');
-- In strict mode: Error 1366: Incorrect string value '\xF0\x9F\x9A\x80' for column 'val'
-- In non-strict mode: Data silently truncated at the emoji!
-- Stored value: 'Hello ' (everything after the emoji is LOST)

-- MySQL with utf8mb4 (correct):
CREATE TABLE t (val VARCHAR(255)) CHARACTER SET utf8mb4;
INSERT INTO t VALUES ('Hello 🚀');
-- Success: 'Hello 🚀'
```

**The Scale of the Problem**: MySQL introduced `utf8mb4` in version 5.5.3 (2010), but `utf8` remained the default until MySQL 8.0 (2018). Millions of MySQL databases created between 2000 and 2018 use the broken 3-byte `utf8` character set. Data loss from emoji and supplementary characters is extremely common.

**Characters affected by MySQL's utf8 limitation:**
- All emoji (🎉, 😀, 🏠, etc.) — U+1F000 and above
- CJK Unified Ideographs Extension B (rare Chinese characters) — U+20000 and above
- Musical symbols (𝄞) — U+1D100 and above
- Mathematical alphanumeric symbols — U+1D400 and above
- Ancient scripts (Cuneiform, Egyptian Hieroglyphs) — various high planes

**Reladiff Implication**: When comparing a MySQL `utf8` (3-byte) source against any other database, Reladiff should detect whether 4-byte characters exist in the target but not in the MySQL source, which would indicate data loss at the MySQL side.

### 3.4 BOM (Byte Order Mark) in Data Files

The UTF-8 BOM (`EF BB BF`, character U+FEFF) is invisible but causes havoc in data pipelines:

```sql
-- A CSV file with BOM:
-- EF BB BF 69 64 2C 6E 61 6D 65 0A  (reads as: ﻿id,name\n)

-- When loaded, the first column header becomes '﻿id' instead of 'id'
-- This breaks column name matching between tables

-- PostgreSQL: Will store the BOM as part of the string
SELECT LENGTH(E'\uFEFF' || 'hello');  -- 6, not 5

-- Detection in SQL:
SELECT LEFT(column_name, 1) = E'\uFEFF' AS has_bom FROM information_schema.columns;
```

**BOM in Practice:**
- Microsoft Excel saves CSV files with a UTF-8 BOM by default
- Windows Notepad adds BOM to UTF-8 files by default
- Unix tools (vim, nano, standard `echo`) do NOT add BOM
- Cloud storage services generally pass through BOMs unchanged

**Reladiff Implication**: When comparing string values, Reladiff should strip leading BOMs from string values, particularly for the first column in tables loaded from CSV files.

### 3.5 JSON Encoding: \uXXXX Escapes vs Raw UTF-8

JSON data in databases can contain the same character in two different representations:

```sql
-- The character é can appear in JSON as:
-- Raw UTF-8: {"name": "café"}
-- Escaped:    {"name": "caf\u00e9"}

-- PostgreSQL JSONB normalizes to raw UTF-8
SELECT '{"name": "caf\\u00e9"}'::jsonb;
-- Result: {"name": "café"}

-- Snowflake VARIANT preserves the original form
SELECT PARSE_JSON('{"name": "caf\\u00e9"}');
-- May preserve the escaped form or normalize — implementation-dependent

-- This means the same JSON document can have different string representations
-- across databases, causing hash mismatches
```

---

## 4. NULL Semantics Variations

### 4.1 Three-Valued Logic in Practice

All SQL databases implement three-valued logic (TRUE, FALSE, UNKNOWN/NULL), but the practical implications differ:

```sql
-- The fundamental NULL comparison trap
SELECT NULL = NULL;    -- Result: NULL (not TRUE!)
SELECT NULL <> NULL;   -- Result: NULL (not TRUE!)
SELECT NULL < 1;       -- Result: NULL
SELECT NULL > 1;       -- Result: NULL
SELECT NOT NULL;       -- Result: NULL

-- This means:
SELECT * FROM t WHERE x = NULL;   -- Returns NOTHING (always)
SELECT * FROM t WHERE x <> NULL;  -- Returns NOTHING (always)
-- Must use IS NULL / IS NOT NULL
```

### 4.2 NULL in Aggregate Functions

```sql
-- Setup: table with values (1, 2, NULL, 4)

-- COUNT(*) vs COUNT(column)
SELECT COUNT(*) FROM t;        -- Result: 4 (counts all rows)
SELECT COUNT(val) FROM t;      -- Result: 3 (excludes NULL)
-- This is standard across ALL databases

-- SUM/AVG with NULLs
SELECT SUM(val) FROM t;        -- Result: 7 (NULLs ignored)
SELECT AVG(val) FROM t;        -- Result: 2.333... (7/3, not 7/4!)
-- AVG divides by COUNT(column), not COUNT(*)
-- This is consistent across all databases but often surprising

-- MIN/MAX with NULLs
SELECT MIN(val) FROM t;        -- Result: 1 (NULLs ignored)
SELECT MAX(val) FROM t;        -- Result: 4 (NULLs ignored)
```

### 4.3 NULL in GROUP BY

All databases treat NULLs as equal for GROUP BY purposes (they go into the same group):

```sql
-- All databases:
SELECT val, COUNT(*)
FROM (VALUES (1), (NULL), (2), (NULL), (1)) AS t(val)
GROUP BY val;
-- Result:
--  val  | count
-- ------+------
--  1    |  2
--  2    |  1
--  NULL |  2    <-- Both NULLs grouped together
```

### 4.4 NULL in DISTINCT

All databases treat NULLs as equal for DISTINCT purposes:

```sql
SELECT DISTINCT val FROM (VALUES (1), (NULL), (2), (NULL), (1)) AS t(val);
-- All databases return: 1, 2, NULL (one NULL only)
```

### 4.5 NULL in ORDER BY: NULLS FIRST vs NULLS LAST

This is where databases diverge significantly:

```sql
-- Default NULL ordering in ascending sort:

-- PostgreSQL: NULLs LAST in ASC (NULLs are "largest")
SELECT val FROM t ORDER BY val ASC;
-- Result: 1, 2, 4, NULL

-- MySQL: NULLs FIRST in ASC (NULLs are "smallest")
SELECT val FROM t ORDER BY val ASC;
-- Result: NULL, 1, 2, 4

-- Snowflake: NULLs LAST in ASC (configurable via NULLS FIRST/LAST)
-- BigQuery: NULLs LAST in ASC
-- DuckDB: NULLs LAST in ASC (PostgreSQL-compatible)
-- Databricks: NULLs LAST in ASC
```

**NULL Ordering Defaults:**

| Database | ASC Default | DESC Default | Supports NULLS FIRST/LAST? |
|----------|-----------|-------------|---------------------------|
| PostgreSQL | NULLS LAST | NULLS FIRST | Yes |
| MySQL | NULLS FIRST | NULLS LAST | No (workaround: `ORDER BY val IS NULL, val`) |
| Snowflake | NULLS LAST | NULLS FIRST | Yes |
| BigQuery | NULLS LAST | NULLS FIRST | Yes |
| DuckDB | NULLS LAST | NULLS FIRST | Yes |
| Databricks | NULLS LAST | NULLS FIRST | Yes |

**Reladiff Implication**: For ordered comparisons (e.g., comparing the Nth row of each table), NULL ordering differences between MySQL and other databases will cause rows to appear in different positions. Reladiff should normalize NULL ordering or compare unordered.

### 4.6 IS NOT DISTINCT FROM — NULL-Safe Equality

The `IS NOT DISTINCT FROM` operator treats NULLs as equal, which is essential for cross-database comparison:

```sql
-- Standard SQL:
SELECT NULL IS NOT DISTINCT FROM NULL;  -- Result: true
SELECT 1 IS NOT DISTINCT FROM NULL;     -- Result: false
SELECT 1 IS NOT DISTINCT FROM 1;        -- Result: true
```

**Availability:**

| Database | IS NOT DISTINCT FROM | Alternative |
|----------|---------------------|-------------|
| PostgreSQL | Yes (since 8.3) | `IS NOT DISTINCT FROM` |
| Snowflake | Yes | `IS NOT DISTINCT FROM` or `EQUAL_NULL()` |
| BigQuery | Yes | `IS NOT DISTINCT FROM` (since 2023) |
| MySQL | No | `<=>` operator (NULL-safe equals) |
| DuckDB | Yes | `IS NOT DISTINCT FROM` |
| Databricks | Yes | `IS NOT DISTINCT FROM` or `<=>` |

```sql
-- MySQL NULL-safe equals (proprietary syntax):
SELECT NULL <=> NULL;  -- Result: 1 (true)
SELECT 1 <=> NULL;     -- Result: 0 (false)
SELECT 1 <=> 1;        -- Result: 1 (true)
```

**Reladiff Implication**: For JoinDiff operations, Reladiff must use NULL-safe equality for join conditions. It should generate `IS NOT DISTINCT FROM` for most databases and `<=>` for MySQL.

### 4.7 COALESCE and IFNULL Behavior

```sql
-- COALESCE is standard and works consistently across all databases:
SELECT COALESCE(NULL, NULL, 3, 4);  -- Result: 3

-- IFNULL (MySQL, Snowflake) vs COALESCE:
-- MySQL
SELECT IFNULL(NULL, 'default');  -- Result: 'default'

-- Snowflake
SELECT IFNULL(NULL, 'default');  -- Result: 'default'

-- PostgreSQL has no IFNULL (use COALESCE)
-- BigQuery has IFNULL

-- NVL (Snowflake, Oracle) — same as IFNULL
SELECT NVL(NULL, 'default');  -- Result: 'default' (Snowflake)

-- Key difference: COALESCE evaluates arguments lazily (short-circuit)
-- IFNULL may or may not short-circuit depending on the database
```

### 4.8 NULL in JSON: Three Kinds of Nothing

When working with JSON data, there are three distinct concepts of "nothing":

```sql
-- PostgreSQL JSONB:
-- 1. SQL NULL (column is NULL)
SELECT NULL::jsonb IS NULL;  -- true

-- 2. JSON null (the value is the JSON literal null)
SELECT '"null"'::jsonb IS NULL;  -- false (it's the string "null")
SELECT 'null'::jsonb IS NULL;    -- false! (it's a valid JSONB value)
SELECT 'null'::jsonb = 'null'::jsonb;  -- true

-- 3. Missing key (key doesn't exist in object)
SELECT '{"a": 1}'::jsonb -> 'b';       -- Result: NULL (SQL NULL)
SELECT '{"a": 1}'::jsonb -> 'b' IS NULL;  -- true
SELECT '{"a": null}'::jsonb -> 'a';     -- Result: null (JSON null)
SELECT '{"a": null}'::jsonb -> 'a' IS NULL;  -- false!

-- Snowflake VARIANT — three distinct states:
-- SQL NULL: The VARIANT column is NULL
-- VARIANT null: The VARIANT value contains JSON null (IS_NULL_VALUE returns TRUE)
-- Missing: Accessing a non-existent key returns SQL NULL

SELECT IS_NULL_VALUE(PARSE_JSON('null'));    -- true (JSON null)
SELECT PARSE_JSON('null') IS NULL;           -- false (it's not SQL NULL!)
SELECT PARSE_JSON('{"a": null}'):a IS NULL;  -- false
SELECT IS_NULL_VALUE(PARSE_JSON('{"a": null}'):a);  -- true
```

**NULL-in-JSON Comparison Matrix:**

| Scenario | PostgreSQL JSONB | Snowflake VARIANT | BigQuery JSON |
|----------|-----------------|-------------------|---------------|
| SQL NULL column | IS NULL = true | IS NULL = true | IS NULL = true |
| JSON null value | IS NULL = false | IS NULL = false | IS NULL = false |
| Missing key access | Returns SQL NULL | Returns SQL NULL | Returns SQL NULL |
| JSON null = JSON null | true | true | true |
| SQL NULL = JSON null | NULL (unknown) | false | NULL |

**Reladiff Implication**: When comparing JSON columns across databases, Reladiff must handle the three-way distinction between SQL NULL, JSON null, and missing keys. Two rows might appear different because one has `{"key": null}` and the other has `{}` (missing key), even though the application treats them identically.

---

## 5. Date/Time Semantic Differences

### 5.1 TIMESTAMP Type Variants

This is arguably the most complex area of cross-database incompatibility. Each database has different timestamp types with different timezone semantics:

```
PostgreSQL:
  TIMESTAMP         = TIMESTAMP WITHOUT TIME ZONE (stores local time, no TZ info)
  TIMESTAMPTZ       = TIMESTAMP WITH TIME ZONE (stores as UTC, displays in session TZ)

Snowflake:
  TIMESTAMP_NTZ     = No timezone (default for TIMESTAMP!)
  TIMESTAMP_LTZ     = Local timezone (stores UTC, displays in session TZ)
  TIMESTAMP_TZ      = Stores UTC + offset at insertion time

BigQuery:
  DATETIME          = No timezone (local time)
  TIMESTAMP         = Always UTC (displayed in session TZ)

MySQL:
  DATETIME          = No timezone, stored as-is
  TIMESTAMP         = Auto-converted to/from UTC based on session timezone

DuckDB:
  TIMESTAMP         = No timezone
  TIMESTAMPTZ       = With timezone (stores UTC)
  TIMESTAMP_S       = Second precision
  TIMESTAMP_MS      = Millisecond precision
  TIMESTAMP_NS      = Nanosecond precision

Databricks:
  TIMESTAMP         = With timezone (session-aware) — default
  TIMESTAMP_NTZ     = Without timezone
```

**The Snowflake TIMESTAMP_NTZ Default Trap:**

Snowflake's `TIMESTAMP` alias defaults to `TIMESTAMP_NTZ` (no timezone), which is the opposite of PostgreSQL's `TIMESTAMPTZ` convention. This creates a major gotcha when migrating between the two:

```sql
-- Snowflake (default TIMESTAMP = TIMESTAMP_NTZ)
ALTER SESSION SET TIMEZONE = 'America/New_York';
CREATE TABLE events (ts TIMESTAMP);  -- Actually TIMESTAMP_NTZ
INSERT INTO events VALUES ('2024-07-15 14:30:00');
ALTER SESSION SET TIMEZONE = 'Europe/London';
SELECT ts FROM events;
-- Result: 2024-07-15 14:30:00 (same! no timezone conversion)

-- PostgreSQL (TIMESTAMPTZ)
SET timezone = 'America/New_York';
CREATE TABLE events (ts TIMESTAMPTZ);
INSERT INTO events VALUES ('2024-07-15 14:30:00');
SET timezone = 'Europe/London';
SELECT ts FROM events;
-- Result: 2024-07-15 19:30:00+01 (converted! 5 hours ahead)
```

**If you compare these two tables, every single timestamp will differ by the timezone offset**, even though they represent the same event.

### 5.2 Timestamp Type Mapping Table

| Concept | PostgreSQL | Snowflake | BigQuery | MySQL | DuckDB | Databricks |
|---------|-----------|-----------|----------|-------|--------|------------|
| Timestamp without TZ | `TIMESTAMP` | `TIMESTAMP_NTZ` (default) | `DATETIME` | `DATETIME` | `TIMESTAMP` | `TIMESTAMP_NTZ` |
| Timestamp with TZ | `TIMESTAMPTZ` | `TIMESTAMP_LTZ` or `TIMESTAMP_TZ` | `TIMESTAMP` | `TIMESTAMP` (auto-UTC) | `TIMESTAMPTZ` | `TIMESTAMP` |
| Date only | `DATE` | `DATE` | `DATE` | `DATE` | `DATE` | `DATE` |
| Time only | `TIME` | `TIME` | `TIME` | `TIME` | `TIME` | N/A |

### 5.3 Precision Differences

```sql
-- PostgreSQL: Microsecond precision (6 decimal places) by default
SELECT NOW()::TIMESTAMP(6);
-- Result: 2024-07-15 14:30:00.123456

-- Snowflake: Nanosecond precision (9 decimal places) available
SELECT CURRENT_TIMESTAMP()::TIMESTAMP_NTZ(9);
-- Result: 2024-07-15 14:30:00.123456789

-- BigQuery: Microsecond precision
SELECT CURRENT_TIMESTAMP();
-- Result: 2024-07-15 14:30:00.123456 UTC

-- MySQL: Second precision by default (!), microsecond with DATETIME(6)
SELECT NOW();        -- Result: 2024-07-15 14:30:00 (no fractional seconds!)
SELECT NOW(6);       -- Result: 2024-07-15 14:30:00.123456

-- DuckDB: Microsecond precision by default (TIMESTAMP)
-- Also supports TIMESTAMP_NS for nanosecond, TIMESTAMP_MS for millisecond, TIMESTAMP_S for second
SELECT CURRENT_TIMESTAMP;
-- Result: 2024-07-15 14:30:00.123456
```

**Precision Summary:**

| Database | Default Precision | Max Precision | Notes |
|----------|------------------|---------------|-------|
| PostgreSQL | 6 (microseconds) | 6 | Fixed |
| Snowflake | 9 (nanoseconds) | 9 | Configurable per column |
| BigQuery | 6 (microseconds) | 6 | Fixed |
| MySQL | 0 (seconds!) | 6 | Must specify: `DATETIME(6)` |
| DuckDB | 6 (microseconds) | 9 (TIMESTAMP_NS) | Different types for different precision |
| Databricks | 6 (microseconds) | 6 | Fixed |

**MySQL's Default Second Precision**: MySQL's default `DATETIME` and `TIMESTAMP` types have **zero fractional seconds precision**. This is a notorious source of data loss — inserting `'2024-07-15 14:30:00.999999'` into a `DATETIME` column silently truncates to `'2024-07-15 14:30:00'`. This was a MySQL bug (#8523) reported in 2005 and only addressed in MySQL 5.6.4 (2013) with the introduction of `DATETIME(fsp)` syntax.

**Reladiff Implication**: When comparing timestamps across databases, Reladiff must truncate to the lowest common precision. A Snowflake nanosecond timestamp compared against PostgreSQL's microsecond timestamp should be truncated to microseconds before comparison.

### 5.4 Epoch Timestamps: Seconds vs Milliseconds vs Microseconds

Different systems use different epoch units:

| System | Epoch Unit | Example for 2024-07-15T14:30:00Z |
|--------|-----------|----------------------------------|
| Unix / PostgreSQL `EXTRACT(EPOCH)` | Seconds | 1721054400 |
| Java / JavaScript `Date.getTime()` | Milliseconds | 1721054400000 |
| PostgreSQL `EXTRACT(EPOCH) * 1000000` | Microseconds | 1721054400000000 |
| Snowflake `DATE_PART(EPOCH_SECOND)` | Seconds | 1721054400 |
| BigQuery `UNIX_SECONDS()` | Seconds | 1721054400 |
| BigQuery `UNIX_MICROS()` | Microseconds | 1721054400000000 |
| DuckDB `epoch()` | Seconds | 1721054400 |

When data is stored as integer epoch values, comparing across databases requires knowing which unit each source uses. A millisecond epoch from Java will be 1000x larger than a second epoch from Unix.

### 5.5 DST Transitions: The 2:30 AM Problem

Daylight Saving Time transitions create two types of dangerous edge cases:

**Spring Forward (invalid time):**
```sql
-- On March 10, 2024 in US Eastern, clocks jump from 2:00 AM to 3:00 AM
-- The time 2:30 AM does NOT EXIST

-- PostgreSQL:
SELECT '2024-03-10 02:30:00 America/New_York'::TIMESTAMPTZ;
-- Result: 2024-03-10 03:30:00-04 (silently adjusted to 3:30 AM EDT!)

-- Snowflake:
SELECT '2024-03-10 02:30:00'::TIMESTAMP_LTZ;
-- Behavior depends on session timezone setting

-- This means two databases might interpret the same input differently
```

**Fall Back (ambiguous time):**
```sql
-- On November 3, 2024 in US Eastern, clocks go from 2:00 AM back to 1:00 AM
-- The time 1:30 AM EXISTS TWICE (once EDT, once EST)

-- PostgreSQL:
SELECT '2024-11-03 01:30:00 America/New_York'::TIMESTAMPTZ;
-- Result: 2024-11-03 01:30:00-04 (assumes EDT, the first occurrence)

-- Different databases may choose the other occurrence:
-- 2024-11-03 01:30:00-05 (EST, the second occurrence)
-- This is a 1-hour difference for the same input string!
```

**Reladiff Implication**: For timestamps within DST transition windows, Reladiff should convert both sides to UTC before comparison. If one side is timezone-aware and the other isn't, comparison during DST transitions is fundamentally ambiguous.

### 5.6 Year 2038 Problem

MySQL's `TIMESTAMP` type uses a 32-bit signed integer for UTC storage:

```sql
-- MySQL TIMESTAMP range:
-- '1970-01-01 00:00:01' UTC to '2038-01-19 03:14:07' UTC

-- Attempting to store a date beyond 2038:
INSERT INTO t (ts) VALUES ('2039-01-01 00:00:00');
-- In strict mode: Error: Incorrect datetime value
-- In non-strict mode: Silently stores '0000-00-00 00:00:00' (!!)

-- MySQL DATETIME range (no 2038 problem):
-- '1000-01-01 00:00:00' to '9999-12-31 23:59:59'
```

**2038 Problem Summary:**

| Database | TIMESTAMP Range End | Affected? |
|----------|-------------------|-----------|
| PostgreSQL | 294276 AD | No |
| MySQL TIMESTAMP | 2038-01-19 | **Yes** |
| MySQL DATETIME | 9999-12-31 | No |
| Snowflake | Far future | No |
| BigQuery | 9999-12-31 | No |
| DuckDB | ~294247 AD | No |
| Databricks | ~294247 AD | No |

**Reladiff Implication**: When validating MySQL TIMESTAMP columns, Reladiff should warn about values approaching the 2038 boundary. MySQL 8.0.28+ uses 64-bit internally, but older versions and the on-wire format may still be 32-bit.

### 5.7 Calendar Edge Cases

```sql
-- February 29 in non-leap years
SELECT DATE '2023-02-29';
-- PostgreSQL: ERROR: date/time field value out of range
-- MySQL (strict): ERROR: Incorrect date value
-- MySQL (non-strict): '0000-00-00' or adjusted to 2023-02-28
-- Snowflake: ERROR

-- Dates before 1970 (pre-epoch)
SELECT TIMESTAMP '1960-01-01 00:00:00';
-- PostgreSQL: Works (supports dates back to 4713 BC)
-- MySQL DATETIME: Works
-- MySQL TIMESTAMP: ERROR (only supports 1970+)
-- BigQuery: Works
-- Snowflake: Works

-- Adding months to dates (different databases handle end-of-month differently)
SELECT DATE '2024-01-31' + INTERVAL '1 month';
-- PostgreSQL: 2024-02-29 (clamps to end of February in leap year)
-- MySQL: 2024-02-29
-- Snowflake: 2024-02-29 (DATEADD function)
-- BigQuery: 2024-02-29 (DATE_ADD function)

SELECT DATE '2024-03-31' + INTERVAL '1 month';
-- PostgreSQL: 2024-04-30 (clamps to end of April)
-- All databases agree on this
```

---

## 6. Boolean Representation

### 6.1 Native Boolean Types

```sql
-- PostgreSQL: Native BOOLEAN type
SELECT TRUE, FALSE, NULL::BOOLEAN;
-- Display: t, f, NULL

-- MySQL: BOOLEAN is TINYINT(1)
SELECT TRUE, FALSE;
-- Display: 1, 0
-- But TINYINT(1) can store ANY value from -128 to 127:
CREATE TABLE t (flag BOOLEAN);
INSERT INTO t VALUES (42);  -- Works! Stored as 42, not TRUE
SELECT flag FROM t;  -- Returns 42, not 1

-- Snowflake: Native BOOLEAN with flexible input
SELECT CAST('true' AS BOOLEAN);    -- TRUE
SELECT CAST('yes' AS BOOLEAN);     -- TRUE
SELECT CAST('y' AS BOOLEAN);       -- TRUE
SELECT CAST('on' AS BOOLEAN);      -- TRUE
SELECT CAST('1' AS BOOLEAN);       -- TRUE
SELECT CAST('false' AS BOOLEAN);   -- FALSE
SELECT CAST('no' AS BOOLEAN);      -- FALSE
SELECT CAST('n' AS BOOLEAN);       -- FALSE
SELECT CAST('off' AS BOOLEAN);     -- FALSE
SELECT CAST('0' AS BOOLEAN);       -- FALSE
-- Non-zero numbers: TRUE; Zero: FALSE

-- BigQuery: Native BOOL type
SELECT TRUE, FALSE;

-- DuckDB: Native BOOLEAN type
SELECT TRUE, FALSE;

-- Databricks: Native BOOLEAN type
SELECT TRUE, FALSE;
```

### 6.2 Boolean Representation Comparison

| Representation | PostgreSQL | MySQL | Snowflake | BigQuery | DuckDB | Databricks |
|---------------|-----------|-------|-----------|----------|--------|------------|
| `TRUE` | BOOLEAN true | INTEGER 1 | BOOLEAN true | BOOL true | BOOLEAN true | BOOLEAN true |
| `FALSE` | BOOLEAN false | INTEGER 0 | BOOLEAN false | BOOL false | BOOLEAN false | BOOLEAN false |
| `1` (integer) | Error (must cast) | TRUE | TRUE | Error | TRUE | TRUE |
| `0` (integer) | Error (must cast) | FALSE | FALSE | Error | FALSE | FALSE |
| `2` (integer) | Error | TRUE (!) | TRUE | Error | Error | Error |
| `'yes'` (string) | Error | Error | TRUE | Error | Error | Error |
| `'Y'` (string) | Error | Error | TRUE | Error | Error | Error |
| `'true'` (string) | TRUE | Error | TRUE | Error | TRUE | TRUE |
| `NULL` | NULL | NULL | NULL | NULL | NULL | NULL |

**The MySQL TINYINT(1) Trap**: Because MySQL's BOOLEAN is actually TINYINT(1), a "boolean" column can contain values like 2, 42, or -1. ETL tools like Fivetran and Airbyte often convert TINYINT(1) to native BOOLEAN in the target, mapping anything non-zero to TRUE. But if the source MySQL column was using values like 0, 1, 2 to represent a tri-state enum, this conversion silently corrupts the data.

**Reladiff Implication**: When comparing boolean columns across databases, Reladiff should normalize to a canonical boolean (TRUE/FALSE/NULL) representation. For MySQL TINYINT(1) columns, Reladiff should warn if values other than 0 and 1 exist.

---

## 7. JSON/Semi-Structured Data

### 7.1 Type System Comparison

| Database | JSON Type | Key Ordering | Duplicate Keys | Number Precision |
|----------|----------|-------------|----------------|-----------------|
| PostgreSQL (`json`) | Text storage | Preserved | Preserved | Exact (text) |
| PostgreSQL (`jsonb`) | Binary storage | **Not preserved** | Last wins | Double precision |
| Snowflake (`VARIANT`) | Binary storage | **Not preserved** | Last wins | Exact (attempts to preserve) |
| BigQuery (`JSON`) | Binary storage | **Not preserved** | Last wins | Double precision |
| BigQuery (`STRUCT`) | Typed struct | N/A (positional) | N/A | Native types |
| DuckDB (`JSON`) | Text (extension) | Preserved | Preserved | Text |
| MySQL (`JSON`) | Binary storage | **Not preserved** | Error on duplicate | Double precision |

### 7.2 Key Ordering

```sql
-- PostgreSQL json (preserves order):
SELECT '{"z": 1, "a": 2}'::json;
-- Result: {"z": 1, "a": 2}

-- PostgreSQL jsonb (does NOT preserve order):
SELECT '{"z": 1, "a": 2}'::jsonb;
-- Result: {"a": 2, "z": 1}  (alphabetically sorted!)

-- Snowflake VARIANT (order not predictable):
SELECT PARSE_JSON('{"z": 1, "a": 2}');
-- Result: order is implementation-dependent

-- This means hashing the JSON string representation will produce
-- different hashes across databases even for identical logical content
```

**Reladiff Implication**: Hash-based comparison of JSON columns requires canonicalization — sorting keys alphabetically and normalizing whitespace before hashing. String-based comparison will always fail due to key ordering differences.

### 7.3 JSON Number Precision

```sql
-- PostgreSQL JSONB: Numbers stored as double precision
SELECT '{"id": 9007199254740993}'::jsonb -> 'id';
-- Result: 9007199254740992 (precision lost! This exceeds 2^53)

-- Snowflake VARIANT: Attempts to preserve precision
SELECT PARSE_JSON('{"id": 9007199254740993}'):id;
-- Result: 9007199254740993 (preserved as NUMBER)

-- BigQuery JSON: Numbers as double precision
SELECT JSON_VALUE('{"id": 9007199254740993}', '$.id');
-- Result: '9007199254740993' (extracted as STRING to preserve precision)

-- JavaScript-origin data: Numbers > 2^53 lose precision when
-- serialized as JSON numbers (not strings)
```

**The JavaScript Number Problem**: JSON is commonly generated by JavaScript, which uses IEEE 754 doubles for all numbers. JavaScript's `Number.MAX_SAFE_INTEGER` is 9,007,199,254,740,991 (2^53 - 1). Any JSON number larger than this may have already lost precision before reaching the database. Common culprits: Twitter IDs, Snowflake IDs (the Snowflake software company, not the database), Discord IDs.

**Reladiff Implication**: When comparing JSON number values across databases, Reladiff should compare as strings first (to detect representation differences) and then optionally as numbers with tolerance (to detect precision loss).

### 7.4 Nested Structure Comparison

Comparing deeply nested JSON structures requires recursive traversal:

```sql
-- Are these two JSON documents equal?
-- Document A: {"users": [{"name": "Alice", "age": 30}]}
-- Document B: {"users": [{"age": 30, "name": "Alice"}]}
-- Answer: Yes logically, but string comparison says No

-- PostgreSQL JSONB comparison (canonicalized):
SELECT '{"users": [{"name": "Alice", "age": 30}]}'::jsonb
     = '{"users": [{"age": 30, "name": "Alice"}]}'::jsonb;
-- Result: true (JSONB normalizes key order)

-- Snowflake: Direct comparison
SELECT PARSE_JSON('{"users": [{"name": "Alice", "age": 30}]}')
     = PARSE_JSON('{"users": [{"age": 30, "name": "Alice"}]}');
-- Behavior: Compares key-value pairs (may or may not match depending on implementation)
```

**Key Difference Between Snowflake and BigQuery Comparison:**
- **BigQuery STRUCT comparison**: Compares values pairwise in **ordinal order** (ignores field names)
- **Snowflake VARIANT comparison**: Compares both **keys and values**

This means the same logical data can compare as equal in one database and unequal in another.

---

## 8. Binary Data

### 8.1 Type Mapping

| Database | Binary Type | Max Size | Default Display Format |
|----------|-----------|----------|----------------------|
| PostgreSQL | BYTEA | 1 GB | Hex (`\x...`) |
| MySQL | BINARY / VARBINARY / BLOB / LONGBLOB | 4 GB (LONGBLOB) | Hex |
| Snowflake | BINARY / VARBINARY | 8 MB | Hex (no `\x` prefix) |
| BigQuery | BYTES | 10 MB | Base64 |
| DuckDB | BLOB | No limit | Hex (`\x...`) |
| Databricks | BINARY | 2 GB | Hex |

### 8.2 Hex Encoding Differences

```sql
-- PostgreSQL: Hex output includes \x prefix
SELECT '\xDEADBEEF'::bytea;
-- Display: \xdeadbeef

-- Snowflake: Hex output has NO prefix
SELECT TO_BINARY('DEADBEEF', 'HEX');
-- Display: DEADBEEF

-- BigQuery: Uses Base64 by default
SELECT b'\xDE\xAD\xBE\xEF';
-- Display: 3q2+7w==  (base64 encoding)

-- This means the same binary data has different string representations
-- across databases, breaking any text-based comparison
```

### 8.3 Comparison Strategies for Binary Data

```sql
-- Strategy 1: Compare hex representations
-- PostgreSQL:
SELECT ENCODE(col, 'hex') FROM t;  -- Returns hex string without \x prefix

-- Snowflake:
SELECT HEX_ENCODE(col) FROM t;    -- Returns hex string

-- Strategy 2: Compare base64 representations
-- PostgreSQL:
SELECT ENCODE(col, 'base64') FROM t;

-- BigQuery (already base64):
SELECT TO_BASE64(col) FROM t;

-- Strategy 3: Compare hash of binary data
-- All databases support MD5 or SHA-256 of binary columns
SELECT MD5(col) FROM t;  -- Works in most databases
```

**Reladiff Implication**: For binary columns, Reladiff should compare using hash values (MD5 or SHA-256) rather than raw bytes, as the wire format and display format differ across databases.

---

## 9. Array and Complex Types

### 9.1 Array Type Support

| Database | Array Type | Element Type Constraint | Nested Arrays |
|----------|-----------|----------------------|--------------|
| PostgreSQL | ARRAY | Must be homogeneous typed | Yes |
| Snowflake | ARRAY (VARIANT) | No constraint (VARIANT elements) | Yes |
| BigQuery | ARRAY | Must be homogeneous typed | No (no nested ARRAY) |
| DuckDB | LIST | Must be homogeneous typed | Yes |
| DuckDB | ARRAY (fixed-size) | Must be homogeneous typed | Yes |
| MySQL | No native array type | N/A | N/A |
| Databricks | ARRAY | Must be homogeneous typed | Yes |

### 9.2 Array Comparison Semantics

```sql
-- PostgreSQL: Arrays are compared element-by-element, position-sensitive
SELECT ARRAY[1,2,3] = ARRAY[1,2,3];  -- true
SELECT ARRAY[1,2,3] = ARRAY[3,2,1];  -- false (order matters)
SELECT ARRAY[1,2,3] = ARRAY[1,2];    -- false (length matters)

-- DuckDB: Same semantics as PostgreSQL
SELECT [1,2,3] = [1,2,3];  -- true
SELECT [1,2,3] = [3,2,1];  -- false

-- Snowflake: ARRAY comparison
SELECT ARRAY_CONSTRUCT(1,2,3) = ARRAY_CONSTRUCT(1,2,3);  -- true
SELECT ARRAY_CONSTRUCT(1,2,3) = ARRAY_CONSTRUCT(3,2,1);  -- false

-- BigQuery: ARRAY comparison is NOT directly supported
-- Must use ARRAY_TO_STRING or element-wise comparison
```

### 9.3 Order-Sensitive vs Order-Insensitive Comparison

For data validation, arrays sometimes represent sets (order doesn't matter) and sometimes represent sequences (order matters):

```sql
-- Order-insensitive comparison in PostgreSQL:
-- Sort elements before comparing
SELECT ARRAY(SELECT UNNEST(ARRAY[3,1,2]) ORDER BY 1)
     = ARRAY(SELECT UNNEST(ARRAY[1,2,3]) ORDER BY 1);
-- Result: true

-- Snowflake: Sort then compare
SELECT ARRAY_SORT(ARRAY_CONSTRUCT(3,1,2)) = ARRAY_SORT(ARRAY_CONSTRUCT(1,2,3));
-- Result: true

-- DuckDB: Sort then compare
SELECT list_sort([3,1,2]) = list_sort([1,2,3]);
-- Result: true
```

### 9.4 Struct/Map Types

```sql
-- DuckDB: STRUCT (typed, positional)
SELECT {'x': 1, 'y': 2} = {'x': 1, 'y': 2};  -- true
SELECT {'x': 1, 'y': 2} = {'y': 2, 'x': 1};  -- Comparison is by field name

-- DuckDB: MAP (key-value pairs, may have duplicate keys)
SELECT MAP {'a': 1, 'b': 2} = MAP {'b': 2, 'a': 1};  -- true (order-independent)

-- PostgreSQL: No native MAP type, uses JSONB for key-value pairs
-- Snowflake: OBJECT type (within VARIANT) — key-value pairs
-- BigQuery: STRUCT type — named fields, compared positionally

-- BigQuery STRUCT comparison:
SELECT STRUCT(1 AS x, 2 AS y) = STRUCT(1 AS x, 2 AS y);  -- true
SELECT STRUCT(1 AS x, 2 AS y) = STRUCT(1 AS a, 2 AS b);  -- true! (ignores field names)
```

**Critical Difference**: BigQuery STRUCT comparison ignores field names and compares positionally. Snowflake VARIANT object comparison considers both keys and values. This means the same data structure could compare as equal in BigQuery but unequal in Snowflake.

**Reladiff Implication**: For complex types, Reladiff should offer both order-sensitive and order-insensitive comparison modes. For struct/map types, it should offer both positional and named comparison modes.

---

## 10. Practical Mitigation Strategies

### 10.1 Type Canonicalization

The fundamental strategy for cross-database comparison is to normalize values to a canonical representation before comparison. Here is a proposed canonicalization scheme for Reladiff:

#### Numeric Canonicalization

```
Source Type                     → Canonical Type
────────────────────────────────────────────────
INT/INTEGER (any DB)            → INT64
BIGINT (any DB)                 → INT64
HUGEINT (DuckDB)                → STRING (decimal representation)
NUMBER(38,0) (Snowflake)        → INT64 (if fits) or STRING
FLOAT/REAL (4-byte)             → FLOAT64
DOUBLE/FLOAT (8-byte)           → FLOAT64
NUMERIC/DECIMAL                 → DECIMAL(p,s) with explicit precision
MONEY (PostgreSQL)              → DECIMAL(19,4)
```

**Implementation approach**:
```sql
-- Cast to string with explicit format for hash comparison:
-- PostgreSQL:
SELECT TO_CHAR(numeric_col, 'FM9999999999999999999.9999999999')
-- Snowflake:
SELECT TO_CHAR(number_col, 'TM9')
-- This normalizes the text representation across databases
```

#### String Canonicalization

```
Step 1: Encoding normalization → UTF-8 NFC
Step 2: Optional trailing space trim → RTRIM()
Step 3: Optional invisible character removal → regexp_replace with Unicode category
Step 4: Optional case normalization → UPPER() or LOWER()
Step 5: Optional collation-aware comparison
```

#### Timestamp Canonicalization

```
Step 1: Convert to UTC (if timezone-aware)
Step 2: Truncate to common precision (microseconds for most, seconds for MySQL)
Step 3: Format as ISO 8601: 'YYYY-MM-DD HH:MM:SS.ffffff'
```

### 10.2 Configurable Tolerance for Numeric Comparison

Reladiff should support multiple tolerance modes:

```yaml
# reladiff.yaml configuration
comparison:
  numeric:
    # Absolute tolerance: values within ±epsilon are considered equal
    absolute_tolerance: 0.0001

    # Relative tolerance: values within ±(value * epsilon) are considered equal
    relative_tolerance: 0.00001  # 0.001%

    # ULP (Units in the Last Place) tolerance: IEEE 754 aware
    ulp_tolerance: 2  # Allow 2 ULPs of difference

    # Precision truncation: compare only N significant digits
    significant_digits: 10

  string:
    # Trailing space handling
    trim_trailing_spaces: true

    # Unicode normalization
    normalize_unicode: "NFC"  # or "NFD", "NFKC", "NFKD", "none"

    # Case sensitivity
    case_sensitive: true

    # Invisible character handling
    strip_invisible_chars: true

  timestamp:
    # Precision truncation
    precision: "microseconds"  # or "milliseconds", "seconds"

    # Timezone handling
    normalize_to_utc: true

  boolean:
    # Normalize to true/false
    normalize: true
    # Treat MySQL TINYINT(1) as boolean
    mysql_tinyint_as_boolean: true

  null:
    # How to handle empty string vs NULL
    empty_string_equals_null: false

  json:
    # Key ordering
    sort_keys: true
    # Number precision
    number_tolerance: 0.0001
    # NULL handling
    missing_key_equals_null: true
```

### 10.3 Collation-Aware String Comparison

For cross-database string comparison, Reladiff can implement comparison in three modes:

1. **Binary comparison** (strictest): Compare raw bytes. Fast but produces false positives for collation differences.

2. **Normalized comparison** (recommended default): Apply NFC normalization, optional case folding, optional RTRIM. Covers most cross-database scenarios.

3. **Collation-aware comparison** (most permissive): Use ICU collation rules to compare strings as the source database would. This requires knowing the source collation.

### 10.4 Custom Comparators for Complex Types

For JSON, arrays, and struct types, Reladiff should implement pluggable comparators:

```rust
// Pseudo-code for Reladiff comparator trait
trait ValueComparator {
    fn compare(&self, left: &Value, right: &Value) -> ComparisonResult;
}

// JSON comparator that handles key ordering, number precision, null semantics
struct JsonComparator {
    sort_keys: bool,
    number_tolerance: f64,
    missing_key_equals_null: bool,
}

// Array comparator with order sensitivity option
struct ArrayComparator {
    order_sensitive: bool,
    element_comparator: Box<dyn ValueComparator>,
}

// Numeric comparator with configurable tolerance
struct NumericComparator {
    absolute_tolerance: Option<f64>,
    relative_tolerance: Option<f64>,
    significant_digits: Option<u32>,
}
```

### 10.5 What Existing Tools Do

#### Datafold (data-diff)

Datafold's approach to cross-database comparison:

- **Hashing**: Uses MD5 hashing with string casting for column values. Casts all values to character strings before hashing to normalize type differences.
- **Type alignment**: Automatically casts values to a common precision when comparing decimals with different precisions (e.g., `DECIMAL(38,15)` in SQL Server vs `DECIMAL(38,19)` in Snowflake).
- **Timestamp alignment**: Adjusts timestamp precision between databases (e.g., milliseconds in SQL Server vs nanoseconds in Snowflake).
- **Numeric tolerance**: Supports tolerance levels for FLOAT comparisons to avoid flagging inconsequential differences.
- **Algorithm**: Binary search with checksumming for efficient diff detection on large tables.

**Limitation**: data-diff's MD5 approach requires that the string representation of values be identical, which fails for many of the edge cases documented in this research (NaN, Infinity, JSON key ordering, Unicode normalization).

#### Great Expectations

Great Expectations takes a different approach — it validates data quality within a single database rather than comparing across databases:

- **Numeric**: Expectations like `expect_column_values_to_be_between`, `expect_column_mean_to_be_between` with configurable min/max values.
- **String**: Pattern matching, regex validation, set membership.
- **Cross-batch**: Compare today's data against yesterday's with tolerance thresholds.
- **`mostly` parameter**: Allows expectations to pass if a configurable percentage (e.g., 99%) of rows meet the criteria.

**Limitation**: Not designed for row-level cross-database comparison. Better suited for schema and aggregate validation.

### 10.6 Recommended Architecture for Reladiff

Based on the research in this document, here is the recommended approach for handling cross-database semantics in Reladiff:

#### Layer 1: Type Inference and Mapping

```
For each column pair being compared:
1. Determine source type in each database
2. Map to a canonical Reladiff type:
   - RelaInt64, RelaInt128, RelaFloat64, RelaDecimal(p,s)
   - RelaString(encoding, collation)
   - RelaTimestamp(precision, timezone_mode)
   - RelaBoolean
   - RelaJson
   - RelaBinary
   - RelaArray(element_type)
   - RelaNull
3. Determine comparison strategy based on type pair
```

#### Layer 2: Value Normalization

```
For each value being compared:
1. Cast to canonical type
2. Apply normalization rules:
   - Numeric: round to common precision, normalize NaN/Infinity
   - String: normalize encoding, collation, whitespace, invisible chars
   - Timestamp: convert to UTC, truncate to common precision
   - Boolean: normalize to true/false
   - JSON: sort keys, normalize whitespace, handle null semantics
   - Binary: hash
3. Produce comparable representation
```

#### Layer 3: Comparison

```
For each pair of normalized values:
1. Apply configured comparison mode:
   - Exact: byte-for-byte equality
   - Tolerant: within configured tolerance
   - Semantic: type-aware equality (e.g., JSON structural equality)
2. Report differences with context:
   - Raw values from each side
   - Normalized values
   - Why they differ (type mismatch, precision loss, encoding, etc.)
```

#### Layer 4: Reporting

```
For detected differences:
1. Categorize by cause:
   - True data difference (different logical values)
   - Type representation difference (same logical value, different representation)
   - Precision loss (value truncated by one database)
   - Semantic ambiguity (e.g., NULL vs empty string vs missing JSON key)
2. Allow filtering by category
3. Provide remediation suggestions
```

---

## Appendix A: Quick Reference — Cross-Database Behavior Matrix

### A.1 Numeric Behaviors

| Behavior | PG | MySQL | Snowflake | BigQuery | DuckDB | Databricks |
|----------|-------|-------|-----------|----------|--------|------------|
| `5/2` result | 2 | 2.5 | 2.5 | 2.5 | 2 | 2 |
| `1/0` result | Error | NULL | Error | Error | Error | NULL |
| NaN support | Yes | No | No | Yes | Yes | Yes |
| Infinity support | Yes | No | No | Yes | Yes | Yes |
| `ROUND(2.5)` (numeric) | 3 | 3 | 3 | 3 | 3 | 2 |
| `ROUND(2.5)` (float) | 2 | 3 | 2 | 2 | 2 | 2 |
| Max integer type | INT64 | INT64 | NUMBER(38,0) | INT64 | INT128 | INT64 |
| Overflow behavior | Error | Clamp* | Error | Error | Error | Wrap |

*MySQL: in non-strict mode; error in strict mode.

### A.2 String Behaviors

| Behavior | PG | MySQL | Snowflake | BigQuery | DuckDB | Databricks |
|----------|-------|-------|-----------|----------|--------|------------|
| Default case-sensitive | Yes | **No** | Yes | Yes | Yes | Yes |
| `'a' = 'a '` | false | **true*** | false | false | false | false |
| `'' IS NULL` | false | false | false | false | false | false |
| Unicode normalization | No | Partial | No | No | No | No |
| Max VARCHAR | 1 GB | 65 KB | 128 MB | 2 MB | No limit | No limit |
| Full UTF-8 | Yes | utf8mb4 | Yes | Yes | Yes | Yes |

*MySQL: with PAD SPACE collations (traditional default).

### A.3 NULL Behaviors

| Behavior | PG | MySQL | Snowflake | BigQuery | DuckDB | Databricks |
|----------|-------|-------|-----------|----------|--------|------------|
| NULL ORDER BY ASC | Last | **First** | Last | Last | Last | Last |
| NULL in GROUP BY | Grouped | Grouped | Grouped | Grouped | Grouped | Grouped |
| NULL in DISTINCT | One NULL | One NULL | One NULL | One NULL | One NULL | One NULL |
| IS NOT DISTINCT FROM | Yes | No (`<=>`) | Yes | Yes | Yes | Yes |
| `CONCAT(x, NULL)` | NULL | NULL | NULL | NULL | NULL | NULL |

### A.4 Timestamp Behaviors

| Behavior | PG | MySQL | Snowflake | BigQuery | DuckDB | Databricks |
|----------|-------|-------|-----------|----------|--------|------------|
| Default precision | 6 (μs) | **0 (s!)** | 9 (ns) | 6 (μs) | 6 (μs) | 6 (μs) |
| `TIMESTAMP` meaning | Without TZ | Auto-UTC | **NTZ** | **Always UTC** | Without TZ | With TZ |
| 2038 limit | No | **Yes** (TIMESTAMP) | No | No | No | No |
| DST handling | Via TZ DB | Via TZ DB | Via TZ DB | Via TZ DB | Via TZ DB | Via TZ DB |

### A.5 Boolean Behaviors

| Behavior | PG | MySQL | Snowflake | BigQuery | DuckDB | Databricks |
|----------|-------|-------|-----------|----------|--------|------------|
| Native boolean | Yes | **No** (TINYINT) | Yes | Yes | Yes | Yes |
| Accepts `'yes'` | No | No | **Yes** | No | No | No |
| Accepts `2` as true | Error | **Yes** | **Yes** | Error | Error | Error |

---

## Appendix B: SQL Snippets for Type Introspection

### Detecting Column Types Across Databases

```sql
-- PostgreSQL: Get column types
SELECT column_name, data_type, numeric_precision, numeric_scale,
       character_maximum_length, datetime_precision
FROM information_schema.columns
WHERE table_name = 'my_table' AND table_schema = 'public';

-- MySQL: Get column types with character set
SELECT column_name, data_type, numeric_precision, numeric_scale,
       character_maximum_length, character_set_name, collation_name
FROM information_schema.columns
WHERE table_name = 'my_table' AND table_schema = 'my_database';

-- Snowflake: Get column types
SELECT column_name, data_type, numeric_precision, numeric_scale,
       character_maximum_length
FROM information_schema.columns
WHERE table_name = 'MY_TABLE' AND table_schema = 'PUBLIC';

-- BigQuery: Get column types
SELECT column_name, data_type
FROM `project.dataset.INFORMATION_SCHEMA.COLUMNS`
WHERE table_name = 'my_table';

-- DuckDB: Get column types
SELECT column_name, data_type, numeric_precision, numeric_scale
FROM information_schema.columns
WHERE table_name = 'my_table';
```

### Detecting Problematic Data

```sql
-- Detect NaN values (PostgreSQL/DuckDB)
SELECT COUNT(*) FROM t WHERE val != val;  -- NaN != NaN is false, but val != val is true only for NaN
-- Actually in PostgreSQL, NaN = NaN is true, so use:
SELECT COUNT(*) FROM t WHERE val = 'NaN'::double precision;

-- Detect Infinity values (PostgreSQL)
SELECT COUNT(*) FROM t WHERE val = 'Infinity'::double precision OR val = '-Infinity'::double precision;

-- Detect zero-width characters (PostgreSQL)
SELECT COUNT(*) FROM t WHERE string_col ~ '[\u200B\u200C\u200D\u00AD\uFEFF]';

-- Detect trailing spaces (any database)
SELECT COUNT(*) FROM t WHERE string_col <> RTRIM(string_col);

-- Detect non-UTF-8 sequences (PostgreSQL)
SELECT COUNT(*) FROM t WHERE string_col IS NOT NULL AND octet_length(string_col) <> length(convert_to(string_col, 'UTF8'));

-- Detect MySQL TINYINT(1) values outside 0/1
SELECT DISTINCT flag_col FROM t WHERE flag_col NOT IN (0, 1) AND flag_col IS NOT NULL;

-- Detect timestamps near 2038 boundary (MySQL)
SELECT COUNT(*) FROM t WHERE ts_col > '2037-01-01';

-- Detect BOM in strings (PostgreSQL)
SELECT COUNT(*) FROM t WHERE LEFT(string_col, 1) = E'\uFEFF';

-- Detect JSON null vs SQL NULL (PostgreSQL)
SELECT COUNT(*) FROM t WHERE json_col::text = 'null';  -- JSON null
SELECT COUNT(*) FROM t WHERE json_col IS NULL;           -- SQL NULL

-- Detect precision loss in JSON numbers (PostgreSQL)
SELECT json_col ->> 'id' as id_text,
       (json_col -> 'id')::text as id_raw,
       (json_col ->> 'id')::bigint as id_int
FROM t
WHERE (json_col ->> 'id')::numeric > 9007199254740991;  -- > 2^53 - 1
```

---

## Appendix C: War Stories and Real-World Incidents

### C.1 The Trailing Space Deduplication Bug

**Context**: A data pipeline loaded user emails from a MySQL database (PAD SPACE collation) into Snowflake (binary comparison). The MySQL source had a UNIQUE constraint on the email column. In Snowflake, the deduplication logic broke because `'user@example.com'` and `'user@example.com '` (with trailing space) were treated as different values, whereas MySQL had treated them as duplicates and prevented the second insert.

**Fix**: Apply `RTRIM()` to all string columns before loading, or configure Snowflake with `TRIM_SPACE = TRUE` on file formats.

### C.2 The Emoji Data Loss

**Context**: A social media analytics platform stored user comments in MySQL with `utf8` character set (3-byte). Comments containing emoji were silently truncated at the emoji character. When the data was compared against a Snowflake mirror (which correctly stored full UTF-8), every row containing an emoji showed as different — the MySQL side was truncated, the Snowflake side had the full text.

**Fix**: Migrate MySQL to `utf8mb4`, then re-ingest the original data from the source system.

### C.3 The Timezone Comparison Disaster

**Context**: A financial data warehouse replicated from PostgreSQL (TIMESTAMPTZ, stored as UTC) to Snowflake (TIMESTAMP, which defaults to TIMESTAMP_NTZ). The replication tool extracted timestamps and inserted them as strings. PostgreSQL exported timestamps in the session timezone (America/New_York), and Snowflake stored them as-is without timezone. When comparing the two, every timestamp differed by 4 or 5 hours (depending on DST).

**Fix**: Configure the replication tool to always export timestamps in UTC format, or explicitly use `TIMESTAMP_LTZ` in Snowflake.

### C.4 The Rounding Penny Problem

**Context**: A bank's reconciliation system compared transaction amounts between a PostgreSQL ledger and a Snowflake analytics warehouse. Some transactions showed a 1-cent difference. Investigation revealed that PostgreSQL was using `NUMERIC` type with `ROUND()` (half away from zero), while the Snowflake pipeline used Python `round()` (half to even / banker's rounding) before loading. For a transaction of $2.175, PostgreSQL rounded to $2.18 while Python/Snowflake rounded to $2.18 — but for $2.185, PostgreSQL rounded to $2.19 while Python rounded to $2.18.

**Fix**: Standardize on one rounding mode across the entire pipeline, or compare with 1-cent tolerance for financial amounts.

### C.5 The NULL-Safe Join Failure

**Context**: A data quality check compared two copies of a customer table by joining on `customer_id`. Some customers had NULL values in the `status` column. The join condition `a.status = b.status` failed to match rows where both sides had NULL status (because `NULL = NULL` is NULL, not TRUE). The validation tool reported these as "missing" rows.

**Fix**: Use `IS NOT DISTINCT FROM` (or `<=>` in MySQL) for all join conditions in the comparison, or use `COALESCE(status, '__NULL__')` to replace NULLs with a sentinel value.

### C.6 The data-diff Float Issue

**Context**: GitHub Issue #379 on the data-diff repository documented that comparing float columns between PostgreSQL and Snowflake produces diffs for rows where the values should be identical. The root cause: PostgreSQL's `double precision` and Snowflake's `FLOAT` (also double precision) have different formatting behaviors when converting to string for hashing. PostgreSQL might output `0.1` while Snowflake outputs `1.000000000000000e-01`, producing different MD5 hashes.

**Fix**: Cast both sides to a common string format with explicit precision before hashing, or use tolerance-based comparison instead of hash-based comparison for float columns.

---

## Appendix D: Recommendations for Reladiff Implementation

### Priority 1: Must-Have for Cross-Database Correctness

1. **Numeric tolerance mode**: Absolute and relative tolerance for float/double columns
2. **NULL-safe comparison**: Use `IS NOT DISTINCT FROM` or equivalent in all join conditions
3. **Timestamp precision alignment**: Truncate to common precision before comparison
4. **Timestamp timezone normalization**: Convert to UTC for timezone-aware types
5. **String trailing space handling**: Configurable RTRIM
6. **Boolean normalization**: Map MySQL TINYINT(1) to boolean

### Priority 2: Important for Data Quality

7. **Unicode NFC normalization**: Normalize strings to NFC before comparison
8. **JSON key ordering**: Canonicalize JSON before comparison
9. **Integer division awareness**: Detect computed columns that may use integer division
10. **MySQL utf8 vs utf8mb4 detection**: Warn about potential data loss
11. **Empty string vs NULL handling**: Configurable treatment

### Priority 3: Advanced Features

12. **Collation-aware comparison**: ICU-based string comparison
13. **Array order-insensitive comparison**: Sort arrays before comparison
14. **JSON number precision handling**: Compare JSON numbers with tolerance
15. **Binary comparison via hash**: Use MD5/SHA-256 for BYTEA/BLOB columns
16. **NaN/Infinity handling**: Normalize special float values to NULL or sentinel
17. **Invisible character detection**: Strip zero-width characters
18. **BOM detection and removal**: Strip UTF-8 BOMs from string values
19. **Mojibake detection**: Pattern-match common mojibake sequences and warn

### Priority 4: Diagnostic and Reporting

20. **Type compatibility matrix**: Before comparison, report type mappings and potential issues
21. **Precision loss detection**: Identify columns where precision was lost in conversion
22. **False positive categorization**: Separate true data diffs from representation diffs
23. **Remediation suggestions**: For each diff category, suggest configuration changes

---

## Appendix E: Per-Database Cheat Sheets

### E.1 PostgreSQL Gotchas for Cross-Database Comparison

- `NUMERIC` rounds ties away from zero; `DOUBLE PRECISION` rounds to even
- `FLOAT` is 4-byte (not 8-byte like Snowflake)
- Integer division truncates: `5/2 = 2`
- NaN and Infinity supported in floating-point AND numeric types
- `MONEY` type is locale-dependent — avoid or cast to `NUMERIC`
- `TIMESTAMPTZ` stores UTC, displays in session timezone
- `BYTEA` hex output includes `\x` prefix
- Strings are binary-compared by default (case-sensitive, no trailing space padding)
- `JSONB` sorts keys alphabetically, removes duplicate keys
- No `IFNULL` — use `COALESCE`
- ARRAY comparison is position-sensitive

### E.2 MySQL Gotchas for Cross-Database Comparison

- Default collation is case-insensitive and accent-insensitive
- PAD SPACE collations ignore trailing spaces in `=` but NOT in `LIKE`
- `utf8` character set is only 3-byte — use `utf8mb4` for full UTF-8
- `BOOLEAN` is `TINYINT(1)` — can store values other than 0/1
- `FLOAT(M,D)` is deprecated and silently truncates
- Non-strict mode silently truncates, clamps, and converts invalid data
- `TIMESTAMP` has a 2038 limit and auto-converts to/from UTC
- `DATETIME` has zero fractional seconds by default
- Integer division returns float: `5/2 = 2.5`
- Division by zero returns NULL (not an error)
- No native `IS NOT DISTINCT FROM` — use `<=>`
- NULL sorts FIRST in ascending order (opposite of most databases)
- No native ARRAY type

### E.3 Snowflake Gotchas for Cross-Database Comparison

- `FLOAT` is always 8-byte double (not 4-byte like PostgreSQL)
- `INTEGER` is `NUMBER(38,0)` — always 128-bit
- `NUMBER` without scale defaults to `NUMBER(38,0)` (zero decimal places!)
- `TIMESTAMP` defaults to `TIMESTAMP_NTZ` (no timezone) — major trap
- `TIMESTAMP_LTZ` behavior depends on session timezone
- `TIMESTAMP_TZ` stores offset, not timezone name (no DST awareness)
- NaN and Infinity are NOT supported
- Division by zero is an error (use `DIV0` or `DIV0NULL`)
- `VARIANT` does not preserve JSON key ordering
- `VARIANT` null is distinct from SQL NULL
- `BOOLEAN` accepts 'yes', 'no', 'y', 'n', 'on', 'off'
- `ARRAY` elements are always VARIANT type
- String comparison is case-sensitive (but identifier comparison is case-insensitive)
- `COLLATE` function affects only simple comparison operators

### E.4 BigQuery Gotchas for Cross-Database Comparison

- Only `INT64` — no 32-bit integer type
- `NUMERIC` is `NUMERIC(29,9)` — 29 pre-decimal, 9 post-decimal digits
- `BIGNUMERIC` for larger precision: up to 76 digits
- `FLOAT64` only (no 4-byte float)
- `TIMESTAMP` is always UTC; `DATETIME` has no timezone
- No `CHAR` type — only `STRING`
- `STRING` max is 2 MB
- `STRUCT` comparison ignores field names (positional only)
- No nested `ARRAY` types
- `ARRAY` comparison not directly supported
- IEEE division available via `IEEE_DIVIDE` (returns Inf/NaN instead of error)
- `IS NOT DISTINCT FROM` supported (since 2023)

### E.5 DuckDB Gotchas for Cross-Database Comparison

- `HUGEINT` (INT128) — no equivalent in other databases
- Integer division truncates: `5/2 = 2`
- Division by zero: error for integers, Infinity for floats (IEEE 754)
- NaN = NaN is true (deviation from IEEE 754)
- `LIST` (variable length) vs `ARRAY` (fixed length) — both exist
- `MAP` type supports order-independent comparison
- `STRUCT` comparison is lexicographic with NULL as largest
- Unlimited string length
- Multiple timestamp precision types: `TIMESTAMP`, `TIMESTAMP_S`, `TIMESTAMP_MS`, `TIMESTAMP_NS`
- PostgreSQL-compatible NULL ordering (NULLS LAST in ASC)

### E.6 Databricks Gotchas for Cross-Database Comparison

- `TIMESTAMP` default includes timezone (session-aware)
- `TIMESTAMP_NTZ` available since Delta Lake protocol upgrade
- Integer division truncates: `5/2 = 2`
- Division by zero returns NULL
- `ROUND(2.5)` uses half-to-even (banker's rounding) — differs from most databases
- Supports `IS NOT DISTINCT FROM` and `<=>`
- `DECIMAL` max precision is 38 digits
- Integer overflow wraps around (Java-style) — dangerous
- `ARRAY`, `MAP`, `STRUCT` types supported
- Based on Apache Spark SQL semantics

---

## References

### Official Documentation

- [PostgreSQL 18: Numeric Types](https://www.postgresql.org/docs/current/datatype-numeric.html)
- [Snowflake: Numeric Data Types](https://docs.snowflake.com/en/sql-reference/data-types-numeric)
- [BigQuery: Data Types](https://cloud.google.com/bigquery/docs/reference/standard-sql/data-types)
- [MySQL 8.4: Floating-Point Types](https://dev.mysql.com/doc/refman/8.4/en/floating-point-types.html)
- [DuckDB: Numeric Types](https://duckdb.org/docs/stable/sql/data_types/numeric)
- [Snowflake: Date & Time Data Types](https://docs.snowflake.com/en/sql-reference/data-types-datetime)
- [Snowflake: Collation Support](https://docs.snowflake.com/en/sql-reference/collation)
- [Snowflake: IS NOT DISTINCT FROM](https://docs.snowflake.com/en/sql-reference/functions/is-distinct-from)
- [PostgreSQL 18: JSON Types](https://www.postgresql.org/docs/current/datatype-json.html)
- [PostgreSQL 18: Binary Data Types](https://www.postgresql.org/docs/current/datatype-binary.html)
- [Snowflake: Semi-Structured Data Types](https://docs.snowflake.com/en/sql-reference/data-types-semistructured)
- [Snowflake: DIV0 and DIV0NULL](https://docs.snowflake.com/en/sql-reference/functions/div0)
- [Databricks: TIMESTAMP_NTZ](https://docs.databricks.com/aws/en/sql/language-manual/data-types/timestamp-ntz-type)
- [Databricks: NULL Semantics](https://docs.databricks.com/aws/en/sql/language-manual/sql-ref-null-semantics)

### Blog Posts and Articles

- [FLOAT vs NUMERIC in BigQuery](https://medium.com/data-engineers-notes/float-vs-numeric-in-bigquery-47c66053b03e)
- [TIMESTAMPS in Snowflake: NTZ vs LTZ vs TZ](https://medium.com/snowflake/timestamps-in-snowflake-ntz-vs-ltz-vs-tz-790e8c60a00d)
- [Snowflake Supports Banker's Rounding](https://medium.com/snowflake/snowflake-supports-bankers-rounding-f342f656c124)
- [Working with Money in PostgreSQL](https://www.crunchydata.com/blog/working-with-money-in-postgres)
- [MySQL utf8 vs utf8mb4](https://mathiasbynens.be/notes/mysql-utf8mb4)
- [Summary of Trailing Spaces in MySQL](https://saveriomiroddi.github.io/Summary-of-trailing-spaces-handling-in-MySQL-with-version-8.0-upgrade-considerations/)
- [How NULL and Empty Strings are Treated in PostgreSQL vs Oracle](https://www.enterprisedb.com/postgres-tutorials/how-null-and-empty-strings-are-treated-postgresql-vs-oracle)
- [PostgreSQL to Snowflake Migration](https://medium.com/@vithakota/postgresql-to-snowflake-migration-2-50bcc6952c85)
- [DATETIME vs TIMESTAMP in BigQuery](https://medium.com/data-engineers-notes/datetime-vs-timestamp-in-bigquery-e09dff06e245)
- [Choosing the Right Case Insensitive Collation in Snowflake](https://medium.com/snowflake/choosing-the-right-case-insensitive-collation-in-snowflake-a-deep-dive-into-upper-and-lower-67cf94d17a4e)
- [IS DISTINCT FROM — Modern SQL](https://modern-sql.com/feature/is-distinct-from)
- [Timestamps Are Hard — Omni Analytics](https://omni.co/blog/database-timestamps)
- [Integer Division Behavior Across SQL Databases](https://selectfromwhereand.com/posts/sql_types/)

### Tools and Projects

- [Datafold data-diff: Technical Explanation](https://github.com/datafold/data-diff/blob/master/docs/technical-explanation.md)
- [Datafold: Best Practices for Cross-Database Diffing](https://docs.datafold.com/data-diff/cross-database-diffing/best-practices)
- [data-diff Issue #379: Float Column Diffs Between PostgreSQL and Snowflake](https://github.com/datafold/data-diff/issues/379)
- [data-diff Issue #103: Shared Hashing Algorithm](https://github.com/datafold/data-diff/issues/103)
- [DuckDB Issue #530: Convert NaN and Infinity to NULL](https://github.com/duckdb/duckdb/issues/530)
- [MySQL WL#12595: Deprecate FLOAT(M,D)](https://dev.mysql.com/worklog/task/?id=12595)
- [MySQL Bug #7361: Strange Data Truncation with float(M,30)](https://bugs.mysql.com/7361)
- [MySQL Bug #64772: Trailing Whitespace Ignored in WHERE](https://bugs.mysql.com/bug.php?id=64772)

### Standards

- [IEEE 754-2019: Standard for Floating-Point Arithmetic](https://en.wikipedia.org/wiki/IEEE_754)
- [Unicode Normalization Forms (UAX #15)](https://unicode.org/reports/tr15/)
- [Year 2038 Problem](https://en.wikipedia.org/wiki/Year_2038_problem)
- [RFC 7159: The JavaScript Object Notation (JSON) Data Interchange Format](https://tools.ietf.org/html/rfc7159)
