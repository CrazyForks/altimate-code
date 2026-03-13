# How Real Companies Validate Data During Large-Scale Database Migrations

> A comprehensive survey of engineering practices, tools, and lessons learned from the world's most demanding migration projects.

**Last updated:** 2026-03-13

---

## Table of Contents

1. [Netflix: Iceberg Migration and Write-Audit-Publish](#1-netflix-iceberg-migration-and-write-audit-publish)
2. [Stripe: Zero-Downtime Migrations at Financial Scale](#2-stripe-zero-downtime-migrations-at-financial-scale)
3. [GitHub: MySQL Migrations with gh-ost and Vitess](#3-github-mysql-migrations-with-gh-ost-and-vitess)
4. [Uber: Schemaless to DocStore and MyRocks](#4-uber-schemaless-to-docstore-and-myrocks)
5. [Airbnb: Data Quality at Scale](#5-airbnb-data-quality-at-scale)
6. [Shopify: Shard Balancing with Ghostferry](#6-shopify-shard-balancing-with-ghostferry)
7. [LinkedIn: Self-Healing Migrations and Data Sentinel](#7-linkedin-self-healing-migrations-and-data-sentinel)
8. [Pinterest: Shadow Traffic and Graph Service Modernization](#8-pinterest-shadow-traffic-and-graph-service-modernization)
9. [Square/Block: Shift and Vitess at Scale](#9-squareblock-shift-and-vitess-at-scale)
10. [Open-Source Migration Tools and Their Validation Features](#10-open-source-migration-tools-and-their-validation-features)
11. [Community Wisdom: Reddit and Hacker News](#11-community-wisdom-reddit-and-hacker-news)
12. [Anti-Patterns: Migrations That Failed](#12-anti-patterns-migrations-that-failed)
13. [Cross-Cutting Themes and Synthesis](#13-cross-cutting-themes-and-synthesis)

---

## 1. Netflix: Iceberg Migration and Write-Audit-Publish

### Context and Scale

Netflix created Apache Iceberg and undertook one of the largest table format migrations in history: converting approximately **1.5 million Hive tables** across a data warehouse storing **300+ petabytes** of data to the Iceberg format. This was not a simple schema change -- it was a fundamental rearchitecture of how Netflix's entire data lake operated.

**Sources:**
- [Netflix's Apache Iceberg Data Lake Migration (AWS re:Invent)](https://aws.amazon.com/video/watch/3db41488539/)
- [Netflix-Skunkworks/hive2iceberg-migration (GitHub)](https://github.com/Netflix-Skunkworks/hive2iceberg-migration)
- [Incremental Processing using Netflix Maestro and Apache Iceberg (Netflix TechBlog)](https://netflixtechblog.com/incremental-processing-using-netflix-maestro-and-apache-iceberg-b8ba072ddeeb)
- [How does Netflix ensure data quality for thousands of Apache Iceberg tables?](https://vutr.substack.com/p/how-does-netflix-ensure-the-data)

### Migration Architecture

Netflix built a multi-component migration framework with five distinct services:

1. **PREPROCESSOR** -- Analyzes tables and prepares them for migration
2. **COMMUNICATOR** -- Notifies table owners and tracks acknowledgments
3. **MIGRATOR** -- Performs the actual Hive-to-Iceberg table conversion
4. **SHADOWER** -- Maintains synchronized copies for validation during a probation period
5. **REVERTER** -- Provides rollback capability if issues are discovered

The migration used daily (or custom schedule) workflows to orchestrate these components through a state machine that tracked each table's migration status.

### The Shadow Validation Pattern

Netflix's most distinctive validation technique is the **Shadower**. During the probation period after migration:

- The Shadower selects tables that have been migrated and performs **incremental shadowing** from the new Iceberg table back to the original Hive table (renamed with a `_hive` suffix).
- It compares the Hive table's watermark against the current `snapshot_id` of the Iceberg table.
- If they don't match, the Shadow Tool incrementally copies data from the Iceberg table to the Hive shadow, then updates the watermark to record that the two are in sync.
- Table owners can query both the new Iceberg table and the `_hive` shadow table to verify results match their expectations.
- If any issues are discovered, the **Reverter** can swap the primary table back to Hive without data loss.

This is essentially a **bi-directional sync with automated consistency checking** -- the Iceberg table is the new primary, but the Hive shadow provides a continuous validation baseline.

### Write-Audit-Publish (WAP) Pattern

For ongoing data quality after migration, Netflix employs the **Write-Audit-Publish** pattern, which leverages Iceberg's native branching capability:

1. **Write**: Data producers commit new data to an **isolated Iceberg branch** rather than the main table branch. This creates an independent snapshot lineage that is invisible to downstream consumers.

2. **Audit**: Netflix's internal **Data Auditor** tool validates the staged data against quality standards. The auditor can check completeness, schema conformance, statistical distributions, and business rules. Because Iceberg tracks column-level statistics in manifest files, the auditor can perform lightweight validation without scanning full datasets.

3. **Publish**: Only after the audit passes does the branch get **fast-forward merged** into the main branch -- analogous to merging a Git pull request. If the audit fails, the branch is discarded with zero impact on production consumers.

This pattern is critical because it means **no consumer ever sees bad data**. The validation happens in an isolated staging area before exposure, reducing "dashboards with weird trends/numbers" as Netflix engineers described.

### Key Techniques

| Technique | Description | When Used |
|---|---|---|
| Incremental shadowing | Sync Iceberg data back to Hive shadow for comparison | During probation period |
| Snapshot watermarks | Track sync state between Iceberg and Hive copies | Throughout migration |
| WAP branching | Isolate writes in branches, audit before publishing | Ongoing data quality |
| State machine tracking | Per-table migration status through defined phases | Migration orchestration |
| Automated reverter | One-click rollback to Hive if issues found | Emergency recovery |

### What Worked

- The probation period with shadow tables gave table owners confidence to adopt Iceberg without risking production workloads.
- WAP eliminated the class of bugs where bad data reaches consumers before anyone notices.
- The state machine approach allowed Netflix to migrate 1.5 million tables incrementally rather than in a single cutover.

### What Was Challenging

- At 1.5 million tables, the migration required significant automation -- manual validation was impossible.
- The shadow tables consumed additional storage during the probation period.
- Coordinating with thousands of table owners across the company required the COMMUNICATOR service.

---

## 2. Stripe: Zero-Downtime Migrations at Financial Scale

### Context and Scale

Stripe processes payments for millions of businesses, making data correctness literally a financial obligation. Their infrastructure runs on **DocDB**, a MongoDB-based document database processing **over 5 million queries per second** across **2,000+ database shards**, managing **petabytes of financial data** in **5,000+ collections**.

In 2023 alone, Stripe **migrated 1.5 petabytes of data** and reduced total shard count by approximately 75%, all transparent to product applications.

**Sources:**
- [Online migrations at scale (Stripe Blog, 2017)](https://stripe.com/blog/online-migrations)
- [How Stripe's document databases supported 99.999% uptime with zero-downtime data migrations (Stripe Blog, 2024)](https://stripe.com/blog/how-stripes-document-databases-supported-99.999-uptime-with-zero-downtime-data-migrations)
- [Stripe's Zero-Downtime Data Movement Platform (InfoQ, 2025)](https://www.infoq.com/news/2025/11/stripe-zero-downtime-date-move/)

### The Classic Four-Phase Pattern (2017)

Stripe's 2017 blog post established what has become the canonical approach to online migrations. They migrated hundreds of millions of Subscription objects using four phases:

**Phase 1: Dual Writing**
- Write to both old and new tables simultaneously to keep them in sync.
- Backfill historical data offline using **Hadoop/MapReduce** to avoid straining production databases.
- Sequential processing of 100 million objects at one second per object would take **over three years**, so parallelized offline processing was essential.

**Phase 2: Dark Reading (Change Read Paths)**
- Begin reading from the new table while continuing to write to both.
- Use **GitHub's Scientist library** to run experiments that read from both tables and compare results.
- Any discrepancy triggers an alert, allowing engineers to investigate before committing to the new path.
- Scientist is read-only by design -- it randomizes execution order to catch ordering bugs and records duration of both paths.

**Phase 3: Change Write Paths**
- Reverse the primary write direction to the new table.
- Continue writing to the old table for safety.

**Phase 4: Cleanup**
- Remove dependencies on the legacy data model.
- Delete old data only after thorough verification.

**Key constraint**: Engineers never refactored more than a few hundred lines of code simultaneously, keeping each change small and verifiable.

### The Data Movement Platform (2024)

By 2024, Stripe had built a sophisticated **Data Movement Platform** that automates the entire migration process:

**Step 1: Registration and Index Building**
The Coordinator service registers migration intent in a chunk metadata service and pre-builds indexes on target shards before any data moves.

**Step 2: Bulk Data Import (Optimized)**
A critical optimization: data is sorted by the most common index attributes before insertion, leveraging DocDB's B-tree structure. This **boosted write throughput by 10x** compared to unsorted insertion.

**Step 3: Asynchronous Replication**
Mutations are captured via operation logs (oplog), transported through Kafka, and archived to S3. The replication service supports:
- Starting, pausing, and resuming from checkpoints
- **Bidirectional replication** enabling traffic reversal if issues emerge

**Step 4: Correctness Validation**
Rather than validating row-by-row during replication (which would impact performance), Stripe conducts **comprehensive point-in-time snapshot comparisons**. This decouples validation from the migration hot path.

**Step 5: Traffic Switch via Versioned Gating**
The traffic switch protocol uses **versioned gating**:
- Proxy servers annotate requests with version token numbers
- MongoDB is patched to enforce that incoming version tokens are newer than the current token
- The complete traffic switch **executes in less than two seconds**
- All failed reads and writes succeed on retries

**Step 6: Cleanup**
Old shard data is pruned after verification.

### Validation Philosophy

Stripe's approach reveals a sophisticated understanding of validation trade-offs:

- **Real-time validation during writes**: Too expensive at 5M QPS. Instead, use dual-writes and asynchronous replication.
- **Scientist-based read comparison**: Perfect for verifying read path correctness without risk (read-only experiments).
- **Point-in-time snapshot comparison**: The gold standard for bulk data verification, performed offline to avoid performance impact.
- **Versioned gating**: Ensures no stale reads during cutover -- the database itself enforces version ordering.

### Numbers That Matter

| Metric | Value |
|---|---|
| Queries per second | 5+ million |
| Database shards | 2,000+ |
| Collections | 5,000+ |
| Data migrated (2023) | 1.5 petabytes |
| Traffic switch time | < 2 seconds |
| Write throughput improvement | 10x (sorted insertion) |
| Uptime maintained | 99.999% |

---

## 3. GitHub: MySQL Migrations with gh-ost and Vitess

### Context and Scale

GitHub operates **1,200+ MySQL hosts** storing **300+ TB of data**, serving **5.5 million queries per second** across **50+ database clusters**. Their infrastructure combines Azure Virtual Machines and bare metal servers with both horizontal and vertical sharding. They use Vitess for horizontal sharding of large-domain areas.

**Sources:**
- [gh-ost: GitHub's online schema migration tool for MySQL (GitHub Blog)](https://github.blog/news-insights/company-news/gh-ost-github-s-online-migration-tool-for-mysql/)
- [Automating MySQL schema migrations with GitHub Actions (GitHub Blog)](https://github.blog/enterprise-software/automation/automating-mysql-schema-migrations-with-github-actions-and-more/)
- [Upgrading GitHub.com to MySQL 8.0 (GitHub Blog)](https://github.blog/engineering/infrastructure/upgrading-github-com-to-mysql-8-0/)
- [github/gh-ost (GitHub Repository)](https://github.com/github/gh-ost)

### gh-ost: Triggerless Online Schema Migration

gh-ost (GitHub's Online Schema Transmogrifier) represents a fundamental rethinking of how online schema migrations should work. Unlike trigger-based tools (e.g., `pt-online-schema-change`), gh-ost **intercepts changes by tailing the binary log** in Row Based Replication (RBR) format.

**How it works:**
1. Creates a "ghost" table with the desired schema
2. Streams binary log events to capture ongoing changes
3. Copies existing data in batches to the ghost table
4. Applies captured binlog events to keep the ghost table synchronized
5. Performs an atomic table swap when caught up

**Why triggerless matters for validation:**
- Triggers compete for locks with the production workload, creating unpredictable behavior
- gh-ost decouples migration workload from production workload by serializing writes in a single connection
- This predictability makes validation more reliable -- you can reason about the state of the ghost table

### gh-ost's Three Validation Modes

**1. `--test-on-replica` Mode (Primary validation)**
- Replication is stopped on a replica
- Tables are swapped and then swapped back
- A **complete checksum of the entire table data** is computed from both the original and ghost tables
- If checksums match, the migration is verified as correct
- GitHub runs **thousands of successful migrations on replicas before ever attempting a migration on primaries**

**2. Continuous Covering Migrations**
- GitHub performs continuous "covering migrations" on designated replicas
- Every single production table -- from empty tables to hundreds of GB -- is migrated via a trivial `ALTER` statement
- This serves as continuous integration for the migration infrastructure itself

**3. Runtime Controls**
- Parameters like `chunk-size` and `max-lag-millis` are adjustable during execution
- Migration can be paused and resumed without losing progress
- Network-accessible status reporting provides real-time auditability

### MySQL 8.0 Upgrade Validation

GitHub's upgrade from MySQL 5.7 to 8.0 across 1,200+ hosts demonstrates a comprehensive validation strategy:

**CI-First Validation:**
- Ran MySQL 5.7 and 8.0 **side-by-side in CI** to detect regressions and incompatibilities before they reached production
- Used SolarWinds DPM (VividCortex) for query observability to identify production failures

**Staged Rollouts:**
- Gradually upgraded read replicas across data centers
- Monitored latency, system metrics, and application behavior
- Required **at least one complete 24-hour traffic cycle** before decommissioning rollback infrastructure

**Backward Replication:**
- Maintained replication from MySQL 8.0 primaries to 5.7 replicas during transition
- Configured Orchestrator to blacklist 5.7 hosts as failover candidates to prevent accidental downgrades
- Preserved offline 5.7 replica chains for rapid failover

**Compatibility Issues Discovered:**
- Character collation differences required standardization to `utf8_unicode_ci`
- Role privilege statements were incompatible with 5.7
- The `replica_preserve_commit_order` bug (patched in MySQL 8.0.28) was discovered through this process
- The Trilogy client library provided "more predictability in connection behavior"

### Key Tools in GitHub's Migration Stack

| Tool | Purpose |
|---|---|
| **gh-ost** | Triggerless online schema migration |
| **Vitess** | Horizontal sharding and cross-shard migrations |
| **Orchestrator** | MySQL topology management and failover |
| **freno** | Write throttling during migrations |
| **Percona Toolkit** | Database administration utilities |
| **Scientist** | Read-path experiment framework (used by Stripe, originated at GitHub) |

### The Scientist Library

GitHub created the **Scientist** library (Ruby, with ports to .NET, Java, PHP) specifically for safely refactoring critical code paths. It is a cornerstone validation tool for migrations:

- Creates a lightweight experiment abstraction around code being replaced
- The original code (control) always returns the result to the caller
- The new code (candidate) runs alongside, with execution order randomized
- Results are compared, and **any differences are recorded** along with execution duration
- Critical constraint: **Scientist is only used for read operations** -- candidates must not have side effects

**Source:** [Scientist: Measure Twice, Cut Once (GitHub Blog)](https://github.blog/developer-skills/application-development/scientist/)

---

## 4. Uber: Schemaless to DocStore and MyRocks

### Context and Scale

Uber's storage infrastructure serves **tens of millions of requests per second** and stores **tens of petabytes of data**. They have performed multiple large-scale migrations: rewriting Schemaless's sharding layer from Python to Go, evolving Schemaless into DocStore, and migrating the storage engine from InnoDB to MyRocks.

**Sources:**
- [Code Migration in Production: Rewriting the Sharding Layer of Uber's Schemaless Datastore (Uber Blog)](https://www.uber.com/blog/schemaless-rewrite/)
- [Evolving Schemaless into a Distributed SQL Database (Uber Blog)](https://www.uber.com/en-IN/blog/schemaless-sql-database/)
- [MySQL to MyRocks Migration in Uber's Distributed Datastores (Uber Blog)](https://www.uber.com/en-IN/blog/mysql-to-myrocks-migration-in-uber-distributed-datastores/)

### Schemaless Sharding Layer Rewrite (Python to Go)

Uber rewrote the entire front-end of their Schemaless datastore from Python (uWSGI workers) to Go (called "Frontless"), demonstrating that a massive production datastore can be rewritten **in a completely new language with zero downtime**.

**Validation by Comparison (Read Endpoints):**

Since read endpoints handled approximately **90% of all traffic**, they received the most rigorous validation:

1. Requests flow through Frontless (Go), which also forwards them to the legacy Schemaless (Python) system
2. Both systems query storage nodes independently
3. Responses are compared -- any divergence triggers bug reports
4. Configuration flags allow engineers to:
   - Enable/disable validation per endpoint
   - Adjust the percentage of requests to validate (to avoid overwhelming storage)
   - Make changes **within seconds** via runtime configuration

This is a classic **dark read** pattern, but with the sophistication of per-endpoint percentage control.

**Validation of Write Endpoints:**

Write operations present a unique challenge -- they can only succeed once. Uber's approach:
- Automated integration tests run identical scenarios against both Python and Go implementations
- Tests execute locally or through CI **in minutes**
- A dedicated Schemaless test instance simulates production traffic for write validation

**Results:**
- Median latency decreased by **85%**
- P99 latency decreased by **70%**
- CPU utilization decreased by **more than 85%**

### MySQL to MyRocks Migration

The migration from InnoDB to MyRocks (RocksDB-based MySQL) across all Schemaless and Docstore instances required a different validation approach because it was a storage engine change rather than a code rewrite.

**Multi-Phase Validation:**

1. **Checksum Validation**: Collected checksums for each table and the total number of tables before and after migration to detect corruption or missing data.

2. **Incremental Migration Strategy**: Migrated from single partition to multiple partitions, from single region to all regions. Between each step, validated data integrity and monitored latency.

3. **Query Replay Testing**: Replayed live production queries on MyRocks nodes and compared results with InnoDB to verify execution plans remained unchanged.

4. **Automated Table Comparisons**: After engine conversion, compared collected table information between InnoDB and MyRocks configurations.

**Critical Bugs Discovered Through Validation:**

- If MySQL was killed by OOM during the "waiting for handler commit" phase, **some tables were missing after restart** -- a critical failure mode that required careful monitoring.
- Query result inconsistencies between engines: the same query returned different results on InnoDB vs. RocksDB (MySQL bug PS-7722). Without query replay testing, this would have silently corrupted data.

**Result:** Over 30% disk space savings across all instances.

### Key Validation Patterns from Uber

| Pattern | Used For | Key Feature |
|---|---|---|
| Response comparison | Read endpoint migration | Per-endpoint percentage control |
| Integration test replay | Write endpoint migration | CI-integrated, runs in minutes |
| Checksum validation | Storage engine migration | Pre/post table checksums |
| Query replay | Storage engine migration | Same queries, compare results |
| Incremental rollout | All migrations | Single partition -> all regions |

---

## 5. Airbnb: Data Quality at Scale

### Context

Airbnb processes **500 billion events daily** and manages a massive data warehouse. Rather than a single migration, Airbnb's story is about building systematic data quality infrastructure that applies directly to migration validation scenarios.

**Sources:**
- [Data Quality at Airbnb, Part 1: Rebuilding at Scale (Airbnb Tech Blog)](https://medium.com/airbnb-engineering/data-quality-at-airbnb-e582465f3ef7)
- [Data Quality at Airbnb, Part 2: A New Gold Standard (Airbnb Tech Blog)](https://medium.com/airbnb-engineering/data-quality-at-airbnb-870d03080469)
- [Data Quality Score: The next chapter of data quality at Airbnb (Airbnb Tech Blog)](https://medium.com/airbnb-engineering/data-quality-score-the-next-chapter-of-data-quality-at-airbnb-851dccda19c3)
- [How Airbnb Built "Wall" to Prevent Data Bugs (Airbnb Tech Blog)](https://medium.com/airbnb-engineering/how-airbnb-built-wall-to-prevent-data-bugs-ad1b081d6e8f)

### The Midas Certification Program

**Midas** is Airbnb's data quality certification program, named for the golden touch they wanted to apply to their data. It establishes a "gold standard" that certifies data models meet end-to-end quality requirements.

**Four-Review Certification Process:**

1. **Spec Review**: Validates the data model specification -- definitions, computation logic, and intended use cases.
2. **Data Review**: Verifies data accuracy by comparing against alternative data sources or business logic.
3. **Code Review**: Standard engineering code review of the pipeline producing the data.
4. **Minerva Review**: Validates integration with Minerva (Airbnb's metrics layer) -- ensures each metric is uniquely defined in a single place and correctly exposed across data tools.

**Certified data** is clearly labeled in internal tools (Dataportal, their data catalog), supported by extensive documentation of definitions and computation logic. This labeling is crucial -- consumers can distinguish between certified and uncertified data assets.

### Scaling Beyond Midas: The Data Quality Score

By 2022, Airbnb recognized that Midas certification was too heavyweight for all data assets. Data producers wanted "some of the quality guardrails of Midas, but with less rigor and time investment." This led to the **Data Quality Score (DQ Score)**.

**Design Principles:**
- **Full coverage**: Applicable to any in-scope data warehouse asset (not just certified tables)
- **Automated**: 100% automated input collection (no manual assessment)
- **Actionable**: Easy to discover and act on for both producers and consumers
- **Multi-dimensional**: Decomposable into distinct quality pillars
- **Evolvable**: Scoring criteria can evolve over time

**Four Dimensions:**

| Dimension | What It Measures |
|---|---|
| **Accuracy** | Data values are correct and match reality |
| **Reliability (Timeliness)** | Data arrives on schedule without unexpected delays |
| **Stewardship** | Data is properly owned, documented, and maintained |
| **Usability** | Data is accessible, well-structured, and easy to consume |

**Implementation:**
- Computed via a **daily offline data pipeline** that collects and transforms metadata from Airbnb's data systems
- Surfaced through **Dataportal** (data catalog UI) and the **Unified Metadata Service (UMS)**
- Enables organization-wide visibility into data quality trends

### The Wall: Preventing Data Bugs

Airbnb also built **Wall**, a system specifically designed to prevent data bugs from reaching production. Wall enforces data quality checks as pipeline gates -- if checks fail, the pipeline is blocked.

### Relevance to Migration Validation

Airbnb's approach is directly applicable to migration scenarios:

1. **Pre-migration**: Use Midas-style certification to establish the ground truth quality of source data
2. **During migration**: Run DQ Score checks on both source and target to compare dimensions
3. **Post-migration**: Use Wall-style gates to prevent migrated data from being consumed until quality checks pass
4. **Ongoing**: DQ Score provides continuous monitoring to detect regression after migration

The key insight is that **data quality infrastructure built for operations doubles as migration validation infrastructure**. Companies that invest in quality systems have an easier time validating migrations.

---

## 6. Shopify: Shard Balancing with Ghostferry

### Context and Scale

Shopify operates a **petabyte-scale MySQL** infrastructure organized into "pods" -- fully isolated instances containing MySQL, Redis, and Memcached. In 2015, vertical scaling was no longer possible, forcing a move to horizontal sharding. Regular shard balancing requires moving shop data between pods at **terabyte scale** with **virtually zero consumer-facing downtime**.

**Sources:**
- [Shard Balancing: Moving Shops Confidently with Zero-Downtime at Terabyte-scale (Shopify Engineering)](https://shopify.engineering/mysql-database-shard-balancing-terabyte-scale)
- [A Pods Architecture to Allow Shopify to Scale (Shopify Engineering)](https://shopify.engineering/a-pods-architecture-to-allow-shopify-to-scale)
- [Shopify/ghostferry (GitHub)](https://github.com/Shopify/ghostferry)
- [Ghostferry Verifiers Documentation](https://shopify.github.io/ghostferry/master/verifiers.html)

### Ghostferry: The Swiss Army Knife of Live Data Migrations

Ghostferry is Shopify's open-source library (written in Go) for copying data between MySQL instances with minimal downtime. It combines batch copying with binary log (binlog) tailing.

**Migration Process:**

**Phase 1: Batch Copying and Binlog Tailing**
- Uses `SELECT...FOR UPDATE` with locking reads to maintain data correctness and atomicity
- Simultaneously streams MySQL binlog events, filtering only changes relevant to the migrating shop
- Applies filtered binlog events to the target database

**Phase 2: Cutover**
- Triggered when the binlog queue reaches near-real-time synchronization
- Uses Redis-backed **multi-reader-single-writer (MRSW) locks** to ensure no units of work that can mutate the shop's data are running

**Phase 3: Control Plane Update**
- Routing table is updated to redirect traffic to the new pod
- Stale data is pruned from the source after verification

### Ghostferry's Three Verifiers

This is where Ghostferry truly shines for migration validation. It includes **three distinct verifiers**, each with different trade-offs:

**1. ChecksumTableVerifier**
- Uses MySQL's `CHECKSUM TABLE` statement to compare entire tables between source and target
- Best for: Full table copies where you need comprehensive verification
- Cutover time impact: **Linear with data size** (can be slow for large tables)
- Memory usage: Minimal
- Limitation: Known to produce false positives with JSON columns in MySQL 5.7

**2. InlineVerifier**
- Performs verification **continuously during the copy process** rather than after completion
- Algorithm:
  1. The DataIterator appends **MD5 fingerprints** to SELECT statements: `SELECT *, MD5(...) FROM ...`
  2. The BatchWriter inserts data, then immediately re-selects and compares fingerprints
  3. The BinlogStreamer monitors ongoing changes, placing affected primary keys into a **reverify queue**
  4. Before and during cutover, queued rows undergo additional verification
  5. If a row doesn't match during reverification, it's placed back in the queue for another attempt
- Cutover time impact: **Linear with change rate** (proportional to how fast data changes, not data size)
- Supports partial table copies: Yes
- Best for: When full-table checksum takes too long, or when copying partial tables

**3. TargetVerifier**
- A supplementary verifier that monitors target database integrity
- Attaches a BinlogStreamer to the **target** database
- Prepends a configurable annotation "signature" to all DML operations
- Monitors incoming binlog events and validates the annotation matches Ghostferry's signature
- Flags any DML events lacking proper annotation or with mismatched signatures
- Best for: Detecting unauthorized modifications to the target during migration
- Must be manually stopped before cutover (to prevent false failures from application writes)

### Formal Verification with TLA+

Shopify took the extraordinary step of **formally specifying Ghostferry's central algorithm in TLA+**, enabling rigorous mathematical arguments about correctness. This is one of the few examples of formal methods being applied to a data migration tool in production.

### Verifier Selection Guide

| Verifier | Best For | Cutover Impact | Partial Copy Support |
|---|---|---|---|
| ChecksumTableVerifier | Full table copies | Linear w/ data size | No |
| InlineVerifier | Large tables, partial copies | Linear w/ change rate | Yes |
| TargetVerifier | Detecting unauthorized changes | N/A (supplementary) | N/A |

Shopify recommends starting with ChecksumTableVerifier. If cutover time is too long, switch to InlineVerifier. For maximum assurance, combine InlineVerifier with TargetVerifier.

---

## 7. LinkedIn: Self-Healing Migrations and Data Sentinel

### Context and Scale

LinkedIn has performed some of the largest enterprise data migrations, including migrating their Jobs and Recruiter products from a **single-shard RDBMS to Espresso** (LinkedIn's distributed key-value database), and migrating from **Oracle to Espresso** across multiple services. Espresso handles "close to a hundred clusters, storing about **420 terabytes** of Source of Truth data and handling more than **2 million queries per second** at peak load."

**Sources:**
- [New Recruiter & Jobs: The largest enterprise data migration at LinkedIn (LinkedIn Engineering)](https://www.linkedin.com/blog/engineering/hiring/new-recruiter--jobs-the-largest-enterprise-data-migration-at-l)
- [Migrating to Espresso (LinkedIn Engineering)](https://www.linkedin.com/blog/engineering/open-source/migrating-from-oracle-to-espresso)
- [Data Sentinel: Automating data validation (LinkedIn Engineering)](https://www.linkedin.com/blog/engineering/data-management/data-sentinel-automating-data-validation)
- [Scalable Automated Config-driven data Validation with ValiData (LinkedIn Engineering)](https://www.linkedin.com/blog/engineering/data-management/scalable-automated-config-driven-data-validation)

### Self-Healing Migration Architecture (Recruiter & Jobs)

The Recruiter & Jobs migration is notable because LinkedIn designed the system to be **self-healing** -- it automatically detected and resolved data inconsistencies rather than requiring manual intervention.

**Five-Component Feedback Loop:**

1. **Offline Bulk Loads**: Historical data bootstrapped using Spark/Pig jobs on Hadoop, achieving QPS for bulk loading **as high as 15,900** writes per second.

2. **Online Dual Writes**: Asynchronous writes to the new system following legacy commits. Due to the distributed nature, dual-write transactions were impractical -- the system accepted temporary inconsistencies.

3. **Nearline Stream Verification**: Used LinkedIn's **Brooklin** change-capture service to validate that source updates appeared in the target database in near-real-time.

4. **Online Shadow Reads**: Verified data consistency at the API level during actual user reads. Every read from the old system was also performed against the new system, and results compared.

5. **Offline Bulk Verification**: Periodic full scans detecting discrepancies in data older than 24 hours.

**Convergence Principles:**

LinkedIn formalized three convergence principles that drove their design:

- **Convergence in data**: The gap between source and destination diminishes over time
- **Convergence in time**: Alignment occurs within expected time windows
- **Convergence in engineering**: The system becomes progressively bug-free through iterative improvement

**Achievement: Steady-state data consistency rate above 99.999%.**

**Ramp Process:**

Recognizing the CAP theorem -- that consistency and availability cannot be achieved simultaneously during switchover -- LinkedIn introduced a small window of unavailability:
- Halted bulk operations **72 hours** before ramp
- Scheduled switchovers on **Sunday mornings** (lowest traffic)
- Continuously monitored pre-ramp data consistency
- Minimized the UI redirect downtime window

### Oracle to Espresso Migration

LinkedIn's Oracle to Espresso migration introduced the **shadow read validation** pattern with a clever solution for multi-writer conflicts:

**Shadow Read Validation:**
- Whenever the application (Babylonia) processed a read request, it simultaneously made the same request from the Espresso data store
- Results were compared; any discrepancy flagged for investigation

**MigrationControl Field:**
- Added an optional field to the Espresso schema called `MigrationControl`
- Indicated which process wrote each record: bulk loader, Databus listener, or application
- Write logic examined existing records and **prevented the Databus listener from overwriting recent application writes**
- This solved the race condition where bulk loading and live writes could conflict

**Migration Phases:**
1. Pre-migration cleanup (eliminate deprecated endpoints and direct SQL access)
2. Initial bulk load (Oracle snapshots translated to Espresso format)
3. Change capture (Databus listener replicates ongoing updates)
4. Shadow read validation
5. Dual writes (application writes to both systems)
6. Read cutover (Espresso becomes primary for reads)
7. Write cutover (complete Oracle shutdown)

**Key Lesson:** "The easiest lines of code to migrate are the lines of code that don't exist" -- LinkedIn prioritized eliminating technical debt before starting the migration.

### Data Sentinel: Automated Data Validation Platform

Data Sentinel emerged from a **2018 incident** where data quality issues reduced job recommendation platform views by **40-60%**, requiring 5 engineers working 8 days to identify the root cause and 11 days to resolve it.

**Scale:** Validates over **800 datasets** at LinkedIn.

**Detection Capabilities:**
- Duplicated records and work anniversary data
- Data skew in datasets
- Duplicate examples affecting ML model training
- Invalid field values (negative ages, corrupted primary keys)

**Architecture:**
- Declarative configuration files specifying data checks
- Parsing and dynamic SQL code generation
- Apache Spark for distributed computing
- Schema-conforming validation reports

**Validation Methods:**
- Propositional logic for field property assertions
- Statistical independence testing comparing field distributions
- Computational engineering implementing AI/statistical methods in SQL
- Data visualization of discovered patterns

### ValiData: Config-Driven Validation

LinkedIn also built **ValiData**, a separate tool focused on efficiency:
- Entire validation process for a typical dataset completes in **~15 minutes**
- Reduces manual effort by **more than 85%**
- Config-driven: validation rules defined declaratively rather than in code

---

## 8. Pinterest: Shadow Traffic and Graph Service Modernization

### Context and Scale

Pinterest's legacy Zen storage system handled **over 100 use cases**, **1.5 petabytes of data**, and a peak of **8 million queries per second**. Their modernization involved multiple migration projects including moving to TiDB for graph services and building a new CDC-based ingestion framework.

**Sources:**
- [Graph Service: Why Pinterest Modernized with Distributed SQL (PingCAP)](https://www.pingcap.com/blog/why-pinterest-modernized-graph-service-distributed-sql/)
- [Improve user experience: solving core data inconsistencies at Pinterest (Pinterest Engineering)](https://medium.com/pinterest-engineering/improve-user-experience-solving-core-data-inconsistencies-at-pinterest-d4b64b5d79a1)
- [Next Generation DB Ingestion at Pinterest (Pinterest Engineering)](https://medium.com/pinterest-engineering/next-generation-db-ingestion-at-pinterest-66844b7153b7)

### Shadow Traffic Validation

Pinterest's approach to validating their graph service migration to TiDB (PinGraph) is instructive:

1. **Evaluation Phase**: Evaluated **more than 10 storage backends** before selecting TiDB
2. **Benchmarking**: Performed in-depth benchmarking on 3 finalist solutions
3. **Shadow Traffic**: Asynchronously copied production traffic to the non-production TiDB environment to validate behavior under real-world conditions
4. **Canary Validation Pipeline**: Caught potential issues before changes reached production

### Legacy Data Inconsistency Detection (Dr. Zen)

Pinterest's legacy system required a daily MapReduce job called **"Dr. Zen"** to fix data inconsistencies after failures. This approach was unsustainable:
- Ran as a batch job, so inconsistencies persisted for up to 24 hours
- Could not detect all types of inconsistencies
- Created a maintenance burden

TiDB's native **ACID transactions and secondary indexes** eliminated the need for application-level consistency repair, simplifying data management and reducing errors.

### CDC-Based Ingestion Framework

Pinterest's new database ingestion framework uses **Change Data Capture (CDC)** with low-latency event delivery (typically under one second) via Kafka. This infrastructure also serves as a validation mechanism -- CDC events can be compared between source and target systems during migrations.

### Results

- **P99 latency**: Reduced by up to **10x** compared to Zen
- **Infrastructure costs**: **Over 50% savings**
- Eliminated the need for the Dr. Zen reconciliation job

---

## 9. Square/Block: Shift and Vitess at Scale

### Context

Square (now Block) runs **thousands of database migrations every month** and has scaled its Cash App database infrastructure using Vitess for horizontal sharding.

**Sources:**
- [Shift: Safe and Easy Database Migrations (Square Corner Blog)](https://developer.squareup.com/blog/shift-safe-and-easy-database-migrations/)
- [square/shift (GitHub)](https://github.com/square/shift)

### Shift: Automated Schema Migration

Shift is Square's open-source application for running online schema migrations on MySQL databases. Its validation features include:

**Pre-Migration Validation:**
- After submission, a **dry-run** is executed to verify the migration is syntactically valid
- Basic stats about the table being altered are collected and presented in the UI
- Another engineer must **approve the migration** before execution, optionally leaving feedback

**During Migration:**
- Built on `pt-online-schema-change` with a custom patch for state tracking
- Can be paused and resumed without losing progress
- State is persisted in a file, allowing recovery from killed processes

**Access Control:**
- Granular hooks control which users can perform each action for a given database
- This prevents unauthorized migrations from introducing data quality issues

### Vitess at Cash App

Square uses Vitess for horizontally scaling Cash App's database, joining companies like GitHub, Slack, and Shopify that rely on Vitess for cross-shard data management and migration.

---

## 10. Open-Source Migration Tools and Their Validation Features

### AWS Database Migration Service (DMS)

AWS DMS provides the most comprehensive built-in validation of any cloud migration service.

**Source:** [AWS DMS Data Validation Documentation](https://docs.aws.amazon.com/dms/latest/userguide/CHAP_Validating.html)

**How Validation Works:**
- Compares each row in the source with its corresponding row at the target
- Verifies rows contain the same data and reports mismatches
- Begins immediately after full load completes
- For CDC-enabled tasks, validates incremental changes as they occur

**Validation States:**
| State | Meaning |
|---|---|
| Validated | All rows match |
| Mismatched records | Source and target differ |
| Missing source/target | Records exist in one but not the other |
| Suspended records | Cannot be validated (e.g., ongoing modification) |
| No primary key | Table cannot be validated |

**Enhanced Validation (v3.5.4+):**
- Uses **cryptographic hash functions** for faster comparison
- Oracle: `SYS.DBMS_CRYPTO`
- PostgreSQL: `pgcrypto` extension
- Supports specific migration paths: Oracle-to-PostgreSQL, SQL Server-to-PostgreSQL, Oracle-to-Oracle, SQL Server-to-SQL Server

**Partition-Level Validation:**
For large data volumes, DMS splits tables into smaller groups of contiguous rows based on primary key, comparing at the partition level. During ongoing replication, it dynamically switches between range-based and individual-record fetches based on:
- Query volume and types
- Task latency
- Total record count
- Configurable `PartitionSize` and `ThreadCount`

**Failure Tracking:**
DMS automatically creates a control table (`awsdms_validation_failures_v1`) to log validation failures with:
- Primary key of the failing row
- Failure type: `RECORD_DIFF`, `MISSING_SOURCE`, `MISSING_TARGET`, `TABLE_WARNING`
- JSON-formatted details of mismatched columns

**Validation-Only Tasks (v3.4.6+):**
DMS supports dedicated validation-only tasks (`EnableValidation: true, ValidationOnly: true`) that:
- Run independently of the migration
- Reduce load on the replication instance
- Support data repair workflows
- Can be triggered on demand

**Key Limitations:**
- Tables must have a primary key or unique index
- PK columns cannot be CLOB, BLOB, or BINARY types
- VARCHAR/CHAR PK columns must be < 1024 characters
- NULL PK values not supported
- Cannot validate views or data masking transformations
- Stops if more than **10,000 failed or suspended records** detected

### Google Cloud Data Validation Tool (DVT)

DVT is an **open-source Python CLI tool** created by Google for cross-database validation.

**Source:** [GoogleCloudPlatform/professional-services-data-validator (GitHub)](https://github.com/GoogleCloudPlatform/professional-services-data-validator)

**Supported Databases:** BigQuery, Cloud Spanner, Cloud SQL, Teradata, Hive, Impala, MySQL, Oracle, PostgreSQL, Snowflake, SQL Server.

**Validation Levels:**
- **Table-level**: Row counts and aggregate comparisons
- **Column-level**: Statistical comparisons (sum, min, max, avg)
- **Row-level**: Individual row comparison using primary keys and checksums
- **Schema-level**: Data type and column comparison

**Deployment Options:** CLI, Cloud Run, Cloud Functions, Airflow (Cloud Composer).

**Uses the Ibis framework** for database-agnostic query generation, enabling the same validation logic across heterogeneous environments.

**Note:** This is not an officially supported Google product.

### Datafold data-diff

Datafold built a commercial and (formerly) open-source tool for value-level data comparison across databases.

**Sources:**
- [How to diff your data during a data migration (Datafold Blog)](https://www.datafold.com/blog/how-to-diff-your-data-during-a-data-migration)
- [datafold/data-diff (GitHub)](https://github.com/datafold/data-diff)

**Capabilities:**
- **Value-level comparison** between tables within or across databases
- Supports **13 database connectors** in the cloud version
- Row-, column-, and value-level detail into discrepancies
- Supports filtering on specific primary keys or column values
- Optional **sampling** for approximate validation when full-table diff is too expensive
- Persistent diff history to track migration progress over time
- 10x faster diffing with real-time results (cloud version)

**Limitation:** As of May 2024, Datafold is **no longer actively supporting the open-source data-diff**. The commercial Datafold Cloud product continues.

### Shopify Ghostferry

(Covered in detail in Section 6.)

**Source:** [Shopify/ghostferry (GitHub)](https://github.com/Shopify/ghostferry)

Key distinguishing features:
- Three verifier types (Checksum, Inline, Target)
- MD5 fingerprinting during data copy
- Formally verified with TLA+
- Purpose-built for MySQL-to-MySQL live migrations

### pgloader

**Source:** [pgloader Documentation](https://pgloader.readthedocs.io/)

pgloader migrates data to PostgreSQL using the COPY protocol. Its validation features are limited but practical:

- **Schema introspection**: Reads source database SQL catalogs to get tables, attributes, data types, constraints, indexes, and comments
- **Error handling**: Separates rejected data into `reject.dat` and `reject.log` files while continuing to copy valid data
- **Type casting rules**: User-defined data type casting rules for handling incompatible types
- pgloader does **not** provide post-migration data comparison or checksum validation -- that must be done separately

### pg_chameleon

**Source:** [pg_chameleon (PyPI)](https://pypi.org/project/pg-chameleon/)

pg_chameleon is a MySQL-to-PostgreSQL replica system:

- **Foreign key validation**: Extracts foreign keys and creates them as `NOT VALID` initially. A second run validates them.
- **Error isolation**: Tables generating errors are automatically excluded from the replica.
- **Use case**: Typically used for ongoing replication after initial migration (pgloader handles the initial load).

### Comparison Table

| Tool | Validation Type | Cross-DB | Row-Level | Real-Time | Open Source |
|---|---|---|---|---|---|
| AWS DMS | Built-in, hash-based | Yes | Yes | Yes (CDC) | No |
| Google DVT | External, multi-level | Yes | Yes | No | Yes |
| Datafold data-diff | Value-level comparison | Yes | Yes | No | Deprecated |
| Ghostferry | Checksum/Inline/Target | MySQL only | Yes | Yes | Yes |
| pgloader | Error rejection only | To PG only | No | No | Yes |
| pg_chameleon | FK validation only | MySQL-to-PG | No | No | Yes |

---

## 11. Community Wisdom: Reddit and Hacker News

### Common Themes from Practitioners

**Sources:**
- [How do you deal with DB migrations? (Hacker News)](https://news.ycombinator.com/item?id=21434895)
- [Database Migrations (Hacker News)](https://news.ycombinator.com/item?id=37724549)
- [Ask HN: How do you handle data migrations in SQL databases?](https://news.ycombinator.com/item?id=20105461)
- [Migra: Diff for PostgreSQL schemas (Hacker News)](https://news.ycombinator.com/item?id=30464882)
- [7 Lessons from Data Practitioners on Migration Failures and Fixes (Datafold)](https://www.datafold.com/data-migration-guide/what-data-practitioners-wish-they-knew)

### Recurring Advice

**1. "Row counts are necessary but not sufficient"**

The most common beginner mistake is relying solely on row counts to validate a migration. Practitioners consistently warn that matching row counts proves nothing about data correctness -- you need value-level comparison.

> A global bank identified that 20% of customer records lacked valid identifiers only when they implemented proper field-level validation, something row counts would never catch.
>
> -- Datafold migration guide

**2. "Make migrations separate, testable commits"**

Multiple Hacker News commenters emphasize that migrations should be:
- Version-controlled as separate commits
- Tested in CI before production
- Reversible (with explicit downgrade paths)
- Auditable (every migration has a clear owner and purpose)

**3. "Create an API schema of views"**

A sophisticated pattern recommended on HN: create a schema containing only views, functions, and procedures as an abstraction layer. This provides a layer of indirection that decouples application changes from database migrations, allowing validation against the view contract rather than raw tables.

**4. "Don't wait until the end to validate"**

Community consensus strongly favors continuous validation throughout the migration process rather than a single post-migration check:
- Start validation during planning to uncover schema mismatches early
- Run parallel systems during migration to catch discrepancies in real-time
- Validate business metrics, not just raw data -- run standard reports in both environments and compare

**5. "Migrations are more about people than data"**

Practitioners report that migrations rarely fail due to a single catastrophic technical error. Instead, they "unravel due to hidden complexity, overlooked dependencies, and misaligned expectations." The most successful migrations embed quality checks at every level and treat validation as a first-class concern rather than an afterthought.

### Tools Mentioned by the Community

| Tool | Type | Community Sentiment |
|---|---|---|
| **Sqitch** | Change management | Praised for explicit dependency tracking |
| **Flyway/Liquibase** | Schema migration | Standard choices, good for schema evolution |
| **Migra** | PostgreSQL schema diff | Generates migration SQL from schema differences |
| **GitHub Scientist** | Read-path experiments | Gold standard for safe refactoring |
| **Ghostferry** | Live MySQL migration | Praised for verifier system |
| **pgloader** | Data loading | Good for initial load, weak on validation |

---

## 12. Anti-Patterns: Migrations That Failed

### TSB Bank (2018): The Definitive Migration Disaster

**Sources:**
- [TSB Bank Fined $62m for a Failed Mainframe Migration (Futurum Group)](https://futurumgroup.com/insights/tsb-bank-fined-62m-for-a-failed-mainframe-migration-a-cautionary-tale-we-can-learn-from/)
- [TSB fined 48.65m for operational resilience failings (Bank of England)](https://www.bankofengland.co.uk/news/2022/december/tsb-fined-for-operational-resilience-failings)
- [What broke the bank (Increment Magazine)](https://increment.com/testing/what-broke-the-bank/)
- [TSB and Banco Sabadell slammed in meltdown post-mortem (Finextra)](https://www.finextra.com/newsarticle/34795/tsb-and-banco-sabadell-slammed-in-meltdown-post-mortem)

**What happened:** TSB Bank migrated from its legacy Lloyds Banking Group platform to a new platform built by its parent company Banco Sabadell. The migration of **1.3 billion customer records** went catastrophically wrong.

**Data Validation Failures:**

1. **Customers saw other people's accounts**: Some users logged in and were presented with completely different customers' bank accounts, including balances and transaction history.

2. **Incorrect transaction amounts**: Small purchases were incorrectly recorded as costing thousands of pounds.

3. **Inconsistent data centers**: Two data centers built to support the new platform were "configured inconsistently despite having been specified to be identical."

4. **Testing was read-only**: The post-mortem revealed that testing only covered read-only transactions, not updatable transactions. This is the exact opposite of what Stripe and Uber did -- they validated writes extensively.

5. **Open defects grew during UAT**: Rather than defect counts decreasing toward the end of User Acceptance Testing (as would be healthy), they increased -- a clear red flag that was ignored.

6. **No continuous data reconciliation**: Post-migration data reconciliation was not planned, leading to inconsistencies persisting indefinitely.

**Impact:**
- **1.9 million customers** locked out of online banking
- **269,000 payments** went missing or were duplicated
- Fined **48.65 million GBP** by UK regulators
- CEO resigned
- Cost over **330 million GBP** in total remediation

**Lessons:**
- Validate write operations, not just reads
- Reconciliation must be continuous, not one-time
- Declining defect counts during UAT is a prerequisite for go-live
- Data center parity must be verified, not assumed
- Row-level data comparison between old and new systems is non-negotiable

### Knight Capital (2012): Configuration as Data Migration

**Source:** [Data Disasters: The Worst Cases of Poor Database Management (Inery)](https://inery.io/blog/article/data-disasters-poor-database-management/)

While not a traditional database migration, Knight Capital's disaster illustrates how configuration deployment -- itself a form of data migration -- can fail catastrophically without validation.

**What happened:** A software update was deployed to 8 servers, but only 7 received the new code. The 8th server ran dormant legacy code that was reactivated, causing a cascade of unintended stock orders.

**Impact:** **$440 million loss in under 45 minutes**. The firm was bankrupt by the next day.

**Lesson:** Every deployment is a migration. Validation must confirm that **all targets** received the change, not just spot-check a subset.

### Queensland Health Payroll (2010)

**Source:** [Failed Data Migration Projects and Lessons Learned (Hopp Tech)](https://hopp.tech/resources/data-migration-blog/failed-data-migration-projects-and-lessons-learned/)

Queensland Health's payroll system migration was rushed to meet a deadline. Lack of comprehensive testing and poor planning led to payroll failures affecting thousands of healthcare workers.

**Validation Failure:** The migration team did not adequately validate that the complex business rules governing healthcare worker pay (shift differentials, overtime, leave accrual) were correctly implemented in the new system.

**Impact:** Cost the Queensland government over **AUD 1.2 billion** in remediation.

### The 83% Failure Rate

According to Gartner, **83% of data migration projects either fail outright or exceed planned budgets and schedules**. The most common root causes:

1. **Inadequate validation** -- treating it as an afterthought rather than a core requirement
2. **Schema mismatches** -- assuming source and target schemas are equivalent
3. **Missing foreign key relationships** -- a single mismapped field can corrupt cascading dependencies
4. **Incomplete test coverage** -- testing happy paths but not edge cases
5. **No rollback plan** -- assuming the migration will succeed

---

## 13. Cross-Cutting Themes and Synthesis

### The Five Universal Validation Patterns

Across all the companies studied, five validation patterns appear repeatedly:

#### Pattern 1: Shadow Reading (Dark Reading)

**Used by:** Stripe, Uber, LinkedIn, Pinterest

Read from both old and new systems simultaneously, compare results, alert on divergence. Always return the result from the trusted (old) system until validation passes.

**Key design decisions:**
- Percentage-based traffic sampling (Uber: configurable per endpoint)
- Read-only constraint (GitHub Scientist: candidates must not have side effects)
- Runtime reconfiguration (Uber: changes take effect within seconds)

#### Pattern 2: Dual Writing with Conflict Resolution

**Used by:** Stripe, LinkedIn, Shopify

Write to both old and new systems during the transition period. The critical challenge is handling conflicts when writes arrive out of order or from multiple sources.

**Conflict resolution approaches:**
- LinkedIn's MigrationControl field (tracks which writer produced each record)
- Stripe's versioned gating (database enforces version ordering)
- Shopify's MRSW locks (prevents concurrent mutation during cutover)

#### Pattern 3: Checksum/Hash Comparison

**Used by:** GitHub (gh-ost), Shopify (Ghostferry), Uber (MyRocks), AWS DMS

Compute checksums or hashes of data on both source and target, compare for equality. Can be done at table level (MySQL CHECKSUM TABLE), row level (MD5 fingerprints), or partition level (AWS DMS).

**Trade-offs:**
- Table-level: Fast but all-or-nothing (one row difference fails the whole table)
- Row-level: Precise but slow (must compare every row)
- Partition-level: Good balance for large tables (AWS DMS's approach)

#### Pattern 4: Staged Rollout with Probation

**Used by:** Netflix, GitHub, Uber

Migrate incrementally (one table, one shard, one region at a time) with a probation period before committing. Maintain rollback capability throughout.

**Netflix's shadower** is the most sophisticated implementation -- continuously syncing the new Iceberg table back to a Hive shadow for comparison during probation.

#### Pattern 5: Automated Reconciliation (Self-Healing)

**Used by:** LinkedIn, Pinterest (Dr. Zen)

Rather than just detecting inconsistencies, automatically resolve them. LinkedIn's five-component feedback loop (bulk load, dual write, stream verification, shadow reads, bulk verification) continuously drives toward 99.999% consistency.

**The critical insight:** Consistency is not a binary state but a continuous metric that converges over time.

### Validation Sophistication Spectrum

Companies can be placed on a spectrum of validation sophistication:

```
Basic                                                           Advanced
|                                                                    |
Row Count -> Schema Compare -> Checksum -> Shadow Read -> Self-Healing
                                              |
                                          Value-Level
                                           Comparison
```

- **Row Count Only**: Necessary but grossly insufficient. The TSB disaster would not have been caught by row counts alone.
- **Schema Comparison**: Catches structural mismatches but not data errors.
- **Checksum/Hash**: Catches data differences but doesn't identify which specific values differ.
- **Shadow Reading**: Catches behavioral differences in real production traffic.
- **Value-Level Comparison**: Identifies exactly which rows and columns differ (Datafold, Google DVT).
- **Self-Healing**: Automatically resolves detected inconsistencies (LinkedIn).

### Common Numbers and Benchmarks

| Company | Scale | Consistency Target | Validation Approach |
|---|---|---|---|
| Netflix | 1.5M tables, 300+ PB | WAP: 100% before publish | Shadow + probation period |
| Stripe | 5M QPS, 1.5 PB migrated | 99.999% uptime | Snapshot comparison + versioned gating |
| GitHub | 1,200 hosts, 5.5M QPS | Zero data loss | Checksum on replica, 24h traffic cycle |
| Uber | Tens of M QPS, tens of PB | Zero data loss | Response comparison, query replay |
| LinkedIn | 2M QPS, 420 TB | 99.999% consistency | Five-component self-healing loop |
| Shopify | Petabyte-scale | Zero downtime | Three-verifier system + TLA+ |
| Pinterest | 8M QPS, 1.5 PB | P99 latency reduction | Shadow traffic + canary pipeline |

### The Hierarchy of Migration Validation

Based on this research, here is a recommended hierarchy for migration validation, ordered from most basic to most comprehensive:

**Level 0: No Validation**
Simply migrate and hope for the best. Responsible for most migration disasters.

**Level 1: Count Validation**
Compare row counts between source and target. Catches gross data loss but nothing else.

**Level 2: Schema Validation**
Compare table structures, column types, constraints, and indexes. Catches structural drift.

**Level 3: Aggregate Validation**
Compare column-level aggregates (SUM, MIN, MAX, AVG, COUNT DISTINCT). Catches many data transformation errors.

**Level 4: Hash/Checksum Validation**
Compute table-level or partition-level hashes. Binary pass/fail with no detail on what's different.

**Level 5: Value-Level Comparison**
Compare individual rows and identify exactly which columns differ. Provides actionable detail for fixing issues.

**Level 6: Behavioral Validation**
Shadow reads comparing real production queries against both systems. Catches semantic differences that static comparison misses.

**Level 7: Self-Healing Validation**
Automated detection and resolution of inconsistencies with convergence monitoring. The gold standard for large-scale migrations.

### Tools Ecosystem Map

```
                    Open Source                          Commercial
                    ----------                          ----------
Schema Migration:   gh-ost, Flyway, Liquibase           Bytebase
                    Sqitch, Alembic

Data Migration:     Ghostferry, pgloader                AWS DMS
                    pg_chameleon                         Google DMS

Validation:         Google DVT                          Datafold Cloud
                    data-diff (deprecated)              AWS DMS Validation
                    Ghostferry verifiers                 Monte Carlo

Experimentation:    GitHub Scientist                    LaunchDarkly
                    (Ruby, .NET, Java, PHP)

Orchestration:      Airflow, Maestro                    AWS Step Functions
```

### What Separates Great Migrations from Disasters

| Successful Migrations | Failed Migrations |
|---|---|
| Validate writes, not just reads | Test only read-only transactions (TSB) |
| Continuous reconciliation | One-time post-migration check |
| Percentage-based rollout | Big-bang cutover |
| Automated comparison | Manual spot-checking |
| Formal verification (TLA+) | Informal correctness arguments |
| Rollback infrastructure maintained | Rollback not planned |
| Business metric validation | Only technical validation |
| Defect count decreasing before go-live | Defect count increasing (TSB) |
| 24h+ traffic cycle before decommission | Immediate decommission |
| Convergence as a metric | Consistency as binary |

---

## Appendix A: Source Index

### Netflix
- [Netflix's Apache Iceberg Data Lake Migration (AWS re:Invent)](https://aws.amazon.com/video/watch/3db41488539/)
- [Netflix-Skunkworks/hive2iceberg-migration (GitHub)](https://github.com/Netflix-Skunkworks/hive2iceberg-migration)
- [Incremental Processing using Netflix Maestro and Apache Iceberg (Netflix TechBlog)](https://netflixtechblog.com/incremental-processing-using-netflix-maestro-and-apache-iceberg-b8ba072ddeeb)
- [How does Netflix ensure data quality for thousands of Apache Iceberg tables? (Vu Trinh)](https://vutr.substack.com/p/how-does-netflix-ensure-the-data)
- [Data Bridge: How Netflix simplifies data movement (Netflix TechBlog)](https://netflixtechblog.medium.com/data-bridge-how-netflix-simplifies-data-movement-36d10d91c313)

### Stripe
- [Online migrations at scale (Stripe Blog, 2017)](https://stripe.com/blog/online-migrations)
- [How Stripe's document databases supported 99.999% uptime with zero-downtime data migrations (Stripe Blog, 2024)](https://stripe.com/blog/how-stripes-document-databases-supported-99.999-uptime-with-zero-downtime-data-migrations)
- [Stripe's Zero-Downtime Data Movement Platform (InfoQ, 2025)](https://www.infoq.com/news/2025/11/stripe-zero-downtime-date-move/)

### GitHub
- [gh-ost: GitHub's online schema migration tool for MySQL (GitHub Blog)](https://github.blog/news-insights/company-news/gh-ost-github-s-online-migration-tool-for-mysql/)
- [Automating MySQL schema migrations with GitHub Actions (GitHub Blog)](https://github.blog/enterprise-software/automation/automating-mysql-schema-migrations-with-github-actions-and-more/)
- [Upgrading GitHub.com to MySQL 8.0 (GitHub Blog)](https://github.blog/engineering/infrastructure/upgrading-github-com-to-mysql-8-0/)
- [github/gh-ost (GitHub Repository)](https://github.com/github/gh-ost)
- [Scientist: Measure Twice, Cut Once (GitHub Blog)](https://github.blog/developer-skills/application-development/scientist/)
- [github/scientist (GitHub Repository)](https://github.com/github/scientist)

### Uber
- [Code Migration in Production: Rewriting the Sharding Layer of Uber's Schemaless Datastore (Uber Blog)](https://www.uber.com/blog/schemaless-rewrite/)
- [Evolving Schemaless into a Distributed SQL Database (Uber Blog)](https://www.uber.com/en-IN/blog/schemaless-sql-database/)
- [MySQL to MyRocks Migration in Uber's Distributed Datastores (Uber Blog)](https://www.uber.com/en-IN/blog/mysql-to-myrocks-migration-in-uber-distributed-datastores/)
- [Designing Schemaless, Uber Engineering's Scalable Datastore Using MySQL (Uber Blog)](https://www.uber.com/blog/schemaless-part-one-mysql-datastore/)

### Airbnb
- [Data Quality at Airbnb, Part 1: Rebuilding at Scale (Airbnb Tech Blog)](https://medium.com/airbnb-engineering/data-quality-at-airbnb-e582465f3ef7)
- [Data Quality at Airbnb, Part 2: A New Gold Standard (Airbnb Tech Blog)](https://medium.com/airbnb-engineering/data-quality-at-airbnb-870d03080469)
- [Data Quality Score: The next chapter of data quality at Airbnb (Airbnb Tech Blog)](https://medium.com/airbnb-engineering/data-quality-score-the-next-chapter-of-data-quality-at-airbnb-851dccda19c3)
- [How Airbnb Built "Wall" to Prevent Data Bugs (Airbnb Tech Blog)](https://medium.com/airbnb-engineering/how-airbnb-built-wall-to-prevent-data-bugs-ad1b081d6e8f)

### Shopify
- [Shard Balancing: Moving Shops Confidently with Zero-Downtime at Terabyte-scale (Shopify Engineering)](https://shopify.engineering/mysql-database-shard-balancing-terabyte-scale)
- [A Pods Architecture to Allow Shopify to Scale (Shopify Engineering)](https://shopify.engineering/a-pods-architecture-to-allow-shopify-to-scale)
- [Shopify/ghostferry (GitHub)](https://github.com/Shopify/ghostferry)
- [Ghostferry Verifiers Documentation](https://shopify.github.io/ghostferry/master/verifiers.html)

### LinkedIn
- [New Recruiter & Jobs: The largest enterprise data migration at LinkedIn (LinkedIn Engineering)](https://www.linkedin.com/blog/engineering/hiring/new-recruiter--jobs-the-largest-enterprise-data-migration-at-l)
- [Migrating to Espresso (LinkedIn Engineering)](https://www.linkedin.com/blog/engineering/open-source/migrating-from-oracle-to-espresso)
- [Data Sentinel: Automating data validation (LinkedIn Engineering)](https://www.linkedin.com/blog/engineering/data-management/data-sentinel-automating-data-validation)
- [Scalable Automated Config-driven data Validation with ValiData (LinkedIn Engineering)](https://www.linkedin.com/blog/engineering/data-management/scalable-automated-config-driven-data-validation)
- [Expediting data fixes and data migrations (LinkedIn Engineering)](https://engineering.linkedin.com/blog/2019/expediting-data-fixes-migrations)

### Pinterest
- [Graph Service: Why Pinterest Modernized with Distributed SQL (PingCAP)](https://www.pingcap.com/blog/why-pinterest-modernized-graph-service-distributed-sql/)
- [Improve user experience: solving core data inconsistencies at Pinterest (Pinterest Engineering)](https://medium.com/pinterest-engineering/improve-user-experience-solving-core-data-inconsistencies-at-pinterest-d4b64b5d79a1)
- [Next Generation DB Ingestion at Pinterest (Pinterest Engineering)](https://medium.com/pinterest-engineering/next-generation-db-ingestion-at-pinterest-66844b7153b7)

### Square/Block
- [Shift: Safe and Easy Database Migrations (Square Corner Blog)](https://developer.squareup.com/blog/shift-safe-and-easy-database-migrations/)
- [square/shift (GitHub)](https://github.com/square/shift)

### Open-Source Tools
- [AWS DMS Data Validation Documentation](https://docs.aws.amazon.com/dms/latest/userguide/CHAP_Validating.html)
- [Google Data Validation Tool (GitHub)](https://github.com/GoogleCloudPlatform/professional-services-data-validator)
- [How to diff your data during a data migration (Datafold Blog)](https://www.datafold.com/blog/how-to-diff-your-data-during-a-data-migration)
- [datafold/data-diff (GitHub)](https://github.com/datafold/data-diff)
- [pgloader Documentation](https://pgloader.readthedocs.io/)
- [pg_chameleon (PyPI)](https://pypi.org/project/pg-chameleon/)

### Anti-Patterns and Failures
- [TSB Bank Fined $62m for a Failed Mainframe Migration (Futurum Group)](https://futurumgroup.com/insights/tsb-bank-fined-62m-for-a-failed-mainframe-migration-a-cautionary-tale-we-can-learn-from/)
- [TSB fined 48.65m for operational resilience failings (Bank of England)](https://www.bankofengland.co.uk/news/2022/december/tsb-fined-for-operational-resilience-failings)
- [What broke the bank (Increment Magazine)](https://increment.com/testing/what-broke-the-bank/)
- [Data Disasters: The Worst Cases of Poor Database Management (Inery)](https://inery.io/blog/article/data-disasters-poor-database-management/)
- [7 Lessons from Data Practitioners on Migration Failures and Fixes (Datafold)](https://www.datafold.com/data-migration-guide/what-data-practitioners-wish-they-knew)

### Community Discussions
- [How do you deal with DB migrations? (Hacker News)](https://news.ycombinator.com/item?id=21434895)
- [Database Migrations (Hacker News)](https://news.ycombinator.com/item?id=37724549)
- [Ask HN: How do you handle data migrations in SQL databases?](https://news.ycombinator.com/item?id=20105461)
- [Migra: Diff for PostgreSQL schemas (Hacker News)](https://news.ycombinator.com/item?id=30464882)
