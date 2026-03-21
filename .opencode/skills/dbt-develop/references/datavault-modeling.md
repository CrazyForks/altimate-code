# Data Vault 2.0 Modeling

A methodology for building scalable, auditable data warehouses. Common in regulated industries and enterprises needing full historization and traceability.

## Core Concepts

| Component | Purpose | Prefix | Grain |
|-----------|---------|--------|-------|
| **Hub** | Business keys — unique entity identifiers | `hub_` | One row per business key |
| **Link** | Relationships between hubs | `lnk_` | One row per unique relationship |
| **Satellite** | Descriptive attributes + history | `sat_` | One row per change (versioned) |

**Key principles:**
- **Insert-only**: Never update or delete — always append new rows
- **Hash keys**: Use deterministic hashes for surrogate keys and change detection
- **Load metadata**: Every table tracks `load_datetime` and `record_source`
- **Business keys drive the model**: Hubs are defined by real-world identifiers, not surrogate IDs

## Layer Mapping

| Data Vault Layer | Traditional dbt | Purpose |
|------------------|----------------|---------|
| Staging (`stg_`) | Staging (`stg_`) | Hash keys, load metadata, 1:1 with source |
| Raw Vault (`hub_`, `lnk_`, `sat_`) | Intermediate / Marts | Business-key-driven historized store |
| Business Vault (`bv_`) | Intermediate | Derived calculations, same-as links, bridge tables |
| Information Mart (`fct_`, `dim_`, `obt_`) | Marts | Query-optimized business tables |

## Directory Structure

```
models/
  staging/
    source_system/
      _source_system__sources.yml
      stg_source_system__entity.sql
  raw_vault/
    hubs/
      hub_customer.sql
      hub_product.sql
    links/
      lnk_order.sql
    satellites/
      sat_customer_details.sql
      sat_order_details.sql
  business_vault/
    bv_customer_lifetime.sql
  marts/
    fct_orders.sql
    dim_customers.sql
```

## Staging — Hash Keys + Load Metadata

Staging in Data Vault extends the standard staging pattern with hash key generation and load metadata.

```sql
-- stg_erp__customers.sql
{{ config(materialized='view') }}

with source as (
    select * from {{ source('erp', 'customers') }}
),

hashed as (
    select
        -- Hash key (surrogate for the hub)
        {{ dbt_utils.generate_surrogate_key(['customer_number']) }} as hub_customer_hk,

        -- Hash diff (change detection for satellites)
        {{ dbt_utils.generate_surrogate_key(['customer_name', 'email', 'phone', 'segment']) }} as sat_customer_details_hashdiff,

        -- Business key
        customer_number,

        -- Descriptive attributes
        customer_name,
        email,
        phone,
        segment,

        -- Load metadata
        current_timestamp() as load_datetime,
        'erp' as record_source

    from source
)

select * from hashed
```

**Rules:**
- One hash key per hub this source feeds
- One hashdiff per satellite this source feeds
- Business keys are never transformed (only cast if needed)
- `load_datetime` and `record_source` on every staged row

## Hub — Business Key Registry

```sql
-- hub_customer.sql
{{ config(
    materialized='incremental',
    unique_key='hub_customer_hk'
) }}

with staged as (
    select distinct
        hub_customer_hk,
        customer_number,
        load_datetime,
        record_source
    from {{ ref('stg_erp__customers') }}
)

select staged.*
from staged

{% if is_incremental() %}
left join {{ this }} as existing
    on staged.hub_customer_hk = existing.hub_customer_hk
where existing.hub_customer_hk is null
{% endif %}
```

**Rules:**
- Contains: hash key, business key(s), `load_datetime`, `record_source`
- **No descriptive attributes** — those belong in satellites
- One row per unique business key, ever
- Use `LEFT JOIN ... WHERE NULL` (not `NOT IN` — avoids NULL pitfalls and is faster on large tables)
- Materialization: `incremental` with hash key as `unique_key`

