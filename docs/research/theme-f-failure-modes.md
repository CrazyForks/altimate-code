# Theme F: Real-World Data Validation Failure Modes

_Iteration 2 — 2026-03-13_

## 1. Floating-Point Comparison

### Non-Associativity of FP Addition
`SUM()` on the same data with parallel execution can yield **different results each run** because accumulation order changes between threads. PostgreSQL mailing list confirmed this for parallel mode.

### Cross-Database False Diffs
[data-diff #379](https://github.com/datafold/data-diff/issues/379): `double precision` (Postgres) vs `FLOAT` (Snowflake) — same IEEE 754 value serializes to different decimal strings when cast through `DECIMAL(38,7)`.

**The 0.2 problem**: storing `0.2` in Postgres REAL (32-bit) and reading back as float64 yields `0.20000000298023224`.

### NaN Comparison: Every DB Violates IEEE 754
```sql
-- IEEE 754 says: NaN != NaN
-- But PostgreSQL: NaN = NaN → TRUE, NaN > everything
-- Snowflake: 'NaN'::FLOAT = 'NaN'::FLOAT → TRUE
-- BigQuery: All NaN values equal for GROUP BY and sorting
```

### Datafold's Approach
Cast to common precision before comparison. Timestamps aligned across precision levels. User-configurable tolerance for FLOAT comparisons.

## 2. NULL Semantics

### The NOT IN Trap (Universal, Devastating)
```sql
-- Returns ZERO rows if subquery contains ANY NULL
SELECT * FROM t WHERE id NOT IN (SELECT id FROM other);
-- x NOT IN (1, 2, NULL) → x!=1 AND x!=2 AND x!=NULL → UNKNOWN → excluded
-- Fix: Use NOT EXISTS
```

### Three-Valued Logic Inconsistency
- WHERE treats UNKNOWN as FALSE (rows excluded)
- CHECK constraints treat UNKNOWN as TRUE (rows accepted)
- You can INSERT data that you cannot SELECT back

### DuckDB vs PostgreSQL: `greatest()` Quirk
```sql
-- PostgreSQL: greatest(0::FLOAT, NULL) → 0
-- DuckDB: greatest(0::FLOAT, NULL) → NULL
-- Both agree on integer version: greatest(0, NULL) → 0
```
Trap when using DuckDB as local proxy for PostgreSQL.

### Oracle's Empty String = NULL
Oracle treats `''` as NULL. Every other DB does not. #1 source of mismatches in Oracle-to-Snowflake migrations.

## 3. Timezone and Timestamp Bugs

### Snowflake's Three Timestamp Types
| Type | Stores | DST-Aware |
|------|--------|-----------|
| TIMESTAMP_NTZ | Wall clock, no TZ | No |
| TIMESTAMP_LTZ | UTC internally, displays in session TZ | Yes |
| TIMESTAMP_TZ | UTC + offset at insert time | **No** (offset doesn't update for DST) |

Real bug: [dbt-snowflake #1256](https://github.com/dbt-labs/dbt-snowflake/issues/1256) — microbatch timestamps treated as NTZ instead of TZ, causing "incorrect, duplicative rows."

### Y2K38 Problem
MySQL TIMESTAMP: hard limit `2038-01-19 03:14:07.999999 UTC` (32-bit signed overflow). PostgreSQL uses 64-bit microseconds (range: 4713 BC to 294276 AD).

### BigQuery DATETIME vs TIMESTAMP
DATETIME = no timezone (wall clock). TIMESTAMP = absolute UTC. Converting without explicit timezone → silent data corruption around DST transitions.

## 4. String Encoding

### MySQL utf8 vs utf8mb4 (Emoji Destroyer)
MySQL's legacy `utf8` = 3-byte only. Emojis (4 bytes) silently dropped/corrupted. Affected millions of WordPress installations ([Trac #21212](https://core.trac.wordpress.org/ticket/21212)).

### Unicode Normalization: NFC vs NFD
macOS stores filenames in NFD (decomposed), Linux/Windows use NFC (composed):
```python
"Ü"          # U+00DC (NFC, 1 code point)
"U\u0308"    # U+0055 + U+0308 (NFD, 2 code points)
# Look identical, but different bytes → no match in DB
```

### Trailing Spaces: Every DB Disagrees
| Database | CHAR comparison | VARCHAR comparison |
|----------|----------------|-------------------|
| PostgreSQL | Ignores trailing spaces | Exact |
| MySQL (PAD SPACE) | Ignores trailing spaces | Ignores trailing spaces |
| Snowflake | Exact (CHAR = VARCHAR alias) | Exact |
| SQL Server | Ignores trailing spaces | Ignores trailing spaces |

## 5. Silent Data Corruption

### VARCHAR Truncation
```sql
-- SQL Server (ANSI_WARNINGS OFF): silently truncates
DECLARE @x VARCHAR(5) = 'Hello World';  -- stores 'Hello', no error

-- CAST without length: truncates to 30 chars (undocumented default!)
SELECT CAST('Hello World...' AS VARCHAR);  -- 30 chars max
```

### Date Format Ambiguity
```sql
-- Is '01/02/2024' January 2nd or February 1st?
-- Snowflake: depends on DATE_INPUT_FORMAT session setting
-- If day <= 12 for both parts → NO error, silent corruption
```

### Type Precedence Surprises
```sql
-- SQL Server: INT + VARCHAR → INT wins
SELECT 1 + '2';    -- 3 (string cast to int)
SELECT 1 + '2.5';  -- 3.5 (string cast to float)
SELECT 1 + 'abc';  -- ERROR (only now fails)
```

### JSON Large Integer Precision Loss
```sql
-- Snowflake PARSE_JSON: integers > 2^53 may lose precision when stored as FLOAT
SELECT PARSE_JSON('{"id": 9007199254740993}'):id::NUMBER;
-- May round to 9007199254740992
```

## 6. Ordering and Determinism

### Queries Without ORDER BY
Result order is undefined. Breaks when: parallel execution, index changes, version upgrades, statistics updates, buffer pool changes.

### ROW_NUMBER() Non-Determinism
```sql
-- If two rows have same ORDER BY value, their row numbers swap between runs
SELECT *, ROW_NUMBER() OVER (ORDER BY created_at) FROM events;
-- Breaks deduplication (WHERE rn = 1)
-- Fix: add unique tiebreaker column
```

### Hash Function Output Format
| Database | MD5 Output Format |
|----------|------------------|
| Snowflake | 32-char lowercase hex |
| PostgreSQL | 32-char lowercase hex |
| BigQuery | BYTES (displayed as base64) |

Must normalize format (hex vs base64) before cross-database hash comparison.

## Implications for Reladiff

### What We Handle
- Numeric tolerance (absolute threshold) ✓
- Timestamp tolerance (millisecond threshold) ✓
- NULL-safe comparison in JoinDiff (IS NOT DISTINCT FROM) ✓

### Gaps Identified
1. **NaN/Infinity handling** — need consistent behavior when comparing special float values
2. **Unicode normalization** — NFC/NFD can cause phantom mismatches
3. **Trailing space normalization** — option to trim before comparison (cross-DB CHAR semantics)
4. **Empty string vs NULL** — configurable Oracle-compatibility mode
5. **Timestamp precision alignment** — auto-detect nano vs micro and truncate higher precision
6. **Hash format normalization** — normalize to common format in HashDiff checksums
7. **Date format validation** — warn about ambiguous date strings

### Sources
[data-diff #379](https://github.com/datafold/data-diff/issues/379), [dbt-snowflake #1256](https://github.com/dbt-labs/dbt-snowflake/issues/1256), [WordPress #21212](https://core.trac.wordpress.org/ticket/21212), [Meta: Silent Data Corruption at Scale](https://engineering.fb.com/2021/02/23/data-infrastructure/silent-data-corruption/), Snowflake/PostgreSQL/BigQuery/DuckDB official docs, Modern SQL, Brent Ozar, Percona blog

---

## Iteration 2

_Deep dive — 2026-03-13_

### 7. Data Validation Post-Mortems

#### GitLab Database Incident (2017) — Backup Validation Failure
On January 31, 2017, an engineer accidentally ran `rm -rf` on the primary PostgreSQL database. The cascading failure revealed **five independent backup mechanisms had all silently failed**:
- `pg_dump` backups failed silently because they were built for PostgreSQL 9.2 while production ran 9.6
- LVM snapshots had never been tested and turned out to be empty
- Azure disk snapshots were not configured
- S3 backups pointed to an empty bucket
- Failure notification emails were rejected by the mail server because DMARC signing was misconfigured

**Data validation angle**: 6 hours of production data (5,000 projects, 5,000 comments, 700 user accounts) were permanently lost. A simple periodic **backup integrity validation** — restoring and querying a backup to verify row counts — would have surfaced the failures months earlier. The incident became the canonical example of "untested backups are not backups."

Sources: [GitLab postmortem](https://about.gitlab.com/blog/postmortem-of-database-outage-of-january-31/), [Downtime Project analysis](https://downtimeproject.com/podcast/gitlabs-2017-postgres-outage/)

#### Meta's Silent Data Corruption (2021) — Hardware-Induced Missing Rows
Meta's [landmark paper](https://arxiv.org/pdf/2102.11245) documented that **faulty CPU cores** cause silent data corruption at rates of several per thousand CPUs. The corruptions are mercurial — a defective core produces wrong results only under specific micro-architectural conditions (certain instruction sequences, cache states, or thermal conditions).

Key findings relevant to data validation:
- Corruptions manifested as **missing rows in databases** and incorrect computation results
- Errors propagated across the stack — a single bad CPU could corrupt data that was then replicated, cached, and served
- Detection required **multiple independent computation paths** (running the same calculation on different cores and comparing)
- Google independently confirmed similar rates: ~1,000 defective parts per million in their fleet

**Implication for data diff tools**: Row count mismatches between source and target could have a hardware root cause. Cross-system validation (comparing results from different physical machines) provides a detection mechanism that single-system checksums cannot.

Sources: [Meta engineering blog](https://engineering.fb.com/2021/02/23/data-infrastructure/silent-data-corruption/), [Meta 2022 follow-up](https://engineering.fb.com/2022/03/17/production-engineering/silent-errors/)

#### Knight Capital (2012) — $440M from Missing Deployment Validation
Knight Capital's SMARS order-entry system lost $440 million in 45 minutes due to a chain of validation failures:

1. **Dead code reactivation**: In 2005, the "Power Peg" feature was deprecated but server-side code was never removed. When tests broke during a refactor, engineers deleted the tests instead of the code.
2. **Flag bit reuse**: In July 2012, engineers needed a new binary flag for the Retail Liquidity Program but had exhausted available bits. They reused the Power Peg flag bit, unknowingly creating a trigger for the dormant code.
3. **Silent deployment failure**: The deployment script failed silently when one of eight SMARS servers was unreachable (SSH connection dropped). It reported success despite leaving one server running the old code.
4. **Missing runtime validation**: SMARS was "built to be fast" and deliberately skipped pre-trade risk checks. No position limit validation, no order rate throttling, no reconciliation between expected and actual trade volumes.

**Data validation angle**: A simple post-deployment **binary hash comparison** across all servers would have caught the version mismatch. A runtime **position delta threshold** would have halted trading within seconds.

Sources: [Speculative Branches analysis](https://specbranch.com/posts/knight-capital/), [SEC findings](https://www.sec.gov/litigation/admin/2013/34-70694.pdf)

#### CrowdStrike (2024) — Content Validator Logic Error
A 40KB configuration file update crashed 8.5 million Windows machines worldwide. The root cause: a **mismatch between schema and runtime expectations**. The IPC Template Type defined 21 input fields, but the sensor code only provided 20. The Content Validator — CrowdStrike's automated validation tool — contained a logic error that failed to detect this schema mismatch. The missing bounds check in the Content Interpreter then caused an out-of-bounds memory read.

**Data validation angle**: This is a textbook case of **schema drift** — the template schema evolved independently from the code that consumed it. A cross-referencing validation that compared template field count against consumer field count would have caught the mismatch before deployment.

Sources: [CrowdStrike RCA](https://www.crowdstrike.com/wp-content/uploads/2024/08/Channel-File-291-Incident-Root-Cause-Analysis-08.06.2024.pdf), [TechTarget analysis](https://www.techtarget.com/searchsecurity/news/366596579/CrowdStrike-Content-validation-bug-led-to-global-outage)

#### TUI Airways (2020) — Passenger Weight Miscalculation
A reservation system bug classified adult female passengers with title "Miss" as children, assigning them a standard weight of 35 kg instead of 69 kg. The software was developed outside the UK where "Miss" denotes a child. On one flight, the takeoff mass was **1,244 kg below actual** because the load sheet counted 65 children instead of the actual 29.

**Data validation angle**: A distribution check on the child/adult ratio per flight (statistical validation) would have immediately flagged flights where >50% of passengers were classified as children.

Sources: [The Register](https://www.theregister.com/2021/04/08/tui_software_mistake/)

#### Cloudflare (November 2025) — Configuration Size Validation Gap
A ClickHouse database permissions change caused Bot Management configuration files to double in size, exceeding a hardcoded memory limit in Cloudflare's proxy system. The cascade affected 2.4 billion monthly active users across ChatGPT, Spotify, Discord, and others for nearly 6 hours.

**Data validation angle**: The configuration files were system-generated (not user-supplied), so they bypassed the validation scrutiny applied to external inputs. A **size/structure assertion on generated config files** before they reached the proxy system would have prevented the cascade.

Sources: [Cloudflare post-mortem](https://blog.cloudflare.com/tag/post-mortem/)

#### Zillow Offers (2021) — $881M Loss from Data Quality in ML Pipeline
Zillow's home-flipping algorithm (Zestimate) systematically overpaid for properties, leading to an $881 million write-down and 25% workforce reduction. Root causes included:
- Stale/incorrect property attributes from MLS and tax records (wrong room counts, outdated square footage)
- Model trained on listing prices rather than actual sale prices
- No real-time validation of prediction confidence against market conditions

**Data validation angle**: Input data quality checks (freshness, completeness, cross-source consistency) on the property attributes feeding the model would have surfaced the data quality issues before they cascaded into pricing errors.

Sources: [Towards Data Science analysis](https://towardsdatascience.com/invaluable-data-science-lessons-to-learn-from-the-failure-of-zillows-flipping-business-25fdc218a62/)

### 8. Encoding & Character Set Failures (Deep Dive)

#### The Latin-1 / Windows-1252 / UTF-8 Triangle
The most common encoding corruption in ETL pipelines stems from the **mislabeling triangle**:
- Windows-1252 uses code points 0x80-0x9F for characters like smart quotes and em dashes
- ISO-8859-1 (Latin-1) treats those same code points as undefined control characters
- UTF-8 uses multi-byte sequences that overlap with both

When a Windows-1252 file is mislabeled as Latin-1 and converted to UTF-8, characters like curly quotes (`"` `"`) and em dashes (`—`) are **silently destroyed** — converted to invisible control characters or whitespace.

```
# The "mojibake" cascade:
Original (Windows-1252): "résumé"
Mislabeled as Latin-1 → UTF-8: "rÃ©sumÃ©"
Double-encoded (UTF-8 bytes interpreted as Latin-1 → UTF-8 again): "rÃƒÂ©sumÃƒÂ©"
```

**MySQL's latin1 lie**: MySQL's `latin1` charset is actually Windows-1252, not ISO-8859-1. When a MySQL `latin1` column receives UTF-8 bytes due to connection charset misconfiguration, the bytes are stored raw. Reads work correctly only if the client also uses the wrong charset. Changing the connection charset to UTF-8 exposes the corruption.

Sources: [Whitesmith MySQL encoding guide](https://www.whitesmith.co/blog/latin1-to-utf8/), [i18nqa charset comparison table](https://www.i18nqa.com/debug/table-iso8859-1-vs-windows-1252.html)

#### Zero-Width Characters: Invisible Data Corruption
Six Unicode characters occupy zero visual width but exist as real bytes in text data:
| Character | Code Point | Name |
|-----------|-----------|------|
| ZWSP | U+200B | Zero-Width Space |
| ZWNJ | U+200C | Zero-Width Non-Joiner |
| ZWJ | U+200D | Zero-Width Joiner |
| LRM | U+200E | Left-to-Right Mark |
| RLM | U+200F | Right-to-Left Mark |
| BOM/ZWNBSP | U+FEFF | Zero-Width No-Break Space |

These cause:
- **Primary key collisions**: Two rows with visually identical keys like `"Dog"` and `"Dog"` (with embedded U+200B) coexist in the same table, breaking unique constraint assumptions
- **JOIN failures**: A lookup by string key returns no match even though the row is visibly present in the database
- **Index corruption**: Indexes treat the strings as different values, so queries miss rows that visual inspection confirms exist

**Common sources**: Copy-paste from web pages, PDF extraction, rich text editors, and API responses from systems that embed directional marks in Arabic/Hebrew text.

Sources: [Marko Devcic blog](https://www.markodevcic.com/post/zero_width_space/), [Alteryx community](https://community.alteryx.com/t5/Alteryx-Designer-Desktop-Ideas/Remove-Zero-Width-Spaces-with-the-Data-Cleanse-tool/idi-p/329180)

#### BOM (Byte Order Mark) in CSV Files
The UTF-8 BOM (`EF BB BF`) creates a distinct class of ETL failures:
- **dbt seed**: Excel-generated UTF-8 CSVs include a BOM that becomes part of the first column name, making queries fail silently (`SELECT "column_a"` vs `SELECT "\xEF\xBB\xBFcolumn_a"`) — [dbt-core #1177](https://github.com/fishtown-analytics/dbt/issues/1177)
- **MonetDB COPY INTO**: BOM causes data corruption in the first column value — [MonetDB #3436](https://github.com/MonetDB/MonetDB/issues/3436)
- **Go csv package**: BOM interferes with quote handling — [golang/go #33887](https://github.com/golang/go/issues/33887)
- **Databricks**: Loading CSV files containing BOM characters causes column misalignment

**The Excel paradox**: Excel requires BOM to correctly display UTF-8 CSVs (without it, non-ASCII characters appear garbled). But most data tools choke on BOM. There is no configuration that satisfies both Excel and data pipelines simultaneously.

Sources: [dbt-core #1177](https://github.com/fishtown-analytics/dbt/issues/1177), [Databricks community](https://community.databricks.com/t5/data-engineering/issues-loading-files-csv-files-that-contain-bom-byte-order-mark/td-p/2719)

### 9. Numeric Precision War Stories (Deep Dive)

#### Financial Systems: The $1.15 Error at $25M
A 32-bit float cannot accurately represent $25,474,937.47 — it stores $25,474,936.32, a **$1.15 error** on a single value. At scale:
- London Stock Exchange: floating-point accumulation errors in HFT algorithms forced a 45-minute trading halt
- A German retail bank's mortgage system using standard float arithmetic for compound interest: customers overpaid or underpaid over 5 years, requiring a reported EUR 12 million correction
- Cryptocurrency exchange: $50,000 lost when attackers exploited fractional rounding differences between float representations

**The rounding inconsistency problem**: Even with DECIMAL types, different languages round `0.5` differently:
```
Ruby round():      0.5 → 1  (half away from zero)
Python 3 round():  0.5 → 0  (half even / banker's rounding)
JavaScript Math.round(): 0.5 → 1  (half toward positive infinity)
```
When a Python ETL pipeline rounds a value and loads it into a database, then a Ruby application reads and re-rounds it, the result can differ by one cent per operation. At millions of transactions, this compounds.

Sources: [Modern Treasury](https://www.moderntreasury.com/journal/floats-dont-work-for-storing-cents), [Atomic Object](https://spin.atomicobject.com/currency-rounding-errors/)

#### FP Reproducibility in Database Aggregations
Academic research ([Muller & Arteaga, 2018](https://arxiv.org/abs/1802.09883)) proved that `SUM()` over floating-point columns in RDBMSs is **non-reproducible by design**:
- `float16` example: `(0.5 + 512) + 512.5 = 1025` but `0.5 + (512 + 512.5) = 1024`
- Parallel query execution changes accumulation order between runs
- Different query plans (triggered by statistics updates, index changes, or optimizer version) produce different sums on identical data

The researchers developed "reproducible accumulators" (binned numbers) that guarantee bit-identical results regardless of summation order, at a 1.9x-2.4x performance cost.

**Implication for data diff**: Comparing `SUM()` checksums between source and target databases can produce false diffs even when the data is identical, if the databases use different parallelism strategies.

Sources: [arXiv:1802.09883](https://arxiv.org/abs/1802.09883), [arXiv:2408.05148](https://arxiv.org/html/2408.05148v1)

#### JavaScript Number.MAX_SAFE_INTEGER and the JSON Bridge
JavaScript represents all numbers as 64-bit IEEE 754 doubles, limiting safe integers to 2^53 - 1 (9,007,199,254,740,991). Database BIGINT columns commonly use 64-bit integers (up to 2^63 - 1). When a database row with a BIGINT ID is serialized to JSON and parsed by JavaScript:
```javascript
JSON.parse('{"id": 9007199254740993}')
// → {id: 9007199254740992}  // silently rounded!
```

This affects every system where:
- A backend serves database IDs through a JSON API consumed by JavaScript
- Snowflake IDs (Twitter), Discord IDs, and other snowflake-format IDs exceed 2^53
- Log aggregation systems use nanosecond timestamps as integers

**Mitigation**: Serialize large integers as strings in JSON. The `json-bigint` npm package and BigInt (ES2020) provide client-side solutions. Snowflake and PostgreSQL both support returning BIGINT as string in JSON output.

Sources: [HackerOne/PullRequest blog](https://www.pullrequest.com/blog/safely-handling-large-integers-in-json-best-practices-and-pitfalls/), [TechEmpower](https://www.techempower.com/blog/2016/07/05/mangling-json-numbers/)

### 10. Timezone & Calendar Edge Cases (Deep Dive)

#### DST Transitions: The Non-Existent Hour and the Doubled Hour
During spring-forward (e.g., US: 2:00 AM → 3:00 AM):
- **2:30 AM does not exist**. Scheduling systems that try to find tasks in this window loop forever. Claude Desktop experienced exactly this bug on March 8, 2025 — scheduled tasks during the skipped hour caused an infinite loop that froze the application.

During fall-back (e.g., US: 2:00 AM → 1:00 AM):
- **1:30 AM happens twice**. If timestamps are stored without UTC offset, it is impossible to determine which 1:30 AM a record refers to.
- Using datetime strings as Map/Dictionary keys during this period causes the **second occurrence to overwrite the first**, silently losing data.

**Database-specific traps**:
- TDengine (time-series DB): "It is not possible to write data for nonexistent times during DST transitions, and writing data for repeated times during DST transitions is undefined behavior"
- Metabase: [#55966](https://github.com/metabase/metabase/issues/55966) — hourly visualizations show gaps/overlaps during DST transitions because the query assumes each hour appears exactly once

Sources: [AI Productivity](https://aiproductivity.ai/news/claude-desktop-daylight-saving-time-infinite-loop-bug/), [DateTimeApp guide](https://www.datetimeapp.com/learn/handling-daylight-saving-time)

#### Leap Seconds: The 2012 Internet Meltdown
On June 30, 2012, the insertion of leap second 23:59:60 UTC triggered a Linux kernel bug in the `hrtimer` subsystem. The kernel failed to call `clock_was_set()` after adjusting the clock, causing futex-based waits to spin indefinitely.

Impact on databases:
- **MySQL**: InnoDB threads `srv_lock_timeout_thread` and `srv_error_monitor_thread` consumed 100% CPU. All timed waits on locks within MySQL were affected. Restarting mysqld did not help — only `date -s $(date)` or a full reboot resolved it.
- **Redis, Cassandra, Hadoop**: Similar CPU spikes across Java-based and C-based systems
- **PostgreSQL**: Largely unaffected because it "does not know that the leap second exists" — it uses POSIX time which does not include leap seconds

**Modern mitigation**: Google, AWS, Microsoft, and Meta all use **leap smear** — instead of inserting a discrete 23:59:60 second, they slow the clock by fractions of a millisecond over a 24-hour window, making the leap second invisible to applications.

**Implication for data diff**: Timestamps around leap second events can differ by 1 second between systems that smear and systems that insert. A tolerance of at least 1 second is needed for cross-system timestamp comparisons near leap second boundaries.

Sources: [MySQL bug #65778](https://bugs.mysql.com/bug.php?id=65778), [Launchpad bug #1020285](https://bugs.launchpad.net/bugs/1020285), [Atlassian leap second guide](https://www.atlassian.com/blog/archives/atlassian-application-administrators-need-know-leap-second-bug-lurking-systems)

#### Snowflake TIMESTAMP_TZ: The Offset-Only Trap
Snowflake's TIMESTAMP_TZ stores a UTC value plus the **offset at insert time**, not the named timezone. This means:
- A value inserted as `2024-03-10 01:30:00 America/New_York` (EST, UTC-5) stores offset `-0500`
- After DST spring-forward, querying that value still shows `-0500` even though `America/New_York` is now EDT (UTC-4)
- Converting between TIMESTAMP_TZ and TIMESTAMP_NTZ is **lossy**: the timezone information is permanently destroyed and cannot be recovered

**Session-dependent non-determinism**: TIMESTAMP_LTZ displays differently depending on the session's `TIMEZONE` parameter. Two users querying the same row see different timestamp strings. If those strings are used in ETL (e.g., `TO_CHAR(ts)` for a hash key), the resulting hashes differ by session.

Sources: [Snowflake Builders Blog](https://medium.com/snowflake/timestamps-in-snowflake-ntz-vs-ltz-vs-tz-790e8c60a00d), [Omni Analytics](https://omni.co/blog/database-timestamps)

### 11. NULL Semantics Across Databases (Deep Dive)

#### Oracle Empty String = NULL: The Full Picture
The implications go far beyond simple equality:

```sql
-- Oracle:
SELECT LENGTH('') FROM dual;        -- NULL (not 0!)
SELECT '' || 'hello' FROM dual;     -- 'hello' (NULL ignored in concat)
INSERT INTO t(not_null_col) VALUES ('');  -- REJECTED (empty = NULL violates NOT NULL)
SELECT DECODE(NULL, '', 'match') FROM dual;  -- 'match' (NULL and '' are equal in DECODE)

-- PostgreSQL:
SELECT LENGTH('');                   -- 0
SELECT '' || 'hello';               -- NULL! (NULL propagates in concat)
INSERT INTO t(not_null_col) VALUES ('');  -- ACCEPTED (empty != NULL)
```

**The Snowflake-to-PostgreSQL sync trap**: [sling-cli #349](https://github.com/slingdata-io/sling-cli/issues/349) — empty strings from Snowflake become NULLs in PostgreSQL during sync, causing NOT NULL constraint violations. The fix requires adding `CHECK (field_name <> ''::text)` constraints or pre-processing with `NULLIF`.

**Oracle's concatenation anomaly**: In Oracle, `NULL || 'abc' = 'abc'` (NULL acts as empty string). In PostgreSQL, `NULL || 'abc' = NULL` (NULL propagates). This single difference can silently change the output of every string concatenation in a migrated codebase.

Sources: [ABCloudz migration guide](https://abcloudz.com/blog/handling-null-and-empty-string-differences-in-oracle-and-postgresql/), [AWS migration guide](https://aws.amazon.com/blogs/database/handle-empty-strings-when-migrating-from-oracle-to-postgresql/), [sling-cli #349](https://github.com/slingdata-io/sling-cli/issues/349)

#### NULL in UNIQUE Constraints: The Cross-DB Minefield

| Database | Multiple NULLs in UNIQUE column? | Standard compliance |
|----------|----------------------------------|-------------------|
| PostgreSQL (< 15) | Yes (unlimited) | SQL standard |
| PostgreSQL (>= 15) | Yes by default, `NULLS NOT DISTINCT` option available | SQL standard + extension |
| SQL Server | No (only one NULL allowed) | Non-standard |
| MySQL/InnoDB | Yes (unlimited) | SQL standard |
| Oracle | Yes (unlimited) for single-column; No for composite | Mixed |
| SQLite | Yes (unlimited) | SQL standard |
| Snowflake | Yes (unlimited) | SQL standard |

A migration from SQL Server to PostgreSQL that relies on "only one NULL per unique column" will silently accept duplicate NULLs, potentially corrupting uniqueness assumptions in application logic.

Sources: [PostgreSQL docs](https://www.postgresql.org/docs/current/ddl-constraints.html), [Postgres 15 release notes](https://blog.rustprooflabs.com/2022/07/postgres-15-unique-improvement-with-null)

#### NULL in GROUP BY: The Consistency Exception
All major databases (Oracle, PostgreSQL, MySQL, Snowflake, BigQuery, SQL Server) treat NULLs as equal for GROUP BY purposes — all NULL values form a single group. This is one of the few places where NULL = NULL is true, contradicting three-valued logic.

However, the **GROUPING SETS / ROLLUP / CUBE** extensions introduce a second kind of NULL — a "super-aggregate NULL" representing "all values." To distinguish data-NULLs from super-aggregate-NULLs, each database provides a `GROUPING()` function, but the syntax and return values vary.

#### COALESCE vs NVL vs IFNULL: Subtle Behavioral Traps

| Behavior | COALESCE | Oracle NVL | MySQL IFNULL | SQL Server ISNULL |
|----------|----------|-----------|-------------|-------------------|
| Argument count | N arguments | 2 only | 2 only | 2 only |
| Short-circuit eval | Yes | **No** (evaluates both args) | Yes | Yes |
| Type coercion | Highest precedence type | First arg's type | First arg's type | First arg's type |
| Error on unused arg | No | **Yes** (e.g., `NVL(1, 1/0)` raises error) | No | Depends |

The short-circuit difference is critical: `COALESCE(1, 1/0)` succeeds (returns 1 without evaluating `1/0`), but Oracle's `NVL(1, 1/0)` raises a division-by-zero error because both arguments are always evaluated.

Sources: [DZone comparison](https://medium.com/@vishalbarvaliya/coalesce-vs-isnull-vs-nvl-9b46639aa7ef), [Bar Solutions blog](https://blog.bar-solutions.com/?p=721)

### 12. Collation & Sorting Failures (Deep Dive)

#### The glibc 2.28 Collation Catastrophe
When glibc updated from 2.27 to 2.28 (shipping in Debian 10, RHEL 8, Ubuntu 18.10), it changed the sort order of **ASCII characters** in the `en_US.UTF-8` locale:

```
# glibc < 2.28:  'a-a' < 'a+a'
# glibc >= 2.28: 'a+a' < 'a-a'
```

This caused **silent index corruption** in PostgreSQL because B-tree indexes store keys in collation-dependent order. After a glibc upgrade:
- Index scans could miss rows that existed in the table (the index expected one order, data was in another)
- Range partitioned tables could store rows in the wrong partition
- Queries returned different results on different replicas running different glibc versions

**The TripAdvisor case**: Identical PostgreSQL databases with `en_US.UTF-8` collation returned different results for the same `SELECT` depending on the glibc version of the host machine. This violated the fundamental expectation that the same query on the same data always returns the same result.

**Remediation**: `REINDEX` all text-column indexes (PostgreSQL 12+ supports `REINDEX CONCURRENTLY` to avoid downtime). **Prevention**: Use the `C` locale for bytewise comparison (immune to glibc changes) or ICU-based collations (versioned, deterministic).

Sources: [Crunchy Data blog](https://www.crunchydata.com/blog/glibc-collations-and-data-corruption), [PostgreSQL collation footgun gist](https://gist.github.com/rraval/ef4e4bdc63e68fe3e83c9f98f56af7a4), [Citus Data analysis](https://www.citusdata.com/blog/2020/12/12/dont-let-collation-versions-corrupt-your-postgresql-indexes/)

#### Case Sensitivity: The Identifier Quoting Trap

| Database | Unquoted identifiers | Quoted identifiers | Default string comparison |
|----------|---------------------|-------------------|--------------------------|
| PostgreSQL | Folded to **lowercase** | Case-sensitive, preserved | Case-sensitive |
| Snowflake | Folded to **UPPERCASE** | Case-sensitive, preserved | Case-sensitive (binary collation) |
| MySQL | Case-sensitive (Linux) / insensitive (macOS/Windows) | Case-sensitive | Depends on collation (`_ci` vs `_cs`) |
| BigQuery | Case-insensitive | **Still case-insensitive** | Case-sensitive |
| SQL Server | Depends on collation | Depends on collation | Case-insensitive by default |

The **Snowflake-PostgreSQL trap**: A dbt model creates table `MyTable` (unquoted). Snowflake stores it as `MYTABLE`. PostgreSQL stores it as `mytable`. Cross-database queries referencing the same logical table by name will fail unless identifier case is normalized. dbt's `quoting` config exists specifically to handle this.

The **BigQuery anomaly**: BigQuery is the only major database where quoting identifiers does *not* make them case-sensitive. `SELECT "MyCol"` and `SELECT "mycol"` reference the same column.

Sources: [Snowflake docs](https://docs.snowflake.com/en/sql-reference/collation), [Bytebase PostgreSQL case sensitivity](https://www.bytebase.com/blog/postgres-case-sensitivity/), [dbt quoting docs](https://docs.getdbt.com/reference/project-configs/quoting)

#### MySQL Collation: Swedish Sorting by Default
MySQL's default collation `latin1_swedish_ci` uses **Swedish alphabetical order**:
- `U-umlaut (Ü)` sorts with `Y` in Swedish/Finnish
- `U-umlaut (Ü)` sorts with `U` in German DIN-1
- `U-umlaut (Ü)` sorts as `UE` in German DIN-2

A German user querying a MySQL database with default collation gets Swedish sort order for their data. Cross-database comparisons between MySQL (Swedish) and PostgreSQL (locale-dependent) will show sort-order differences that are **not data errors** but collation mismatches.

In MySQL 8.0+, the default changed to `utf8mb4_0900_ai_ci` (Unicode 9.0, accent-insensitive, case-insensitive), which means `cafe` = `café` in comparisons — potentially surprising for data validation tools that expect accent sensitivity.

Sources: [PlanetScale collation guide](https://planetscale.com/blog/mysql-charsets-collations), [CodeRed MySQL charsets guide](https://www.coderedcorp.com/blog/guide-to-mysql-charsets-collations/)

#### Unicode Normalization in Cross-System Comparisons
NFC (composed: single code point `U+00DC` for `Ü`) and NFD (decomposed: `U+0055` + `U+0308`) are **semantically equivalent** but **byte-different**. Databases generally do not normalize on insert:
- PostgreSQL: Stores bytes as-is, no normalization
- Snowflake: Stores bytes as-is, no normalization
- MySQL: Stores bytes as-is, but collation-based comparison may treat NFC and NFD as equal

The **macOS pipeline trap**: Files processed on macOS (which normalizes filenames to NFD) produce NFD strings. The same files processed on Linux produce NFC strings. Loading both into the same database creates duplicate-looking rows with different byte representations.

**Detection**: `SELECT col, LENGTH(col), OCTET_LENGTH(col) FROM t WHERE col LIKE '%Ü%'` — if LENGTH and OCTET_LENGTH differ unexpectedly, normalization inconsistency is present.

Sources: [Unicode TR15](https://unicode.org/reports/tr15/), [UnicodeCleaner practical guide](https://unicodecleaner.com/blog/practical-guide-unicode-normalization)

### 13. Updated Implications for Reladiff

#### New Gaps Identified (Iteration 2)
8. **Zero-width character stripping** — option to strip U+200B-U+200F and U+FEFF before string comparison
9. **BOM detection** — warn when first column name contains BOM bytes
10. **Encoding validation** — detect mojibake patterns (e.g., `Ã©` instead of `é`) in string columns
11. **Collation-aware comparison** — option to specify collation for string comparison (case-insensitive, accent-insensitive)
12. **Identifier case normalization** — auto-normalize table/column names when comparing across Snowflake (uppercase) and PostgreSQL (lowercase)
13. **Leap second tolerance** — extend timestamp tolerance to handle leap-smear vs leap-insert differences
14. **FP aggregation determinism** — warn when comparing SUM/AVG checksums of float columns across systems with different parallelism
15. **Large integer safety** — detect BIGINT values > 2^53 that may lose precision in JSON serialization
16. **Oracle compatibility mode** — treat empty string as NULL for Oracle-source comparisons (extends gap #4)
17. **Post-deployment validation** — binary/schema hash comparison as a reladiff use case for deployment verification

### Iteration 2 Sources
- [GitLab postmortem](https://about.gitlab.com/blog/postmortem-of-database-outage-of-january-31/)
- [Meta: Silent Data Corruption at Scale](https://engineering.fb.com/2021/02/23/data-infrastructure/silent-data-corruption/)
- [Meta: Detecting Silent Errors (2022)](https://engineering.fb.com/2022/03/17/production-engineering/silent-errors/)
- [Knight Capital: Speculative Branches](https://specbranch.com/posts/knight-capital/)
- [CrowdStrike RCA](https://www.crowdstrike.com/wp-content/uploads/2024/08/Channel-File-291-Incident-Root-Cause-Analysis-08.06.2024.pdf)
- [TUI Airways bug (The Register)](https://www.theregister.com/2021/04/08/tui_software_mistake/)
- [Cloudflare November 2025 post-mortem](https://blog.cloudflare.com/tag/post-mortem/)
- [Zillow failure analysis](https://towardsdatascience.com/invaluable-data-science-lessons-to-learn-from-the-failure-of-zillows-flipping-business-25fdc218a62/)
- [Modern Treasury: Floats and cents](https://www.moderntreasury.com/journal/floats-dont-work-for-storing-cents)
- [Reproducible FP Aggregation (arXiv:1802.09883)](https://arxiv.org/abs/1802.09883)
- [JSON large integer precision (HackerOne)](https://www.pullrequest.com/blog/safely-handling-large-integers-in-json-best-practices-and-pitfalls/)
- [Claude Desktop DST bug](https://aiproductivity.ai/news/claude-desktop-daylight-saving-time-infinite-loop-bug/)
- [MySQL leap second bug #65778](https://bugs.mysql.com/bug.php?id=65778)
- [Snowflake timestamps](https://medium.com/snowflake/timestamps-in-snowflake-ntz-vs-ltz-vs-tz-790e8c60a00d)
- [Oracle vs PostgreSQL NULL/empty string (ABCloudz)](https://abcloudz.com/blog/handling-null-and-empty-string-differences-in-oracle-and-postgresql/)
- [AWS: Oracle to PostgreSQL empty strings](https://aws.amazon.com/blogs/database/handle-empty-strings-when-migrating-from-oracle-to-postgresql/)
- [sling-cli #349: Snowflake empty string → PostgreSQL NULL](https://github.com/slingdata-io/sling-cli/issues/349)
- [PostgreSQL UNIQUE and NULL (Postgres 15)](https://blog.rustprooflabs.com/2022/07/postgres-15-unique-improvement-with-null)
- [glibc collation and PostgreSQL corruption (Crunchy Data)](https://www.crunchydata.com/blog/glibc-collations-and-data-corruption)
- [PostgreSQL collation footgun (GitHub gist)](https://gist.github.com/rraval/ef4e4bdc63e68fe3e83c9f98f56af7a4)
- [MySQL collation (PlanetScale)](https://planetscale.com/blog/mysql-charsets-collations)
- [Whitesmith: MySQL Latin-1 to UTF-8](https://www.whitesmith.co/blog/latin1-to-utf8/)
- [dbt-core #1177: BOM in CSV seeds](https://github.com/fishtown-analytics/dbt/issues/1177)
- [Unicode Normalization TR15](https://unicode.org/reports/tr15/)
