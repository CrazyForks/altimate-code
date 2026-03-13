# Theme B: Cross-Database Type Coercion Issues

_Iteration 2 — 2026-03-13_

## 1. Numeric Precision — Default Scale Divergence

The most insidious issue: **databases disagree on what "NUMERIC" means without explicit precision/scale**.

| Database | Default NUMERIC | Max Precision | Max Scale |
|----------|----------------|---------------|-----------|
| Snowflake | `NUMBER(38, 0)` — **integers only!** | 38 | 37 |
| PostgreSQL | Unconstrained (up to 131,072.16,383) | 1000 (explicit) | 16,383 |
| BigQuery NUMERIC | `NUMERIC(38, 9)` | 38 | 9 |
| BigQuery BIGNUMERIC | `BIGNUMERIC(76, 38)` | 76 | 38 |

**Concrete failure:**
```sql
-- PostgreSQL: stores 123.456789 perfectly
INSERT INTO pg_test (val) VALUES (123.456789);  -- 123.456789

-- Snowflake: silently truncates to integer!
INSERT INTO sf_test (val) VALUES (123.456789);  -- 124 (rounded!)

-- BigQuery: keeps 9 decimal places
SELECT CAST(123.456789 AS NUMERIC);  -- 123.456789000
```

Documented in [dbt-core #8183](https://github.com/dbt-labs/dbt-core/issues/8183).

### Float Comparison False Positives

[data-diff #379](https://github.com/datafold/data-diff/issues/379): comparing `double precision` (Postgres) vs `FLOAT` (Snowflake) produces false diffs because each DB rounds differently when casting float → decimal → varchar.

### NUMBER to FLOAT Round-Trip Loss

Snowflake docs warn: converting `NUMBER(38,37)` to `DOUBLE` and back loses precision (DOUBLE only ~15 significant digits). PostgreSQL's NUMERIC has no such limitation.

## 2. Boolean Representation Matrix

| Database | True Literals | False Literals | Output Format |
|----------|---------------|----------------|---------------|
| PostgreSQL | `true`, `'t'`, `'yes'`, `'1'` | `false`, `'f'`, `'no'`, `'0'` | `t`/`f` |
| Snowflake | `true`, `'t'`, `'yes'`, `'on'`, `'1'` | `false`, `'f'`, `'no'`, `'off'`, `'0'` | `true`/`false` |
| MySQL | Any non-zero integer | `0` | `1`/`0` |
| Oracle | No native type | N/A | `'Y'`/`'N'` typically |
| BigQuery | `TRUE` | `FALSE` | `true`/`false` |

String comparison of boolean output: Postgres `'t'` vs Snowflake `'true'` vs MySQL `'1'` — all mean the same thing but compare as different strings.

## 3. Timestamp Precision Divergence

| Database | Default Precision | Max | Type |
|----------|------------------|-----|------|
| Snowflake TIMESTAMP_NTZ | 9 (nanoseconds) | 9 | Wall-clock, no TZ |
| PostgreSQL TIMESTAMP | 6 (microseconds) | 6 | Wall-clock, no TZ |
| PostgreSQL TIMESTAMPTZ | 6 (microseconds) | 6 | UTC internally |
| BigQuery TIMESTAMP | 6 (microseconds) | 6 | UTC internally |

Snowflake nanoseconds get truncated to microseconds in Postgres — creates phantom diffs.

### TIMESTAMP_NTZ vs TIMESTAMPTZ Semantic Trap

```sql
-- Snowflake TIMESTAMP_NTZ: stores wall-clock (no TZ awareness)
-- Can store times that don't exist (DST gap: 2:30 AM on spring-forward day)

-- PostgreSQL TIMESTAMPTZ: converts to UTC
-- Rejects or adjusts non-existent times during DST transitions
```

### INTERVAL Type: Not Even Portable

- **PostgreSQL**: Full `INTERVAL` data type, storable
- **Snowflake**: INTERVAL is NOT a data type — only a literal in date arithmetic
- **BigQuery**: Has `INTERVAL` but three independent parts
- **DuckDB**: Full `INTERVAL` with months/days/microseconds

Migrating from BigQuery to Snowflake: `INTERVAL` columns become `VARCHAR`.

## 4. JSON/Semi-Structured

### JSON Key Ordering

- **PostgreSQL `json`**: Preserves insertion order
- **PostgreSQL `jsonb`**: Reorders alphabetically, removes duplicates
- **Snowflake VARIANT/OBJECT**: Does NOT preserve order (TO_JSON output is "not predictable")

String-based comparison of JSON values across databases breaks on key ordering.

### Dual NULL Problem (Snowflake-specific)

```sql
-- Snowflake: SQL NULL vs JSON null are DIFFERENT
SELECT PARSE_JSON('null');   -- VARIANT containing JSON null (a value)
SELECT PARSE_JSON(NULL);     -- SQL NULL (absence of value)
```

PostgreSQL/BigQuery don't have this distinction — JSON nulls map to SQL NULL during migration.

### Number Precision in JSON

BigQuery can lose precision for integers > 2^53 when processing through FLOAT64 paths. Snowflake PARSE_JSON preserves exact numeric representation.

## 5. Array Types

| Database | NULL Elements | Nested Arrays |
|----------|---------------|---------------|
| PostgreSQL ARRAY | Yes | Yes (multidimensional) |
| Snowflake ARRAY | Yes (both SQL NULL and JSON null) | Yes |
| BigQuery ARRAY | **No (cannot contain NULLs)** | **No** |
| DuckDB LIST | Yes | Yes |

```sql
-- BigQuery: FATAL
SELECT [1, NULL, 3];  -- ERROR: Array cannot have a NULL element

-- PostgreSQL: fine
SELECT ARRAY[1, NULL, 3];  -- {1,NULL,3}
```

### Serialization Differences

Same logical array, three representations:
- PostgreSQL: `{1,2,3}`
- Snowflake: `[1,2,3]` (JSON format)
- BigQuery: must use `ARRAY_TO_STRING` → `1,2,3`

## 6. Character Types

### CHAR Padding: The Silent Corruptor

```sql
-- PostgreSQL: CHAR(10) pads with spaces, comparison ignores trailing spaces
SELECT 'hello'::CHAR(10) = 'hello     ';  -- TRUE

-- Snowflake: CHAR is alias for VARCHAR, NO PADDING
SELECT 'hello'::CHAR(10) = 'hello     ';  -- FALSE
```

### Binary Encoding

Same binary value, three representations:
- PostgreSQL BYTEA: `\x48656c6c6f` (hex with prefix)
- Snowflake BINARY: `48656c6c6f` (hex, no prefix)
- BigQuery BYTES: `SGVsbG8=` (base64)

## Implications for Reladiff

### What We Handle Today
- Numeric tolerance (absolute threshold)
- Timestamp tolerance (millisecond threshold)
- String comparison (exact, case-sensitive)

### What We Should Consider
1. **Precision-aware numeric comparison** — know when DECIMAL vs FLOAT round-trip loses precision
2. **Boolean normalization** — canonical form before comparison across databases
3. **Timestamp precision truncation** — automatically detect nano vs micro and adjust tolerance
4. **JSON canonical comparison** — parse and compare structurally, not as strings
5. **CHAR padding normalization** — trim trailing spaces when comparing across Postgres/Snowflake
6. **Type coercion matrix** — per-database-pair mapping of type equivalences

### Sources
- [dbt-core #8183](https://github.com/dbt-labs/dbt-core/issues/8183), [data-diff #379](https://github.com/datafold/data-diff/issues/379), [data-diff #877](https://github.com/datafold/data-diff/issues/877)
- Snowflake, PostgreSQL, BigQuery official documentation
- [Timestamps Are Hard (Omni Analytics)](https://omni.co/blog/database-timestamps)

---

## Iteration 2 — Deep Dive

_Added 2026-03-13 — Extends Iteration 1 with Snowflake-specific, BigQuery-specific, DuckDB-specific, cross-database mapping, migration war stories, and JSON comparison findings._

### 7. Snowflake Semi-Structured vs Structured Types

Snowflake now has **two parallel type systems** for nested data, and they are not interchangeable.

#### VARIANT (semi-structured) vs OBJECT/ARRAY/MAP (structured)

| Aspect | VARIANT / semi-structured | Structured OBJECT/ARRAY/MAP |
|--------|--------------------------|----------------------------|
| Schema | Schema-on-read, any shape | Schema-on-write, fixed element types |
| NULL semantics | Dual NULL (SQL NULL vs JSON null) | SQL NULL only (JSON nulls convert on cast) |
| Key ordering | Not preserved (TO_JSON output "not predictable") | Not preserved |
| Max sub-columns | 200 auto-extracted per partition | 1,000 per column |
| Comparison | Cannot compare with structured types | Supports `=`, `!=`, `<`, `>` between same structured types |
| Table support | All table types | Standard tables only (not dynamic, hybrid, or external) |
| Schema evolution | N/A (schemaless) | **Not supported** — column type changes require table recreation |

**Critical restriction:** You cannot nest a structured type inside a VARIANT, or vice versa. Passing a structured OBJECT to `OBJECT_CONSTRUCT()` or `ARRAY_CONSTRUCT()` triggers an implicit coercion error. This means migration from VARIANT columns to structured types requires explicit `CAST()` at every boundary.

**Coercion rules between structured types:**
- `ARRAY(NUMBER)` can coerce to `ARRAY(DOUBLE)` (numeric-to-numeric)
- `ARRAY(NUMBER)` **cannot** coerce to `ARRAY(VARCHAR)` (cross-category blocked)
- MAP keys restricted to `VARCHAR` or `NUMBER` with scale 0 — floating-point keys prohibited
- `TRY_CAST` is **not supported** for structured types

Source: [Snowflake Structured Data Types](https://docs.snowflake.com/en/sql-reference/data-types-structured)

#### VARIANT Column Extraction Gotchas

Snowflake auto-extracts VARIANT elements into columnar storage for performance, but several conditions silently prevent extraction:

1. **Any JSON null in a column** — if even a single row has a JSON `null` for a key, that entire key stays unextracted (full JSON scan per row)
2. **Mixed types across rows** — if `foo` is `1` in one row and `"1"` in another, no extraction
3. **Max 200 elements** per partition (configurable via Snowflake Support)
4. **Non-native types stored as strings** — dates, timestamps, and numbers-as-strings in VARIANT consume more storage and execute slower than relational equivalents

Source: [Snowflake VARIANT Considerations](https://docs.snowflake.com/en/user-guide/semistructured-considerations)

#### LATERAL FLATTEN Type Inference

When flattening semi-structured data, the `VALUE` column from FLATTEN is always VARIANT. Explicit casting is required:

```sql
SELECT f.value::STRING AS name, f.value::INT AS id
FROM my_table, LATERAL FLATTEN(input => my_table.data:items) f;
```

**Key trap:** A missing JSON key and a key with JSON `null` both return something that looks like NULL, but they are semantically different. `IS NULL` catches the missing key case but not the JSON null case — use `IS_NULL_VALUE()` for the latter.

### 8. Snowflake GEOGRAPHY and GEOMETRY

Snowflake has **two spatial types** that cannot be directly cast between each other:

| Aspect | GEOGRAPHY | GEOMETRY |
|--------|-----------|----------|
| Coordinate system | WGS 84 (lat/lon, spherical) | Planar (Euclidean, any SRID) |
| Precision | 14 decimal places | 14 decimal places |
| Search optimization | Supported | **Not supported** |
| Conversion | Via GeoJSON intermediate only | Via GeoJSON intermediate only |
| Distance calculation | Great-circle (meters on Earth surface) | Euclidean (coordinate units) |

**Cross-database comparison trap:** PostgreSQL PostGIS uses `geometry` (planar) by default, BigQuery uses spherical `GEOGRAPHY` only, and Snowflake has both but they are incompatible. Comparing spatial data across databases requires agreeing on coordinate system _and_ precision tolerance for floating-point vertex coordinates.

BigQuery additionally only supports the spherical model — there is no planar GEOMETRY equivalent. Migrating PostGIS `geometry` (projected coordinates like UTM) to BigQuery requires coordinate system transformation _before_ loading.

Source: [Snowflake Geospatial Data Types](https://docs.snowflake.com/en/sql-reference/data-types-geospatial), [BigQuery Geography Functions](https://docs.cloud.google.com/bigquery/docs/reference/standard-sql/geography_functions)

### 9. BigQuery-Specific Type Quirks

#### STRUCT Comparison Semantics

BigQuery STRUCT equality comparison is **positional, not by name**:

```sql
-- These are EQUAL despite different field names:
STRUCT(1 AS x, 'a' AS y) = STRUCT(1 AS p, 'a' AS q)  -- TRUE

-- Field names are IGNORED — only ordinal position and type matter
```

This is the opposite of what most developers expect. If you restructure a STRUCT by reordering fields, previously-equal rows become unequal. Nesting limit: 15 levels of nested RECORD/STRUCT.

#### NUMERIC vs BIGNUMERIC Rounding

| Property | NUMERIC | BIGNUMERIC |
|----------|---------|------------|
| Total digits | 38 | 76 |
| Decimal places | 9 | 38 |
| Rounding rule | Half away from zero | Half away from zero |
| Overflow | Error | Error |
| Safe functions | `SAFE_ADD`, `SAFE_MULTIPLY` return NULL | Same |
| Range | ~10^29 | ~10^38 |

**Cross-database trap:** Snowflake `NUMBER(38,0)` maps to BigQuery `INT64` or `NUMERIC` depending on the tool. BigQuery `NUMERIC(38,9)` has 9 forced decimal places — casting a Snowflake integer to BigQuery NUMERIC adds `.000000000` trailing zeros, creating string comparison mismatches.

#### BigQuery JSON Key Ordering

BigQuery's `JSON` type explicitly does not preserve key order. The `TO_JSON_STRING()` function output is non-deterministic in ordering, same as Snowflake. Only PostgreSQL `json` (not `jsonb`) preserves insertion order.

Source: [BigQuery Data Types](https://docs.cloud.google.com/bigquery/docs/reference/standard-sql/data-types)

### 10. DuckDB Type System Deep Dive

#### Aggressive Type Promotion

DuckDB promotes integer types aggressively during aggregation:

```sql
-- SUM() on INTEGER auto-promotes to HUGEINT (128-bit)
SELECT SUM(int_col) FROM t;  -- Result type: HUGEINT, even for small values

-- PIVOT with >20 SUM columns forces HUGEINT regardless of explicit casts
-- See: https://github.com/duckdb/duckdb/issues/18007
```

**HUGEINT (128-bit integer)** has no equivalent in:
- PostgreSQL (max `BIGINT` = 64-bit; `NUMERIC` is arbitrary-precision but different semantics)
- Snowflake (max `NUMBER(38,0)` = 128 bits of decimal, but different representation)
- BigQuery (max `INT64` = 64-bit; `BIGNUMERIC` = 76 decimal digits)
- MySQL (max `BIGINT` = 64-bit)

When exporting DuckDB HUGEINT to other databases, silent truncation or overflow errors are possible.

#### MAP vs STRUCT vs JSON

| Property | STRUCT | MAP | JSON |
|----------|--------|-----|------|
| Key type | String only | Any type | String only |
| Value types | Different per field | Single type for all values | Any (stored as VARCHAR) |
| Schema | Fixed (same keys every row) | Variable (different keys per row) | Schemaless |
| Key sensitivity | Case-insensitive | Case-sensitive | Case-sensitive |
| Missing key | Error | Empty list | NULL |
| Physical storage | Columnar (fast) | Row-based | VARCHAR (slow) |

**Conversion gotcha:** Casting JSON to STRUCT works, but casting STRUCT to MAP fails if value types differ. MAP requires homogeneous value types.

#### Breaking Change: VARCHAR Implicit Casting (v0.10.0+)

DuckDB 0.10.0 removed implicit casting to VARCHAR. Before, `WHERE int_col = '42'` worked via implicit cast. After, it requires explicit: `WHERE int_col = CAST('42' AS INTEGER)`. This affects cross-database query portability since most other databases allow implicit string-to-number comparison.

Source: [DuckDB Typecasting](https://duckdb.org/docs/stable/sql/data_types/typecasting), [DuckDB PR #10115](https://github.com/duckdb/duckdb/pull/10115)

#### ENUM Portability

DuckDB ENUMs auto-cast to VARCHAR when needed, making them relatively portable. However:
- PostgreSQL ENUMs must be created as separate types (`CREATE TYPE ... AS ENUM`)
- MySQL ENUMs are inline column definitions
- Snowflake/BigQuery have no native ENUM type at all

DuckDB-to-PostgreSQL: updating PostgreSQL ENUM fields from DuckDB is not directly supported — requires staging tables or VARCHAR intermediaries.

Source: [DuckDB ENUM](https://duckdb.org/docs/stable/sql/data_types/enum), [DuckDB-to-PG ENUM issue](https://tech-champion.com/database/how-to-update-enum-fields-in-postgresql-from-duckdb-solutions-workarounds/)

### 11. Cross-Database Type Mapping via ETL Tools

#### Airbyte Internal Type System

Airbyte defines 11 canonical types as the intermediate representation between any source and any destination:

| Airbyte Type | JSON Schema | Precision Notes |
|-------------|-------------|-----------------|
| `string` | `{"type": "string"}` | Unlimited |
| `boolean` | `{"type": "boolean"}` | N/A |
| `integer` | `{"type": "integer"}` | May overflow in Avro (64-bit limit) |
| `number` | `{"type": "number"}` | Float — precision loss possible |
| `date` | `{"format": "date"}` | RFC 3339 string |
| `timestamp_with_timezone` | `{"format": "date-time", "airbyte_type": "..."}` | String representation |
| `timestamp_without_timezone` | Same with different `airbyte_type` | String representation |
| `time_with_timezone` | `{"format": "time", "airbyte_type": "..."}` | String representation |
| `time_without_timezone` | Same with different `airbyte_type` | String representation |
| `array` | `{"type": "array"}` | Serialized to JSON string if destination lacks arrays |
| `object` | `{"type": "object"}` | Maps to JSONB/VARIANT/JSON per destination |

**Lossy conversion risk:** Airbyte's `number` type is float-based. Decimal values from PostgreSQL `NUMERIC` pass through float representation, losing precision for values with >15 significant digits. Infinity and NaN are not supported at all.

Source: [Airbyte Supported Data Types](https://docs.airbyte.com/understanding-airbyte/supported-data-types)

#### Fivetran Type Hierarchy

Fivetran maintains a **subtype-supertype hierarchy** where JSON and STRING sit at the top as universal fallback types:

```
INTEGER < LONG < DOUBLE < DECIMAL < STRING
BOOLEAN < STRING
DATE < TIMESTAMP < STRING
JSON < STRING
```

**Type promotion:** When a source column's type widens (e.g., INT to LONG), Fivetran auto-promotes the destination column. Narrowing changes (LONG to INT) are blocked to prevent data loss. If a destination doesn't support a type (e.g., JSON in a database without native JSON), Fivetran falls back to STRING.

Source: [Fivetran Type Promotion](https://support.fivetran.com/hc/en-us/community/posts/4418392349079)

#### dlt (Data Load Tool) Type System

dlt defines 11 internal types with explicit precision/scale control:

| dlt Type | Precision Semantics | Cross-DB Notes |
|----------|-------------------|----------------|
| `text` | VARCHAR(N) length | N/A |
| `double` | IEEE 754 | Same everywhere |
| `bool` | N/A | Destination-dependent representation |
| `timestamp` | 0-9 (seconds to nanoseconds) | Default 6 (microseconds) |
| `bigint` | Bit width (default 64) | Maps to TINYINT/INT/BIGINT |
| `decimal` | Precision + scale | Destination validates on column creation |
| `wei` | 256-bit integer | Ethereum-specific, few DB equivalents |
| `json` | N/A | Prevents flattening |

**Key design decision:** dlt treats naive timestamps as UTC regardless of system timezone. This means a `datetime(2024, 1, 1, 12, 0, 0)` in Python becomes `2024-01-01T12:00:00+00:00` — which may not match the original intent if the source was in a local timezone.

**Variant columns:** When type coercion fails (e.g., a column has both strings and integers), dlt creates variant columns named `column__v_datatype` rather than failing. This is a pragmatic but surprising behavior if you're doing cross-database comparison — the same logical column may split into multiple physical columns.

Source: [dlt Schema Documentation](https://dlthub.com/docs/general-usage/schema)

### 12. Migration War Stories — Type-Specific Failures

#### Oracle to Snowflake

| Oracle Type | Snowflake Type | Gotcha |
|------------|---------------|--------|
| `NUMBER` (no precision) | `NUMBER(38,0)` | Oracle NUMBER without precision/scale stores any numeric value; Snowflake truncates to integer |
| `NUMBER` with negative scale | Not supported | Snowflake removes negative scale, causing functional inequivalence |
| `NUMBER` with scale >37 | Capped at 18 | SnowConvert silently reduces scale from e.g., 38 to 18 |
| `DATE` | `TIMESTAMP_NTZ` | Oracle DATE includes time component (HH:MI:SS); semantics differ |
| `CLOB`/`NCLOB`/`LONG` | `VARCHAR` | Max 16 MB (now 128 MB); loses LOB streaming semantics |
| `BLOB`/`RAW`/`LONG RAW` | `BINARY` | Loses LOB semantics |
| `INTERVAL YEAR TO MONTH` | `VARCHAR(20)` | Loses type semantics; may truncate beyond 20 chars |
| `INTERVAL DAY TO SECOND` | `VARCHAR(20)` | Same |
| `ROWID`/`UROWID` | `VARCHAR(18)` | Physical row address becomes meaningless string |
| `SDO_GEOMETRY` | Not supported | Requires manual conversion via WKT/GeoJSON |

**Numeric intermediate storage:** Snowflake internally stores all numeric operations differently from Oracle. SnowConvert offers optional `NUMBER` to `DECFLOAT` transformation with automatic `CAST` wrapping in INSERT statements to preserve precision.

Source: [SnowConvert Oracle Data Types](https://docs.snowflake.com/en/migrations/snowconvert-docs/translation-references/oracle/basic-elements-of-oracle-sql/data-types/README)

#### MySQL to PostgreSQL

pgloader's default casting rules reveal the complete UNSIGNED type promotion chain:

| MySQL Type | PostgreSQL Type | Notes |
|-----------|----------------|-------|
| `TINYINT(1)` | `BOOLEAN` | Only when display width = 1 |
| `TINYINT` (other) | `SMALLINT` | Signed: same range; unsigned: promoted |
| `TINYINT UNSIGNED` | `SMALLINT` | Drop typemod |
| `SMALLINT UNSIGNED` | `INTEGER` | Drop typemod |
| `MEDIUMINT UNSIGNED` | `INTEGER` | Drop typemod |
| `INTEGER UNSIGNED` | `BIGINT` | Drop typemod |
| `ENUM('a','b','c')` | `CREATE TYPE ... AS ENUM(...)` | Separate DDL statement required |
| `SET('x','y','z')` | No equivalent | Use arrays or junction tables |
| `AUTO_INCREMENT` | `SERIAL` / `GENERATED ALWAYS AS IDENTITY` | Syntax change |

**The TINYINT(1) trap:** pgloader uses display width to distinguish boolean usage from small integer usage. If a developer used `TINYINT(1)` to store values 0-9 (not just 0/1), the automatic boolean conversion corrupts data — all non-zero values become `TRUE`.

Source: [pgloader MySQL to PostgreSQL](https://pgloader.readthedocs.io/en/latest/ref/mysql.html)

#### SQL Server to BigQuery

| SQL Server Type | BigQuery Equivalent | Loss/Issue |
|----------------|--------------------|----|
| `UNIQUEIDENTIFIER` | `STRING` | Loses type semantics; BigQuery has no native UUID type |
| `MONEY` / `SMALLMONEY` | `NUMERIC` or `FLOAT64` | Tool-dependent; auto-detection may choose wrong type |
| `DATETIMEOFFSET` | `TIMESTAMP` | Timezone offset metadata may be lost |
| `HIERARCHYID` | `STRING` | Completely loses hierarchical semantics |
| `SQL_VARIANT` | `STRING` | Universal fallback; loses original type information |
| `XML` | `STRING` | Loses XML validation and query capabilities |
| `IMAGE` | `BYTES` | Deprecated in SQL Server; simple binary conversion |
| `GEOGRAPHY` | `GEOGRAPHY` | Direct mapping, but SQL Server supports planar too |

**Schema auto-detection risk:** Tools like Dataflow and Data Fusion auto-detect SQL Server schemas, but the mapping is often wrong for edge-case types. Explicit schema definitions are strongly recommended over auto-detection for production migrations.

Source: [SQL Server to BigQuery Mapping (SnapLogic)](https://docs.snaplogic.com/autosync/sql-bigquery.html), [SQL Server to BigQuery Migration (Medium)](https://medium.com/@calvinpaul016/microsoft-sql-server-to-google-bigquery-migration-converting-the-code-54ff1633c3a9)

### 13. JSON/Semi-Structured Comparison Deep Dive

#### The Triple NULL Problem

Across databases, there are actually **three** distinct null states for JSON fields, and each database handles them differently:

| State | PostgreSQL (jsonb) | Snowflake (VARIANT) | BigQuery (JSON) | DuckDB (JSON) | MySQL (JSON) |
|-------|-------------------|--------------------|-----------------|----|---|
| Column is SQL NULL | `IS NULL` = true | `IS NULL` = true | `IS NULL` = true | `IS NULL` = true | `IS NULL` = true |
| Key exists, value is JSON `null` | `= 'null'` | `IS_NULL_VALUE()` = true | `JSON_TYPE() = 'null'` | Historically conflated with SQL NULL ([#13437](https://github.com/duckdb/duckdb/issues/13437)) | `JSON_TYPE() = 'NULL'` but `JSON_EXTRACT` returns string `"null"` ([Bug #85755](https://bugs.mysql.com/bug.php?id=85755)) |
| Key missing entirely | Path extraction returns SQL NULL | Path extraction returns SQL NULL | Path extraction returns SQL NULL | Path extraction returns SQL NULL | Path extraction returns SQL NULL |

**The DuckDB problem:** DuckDB historically could not distinguish between SQL NULL and JSON null via `JSON_EXTRACT` — both returned SQL NULL. This was tracked in [duckdb/duckdb#13437](https://github.com/duckdb/duckdb/issues/13437).

**The MySQL problem:** `JSON_EXTRACT` returns the string literal `"null"` (not SQL NULL) for JSON null values, but `IS NULL` returns false. This means `WHERE json_col->'$.key' IS NULL` fails to detect JSON nulls — you need `JSON_TYPE(json_col->'$.key') = 'NULL'` instead.

#### JSON Number Precision: The 2^53 Boundary

JSON RFC 8259 does not specify numeric precision limits, but most implementations use IEEE 754 double (64-bit float) internally. This creates a hard boundary at **2^53 (9,007,199,254,740,992)** — integers above this value lose precision silently:

```
9007199254740993  →  9007199254740992  (off by 1)
9007199254740995  →  9007199254740996  (off by 1)
```

Database behavior for integers > 2^53 in JSON:

| Database | Behavior |
|----------|----------|
| PostgreSQL `jsonb` | Preserves exact integer (arbitrary precision) |
| Snowflake `PARSE_JSON` | Preserves exact numeric representation |
| BigQuery `JSON` | Uses FLOAT64 internally — **precision loss** above 2^53 |
| MySQL `JSON` | RapidJSON parser may lose precision for scientific notation ([Bug #112904](https://bugs.mysql.com/bug.php?id=112904)) |
| DuckDB `JSON` | VARCHAR storage — no precision loss in storage, but extraction may use DOUBLE |

**Cross-database comparison trap:** The same JSON document `{"id": 9007199254740993}` will have value `9007199254740993` in PostgreSQL/Snowflake but `9007199254740992` in BigQuery — a diff that is a false positive from a business perspective but a true data difference.

Source: [JSON Number Precision (HackerOne)](https://www.pullrequest.com/blog/safely-handling-large-integers-in-json-best-practices-and-pitfalls/), [What is a JSON Number](https://blog.trl.sn/blog/what-is-a-json-number/)

### 14. Comprehensive Cross-Database Type Equivalence Matrix

This matrix shows where types map cleanly and where information is lost. `~` indicates a lossy or approximate mapping.

| Concept | PostgreSQL | Snowflake | BigQuery | DuckDB | MySQL |
|---------|-----------|-----------|----------|--------|-------|
| Small integer | `SMALLINT` (16-bit) | `NUMBER(5,0)` | `INT64` | `SMALLINT` (16-bit) | `SMALLINT` (16-bit) |
| Integer | `INTEGER` (32-bit) | `NUMBER(10,0)` | `INT64` | `INTEGER` (32-bit) | `INT` (32-bit) |
| Big integer | `BIGINT` (64-bit) | `NUMBER(19,0)` | `INT64` (64-bit) | `BIGINT` (64-bit) | `BIGINT` (64-bit) |
| Huge integer | `NUMERIC` ~ | `NUMBER(38,0)` ~ | `BIGNUMERIC` ~ | `HUGEINT` (128-bit) | No equivalent |
| Exact decimal | `NUMERIC(p,s)` | `NUMBER(p,s)` | `NUMERIC(38,9)` / `BIGNUMERIC(76,38)` | `DECIMAL(p,s)` | `DECIMAL(p,s)` max 65,30 |
| Float | `REAL` (32-bit) | `FLOAT` (64-bit!) | `FLOAT64` (64-bit) | `FLOAT` (32-bit) | `FLOAT` (32-bit) |
| Double | `DOUBLE PRECISION` | `FLOAT` (same as above) | `FLOAT64` | `DOUBLE` (64-bit) | `DOUBLE` (64-bit) |
| Boolean | `BOOLEAN` | `BOOLEAN` | `BOOL` | `BOOLEAN` | `TINYINT(1)` ~ |
| UUID | `UUID` (native) | `VARCHAR` ~ | `STRING` ~ | `UUID` (native, stored as HUGEINT) | `CHAR(36)` / `BINARY(16)` ~ |
| Date | `DATE` | `DATE` | `DATE` | `DATE` | `DATE` |
| Time | `TIME` / `TIMETZ` | `TIME` | `TIME` | `TIME` | `TIME` |
| Timestamp no TZ | `TIMESTAMP` (6) | `TIMESTAMP_NTZ` (9) | No equivalent ~ | `TIMESTAMP` (6) | `DATETIME` (6) |
| Timestamp with TZ | `TIMESTAMPTZ` (6) | `TIMESTAMP_TZ` (9) | `TIMESTAMP` (6) | `TIMESTAMPTZ` (6) | `TIMESTAMP` (6) ~ |
| Interval | `INTERVAL` | No data type ~ | `INTERVAL` (3-part) | `INTERVAL` | No equivalent ~ |
| JSON | `JSON` / `JSONB` | `VARIANT` | `JSON` | `JSON` (VARCHAR) | `JSON` |
| Array | `ARRAY` (typed) | `ARRAY` (VARIANT) | `ARRAY<T>` (no NULLs!) | `LIST` (typed) | `JSON` ~ |
| Nested object | `JSONB` ~ | `OBJECT` / `VARIANT` | `STRUCT` / `RECORD` | `STRUCT` / `MAP` | `JSON` ~ |
| Binary | `BYTEA` (hex) | `BINARY` (hex) | `BYTES` (base64) | `BLOB` | `BLOB` / `VARBINARY` |
| Enum | `CREATE TYPE ... AS ENUM` | No equivalent ~ | No equivalent ~ | `ENUM` (native) | `ENUM` (inline) |
| Geography | PostGIS `geography` | `GEOGRAPHY` | `GEOGRAPHY` | `GEOMETRY` ~ | No equivalent |
| Geometry | PostGIS `geometry` | `GEOMETRY` | No equivalent ~ | `GEOMETRY` | No equivalent |
| XML | `XML` | `VARIANT` ~ | `STRING` ~ | `VARCHAR` ~ | No equivalent |
| Money | `MONEY` | No equivalent ~ | No equivalent ~ | No equivalent | No equivalent |

**Key lossy mappings:**
- **Snowflake FLOAT is always 64-bit** — PostgreSQL `REAL` (32-bit) values gain phantom precision when migrated to Snowflake, creating false diffs on round-trip
- **BigQuery INT64 is the only integer** — no SMALLINT/INT distinction; everything widens to 64-bit
- **MySQL has no native BOOLEAN** — `TINYINT(1)` is a convention, not a type guarantee
- **UUID has no universal type** — only PostgreSQL and DuckDB have native UUID; everywhere else it's a string with no validation
- **BigQuery arrays cannot contain NULLs** — migration from any other DB must handle NULL array elements

### 15. Implications for Reladiff — Iteration 2

Building on the Iteration 1 recommendations, the research deepens the case for these additional capabilities:

#### Must-Have for Cross-Database Diffing

1. **Structured vs semi-structured awareness** — when comparing Snowflake VARIANT columns against BigQuery STRUCT or DuckDB STRUCT, parse both sides structurally rather than comparing serialized strings
2. **JSON null three-way distinction** — detect and normalize the SQL NULL / JSON null / missing key trichotomy before comparison
3. **HUGEINT overflow detection** — flag when DuckDB HUGEINT values exceed the target database's integer range (e.g., >2^63 for PostgreSQL BIGINT)
4. **ENUM normalization** — treat ENUMs as their string representation for cross-database comparison regardless of source database
5. **Spatial tolerance** — GEOGRAPHY/GEOMETRY comparison needs configurable vertex-coordinate epsilon, not just ST_EQUALS (floating-point coordinates differ across serialization round-trips)

#### Should-Have for Production Quality

6. **BigQuery STRUCT positional comparison warning** — detect and warn when STRUCT field ordering differs between source and target (since BigQuery compares positionally, not by name)
7. **Array NULL element handling** — when comparing arrays across BigQuery (no NULLs) and other databases (NULLs allowed), flag the incompatibility rather than silently dropping NULLs
8. **JSON large integer precision** — for JSON fields containing integers > 2^53, compare as strings rather than numbers to avoid BigQuery FLOAT64 precision loss
9. **Binary encoding normalization** — hex vs base64 vs hex-with-prefix must be normalized before comparison
10. **UNSIGNED integer type promotion awareness** — MySQL `INT UNSIGNED` (0 to 4.3B) maps to PostgreSQL `BIGINT`, creating width mismatches in type metadata even when values fit

#### Iteration 2 Sources

- [Snowflake Structured Data Types](https://docs.snowflake.com/en/sql-reference/data-types-structured)
- [Snowflake VARIANT Considerations](https://docs.snowflake.com/en/user-guide/semistructured-considerations)
- [Snowflake Geospatial Data Types](https://docs.snowflake.com/en/sql-reference/data-types-geospatial)
- [BigQuery Data Types](https://docs.cloud.google.com/bigquery/docs/reference/standard-sql/data-types)
- [BigQuery Geography Functions](https://docs.cloud.google.com/bigquery/docs/reference/standard-sql/geography_functions)
- [DuckDB Typecasting](https://duckdb.org/docs/stable/sql/data_types/typecasting)
- [DuckDB MAP Type](https://duckdb.org/docs/stable/sql/data_types/map)
- [DuckDB STRUCT Type](https://duckdb.org/docs/stable/sql/data_types/struct)
- [DuckDB ENUM Type](https://duckdb.org/docs/stable/sql/data_types/enum)
- [DuckDB HUGEINT PIVOT issue #18007](https://github.com/duckdb/duckdb/issues/18007)
- [DuckDB VARCHAR casting change PR #10115](https://github.com/duckdb/duckdb/pull/10115)
- [DuckDB JSON null issue #13437](https://github.com/duckdb/duckdb/issues/13437)
- [Airbyte Supported Data Types](https://docs.airbyte.com/understanding-airbyte/supported-data-types)
- [Fivetran Type Promotion](https://support.fivetran.com/hc/en-us/community/posts/4418392349079)
- [dlt Schema Documentation](https://dlthub.com/docs/general-usage/schema)
- [SnowConvert Oracle Data Types](https://docs.snowflake.com/en/migrations/snowconvert-docs/translation-references/oracle/basic-elements-of-oracle-sql/data-types/README)
- [pgloader MySQL to PostgreSQL](https://pgloader.readthedocs.io/en/latest/ref/mysql.html)
- [MySQL JSON Bug #85755](https://bugs.mysql.com/bug.php?id=85755)
- [MySQL JSON Precision Bug #112904](https://bugs.mysql.com/bug.php?id=112904)
- [JSON Number Precision (HackerOne)](https://www.pullrequest.com/blog/safely-handling-large-integers-in-json-best-practices-and-pitfalls/)
- [What is a JSON Number](https://blog.trl.sn/blog/what-is-a-json-number/)
- [Datafold Cross-Database Best Practices](https://docs.datafold.com/data-diff/cross-database-diffing/best-practices)