### Multi-Source Hub Loading

A key Data Vault advantage: the same hub can be loaded from multiple sources.

```sql
-- hub_customer.sql (fed by ERP + CRM)
{{ config(
    materialized='incremental',
    unique_key='hub_customer_hk'
) }}

with erp_customers as (
    select hub_customer_hk, customer_number, load_datetime, record_source
    from {{ ref('stg_erp__customers') }}
),

crm_customers as (
    select hub_customer_hk, customer_number, load_datetime, record_source
    from {{ ref('stg_crm__customers') }}
),

all_sources as (
    select * from erp_customers
    union all
    select * from crm_customers
),

deduplicated as (
    select distinct
        hub_customer_hk,
        customer_number,
        load_datetime,
        record_source
    from all_sources
)

select deduplicated.*
from deduplicated

{% if is_incremental() %}
left join {{ this }} as existing
    on deduplicated.hub_customer_hk = existing.hub_customer_hk
where existing.hub_customer_hk is null
{% endif %}
```

**Key point:** Both sources must hash the same business key (`customer_number`) identically. Use consistent `upper(trim(...))` in all staging models.

## Link — Relationships

```sql
-- lnk_order.sql
{{ config(
    materialized='incremental',
    unique_key='lnk_order_hk'
) }}

with staged as (
    select distinct
        -- Link hash key (hash of all parent hub keys)
        {{ dbt_utils.generate_surrogate_key(['hub_customer_hk', 'hub_product_hk']) }} as lnk_order_hk,

        -- Parent hub hash keys
        hub_customer_hk,
        hub_product_hk,

        -- Load metadata
        load_datetime,
        record_source
    from {{ ref('stg_erp__orders') }}
)

select staged.*
from staged

{% if is_incremental() %}
left join {{ this }} as existing
    on staged.lnk_order_hk = existing.lnk_order_hk
where existing.lnk_order_hk is null
{% endif %}
```

**Rules:**
- Contains: link hash key, parent hub hash keys, `load_datetime`, `record_source`
- Link hash key = hash of all parent hub hash keys (or business keys)
- One row per unique relationship, ever
- **No descriptive attributes** — those belong in satellites on the link

## Satellite — Historized Attributes

```sql
-- sat_customer_details.sql
{{ config(
    materialized='incremental',
    unique_key=['hub_customer_hk', 'load_datetime']
) }}

with staged as (
    select
        hub_customer_hk,
        sat_customer_details_hashdiff,
        customer_name,
        email,
        phone,
        segment,
        load_datetime,
        record_source
    from {{ ref('stg_erp__customers') }}
),

{% if is_incremental() %}
latest as (
    select
        hub_customer_hk,
        sat_customer_details_hashdiff
    from {{ this }}
    qualify row_number() over (
        partition by hub_customer_hk
        order by load_datetime desc
    ) = 1
),
{% endif %}

new_records as (
    select staged.*
    from staged
    {% if is_incremental() %}
    left join latest
        on staged.hub_customer_hk = latest.hub_customer_hk
    where latest.hub_customer_hk is null  -- new key
       or staged.sat_customer_details_hashdiff != latest.sat_customer_details_hashdiff  -- changed
    {% endif %}
)

select * from new_records
```

**Rules:**
- Contains: parent hash key, hashdiff, descriptive attributes, `load_datetime`, `record_source`
- New row inserted **only when attributes change** (hashdiff comparison)
- Composite key: parent hash key + `load_datetime`
- Split satellites by rate of change (e.g., `sat_customer_contact` vs `sat_customer_segment`)

> **Dialect note:** `qualify` (used in satellite queries) works on Snowflake, BigQuery, and Databricks. For PostgreSQL/Redshift, wrap the `qualify` in a subquery with `row_number()` and filter in an outer `WHERE` clause.

### Satellite on a Link

Satellites can also attach to links (not just hubs). The pattern is identical — replace the hub hash key with the link hash key:

