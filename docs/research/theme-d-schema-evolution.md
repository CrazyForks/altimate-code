# Theme D: Schema Evolution & Drift Detection

_Iteration 2 — 2026-03-13_

## 1. Schema Drift Detection

### The Problem Space

Schema drift — unauthorized or unexpected structural changes to tables — is the silent killer of data pipelines. A single column rename, type change, or dropped constraint can cascade through dozens of downstream models, dashboards, and ML features without triggering any obvious error until a user reports "the numbers look wrong."

### Detection Techniques

#### Column-Level Diff

The foundational operation: compare two schema snapshots and emit a change set.

```python
from dataclasses import dataclass
from enum import Enum
from typing import Optional

class ChangeKind(Enum):
    ADDED = "added"
    REMOVED = "removed"
    TYPE_CHANGED = "type_changed"
    NULLABLE_CHANGED = "nullable_changed"
    DEFAULT_CHANGED = "default_changed"
    CONSTRAINT_CHANGED = "constraint_changed"
    POSITION_CHANGED = "position_changed"

@dataclass
class ColumnSchema:
    name: str
    data_type: str
    nullable: bool
    default: Optional[str] = None
    ordinal_position: int = 0
    character_max_length: Optional[int] = None
    numeric_precision: Optional[int] = None
    numeric_scale: Optional[int] = None

@dataclass
class SchemaDelta:
    column: str
    kind: ChangeKind
    old_value: Optional[str] = None
    new_value: Optional[str] = None
    breaking: bool = False

def diff_schemas(
    source: list[ColumnSchema],
    target: list[ColumnSchema],
) -> list[SchemaDelta]:
    """Produce a minimal change set between two column lists."""
    src_map = {c.name.lower(): c for c in source}
    tgt_map = {c.name.lower(): c for c in target}
    deltas: list[SchemaDelta] = []

    for name, col in src_map.items():
        if name not in tgt_map:
            deltas.append(SchemaDelta(col.name, ChangeKind.REMOVED, breaking=True))
            continue
        tgt_col = tgt_map[name]
        if col.data_type != tgt_col.data_type:
            deltas.append(SchemaDelta(
                col.name, ChangeKind.TYPE_CHANGED,
                old_value=col.data_type, new_value=tgt_col.data_type,
                breaking=True,
            ))
        if col.nullable != tgt_col.nullable:
            deltas.append(SchemaDelta(
                col.name, ChangeKind.NULLABLE_CHANGED,
                old_value=str(col.nullable), new_value=str(tgt_col.nullable),
                breaking=not tgt_col.nullable,  # NULL→NOT NULL is breaking
            ))

    for name, col in tgt_map.items():
        if name not in src_map:
            deltas.append(SchemaDelta(col.name, ChangeKind.ADDED, breaking=False))

    return deltas
```

#### Schema Fingerprinting

Hash-based fingerprints enable O(1) "has anything changed?" checks before expensive diffs.

```python
import hashlib
import json

def schema_fingerprint(columns: list[ColumnSchema]) -> str:
    """Deterministic hash of ordered column signatures.

    Sort by name (case-insensitive) to be position-independent.
    Include type, nullable, and precision for change sensitivity.
    """
    normalized = sorted(
        [
            {
                "name": c.name.lower(),
                "type": c.data_type.upper(),
                "nullable": c.nullable,
                "precision": c.numeric_precision,
                "scale": c.numeric_scale,
            }
            for c in columns
        ],
        key=lambda x: x["name"],
    )
    payload = json.dumps(normalized, sort_keys=True).encode()
    return hashlib.sha256(payload).hexdigest()[:16]
```

