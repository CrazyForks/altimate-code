# Theme I: Data Contracts & API-Driven Validation

The emerging paradigm of treating data interfaces like software APIs with formal contracts.

---

## 1. Data Contracts Overview

### The Paradigm Shift

Data contracts represent a fundamental shift from reactive "schema tests" to proactive, formal API-like agreements between data producers and consumers. Instead of discovering data issues after they propagate through pipelines, contracts enforce structural and quality guarantees at the boundary — the same way API contracts (OpenAPI, gRPC) govern service-to-service communication.

The core idea: **data is an API, and every API needs a contract.**

A data contract is a formal agreement between a data producer and its consumers that specifies:
- **Schema**: Column names, data types, constraints
- **Quality**: Freshness, completeness, validity rules
- **SLA**: Availability, latency, update frequency
- **Terms**: Usage rights, retention, PII classification
- **Ownership**: Who is responsible for the data product

### Andrew Jones and the Origin Story

[Andrew Jones](https://andrew-jones.com/categories/data-contracts/), Principal Engineer at GoCardless (formerly PayPal), created data contracts in 2021 as an architectural pattern. His 2023 book *"Driving Data Quality with Data Contracts"* (O'Reilly) is the definitive reference. The key insight: traditional data quality approaches are **reactive** (monitoring after the fact), while contracts are **proactive** (preventing bad data at the source).

Jones's formulation positions data contracts at the intersection of three forces:
1. **Data mesh** — Domain teams own their data products
2. **Software engineering** — API versioning, backward compatibility, contract testing
3. **Data quality** — Schema validation, freshness, completeness

### The Two Specification Standards

#### Open Data Contract Standard (ODCS) v3.1.0 — The Active Standard

The [Open Data Contract Standard](https://bitol-io.github.io/open-data-contract-standard/v3.1.0/home/) (ODCS), governed by the [Bitol](https://github.com/bitol-io/open-data-contract-standard) project under the LF AI & Data Foundation, is now the unified industry standard. Apache 2.0 licensed, 696+ GitHub stars.

**Top-level structure:**

| Section | Purpose |
|---------|---------|
| Fundamentals | `apiVersion`, `kind`, `id`, `name`, `version`, `status`, `domain` |
| Schema | Tables, columns, data types, complex structures (JSON, Avro) |
| Data Quality | Plain text, SQL, or predefined rules (rowCount, unique, freshness) |
| SLA | Declarative dimensions + executable "as code" rules |
| Team | Ownership, contacts |
| Roles | Stakeholder assignments |
| Pricing | Cost structures |
| Infrastructure & Servers | Technical deployment details |
| Custom Properties | Extension fields |

ODCS v3.1.0 supports complex data structures (JSON, Avro models), quality guarantees as both human-readable text and machine-executable SQL, and SLA objects split into declarative (target levels) and executable (validation code) sections.

Official media type: `application/odcs+yaml;version=3.1.0`

#### Data Contract Specification — Deprecated

The [Data Contract Specification](https://datacontract-specification.com/) (created by the datacontract.com community) has been **deprecated in favor of ODCS** as of 2025, with support continuing until end of 2026. Migration path:

```bash
datacontract export --format odcs --output odcs.yaml datacontract.yaml
```

The deprecated spec remains instructive for its clean design. Here is a representative example:

```yaml
dataContractSpecification: 1.2.1
id: orders-latest
info:
  title: Orders Latest
  version: 2.0.0
  description: Customer order data from webshop
  owner: Checkout Team
  status: active
  contact:
    name: John Doe
    url: https://teams.microsoft.com/l/channel/example/checkout

servers:
  production:
    type: s3
    environment: prod
    location: s3://bucket/path/{model}/*.json
    format: json
    delimiter: new_line

terms:
  usage: Data for reports, analytics, and ML
  limitations: Not for real-time use
  billing: 5000 USD per month
  noticePeriod: P3M

models:
  orders:
    type: table
    description: One record per order
    fields:
      order_id:
        type: text
        format: uuid
        required: true
        primaryKey: true
      customer_email:
        type: text
        format: email
        required: true
        pii: true
        classification: sensitive
      order_total:
        type: long
        required: true
        quality:
          - type: sql
            query: "SELECT COUNT(*) FROM {model}"
            mustBeGreaterThan: 100

servicelevels:
  availability:
    percentage: 99.9%
  retention:
    period: P1Y
  latency:
    threshold: 25h
    sourceTimestampField: orders.order_timestamp
```

### YAML-Based vs Code-Based Contracts

| Approach | Examples | Strengths | Weaknesses |
|----------|----------|-----------|------------|
| **YAML-based** | ODCS, Data Contract Spec, Soda Contracts | Declarative, readable, versionable, language-agnostic | Limited expressiveness for complex validation logic |
| **Code-based** | Great Expectations (Python), Protobuf + Protovalidate | Full programming power, type-safe generated code | Tied to a language, harder for non-engineers to read |
| **Hybrid** | dbt contracts (YAML config + SQL enforcement) | Best of both: declarative interface, SQL power underneath | Coupled to dbt ecosystem |

The industry is converging on **YAML-first with escape hatches to SQL/code** for complex validations.

### Community Sentiment

The data engineering community on Reddit and Substack shows mixed adoption:
- **Proponents**: Data contracts enforce accountability, prevent breaking changes, and formalize the producer-consumer relationship
- **Skeptics**: Implementation requires organizational buy-in that most teams lack; the tooling ecosystem is immature; contracts add process overhead
- **Pragmatists**: Contracts work well at scale (50+ data products) but are overkill for small teams; start with schema contracts and add quality rules incrementally

Sources: [Data Contracts — Andrew Jones](https://andrew-jones.com/categories/data-contracts/), [Data Contract Specification](https://datacontract-specification.com/), [ODCS GitHub](https://github.com/bitol-io/open-data-contract-standard), [datacontract.com](https://datacontract.com/), [Monte Carlo — Data Contracts Explained](https://www.montecarlodata.com/blog-data-contracts-explained/)

---

## 2. dbt Contracts & Model Governance

### Model Contracts

dbt introduced [model contracts](https://docs.getdbt.com/docs/mesh/govern/model-contracts) as a governance mechanism that guarantees the **shape** of a model (column names, data types, constraints) before it builds. When a contract is enforced, dbt validates the model's runtime schema against the contract — if something changed (column dropped, type changed, field missing), the run fails.

```yaml
models:
  - name: dim_customers
    config:
      contract:
        enforced: true
    columns:
      - name: customer_id
        data_type: int
        constraints:
          - type: not_null
      - name: customer_name
        data_type: string
      - name: email
        data_type: string
        constraints:
          - type: unique
```

**Enforcement mechanism** (two steps):
1. **Preflight validation**: Verifies the model's query returns columns matching names and data types (order-independent)
2. **DDL integration**: Includes column names, types, and constraints in database CREATE/ALTER statements

**Key distinction**: Contracts validate **structure at build time** (preventing the model from materializing). Data tests validate **content after build** (checking row-level quality). Both are needed.

### Supported Constraints by Platform

| Constraint | PostgreSQL | Snowflake | BigQuery | Databricks |
|-----------|-----------|-----------|----------|------------|
| `not_null` | Enforced | Enforced | Enforced | Enforced |
| `unique` | Enforced | Definable only | Not supported | Not supported |
| `primary_key` | Enforced | Definable only | Definable only | Definable only |
| `foreign_key` | Enforced | Definable only | Definable only | Definable only |
| `check` | Enforced | Not supported | Not supported | Enforced |

**Supported materializations**: `table`, `view` (limited), `incremental` (with `on_schema_change: append_new_columns` or `fail`). Not supported: Python models, ephemeral, materialized views.

### Access Modifiers

dbt provides three [access levels](https://docs.getdbt.com/docs/mesh/govern/model-access) to control model visibility:

| Level | Referenceable By | Use Case |
|-------|-----------------|----------|
| `private` | Same group only | Implementation details, staging models |
| `protected` | Same project (default) | Internal project models |
| `public` | Any group, package, or project | Stable data products for cross-team consumption |

```yaml
groups:
  - name: customer_success
    owner:
      name: Customer Success Team
      email: cx@jaffle.shop

models:
  - name: dim_customers
    config:
      group: customer_success
      access: public
      contract:
        enforced: true   # Recommended for all public models

  - name: int_customer_history_rollup
    config:
      group: customer_success
      access: private    # Implementation detail
```

Best practice: **All public models should have enforced contracts.** The dbt project evaluator's `fct_public_models_without_contract` rule flags violations.

### Model Versions for Backward Compatibility

[Model versions](https://docs.getdbt.com/docs/mesh/govern/model-versions) enable producers to make breaking changes without immediately breaking consumers:

```yaml
models:
  - name: dim_customers
    latest_version: 2
    config:
      contract:
        enforced: true
    columns:
      - name: customer_id
        data_type: int
      - name: country_name
        data_type: varchar
    versions:
      - v: 2
        columns:
          - include: all
            exclude: [country_name]  # Breaking change: removed column
      - v: 1
        deprecation_date: 2025-06-01
```

**How `ref()` resolves:**
- `ref('dim_customers')` → latest version (v2)
- `ref('dim_customers', v=1)` → pinned to v1 (shows deprecation warning)

**Recommended cadence**: Bump latest version once or twice a year with advance communication. Non-breaking changes (adding columns, fixing calculations) don't require new versions.

### Breaking Change Detection

dbt detects and flags breaking changes when comparing against previous project state:
- Removing existing columns
- Changing a column's data type
- Removing or modifying constraints
- Removing contracted models (error for versioned, warning for unversioned)

Sources: [dbt Model Contracts](https://docs.getdbt.com/docs/mesh/govern/model-contracts), [dbt Model Access](https://docs.getdbt.com/docs/mesh/govern/model-access), [dbt Model Versions](https://docs.getdbt.com/docs/mesh/govern/model-versions), [dbt Governance Overview](https://docs.getdbt.com/docs/mesh/govern/about-model-governance)

---

## 3. Schema Registry Approaches

### Confluent Schema Registry

The [Confluent Schema Registry](https://docs.confluent.io/platform/current/schema-registry/index.html) is the most mature schema evolution system, supporting Avro, Protobuf, and JSON Schema. It validates schema changes **at registration time**, preventing incompatible schemas from being published.

#### Compatibility Modes

| Mode | Rule | Use Case |
|------|------|----------|
| `BACKWARD` (default) | New schema can read old data | Adding optional fields, removing fields with defaults |
| `BACKWARD_TRANSITIVE` | New schema can read all old data | Strictest backward compat — checked against all versions |
| `FORWARD` | Old schema can read new data | Adding required fields (consumers handle unknowns) |
| `FORWARD_TRANSITIVE` | All old schemas can read new data | Checked against all versions |
| `FULL` | Both backward and forward compatible | Only safe changes: add/remove optional fields |
| `FULL_TRANSITIVE` | Full compat against all versions | Maximum safety, minimum flexibility |
| `NONE` | No compatibility checking | Development/testing only |

#### How It Prevents Data Corruption — A Real Example

A retail system streams transactions via Kafka. The `transactions-value` subject has a schema with a `uuid` field. If a developer removes the `uuid` field:

1. **Without Schema Registry**: Producer sends data without `uuid` → Consumer expects `uuid` → Exception → Application crashes → Data loss
2. **With Schema Registry (BACKWARD mode)**: Developer tries to register new schema without `uuid` → Registry rejects registration (removing a required field without a default breaks backward compatibility) → Schema change never reaches production

The registry acts as a **compile-time check for data schemas** — the same way a type checker prevents type errors in compiled languages.

#### Transitive vs Non-Transitive

- **Non-transitive** (e.g., `BACKWARD`): Checks only against the latest version. If you evolve A→B→C, C is checked against B only.
- **Transitive** (e.g., `BACKWARD_TRANSITIVE`): Checks against all versions. C is checked against both A and B. This prevents subtle incompatibilities that emerge over multiple evolution steps.

### AWS Glue Schema Registry

[AWS Glue Schema Registry](https://docs.aws.amazon.com/glue/latest/dg/schema-registry.html) provides similar capabilities natively in AWS:
- Supports Avro, JSON Schema, and Protobuf
- Same compatibility modes as Confluent (BACKWARD, FORWARD, FULL, NONE + transitive variants)
- Integrates with MSK, Kinesis Data Streams, Kafka Streams
- Auto-registration: New schemas can be registered automatically when a producer sends data
- IAM-based access control
- `DISABLED` mode: Prevents any schema changes after the first version (for locked-down production topics)

### Lessons for Data Contracts

Schema registries pioneered key concepts that data contracts now generalize:

| Schema Registry Concept | Data Contract Equivalent |
|------------------------|-------------------------|
| Schema subject | Data product / dataset |
| Compatibility mode | Contract versioning rules |
| Registration-time validation | CI/CD contract validation |
| Schema evolution | Contract evolution with deprecation |
| Subject-level policies | Per-dataset governance rules |

The critical lesson: **validate at the boundary, not after the fact.** Schema registries reject incompatible changes before they reach production. Data contracts should do the same.

Sources: [Confluent Schema Evolution](https://docs.confluent.io/platform/current/schema-registry/fundamentals/schema-evolution.html), [Schema Compatibility Patterns](https://developer.confluent.io/patterns/event-stream/schema-compatibility/), [AWS Glue Schema Registry](https://docs.aws.amazon.com/glue/latest/dg/schema-registry.html)

---

## 4. Contract Testing for Data

### From Microservices to Data Pipelines

Consumer-driven contract testing (popularized by [Pact](https://pact.io/) for microservices) is being adapted for data pipelines. The core pattern:

1. **Consumer defines expectations**: "I need columns A, B, C with types X, Y, Z"
2. **Producer validates against consumer expectations**: "My output satisfies all registered consumer contracts"
3. **Breaking change detection**: "This schema change would violate Consumer X's contract"

### Producer vs Consumer Contracts

| Aspect | Producer Contract | Consumer Contract |
|--------|------------------|-------------------|
| **Defined by** | Data producer (domain team) | Data consumer (analytics/ML team) |
| **Guarantees** | "I will always provide these columns, types, and quality levels" | "I depend on these specific columns and expect these quality levels" |
| **Enforced at** | Build time / CI/CD | Integration test / pre-deployment |
| **Analogy** | OpenAPI spec defined by API team | Pact contract defined by API consumer |

### The Data Mesh Contract Pattern

In a data mesh architecture, contracts serve as the **interface specification** for data product output ports:

```
┌─────────────────┐     Contract     ┌─────────────────┐
│  Domain Team A  │ ──────────────── │  Domain Team B  │
│  (Producer)     │    defines:      │  (Consumer)     │
│                 │   - Schema       │                 │
│  Output Port    │   - Quality SLA  │  Input Port     │
│  (BigQuery)     │   - Freshness    │  (reads table)  │
└─────────────────┘   - Terms        └─────────────────┘
```

The contract lives at the boundary between producer and consumer. It can be validated:
- **At the producer**: "Does my output match what I promised?"
- **At the consumer**: "Does the data I received match what I expected?"
- **In CI/CD**: "Does this code change break any downstream contract?"

### Shift-Left Contract Validation in CI/CD

The emerging best practice is a four-stage pipeline ([source](https://dev.to/nabindebnath/the-shift-left-imperative-implementing-data-contracts-in-cicd-pipeline-40cl)):

1. **Contract Definition & Storage**: Contracts live in source control alongside producer code (YAML/JSON Schema/Avro). Changes go through pull request review.
2. **CI Validation (Pre-Merge)**: Structural validation (is the contract well-formed?) + compatibility checking (does this change break backward compatibility?). Failing CI blocks the merge.
3. **Artifact Generation**: Post-validation, auto-generate language-specific domain objects and publish the contract to a registry.
4. **Consumer Integration**: Downstream services pull approved contracts and embed validation into production code.

This transforms data quality from **reactive** (post-mortem debugging) to **proactive** (contract-driven development).

Sources: [Shift-Left Data Contracts in CI/CD](https://dev.to/nabindebnath/the-shift-left-imperative-implementing-data-contracts-in-cicd-pipeline-40cl), [Data Mesh Architecture](https://www.datamesh-architecture.com/), [From Monolith to Contract-Driven Data Mesh](https://towardsdatascience.com/from-monolith-to-contract-driven-data-mesh/)

---

## 5. Open-Source Contract Tools

### datacontract-cli

The [datacontract-cli](https://github.com/datacontract/datacontract-cli) is the most comprehensive open-source CLI for data contract management. Written in Python, it natively supports ODCS.

**Core commands:**

| Command | Purpose |
|---------|---------|
| `datacontract init` | Create a new contract from template |
| `datacontract lint` | Validate YAML structure and compliance |
| `datacontract test` | Execute schema + quality checks against live data |
| `datacontract export` | Convert to 25+ formats (HTML, Avro, dbt, JSON Schema, SQL DDL, Protobuf, Pydantic, etc.) |
| `datacontract import` | Generate contracts from existing schemas (Avro, SQL, Glue, BigQuery, etc.) |
| `datacontract catalog` | Generate HTML documentation for multiple contracts |

**Supported data sources for testing** (14+):
- Cloud warehouses: BigQuery, Snowflake, Databricks
- Data lakes: S3, Azure Blob/ADLS, Athena
- Databases: PostgreSQL, SQL Server, Oracle, Trino
- Streaming: Kafka
- File formats: Parquet, JSON, CSV, Delta, Iceberg

**Export formats** (25+): HTML, Markdown, JSON Schema, Avro, Protobuf, SQL DDL, BigQuery, dbt models/sources, Great Expectations, Terraform, Go, Pydantic, SQLAlchemy, DBML, Spark StructType, Excel, Jinja templates.

**Installation:**
```bash
pip install datacontract-cli            # Base
pip install datacontract-cli[snowflake] # With Snowflake support
pip install datacontract-cli[all]       # All integrations
```

### Soda Contracts

[Soda Core](https://github.com/sodadata/soda-core) (open source, Apache 2.0) provides a data contract verification engine with its own YAML-based language (SodaCL).

**Contract YAML structure:**

```yaml
dataset: production/analytics/public/orders

checks:
  - schema:
      allow_extra_columns: false
      allow_other_column_order: false
  - row_count:
      threshold:
        must_be_greater_than: 0
  - freshness:
      column: created_at
      threshold:
        unit: hour
        must_be_less_than: 24

filter: "created_at >= CURRENT_DATE - INTERVAL '1 day'"

columns:
  - name: order_id
    data_type: varchar
    checks:
      - missing:
          threshold:
            must_be: 0
      - duplicate:

  - name: customer_email
    data_type: varchar
    checks:
      - missing:
          threshold:
            metric: percent
            must_be_less_than: 5
      - invalid:
          valid_format:
            regex: ^[a-zA-Z0-9+_.-]+@[a-zA-Z0-9.-]+$

  - name: order_total
    data_type: numeric
    checks:
      - aggregate:
          function: avg
          threshold:
            must_be_between:
              greater_than: 20
              less_than: 500
      - invalid:
          valid_min: 0
```

**Available check types:**
- `schema` — Column presence, types, ordering
- `row_count` — Row count thresholds
- `freshness` — Data staleness detection
- `missing` — Null/empty value checks
- `invalid` — Value format/range validation
- `duplicate` — Uniqueness enforcement
- `aggregate` — AVG, MIN, MAX, SUM thresholds
- `metric` — Custom SQL expression checks
- `failed_rows` — Row-level condition checks
- `group_by` — Per-group metric validation

**Programmatic verification:**
```python
from soda.contracts.contract_verification import ContractVerification

verification = (
    ContractVerification.builder()
    .with_contract_yaml_file("orders_contract.yaml")
    .with_data_source_yaml_file("datasource.yaml")
    .execute()
)

# Check results
if verification.failed:
    for check in verification.failed_checks:
        print(f"FAILED: {check.name} — {check.message}")
```

**Note**: Soda Core is open source; dashboards, alerting, anomaly detection, and full data contract management require Soda Cloud (commercial).

### Great Expectations

[Great Expectations](https://greatexpectations.io/) (GX) serves as a contract enforcement layer through its "Expectations" model — each expectation is essentially a data quality assertion:

```python
import great_expectations as gx

context = gx.get_context()

# Define expectations (contract assertions)
suite = context.add_expectation_suite("orders_contract")
suite.add_expectation(
    gx.expectations.ExpectColumnToExist(column="order_id")
)
suite.add_expectation(
    gx.expectations.ExpectColumnValuesToNotBeNull(column="order_id")
)
suite.add_expectation(
    gx.expectations.ExpectColumnValuesToBeUnique(column="order_id")
)
suite.add_expectation(
    gx.expectations.ExpectColumnValuesToBeBetween(
        column="order_total", min_value=0, max_value=100000
    )
)

# Run validation (contract enforcement)
result = context.run_checkpoint(checkpoint_name="orders_checkpoint")
```

GX is commonly used in Airflow DAGs: wrap GX validation in a Docker container, run with Kubernetes Pod Operator, and fail the DAG task if expectations are violated. This pattern separates scheduling (Airflow) from validation logic (GX).

### Buf (Protobuf Lessons for Data Contracts)

[Buf](https://buf.build/) provides 40 lint rules and 53 breaking change rules for Protobuf schemas. Its [Protovalidate](https://github.com/bufbuild/protovalidate) library (v1.0) enables semantic validation directly in schema definitions.

Key architectural lessons from Buf that apply to data contracts:

1. **Breaking change detection should be automated and fast** — Buf runs in IDEs and CI, catching issues before code review. Data contract tools should do the same.
2. **Compatibility levels should be configurable** — Buf's `FILE` (strictest) vs `PACKAGE` vs `WIRE_JSON` levels parallel schema registry compatibility modes.
3. **Schema gives structure; validation gives quality** — Protobuf defines shape, Protovalidate enforces semantics. Similarly, data contracts need both schema (column types) and quality rules (value constraints).
4. **Define validation once, enforce everywhere** — Protovalidate rules live in the .proto file and are enforced in Go, Java, Python, C++, JS/TS. Data contract rules should similarly be defined once and enforced across all consumers.

Sources: [datacontract-cli](https://cli.datacontract.com/), [Soda Data Contracts](https://docs.soda.io/data-contracts), [Great Expectations](https://greatexpectations.io/), [Buf](https://buf.build/), [Protovalidate](https://github.com/bufbuild/protovalidate)

---

## 6. Production Implementations

### GoCardless — 300 Contracts in Production

[GoCardless](https://medium.com/gocardless-tech/data-contracts-at-gocardless-6-months-on-bbf24a37206e) (Andrew Jones's employer) is the canonical data contracts success story:

- **Contract format**: Jsonette (a configuration language), stored in Git
- **Infrastructure**: Custom Kubernetes-based platform ("Utopia") that auto-deploys BigQuery tables and PubSub topics from contract definitions
- **Adoption**: ~300 contracts in production, with 50% created in the most recent 6 months
- **Coverage**: 80% of Pub/Sub topics managed via data contracts
- **Key outcome**: Data contracts have become the primary mechanism for inter-service asynchronous communication

**Architecture:**
```
Contract (Jsonette)          Utopia Platform           Data Consumers
    ↓                            ↓                        ↓
Merged to Git → Auto-deploy → BigQuery tables     ← Analysts query
                            → PubSub topics       ← Services consume
                            → Access controls     ← RBAC enforced
```

### PayPal — The Original Data Contract Template

PayPal released the first widely-known data contract specification, focusing on eight sections: demographics, dataset & schema, data quality, pricing, stakeholders, roles, SLA, and custom properties. The PayPal template (v2.1.1) influenced both ODCS and the Data Contract Specification.

### Adevinta Spain — Data Mesh + Contracts

[Adevinta Spain](https://www.gable.ai/blog/data-contracts-in-the-real-world-the-adevinta-spain-implementation-sergio-catoira-shift-left-data-conference-2025) transitioned from a best-effort governance model to governed data integration by design:

- **Problem**: Third-party integrators creating data ingestion didn't understand the data well enough
- **Solution**: Declarative data contract framework for the bronze layer
- **Architecture**: Contracts define source-aligned data products; the ingestion suite validates data quality on events, creating a raw, event-oriented bronze layer
- **Key outcome**: Democratized data ingestion — domain experts (not just engineers) can author contracts because the framework is declarative, not code-heavy

### Data Mesh + Data Contracts: The Governance Layer

In data mesh architectures, contracts serve as the **governance mechanism** for the fourth principle (federated computational governance):

```
┌──────────────────────────────────────────────────┐
│                 Federated Governance              │
│                                                   │
│  Global Policies    Data Contracts    Domain Rules │
│  (compliance,       (schema, SLA,    (business     │
│   security)         quality)          logic)        │
└──────────────────────────────────────────────────┘
         ↓                  ↓                ↓
    ┌─────────┐      ┌─────────┐      ┌─────────┐
    │ Domain A│      │ Domain B│      │ Domain C│
    │ (Orders)│      │ (Users) │      │ (Billing)│
    │         │      │         │      │          │
    │ Output  │ ──── │ Input   │ ──── │ Input    │
    │ Port    │      │ Port    │      │ Port     │
    └─────────┘      └─────────┘      └──────────┘
```

Each domain owns its data products, each product has an output port, and each output port has a contract. The contract is what makes the data product **trustworthy** — without it, consumers must blindly trust that upstream data hasn't changed.

### The "Data Product" Quality Guarantee

A data product is only a product if it has quality guarantees. The contract provides:
- **Discoverability**: What data exists, what it means, who owns it
- **Addressability**: Where to find it (table, topic, API endpoint)
- **Trustworthiness**: Schema guarantees, quality rules, freshness SLAs
- **Self-describing**: Documentation, lineage, PII classification
- **Interoperability**: Standardized format that tools can consume

### Gable — Commercial Data Contract Platform

[Gable](https://www.gable.ai/) ($27M funded, Series A in 2025) is the leading commercial data contract platform:
- Analyzes source code for data lineage
- Enforces contracts in CI/CD pipelines
- Prevents schema drift before deployment
- Serves 15,000+ data practitioners

Sources: [GoCardless — 6 Months On](https://medium.com/gocardless-tech/data-contracts-at-gocardless-6-months-on-bbf24a37206e), [GoCardless — Improving Data Quality](https://medium.com/gocardless-tech/improving-data-quality-with-data-contracts-238041e35698), [Adevinta — Shift Left Conference 2025](https://www.gable.ai/blog/data-contracts-in-the-real-world-the-adevinta-spain-implementation-sergio-catoira-shift-left-data-conference-2025), [Data Mesh Architecture](https://www.datamesh-architecture.com/), [Gable](https://www.gable.ai/)

---

## 7. Implications for Reladiff

### The Opportunity: Contract-Aware Data Diffing

Today, data diff tools compare tables structurally: "these rows differ between source and target." But they don't answer the question: **"does this data meet its contract?"** This is the gap Reladiff can fill.

### Pre-Diff Contract Validation

Before computing row-level diffs, validate that both source and target datasets conform to their contracts:

```
                    Contract YAML
                         │
                    ┌────┴─────┐
                    │ Contract │
                    │ Validator│
                    └────┬─────┘
                         │
              ┌──────────┼──────────┐
              ▼                     ▼
         ┌─────────┐          ┌─────────┐
         │ Source   │          │ Target  │
         │ Dataset  │          │ Dataset │
         └────┬────┘          └────┬────┘
              │                    │
              └────────┬───────────┘
                       │
                  ┌────┴─────┐
                  │  Data    │
                  │  Diff    │
                  └──────────┘
```

**Pre-diff checks** (fast, run before expensive diff):
- Schema conformance: Are all required columns present with correct types?
- Constraint validation: NOT NULL, UNIQUE, PRIMARY KEY
- Freshness: Is the data recent enough per the SLA?
- Row count sanity: Is the dataset within expected bounds?

If pre-diff checks fail, report the contract violations *without* running the full diff — this saves compute and gives an immediate, actionable answer.

### Post-Diff Contract Validation

After computing the diff, validate that the **differences themselves** don't represent contract violations:

- **New rows in target violate constraints**: "5,000 new rows have NULL values in `customer_id` (NOT NULL contract)"
- **Changed values violate ranges**: "Modified `order_total` values include negatives (contract: min=0)"
- **Missing rows impact SLA**: "1,200 rows present in source but missing in target; row_count drops below contract minimum"

### Consuming Data Contract YAML Definitions

Reladiff could natively consume ODCS or Data Contract Specification YAML files:

```bash
# Validate source against contract, then diff against target
reladiff \
  --source snowflake://prod/orders \
  --target snowflake://staging/orders \
  --contract orders.odcs.yaml \
  --primary-key order_id
```

The contract YAML provides:
1. **Column types**: For type-aware comparison (don't diff timestamps as strings)
2. **Required columns**: Flag if target is missing columns that exist in contract
3. **Quality rules**: Apply contract quality checks to the diff result
4. **PII classification**: Mask sensitive columns in diff output
5. **SLA thresholds**: Alert if diff results indicate SLA violations (e.g., freshness)

### Contract-Based Validation Rules

A contract naturally maps to validation checks:

| Contract Field | Reladiff Validation |
|---------------|---------------------|
| `required: true` | Column must exist in both source and target |
| `primaryKey: true` | Use as diff join key; validate uniqueness |
| `type: integer` | Type-coerce before comparison; flag type mismatches |
| `constraints.not_null` | Flag NULL values as contract violations, not just diffs |
| `constraints.unique` | Flag duplicate values in diff results |
| `quality.freshness` | Check data timestamps against SLA before diffing |
| `quality.rowCount` | Sanity check before expensive diff |
| `pii: true` | Mask in diff output; optionally skip diffing PII columns |
| `format: email` | Validate format of changed values |

### Integration Architecture

```python
# Conceptual API for contract-aware diffing
from reladiff import DiffEngine
from reladiff.contracts import ContractLoader

# Load contract from YAML (supports ODCS, Data Contract Spec, Soda)
contract = ContractLoader.from_yaml("orders.odcs.yaml")

# Create diff engine with contract awareness
engine = DiffEngine(
    source="snowflake://prod/analytics/orders",
    target="snowflake://staging/analytics/orders",
    contract=contract,
)

# Pre-diff: validate both datasets against contract
pre_check = engine.validate_contract()
if pre_check.has_violations:
    print(f"Contract violations before diff: {pre_check.violations}")
    # Optionally abort diff if contract is violated

# Run diff with contract-aware type coercion
diff_result = engine.diff()

# Post-diff: validate diff results against contract
post_check = engine.validate_diff_against_contract(diff_result)
if post_check.has_violations:
    print(f"Diff results violate contract: {post_check.violations}")
```

### Why This Matters

The current data quality landscape has a gap:

| Tool | What It Does | What It Doesn't Do |
|------|--------------|--------------------|
| **dbt contracts** | Validates schema at build time | Doesn't compare datasets |
| **Great Expectations** | Validates data quality assertions | Doesn't diff source vs target |
| **Soda** | Validates quality checks | Doesn't provide row-level diffs |
| **Datafold data-diff** | Diffs tables at row level | Doesn't validate against contracts |
| **Schema Registry** | Validates schema evolution | Only for streaming (Kafka) |

**Reladiff + Contracts** fills the intersection: **contract-validated data diffing.** No existing tool does both — validate data against a formal contract specification AND produce row-level diffs between environments.

This positions Reladiff as the tool that answers: "Does this migration/deployment/transformation change data in ways that violate our contracts?" — a question that today requires stitching together multiple tools.

---

## Tool Comparison Matrix

| Tool | Type | Contract Format | Schema Validation | Quality Checks | Breaking Change Detection | Data Diffing | Open Source |
|------|------|----------------|-------------------|----------------|--------------------------|--------------|-------------|
| [datacontract-cli](https://github.com/datacontract/datacontract-cli) | CLI | ODCS YAML | Yes | Yes | Deprecated | No | Yes (Apache 2.0) |
| [Soda Core](https://github.com/sodadata/soda-core) | Engine | SodaCL YAML | Yes | Yes (extensive) | No | No | Yes (Apache 2.0) |
| [Great Expectations](https://greatexpectations.io/) | Framework | Python code | Yes | Yes (extensive) | No | No | Yes (Apache 2.0) |
| [dbt Contracts](https://docs.getdbt.com/docs/mesh/govern/model-contracts) | Build-time | dbt YAML | Yes | Via tests | Yes | No | Yes (Apache 2.0) |
| [Confluent Schema Registry](https://docs.confluent.io/platform/current/schema-registry/) | Registry | Avro/Protobuf/JSON | Yes | No | Yes (core feature) | No | Community Edition |
| [Buf](https://buf.build/) | CLI/Registry | Protobuf | Yes (lint) | Via Protovalidate | Yes (53 rules) | No | Yes (Apache 2.0) |
| [Datafold data-diff](https://github.com/datafold/data-diff) | CLI | None | No | No | No | Yes (core feature) | Yes (MIT) |
| [Gable](https://www.gable.ai/) | Platform | Multiple | Yes | Yes | Yes (CI/CD) | No | No (Commercial) |
| **Reladiff (proposed)** | **CLI** | **ODCS/Soda/dbt** | **Yes** | **Yes** | **Via diff** | **Yes** | **Yes** |