```sql
-- sat_order_details.sql
{{ config(
    materialized='incremental',
    unique_key=['lnk_order_hk', 'load_datetime']
) }}

with staged as (
    select
        lnk_order_hk,
        sat_order_details_hashdiff,
        order_amount,
        order_status,
        order_date,
        load_datetime,
        record_source
    from {{ ref('stg_erp__orders') }}
),

{% if is_incremental() %}
latest as (
    select
        lnk_order_hk,
        sat_order_details_hashdiff
    from {{ this }}
    qualify row_number() over (
        partition by lnk_order_hk
        order by load_datetime desc
    ) = 1
),
{% endif %}

new_records as (
    select staged.*
    from staged
    {% if is_incremental() %}
    left join latest
        on staged.lnk_order_hk = latest.lnk_order_hk
    where latest.lnk_order_hk is null
       or staged.sat_order_details_hashdiff != latest.sat_order_details_hashdiff
    {% endif %}
)

select * from new_records
```

### Effectivity Satellite

Tracks when a link relationship is active or inactive (e.g., customer-account assignment periods):

```sql
-- sat_customer_account_eff.sql
{{ config(
    materialized='incremental',
    unique_key=['lnk_customer_account_hk', 'load_datetime']
) }}

with staged as (
    select
        lnk_customer_account_hk,
        effective_from,
        effective_to,  -- NULL = currently active
        load_datetime,
        record_source
    from {{ ref('stg_crm__customer_accounts') }}
),

{% if is_incremental() %}
latest as (
    select
        lnk_customer_account_hk,
        effective_from,
        effective_to
    from {{ this }}
    qualify row_number() over (
        partition by lnk_customer_account_hk
        order by load_datetime desc
    ) = 1
),
{% endif %}

new_records as (
    select staged.*
    from staged
    {% if is_incremental() %}
    left join latest
        on staged.lnk_customer_account_hk = latest.lnk_customer_account_hk
    where latest.lnk_customer_account_hk is null
       or staged.effective_from != latest.effective_from
       or staged.effective_to is distinct from latest.effective_to
    {% endif %}
)

select * from new_records
```

## Business Vault — Derived Logic

```sql
-- bv_customer_lifetime.sql
{{ config(materialized='table') }}

with orders as (
    select
        lnk.hub_customer_hk,
        sat.order_amount,
        sat.order_date
    from {{ ref('lnk_order') }} lnk
    inner join {{ ref('sat_order_details') }} sat
        on lnk.lnk_order_hk = sat.lnk_order_hk
    qualify row_number() over (
        partition by lnk.lnk_order_hk
        order by sat.load_datetime desc
    ) = 1  -- latest version of each satellite record
),

aggregated as (
    select
        hub_customer_hk,
        count(*) as lifetime_order_count,
        sum(order_amount) as lifetime_revenue,
        min(order_date) as first_order_date,
        max(order_date) as most_recent_order_date
    from orders
    group by 1
)

select * from aggregated
```

**Rules:**
- Derived calculations, same-as links, bridge tables
- References raw vault tables
- Business logic lives here, **not** in raw vault
- Materialization: `table` (or `incremental` for large volumes)

## Information Mart — Business-Ready

```sql
-- dim_customers.sql
{{ config(materialized='table') }}

with hub as (
    select * from {{ ref('hub_customer') }}
),

sat as (
    select *
    from {{ ref('sat_customer_details') }}
    qualify row_number() over (
        partition by hub_customer_hk
        order by load_datetime desc
    ) = 1  -- current version
),

lifetime as (
    select * from {{ ref('bv_customer_lifetime') }}
),

final as (
    select
        hub.customer_number,
        sat.customer_name,
        sat.email,
        sat.segment,
        lifetime.lifetime_order_count,
        lifetime.lifetime_revenue,
        lifetime.first_order_date,
        lifetime.most_recent_order_date
    from hub
    left join sat on hub.hub_customer_hk = sat.hub_customer_hk
    left join lifetime on hub.hub_customer_hk = lifetime.hub_customer_hk
)

select * from final
```