This is analogous to how Confluent Schema Registry uses a canonical form fingerprint (Parsing Canonical Form for Avro, documented in the [Avro spec](https://avro.apache.org/docs/current/specification/#parsing-canonical-form-for-schemas)) to detect schema identity.

#### Cross-Database Schema Retrieval

Every database exposes schema metadata differently:

```sql
-- PostgreSQL: INFORMATION_SCHEMA (ANSI standard)
SELECT column_name, data_type, is_nullable, column_default,
       character_maximum_length, numeric_precision, numeric_scale
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'orders'
ORDER BY ordinal_position;

-- Snowflake: INFORMATION_SCHEMA (similar but not identical)
SELECT column_name, data_type, is_nullable, column_default,
       character_maximum_length, numeric_precision, numeric_scale
FROM information_schema.columns
WHERE table_schema = 'PUBLIC' AND table_name = 'ORDERS'
ORDER BY ordinal_position;

-- BigQuery: INFORMATION_SCHEMA (GA since 2020)
SELECT column_name, data_type, is_nullable,
       -- No character_maximum_length; types are self-describing (STRING, BYTES)
FROM `project.dataset.INFORMATION_SCHEMA.COLUMNS`
WHERE table_name = 'orders'
ORDER BY ordinal_position;

-- MySQL: INFORMATION_SCHEMA (the original)
SELECT column_name, column_type, is_nullable, column_default,
       character_maximum_length, numeric_precision, numeric_scale
FROM information_schema.columns
WHERE table_schema = 'mydb' AND table_name = 'orders'
ORDER BY ordinal_position;
```

Key divergences:
- **Snowflake** uppercases all identifiers by default; `data_type` returns `TEXT` not `VARCHAR`
- **BigQuery** has no `character_maximum_length` — `STRING` is unbounded
- **MySQL** uses `column_type` (e.g., `varchar(255)`) vs `data_type` (`varchar`)
- **DuckDB** uses `duckdb_columns()` function or `information_schema.columns`

### Existing Tools

**SchemaCrawler** (open source, Java): Extracts full DDL including indexes, constraints, triggers. Produces schema diffs as HTML/text/JSON. Supports 20+ databases. Reference: [schemacrawler.com](https://www.schemacrawler.com/).

**SchemaHero** (open source, Go, Kubernetes-native): Declarative schema management via CRDs. Computes migration plans as Kubernetes resources. Focuses on PostgreSQL, MySQL, CockroachDB. Reference: [schemahero.io](https://schemahero.io/).

**dbt schema tests**: `schema.yml` defines expected columns and types. `dbt test` validates at runtime:

```yaml
# dbt schema.yml
models:
  - name: orders
    columns:
      - name: order_id
        data_type: integer
        tests:
          - not_null
          - unique
      - name: total_amount
        data_type: numeric(12,2)
        tests:
          - not_null
```

**Great Expectations**: `expect_table_columns_to_match_ordered_list`, `expect_column_values_to_be_of_type`, `expect_table_column_count_to_equal`. Reference: [greatexpectations.io](https://greatexpectations.io/expectations/).

**elementary-data** (open source, dbt package): Schema change detection via snapshot comparison — alerts on column additions/removals/type changes between dbt runs. Reference: [elementary-data.com](https://www.elementary-data.com/).

---

## 2. Schema Evolution Strategies

### Avro Schema Evolution Rules

The canonical reference for schema evolution compatibility. Defined in the [Avro specification](https://avro.apache.org/docs/current/specification/).

| Compatibility | Rule | Example |
|---|---|---|
| **Backward** | New schema can read old data | Add column with default; remove column |
| **Forward** | Old schema can read new data | Remove column; add column with default |
| **Full** | Both backward + forward | Add/remove columns with defaults only |
| **None** | No guarantees | Type changes, renaming |

```json
// Avro: backward-compatible addition (new field with default)
{
  "type": "record",
  "name": "Order",
  "fields": [
    {"name": "order_id", "type": "long"},
    {"name": "amount", "type": "double"},
    {"name": "currency", "type": "string", "default": "USD"}  // NEW — backward compatible
  ]
}
```

Removing a field is **forward compatible** (old readers ignore unknown fields) but **not backward compatible** (new readers expect the field).

### Apache Iceberg Schema Evolution

Iceberg tracks columns by **unique IDs**, not names or positions. This enables:

- **Add column**: New ID assigned, existing data files untouched
- **Rename column**: ID stays the same, metadata updated, no file rewrite
- **Reorder columns**: Metadata-only operation
- **Drop column**: Marked as deleted in metadata, data files unaffected
- **Widen type**: `int` → `long`, `float` → `double`, `decimal(P,S)` → `decimal(P',S)` where P' > P
- **NOT supported**: Narrowing types, changing between incompatible types

```sql
-- Iceberg schema evolution (Spark SQL)
ALTER TABLE prod.orders ADD COLUMN currency STRING AFTER amount;
ALTER TABLE prod.orders RENAME COLUMN amt TO amount;
ALTER TABLE prod.orders ALTER COLUMN quantity TYPE bigint;  -- int → bigint widening
ALTER TABLE prod.orders DROP COLUMN deprecated_field;
```

Reference: [Iceberg Schema Evolution](https://iceberg.apache.org/docs/latest/evolution/#schema-evolution).

Critical for Reladiff: Iceberg's ID-based tracking means a renamed column is **the same column** — a diff tool comparing by name would see it as a drop + add.

### Delta Lake Schema Enforcement vs Merging

**Schema enforcement** (default): Rejects writes that don't match the table schema.

```python
# Delta Lake: schema enforcement rejects this
df_with_new_column.write.format("delta").mode("append").save("/data/orders")
# AnalysisException: A schema mismatch detected when writing to the Delta table.

# Schema merging: opt-in per write
df_with_new_column.write.format("delta") \
    .option("mergeSchema", "true") \
    .mode("append").save("/data/orders")

# Or enable globally
spark.conf.set("spark.databricks.delta.schema.autoMerge.enabled", "true")
```

Delta's schema merging rules ([docs](https://docs.delta.io/latest/delta-update.html#automatic-schema-evolution)):
- New columns: added at end of struct
- NullType columns: adopt target type
- Type widening: `byte` → `short` → `int` → `long`, `float` → `double`
- Struct fields: recursively merged

### Snowflake Schema Evolution

```sql
-- Snowflake: Column operations
ALTER TABLE orders ADD COLUMN currency VARCHAR DEFAULT 'USD';
ALTER TABLE orders DROP COLUMN deprecated_field;
ALTER TABLE orders RENAME COLUMN amt TO amount;
ALTER TABLE orders ALTER COLUMN description SET DATA TYPE VARCHAR(500);

-- Snowflake: Structured type evolution (2024+)
ALTER ICEBERG TABLE events ALTER COLUMN payload
  SET DATA TYPE OBJECT(
    event_type VARCHAR,
    timestamp TIMESTAMP_NTZ,
    metadata OBJECT(source VARCHAR, version INTEGER)  -- NEW nested field
  );
```

Snowflake's structured types follow Iceberg evolution rules when backed by Iceberg tables. Standard Snowflake tables have looser rules but lack column-ID tracking.

### Confluent Schema Registry Patterns

The Schema Registry enforces compatibility at the topic level:

```bash
# Set compatibility level for a subject
curl -X PUT http://localhost:8081/config/orders-value \
  -H "Content-Type: application/vnd.schemaregistry.v1+json" \
  -d '{"compatibility": "BACKWARD"}'

# Test compatibility before registering
curl -X POST http://localhost:8081/compatibility/subjects/orders-value/versions/latest \
  -H "Content-Type: application/vnd.schemaregistry.v1+json" \
  -d '{"schema": "{\"type\":\"record\",\"name\":\"Order\",...}"}'
# Returns: {"is_compatible": true}
```

Each schema version gets a global ID; consumers specify which version they read. This is the gold standard for managing schema evolution in streaming pipelines.

Reference: [Confluent Schema Registry docs](https://docs.confluent.io/platform/current/schema-registry/).

---

## 3. Migration Validation

### Pre/Post Migration Schema Comparison

The standard pattern for validating database migrations:

```python
def validate_migration(
    source_conn, target_conn,
    source_table: str, target_table: str,
    type_map: dict[str, str],
) -> list[str]:
    """Compare schemas before and after migration, accounting for type mappings."""
    source_cols = fetch_columns(source_conn, source_table)
    target_cols = fetch_columns(target_conn, target_table)
    issues = []

    src_map = {c.name.lower(): c for c in source_cols}
    tgt_map = {c.name.lower(): c for c in target_cols}

    for name, src_col in src_map.items():
        if name not in tgt_map:
            issues.append(f"MISSING: column '{name}' not in target")
            continue
        tgt_col = tgt_map[name]
        expected_type = type_map.get(src_col.data_type.upper(), src_col.data_type.upper())
        if tgt_col.data_type.upper() != expected_type:
            issues.append(
                f"TYPE MISMATCH: '{name}' expected {expected_type}, "
                f"got {tgt_col.data_type.upper()}"
            )
        if src_col.nullable and not tgt_col.nullable:
            issues.append(f"CONSTRAINT: '{name}' was nullable, now NOT NULL")

    for name in tgt_map:
        if name not in src_map:
            issues.append(f"EXTRA: column '{name}' in target but not source")

    return issues
```

### Data Type Mapping Matrices

#### Snowflake ↔ PostgreSQL

| Snowflake | PostgreSQL | Notes |
|---|---|---|
| `NUMBER(38,0)` | `BIGINT` or `NUMERIC(38,0)` | BIGINT if ≤18 digits |
| `NUMBER(p,s)` | `NUMERIC(p,s)` | Direct mapping |
| `FLOAT` / `DOUBLE` | `DOUBLE PRECISION` | Both IEEE 754 |
| `VARCHAR(n)` | `VARCHAR(n)` | SF max 16MB, PG max 1GB |
| `TEXT` | `TEXT` | SF `TEXT` = `VARCHAR(16777216)` |
| `BOOLEAN` | `BOOLEAN` | Direct mapping |
| `DATE` | `DATE` | Direct mapping |
| `TIMESTAMP_NTZ` | `TIMESTAMP` | SF: nanoseconds → PG: microseconds |
| `TIMESTAMP_TZ` | `TIMESTAMPTZ` | SF: embedded offset → PG: converts to UTC |
| `TIMESTAMP_LTZ` | `TIMESTAMPTZ` | SF: session TZ dependent |
| `VARIANT` | `JSONB` | SF preserves insertion order; PG reorders keys |
| `ARRAY` | `JSONB` | No native PG array mapping for heterogeneous data |
| `OBJECT` | `JSONB` | Direct |
| `BINARY` | `BYTEA` | Direct |
| `GEOGRAPHY` | `GEOGRAPHY` (PostGIS) | Requires PostGIS extension |

#### BigQuery ↔ Snowflake

| BigQuery | Snowflake | Danger Zone |
|---|---|---|
| `INT64` | `NUMBER(38,0)` | Safe |
| `NUMERIC(38,9)` | `NUMBER(38,9)` | Safe, but BQ's default scale=9 vs SF default scale=0 |
| `BIGNUMERIC(76,38)` | `NUMBER(38,s)` | **PRECISION LOSS**: BQ 76 digits → SF max 38 |
| `FLOAT64` | `DOUBLE` | Both IEEE 754 |
| `STRING` | `VARCHAR` | BQ unbounded → SF 16MB |
| `BYTES` | `BINARY` | Direct |
| `BOOL` | `BOOLEAN` | Direct |
| `DATE` | `DATE` | Direct |
| `DATETIME` | `TIMESTAMP_NTZ` | BQ microseconds → SF nanoseconds (safe) |
| `TIMESTAMP` | `TIMESTAMP_TZ` | BQ always UTC → SF stores offset |
| `TIME` | `TIME` | Direct |
| `STRUCT` | `OBJECT` | BQ typed fields → SF semi-structured |
| `ARRAY` | `ARRAY` | BQ typed → SF VARIANT array |
| `GEOGRAPHY` | `GEOGRAPHY` | Both GeoJSON-based |
| `JSON` | `VARIANT` | BQ validates JSON; SF accepts any semi-structured |
| `INTERVAL` | `VARCHAR` | **NO EQUIVALENT**: SF INTERVAL is not a storable type |

#### MySQL ↔ PostgreSQL

| MySQL | PostgreSQL | Danger Zone |
|---|---|---|
| `TINYINT(1)` | `BOOLEAN` | MySQL uses 0/1; PG uses true/false |
| `INT UNSIGNED` | `BIGINT` | PG has no unsigned; must widen |
| `DOUBLE` | `DOUBLE PRECISION` | Direct |
| `DECIMAL(p,s)` | `NUMERIC(p,s)` | Direct |
| `VARCHAR(n)` | `VARCHAR(n)` | Character count vs byte count in some MySQL charsets |
| `TEXT` | `TEXT` | MySQL 64KB limit; PG unlimited |
| `MEDIUMTEXT` | `TEXT` | PG `TEXT` covers all MySQL text types |
| `LONGTEXT` | `TEXT` | Same |
| `BLOB` | `BYTEA` | Direct |
| `ENUM(...)` | `VARCHAR` + CHECK | PG has `CREATE TYPE ... AS ENUM` but rarely used in migrations |
| `SET(...)` | `VARCHAR[]` or `TEXT` | No direct equivalent |
| `DATETIME` | `TIMESTAMP` | MySQL: no TZ; PG: no TZ |
| `TIMESTAMP` | `TIMESTAMPTZ` | MySQL: auto-converts to UTC; PG: stores UTC |
| `YEAR` | `SMALLINT` | No direct PG type |
| `JSON` | `JSONB` | MySQL validates; PG reorders keys |
| `GEOMETRY` | `GEOMETRY` (PostGIS) | Requires PostGIS |

### Silent Coercion Detection

The most dangerous class of migration bugs: data that migrates "successfully" but is subtly wrong.

**Category 1: Precision truncation**
```sql
-- Source (BigQuery): BIGNUMERIC(76, 38)
SELECT CAST(1234567890123456789012345678901234567890.12345 AS BIGNUMERIC);
-- 1234567890123456789012345678901234567890.12345

-- Target (Snowflake): NUMBER(38, 0) — silently truncates!
SELECT CAST('1234567890123456789012345678901234567890.12345' AS NUMBER);
-- 1234567890123456789012345678901234567890 (integer, lost decimals)
```

**Category 2: Timestamp precision loss**
```sql
-- Source (Snowflake): nanosecond precision
SELECT '2024-01-15 10:30:45.123456789'::TIMESTAMP_NTZ;

-- Target (PostgreSQL): microsecond precision — last 3 digits lost
SELECT '2024-01-15 10:30:45.123456789'::TIMESTAMP;
-- 2024-01-15 10:30:45.123457 (rounded!)
```

**Category 3: Encoding-dependent string length**
```sql
-- MySQL: VARCHAR(255) in utf8mb3 = 255 characters = 765 bytes
-- PostgreSQL: VARCHAR(255) = 255 characters regardless of encoding
-- Snowflake: VARCHAR(255) = 255 characters in UTF-8

-- But MySQL utf8mb4: VARCHAR(255) = 255 characters = 1020 bytes max
-- If a migration tool uses byte counts, strings may be silently truncated
```

**Category 4: Boolean/integer conflation**
```sql
-- MySQL: TINYINT(1) stores 0-255 but is "conventionally" boolean
-- If source has values 0, 1, 2, 3 in a TINYINT(1) column:
-- Migration to PG BOOLEAN: 0→false, everything else→true (data loss!)
```

Detection strategy for Reladiff:

```python
SILENT_COERCION_RISKS = {
    ("BIGNUMERIC", "NUMBER"): "precision_loss",
    ("TIMESTAMP_NTZ", "TIMESTAMP"): "nanosecond_truncation",
    ("TINYINT", "BOOLEAN"): "value_range_collapse",
    ("VARCHAR", "VARCHAR"): "encoding_length_mismatch",
    ("VARIANT", "JSONB"): "key_order_change",
    ("NUMBER(38,0)", "INTEGER"): "overflow_risk",
    ("DOUBLE", "NUMERIC"): "float_to_decimal_rounding",
}
```

### Constraint Preservation Validation

```sql
-- PostgreSQL: extract all constraints for a table
SELECT
    tc.constraint_name,
    tc.constraint_type,
    kcu.column_name,
    ccu.table_name AS foreign_table_name,
    ccu.column_name AS foreign_column_name
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name
LEFT JOIN information_schema.constraint_column_usage ccu
    ON tc.constraint_name = ccu.constraint_name
    AND tc.constraint_type = 'FOREIGN KEY'
WHERE tc.table_name = 'orders';

-- Snowflake: constraints are metadata-only (not enforced!)
SELECT constraint_name, constraint_type, column_name
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
    USING (constraint_name, constraint_schema, constraint_catalog)
WHERE tc.table_name = 'ORDERS';
-- WARNING: Snowflake PKs, FKs, UNIQUE are informational only
```

Critical insight: **Snowflake does not enforce constraints**. A migration from PostgreSQL to Snowflake may "preserve" the PK definition, but duplicates can exist. Reladiff must check for actual uniqueness, not just declared constraints.

---

## 4. Breaking vs Non-Breaking Changes

### Classification Framework

```python
from enum import Enum

class ChangeImpact(Enum):
    SAFE = "safe"           # No downstream impact
    WARNING = "warning"     # Possible impact, usually safe
    BREAKING = "breaking"   # Will break downstream consumers
    DATA_LOSS = "data_loss" # May silently lose data

SCHEMA_CHANGE_CLASSIFICATION = {
    # Column operations
    "add_nullable_column": ChangeImpact.SAFE,
    "add_column_with_default": ChangeImpact.SAFE,
    "add_not_null_column_no_default": ChangeImpact.BREAKING,
    "drop_column": ChangeImpact.BREAKING,
    "rename_column": ChangeImpact.BREAKING,

    # Type changes
    "widen_varchar": ChangeImpact.SAFE,          # VARCHAR(100) → VARCHAR(200)
    "narrow_varchar": ChangeImpact.DATA_LOSS,    # VARCHAR(200) → VARCHAR(100)
    "int_to_bigint": ChangeImpact.SAFE,          # Widening
    "bigint_to_int": ChangeImpact.DATA_LOSS,     # Narrowing
    "int_to_varchar": ChangeImpact.WARNING,      # Representable but query changes
    "varchar_to_int": ChangeImpact.BREAKING,     # Non-numeric strings fail
    "float_to_decimal": ChangeImpact.WARNING,    # Rounding differences
    "decimal_to_float": ChangeImpact.DATA_LOSS,  # Precision loss
    "timestamp_to_date": ChangeImpact.DATA_LOSS, # Time component lost
    "date_to_timestamp": ChangeImpact.SAFE,      # Midnight assumed

    # Constraint changes
    "add_not_null": ChangeImpact.BREAKING,       # Existing NULLs rejected
    "drop_not_null": ChangeImpact.WARNING,       # Downstream may assume non-null
    "add_primary_key": ChangeImpact.WARNING,     # Fails if duplicates exist
    "drop_primary_key": ChangeImpact.WARNING,    # Downstream joins may produce dupes
    "add_foreign_key": ChangeImpact.WARNING,     # Fails if orphans exist
    "drop_foreign_key": ChangeImpact.SAFE,       # Less enforcement, no breakage
    "add_unique": ChangeImpact.WARNING,          # Fails if duplicates exist
    "drop_unique": ChangeImpact.SAFE,

    # Structural
    "add_partition_key": ChangeImpact.WARNING,   # May change query plans
    "change_partition_key": ChangeImpact.BREAKING,
    "change_sort_order": ChangeImpact.SAFE,      # Performance only
}
```

### Impact Analysis: Downstream Breakage

When a column changes, which queries break?

```sql
-- Given a schema change: DROP COLUMN customer_email FROM orders

-- These break (direct reference):
SELECT customer_email FROM orders;
SELECT * FROM orders WHERE customer_email LIKE '%@gmail.com';

-- These break (view dependency):
CREATE VIEW order_summary AS SELECT order_id, customer_email FROM orders;

-- These break (materialized view / dbt model):
-- models/order_metrics.sql
SELECT customer_email, COUNT(*) FROM {{ ref('orders') }} GROUP BY 1;

-- These DON'T break (no reference to dropped column):
SELECT order_id, total_amount FROM orders;
```

In data warehouses, `SELECT *` is the primary vector for breakage propagation — any column change breaks all `SELECT *` consumers.

### dbt's `state:modified` for Detecting Model Changes

dbt compares the current project against a previous `manifest.json` to detect changes:

```bash
# Run only models that changed since production
dbt run --select state:modified --state ./prod-manifest/

# Types of changes dbt detects:
# - SQL body changed (hash comparison)
# - Config changed (materialization, schema, etc.)
# - Schema changed (columns in schema.yml)
# - Upstream dependency changed
```

dbt does NOT detect:
- Source table schema changes (columns added/removed in the warehouse)
- Type changes within sources
- Constraint changes

This is where `dbt source freshness` and custom macros fill the gap:

```sql
-- dbt macro: detect source schema drift
{% macro check_source_schema(source_name, table_name, expected_columns) %}
    {% set actual_columns = adapter.get_columns_in_relation(
        source(source_name, table_name)
    ) %}
    {% set actual_names = actual_columns | map(attribute='name') | list %}
    {% set expected_names = expected_columns | map(attribute='name') | list %}

    {% set missing = expected_names | reject('in', actual_names) | list %}
    {% set extra = actual_names | reject('in', expected_names) | list %}

    {% if missing %}
        {{ exceptions.raise_compiler_error(
            "Schema drift detected! Missing columns: " ~ missing | join(', ')
        ) }}
    {% endif %}
    {% if extra %}
        {{ log("WARNING: Unexpected columns in source: " ~ extra | join(', '), info=True) }}
    {% endif %}
{% endmacro %}
```

### Automated Compatibility Checking

**Buf** (for Protobuf) is the gold standard for schema compatibility checks in CI:

```yaml
# buf.yaml
version: v1
breaking:
  use:
    - FILE           # Most strict: field numbers, names, types all checked
  except:
    - FIELD_NO_DELETE  # Allow field deletion (forward-compatible only)

# CI command
buf breaking --against '.git#branch=main'
```

Buf's breaking change categories (reference: [buf.build/docs/breaking](https://buf.build/docs/breaking/overview)):
- `WIRE`: Binary wire format compatibility (field numbers, types)
- `WIRE_JSON`: JSON wire format compatibility (field names)
- `FILE`: Source-level compatibility (everything)

An equivalent for SQL schemas does not exist as a standalone tool. Reladiff could fill this gap.

---

## 5. Temporal Schema Management

### Schema-on-Read vs Schema-on-Write

| Aspect | Schema-on-Write | Schema-on-Read |
|---|---|---|
| Enforcement | At write time (RDBMS) | At query time (data lake) |
| Migration | ALTER TABLE, backfill required | No migration, reader interprets |
| Query performance | Optimized (known types) | Slower (type inference/casting) |
| Flexibility | Low (rigid schema) | High (any structure) |
| Examples | PostgreSQL, MySQL, Snowflake | Spark on Parquet, Athena, Presto |

Hybrid approach (modern data stack): Schema-on-write at the warehouse level, schema-on-read at the lakehouse level.

### Time-Travel with Schema Changes

**Iceberg snapshots preserve the schema at each commit:**

```sql
-- Query data as of a specific snapshot (with its schema)
SELECT * FROM orders VERSION AS OF 12345678;

-- If column 'currency' was added in snapshot 12345679:
-- Queries before that snapshot return NULL for 'currency'
-- Queries after return actual values
```

**Snowflake Time Travel with schema changes:**

```sql
-- Query 24 hours ago — but the schema is CURRENT, not historical
SELECT * FROM orders AT (OFFSET => -86400);
-- If a column was dropped since then: ERROR
-- If a column was added since then: returns NULL for old rows
-- If a column was renamed: uses CURRENT name, old data

-- This is a critical gotcha: Snowflake Time Travel does NOT restore old schema
```

**Delta Lake time travel:**

```python
# Read a specific version
df = spark.read.format("delta").option("versionAsOf", 5).load("/data/orders")

# Delta uses the schema from the specified version
# If column 'x' existed in v5 but was dropped in v7, reading v5 returns 'x'
```

### Schema Changes During Incremental Loads

The most common source of pipeline failures:

```sql
-- dbt incremental model: what happens when source schema changes?
{{ config(materialized='incremental', unique_key='order_id') }}

SELECT
    order_id,
    customer_id,
    total_amount,
    -- This column was added to the source last week:
    -- currency  -- uncommented now → full_refresh required!
FROM {{ source('raw', 'orders') }}

{% if is_incremental() %}
WHERE updated_at > (SELECT MAX(updated_at) FROM {{ this }})
{% endif %}

-- Problem: incremental runs fail if new columns aren't in target table
-- Solutions:
-- 1. on_schema_change='append_new_columns' (dbt 1.0+)
-- 2. on_schema_change='sync_all_columns' (riskier: drops columns too)
-- 3. on_schema_change='fail' (safest: forces manual review)
```

dbt `on_schema_change` options (reference: [dbt docs](https://docs.getdbt.com/docs/build/incremental-models#what-if-the-columns-of-my-incremental-model-change)):

```yaml
{{ config(
    materialized='incremental',
    on_schema_change='sync_all_columns'  # Options: ignore, fail, append_new_columns, sync_all_columns
) }}
```

### SCD Implications for Validation

When validating tables with Slowly Changing Dimensions, schema evolution creates unique challenges:

**Type 2 SCD with schema changes:**
```sql
-- Suppose 'customer_tier' was added on 2024-06-01
-- Historical records (valid_from < 2024-06-01) have NULL customer_tier
-- Current records have actual values

-- Naive validation: "15% NULL rate in customer_tier" — is this drift or expected?
-- Schema-aware validation: "100% NULL for records before 2024-06-01, 0% after"
```

A schema-aware diff tool needs to understand that NULLs in historically-added columns are expected, not anomalies.

---

## 6. Production Patterns

### Airbnb: Schema Management at Scale (100K+ Datasets)

Airbnb's data platform manages schema evolution through several layers (reference: [Airbnb Engineering Blog, "Data Quality at Airbnb"](https://medium.com/airbnb-engineering/data-quality-at-airbnb-e582465f3ef7)):

- **Midas**: Certification system requiring schema contracts before datasets are promoted to "certified" status. Schema changes to certified datasets require a review process.
- **Minerva metrics layer**: Defines metrics with explicit dimension/measure schemas. Schema changes require Minerva config updates, preventing silent drift.
- **Dataportal**: Central catalog that tracks schema lineage — when a column changes, all downstream consumers are identified and notified.

Key pattern: **Schema contracts are social as much as technical** — team ownership of datasets means schema changes go through the owning team's review process.

### LinkedIn: Schema Evolution at Scale

LinkedIn's approach (reference: [LinkedIn Engineering Blog, "Gobblin"](https://engineering.linkedin.com/blog/2021/linkedin-datahub-project-updates) and [DataHub docs](https://datahubproject.io/docs/advanced/schema-history)):

- **DataHub**: Central metadata platform tracking schema history with full versioning. Every schema change is recorded as a timeline event.
- **Gobblin** (now Apache Gobblin): Data ingestion framework with built-in schema evolution support. Handles Avro schema compatibility during ingestion:
  - Source schema changes detected during pull
  - Compatibility checked against target schema registry
  - Incompatible changes blocked at ingestion time
- **Schema assertions**: Automated monitors that fire when schema drift exceeds thresholds (e.g., >5% of columns changed in a single operation).

Key pattern: **Schema evolution is a first-class event** — changes are tracked, versioned, and auditable, not just applied and forgotten.

### Uber: Schemaless + Schema Evolution

Uber's approach is unique due to their Schemaless datastore (reference: [Uber Engineering Blog, "Schemaless"](https://www.uber.com/blog/schemaless-part-one-mysql-datastore/)):

- **Schemaless**: MySQL-backed store where rows are arbitrary JSON blobs. No enforced schema — purely schema-on-read.
- **Databook**: Central catalog that maintains "expected" schemas even for schemaless stores, enabling drift detection.
- **uReplicator**: Kafka-based replication with schema registry integration. Schema changes in source databases are captured as change events and validated against downstream contracts.

For their analytics warehouse (Presto/Hive/Spark ecosystem):
- Schema changes flow through a centralized governance layer
- Backward-incompatible changes require a deprecation period
- Automated impact analysis identifies affected queries and dashboards

Key pattern: **Even schemaless systems need schema governance** — "schema-free" databases push the complexity to read time but don't eliminate it.

### Netflix: Schema Validation in Data Pipelines

Netflix's approach (reference: [Netflix Tech Blog, "Data Mesh"](https://netflixtechblog.com/data-mesh-a-data-movement-and-processing-platform-netflix-1288bcab2873)):

- **Metacat**: Central metadata service that provides a unified view of table schemas across Hive, RDS, Redshift, Snowflake, Iceberg.
- **Schema compatibility checks**: Integrated into their CI/CD pipeline for data pipeline deployments. Schema changes are validated against consumer contracts before deployment.
- **Iceberg-first**: Netflix was an early adopter of Apache Iceberg, leveraging its ID-based schema evolution to avoid rewriting data files on schema changes.
- **Data lineage**: Schema changes propagate lineage impact analysis — consumers are notified before breaking changes are applied.

Key pattern: **Iceberg's schema evolution model is the foundation** — Netflix treats schema as immutable metadata, not mutable state.

---

## 7. Implications for Reladiff

### Current State

Reladiff currently compares tables with known schemas via a Rust state machine that:
1. Creates a session with source/target table references
2. Executes SQL queries against both sides (via `ConnectionRegistry`)
3. Compares results row-by-row using key columns and extra columns
4. Reports diffs as added/removed/modified rows

Schema handling is implicit — the user specifies `key_columns` and `extra_columns`, and the diff engine assumes both tables have matching column names and compatible types. There is no pre-flight schema validation.

### What Schema Evolution Awareness Could Enable

#### Feature 1: Pre-Diff Schema Compatibility Check

Before executing any data queries, compare source and target schemas and surface issues:

```python
def pre_diff_schema_check(
    source_conn, target_conn,
    source_table: str, target_table: str,
    key_columns: list[str],
    extra_columns: list[str] | None,
) -> SchemaCompatibilityReport:
    """Run before data diff to catch schema mismatches early.

    Returns a report with:
    - missing_columns: columns in source but not target (or vice versa)
    - type_mismatches: columns with incompatible types
    - coercion_warnings: columns with compatible but lossy type mappings
    - constraint_differences: PK/NULL/UNIQUE mismatches
    - recommendation: proceed, proceed_with_warnings, or abort
    """
```

This saves compute cost (no point running a full diff if the schema doesn't match) and provides actionable diagnostics.

#### Feature 2: Column Mapping Suggestions (Renamed Columns)

When columns exist in source but not target (or vice versa), suggest potential mappings:

```python
def suggest_column_mappings(
    source_only: list[ColumnSchema],
    target_only: list[ColumnSchema],
) -> list[tuple[str, str, float]]:
    """Suggest (source_col, target_col, confidence) for renamed columns.

    Heuristics:
    - Exact type match + similar name (Levenshtein distance)
    - Same position in ordinal order
    - Same statistics (NULL count, distinct count, min/max)
    """
```

Example output:
```
Potential column mappings:
  customer_email (source) → email (target)     confidence: 0.85
  amt (source) → total_amount (target)         confidence: 0.72
```

#### Feature 3: Type Coercion Warnings

Leverage the type mapping matrices from Section 3 to warn about silent coercions:

```
Schema Compatibility Report for orders:
  ✓ 12 columns matched
  ⚠ amount: Snowflake NUMBER(38,0) → PostgreSQL NUMERIC(38,0)
    Warning: Snowflake NUMBER(38,0) is integer-only. If source has decimals, they were truncated.
  ⚠ created_at: Snowflake TIMESTAMP_NTZ(9) → PostgreSQL TIMESTAMP(6)
    Warning: Nanosecond precision will be truncated to microseconds.
  ✗ metadata: Snowflake VARIANT → PostgreSQL JSONB
    Warning: JSON key ordering may differ — string comparison will produce false diffs.
```

#### Feature 4: Nullable vs NOT NULL Mismatch Detection

A column that is `NOT NULL` in source but `NULL` in target (or vice versa) has different semantics:

```
Constraint Differences:
  order_id: NOT NULL in both ✓
  customer_id: NOT NULL in source, NULLABLE in target ⚠
    Impact: Target may contain NULL customer_ids not present in source.
    Recommendation: Add WHERE customer_id IS NOT NULL to target query,
                    or validate NULL count separately.
```

#### Feature 5: Schema Fingerprint for Incremental Validation

Store schema fingerprints alongside diff results to detect when schemas have changed between runs:

```python
@dataclass
class DiffResult:
    source_schema_fingerprint: str
    target_schema_fingerprint: str
    rows_added: int
    rows_removed: int
    rows_modified: int
    # ...

# On subsequent run:
if prev_result.source_schema_fingerprint != current_fingerprint:
    logger.warning(
        "Source schema changed since last diff. "
        "Previous: %s, Current: %s. Full diff recommended.",
        prev_result.source_schema_fingerprint, current_fingerprint,
    )
```

### Concrete Implementation Path

**Phase 1 (Low effort, high value):**
- Add `INFORMATION_SCHEMA` queries to each database connector
- Implement `diff_schemas()` and `schema_fingerprint()` functions
- Run pre-flight schema check before data diff; emit warnings in diff output
- Surface type coercion risks using the mapping matrices

**Phase 2 (Medium effort):**
- Column mapping suggestions using name similarity + type compatibility
- Constraint comparison (PK, NOT NULL, UNIQUE)
- Schema fingerprint caching for incremental validation

**Phase 3 (Higher effort):**
- Temporal schema tracking (schema history per table)
- Integration with dbt `manifest.json` for downstream impact analysis
- Automated compatibility classification (breaking/non-breaking/data-loss)

### Key Insight

The most valuable feature for Reladiff is not detecting schema changes in isolation — it is **contextualizing data diffs with schema awareness**. When a diff reports 10,000 modified rows, knowing that the source column changed from `FLOAT` to `DECIMAL(10,2)` in the same timeframe transforms "10,000 unexplained changes" into "expected rounding differences from a type migration." Schema evolution context turns noise into signal.

---

## References

1. Apache Avro Specification — Schema Resolution: https://avro.apache.org/docs/current/specification/
2. Apache Iceberg — Schema Evolution: https://iceberg.apache.org/docs/latest/evolution/
3. Delta Lake — Schema Enforcement and Evolution: https://docs.delta.io/latest/delta-update.html
4. Confluent Schema Registry: https://docs.confluent.io/platform/current/schema-registry/
5. Buf — Breaking Change Detection: https://buf.build/docs/breaking/overview
6. dbt — Incremental Models Schema Changes: https://docs.getdbt.com/docs/build/incremental-models
7. SchemaCrawler: https://www.schemacrawler.com/
8. SchemaHero: https://schemahero.io/
9. Great Expectations Schema Expectations: https://greatexpectations.io/expectations/
10. elementary-data: https://www.elementary-data.com/
11. Netflix Metacat: https://netflixtechblog.com/metacat-making-big-data-discoverable-and-meaningful-at-netflix-56fb36a53520
12. LinkedIn DataHub Schema History: https://datahubproject.io/docs/advanced/schema-history
13. Airbnb Data Quality: https://medium.com/airbnb-engineering/data-quality-at-airbnb-e582465f3ef7
14. Uber Schemaless: https://www.uber.com/blog/schemaless-part-one-mysql-datastore/
15. Snowflake INFORMATION_SCHEMA: https://docs.snowflake.com/en/sql-reference/info-schema
16. dbt-core Issue #8183 (Numeric precision): https://github.com/dbt-labs/dbt-core/issues/8183
17. data-diff Issue #379 (Float comparison): https://github.com/datafold/data-diff/issues/379