**Rules:**
- Standard `fct_`/`dim_` patterns apply (see [layer-patterns.md](layer-patterns.md))
- Join hubs + latest satellite records + business vault
- This is where end users query — raw vault is not exposed

## Naming Conventions

| Object | Prefix | Example |
|--------|--------|---------|
| Hub | `hub_` | `hub_customer`, `hub_product` |
| Link | `lnk_` | `lnk_order`, `lnk_customer_product` |
| Satellite (on hub) | `sat_` | `sat_customer_details`, `sat_customer_contact` |
| Satellite (on link) | `sat_` | `sat_order_details` |
| Effectivity satellite | `sat_` + `_eff` | `sat_customer_account_eff` |
| Business vault | `bv_` | `bv_customer_lifetime` |
| Staging | `stg_` | `stg_erp__customers` |
| Mart | `fct_`/`dim_` | `dim_customers`, `fct_orders` |

## dbt_project.yml Config

```yaml
models:
  my_project:
    staging:
      +materialized: view
    raw_vault:
      hubs:
        +materialized: incremental
      links:
        +materialized: incremental
      satellites:
        +materialized: incremental
    business_vault:
      +materialized: table
    marts:
      +materialized: table
```

## Hash Key Guidelines

- Use `dbt_utils.generate_surrogate_key()` or `dbt_utils.hash()` for portability
- Hash inputs must be deterministic: cast to consistent types, handle NULLs
- Use the same hash function across your entire vault
- Business keys fed into hubs should be **upper-cased and trimmed** before hashing

```sql
-- Consistent hashing pattern
{{ dbt_utils.generate_surrogate_key([
    'upper(trim(customer_number))'
]) }} as hub_customer_hk
```

## When to Use Data Vault vs Other Patterns

| Use Data Vault When | Use Traditional/Medallion When |
|---------------------|-------------------------------|
| Regulatory audit requirements (full history) | Simple analytics use cases |
| Multiple source systems feeding same entities | Single source of truth |
| Business keys are well-defined and stable | Rapid prototyping or small teams |
| Need to track every change over time | Current-state reporting is sufficient |
| Enterprise data warehouse at scale | Department-level analytics |
| Team experienced with Data Vault patterns | Team new to data modeling |

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Putting descriptive attributes in hubs | Hubs only contain business keys + metadata |
| Skipping the hashdiff in satellites | Without hashdiff, you insert duplicates on every load |
| Using natural keys instead of hash keys for joins | Hash keys enable multi-source integration |
| Building marts directly on raw vault without business vault | Business vault is where derived logic belongs |
| One giant satellite per hub | Split by rate of change (contact info vs. preferences vs. status) |
| Forgetting `record_source` | Essential for tracing data lineage across sources |
| Using `NOT IN` for incremental dedup | Use `LEFT JOIN ... WHERE NULL` — `NOT IN` fails with NULLs and is slower |
| Inconsistent hashing across sources | All staging models must cast, trim, and upper-case business keys identically before hashing |
| Not using `IS DISTINCT FROM` for NULL-safe comparisons | `!=` treats NULL as unknown — use `IS DISTINCT FROM` in hashdiff comparisons where NULLs are possible |

## dbt Packages for Data Vault

**[automate-dv](https://automate-dv.readthedocs.io/)** (formerly dbtvault) provides macros that automate hub/link/satellite generation:

```sql
-- Example: hub using automate-dv macro
{{ automate_dv.hub(
    src_pk='hub_customer_hk',
    src_nk='customer_number',
    src_ldts='load_datetime',
    src_source='record_source',
    source_model='stg_erp__customers'
) }}
```

The package reduces boilerplate by generating the incremental + hashdiff + deduplication logic from declarative config. Consider using it for larger vaults with many hubs/links/satellites.
