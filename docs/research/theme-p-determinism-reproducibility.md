# Theme P: Determinism and Reproducibility in SQL-Based Data Validation

**Status**: Research Complete
**Last Updated**: 2026-03-13
**Scope**: Why validation results can be non-deterministic and how to fix it

---

## Table of Contents

1. [Sources of Non-Determinism in SQL](#1-sources-of-non-determinism-in-sql)
2. [Floating-Point Non-Reproducibility Deep Dive](#2-floating-point-non-reproducibility-deep-dive)
3. [Hash Function Stability](#3-hash-function-stability)
4. [Timestamp Determinism](#4-timestamp-determinism)
5. [NULL Handling Non-Determinism](#5-null-handling-non-determinism)
6. [Collation and Locale Non-Determinism](#6-collation-and-locale-non-determinism)
7. [Concurrent Modification During Validation](#7-concurrent-modification-during-validation)
8. [Making Validation Reproducible](#8-making-validation-reproducible)
9. [Real-World Incidents](#9-real-world-incidents)
10. [References](#10-references)

---

## 1. Sources of Non-Determinism in SQL

SQL is built on relational algebra, which operates on *sets*---unordered collections. This foundational property means that without explicit ordering constraints, the database engine is free to return results in any order it chooses. When combined with parallel execution, hash-based algorithms, and floating-point arithmetic, this creates multiple sources of non-determinism that can silently corrupt data validation results.

### 1.1 Parallel Execution Changing Aggregation Order

Modern database engines execute queries in parallel across multiple threads or workers. For aggregation operations like `SUM`, `AVG`, and `STDDEV`, this means that values are accumulated in an order determined by thread scheduling---which varies between executions.

For integer or `DECIMAL` types, this is mathematically irrelevant: addition is both commutative and associative. But for floating-point types (`FLOAT`, `DOUBLE`, `REAL`), addition is commutative but **not associative**. The order in which values are accumulated changes the result.

```sql
-- This query may return different results on successive runs
-- if the column uses FLOAT/DOUBLE types
SELECT department_id, SUM(salary) AS total_salary
FROM employees
GROUP BY department_id;
```

As documented in the [PostgreSQL mailing list](https://www.postgresql.org/message-id/CAFRJ5K0+ZZaUz0-ihX-aCj1h42H=s-CLWO+2Fb6nHCvXx19Diw@mail.gmail.com), parallel mode makes floating-point aggregation results non-deterministic because the order of addition changes between runs. The DuckDB documentation [explicitly warns](https://duckdb.org/docs/stable/operations_manual/non-deterministic_behavior) that functions like `stddev` and `corr` may yield inconsistent results under multi-threaded execution:

```sql
-- DuckDB example: stddev of a constant column should be 0,
-- but parallel execution can produce small nonzero values
CREATE TABLE tbl AS
    SELECT 'ABCDEFG'[floor(random() * 7 + 1)::INT] AS s,
           3.7 AS x,
           i AS y
    FROM range(1, 1_000_000) r(i);

SELECT s,
       stddev(x) AS standard_deviation,  -- May return ~10e-16 instead of 0
       corr(x, y) AS correlation
FROM tbl
GROUP BY s
ORDER BY s;
```

**Impact on validation**: A checksum query computing `SUM(amount)` on a FLOAT column can return different values on consecutive runs against identical data, causing false-positive validation failures.

### 1.2 Non-Deterministic Window Functions (ROW_NUMBER with Ties)

`ROW_NUMBER()` assigns a unique sequential integer to each row within its partition. When rows have identical values in the `ORDER BY` clause, the assignment is arbitrary---which row gets which number is determined by the execution plan, thread scheduling, and physical storage order.

```sql
-- Non-deterministic: multiple employees can share the same salary
SELECT employee_id,
       department_id,
       salary,
       ROW_NUMBER() OVER (
           PARTITION BY department_id
           ORDER BY salary DESC
       ) AS rank
FROM employees;
```

As [Itzik Ben-Gan documents at SQLPerformance.com](https://sqlperformance.com/2019/11/t-sql-queries/row-numbers-with-nondeterministic-order), ROW_NUMBER() is deterministic if and only if the combination of `PARTITION BY` and `ORDER BY` columns is unique. When it is not unique, different executions can assign different row numbers to tied rows.

**The fix**: Always include a unique tiebreaker column:

```sql
-- Deterministic: employee_id breaks ties
SELECT employee_id,
       department_id,
       salary,
       ROW_NUMBER() OVER (
           PARTITION BY department_id
           ORDER BY salary DESC, employee_id ASC
       ) AS rank
FROM employees;
```

`RANK()` and `DENSE_RANK()` are deterministic even without a unique tiebreaker because they assign the same rank to tied rows. But `ROW_NUMBER()` and `NTILE()` are not.

### 1.3 Undefined ORDER BY Behavior

The SQL standard specifies that without an `ORDER BY` clause, the result set has no defined order. Even with `ORDER BY`, if the ordering columns are not unique, the relative order of tied rows is undefined.

```sql
-- Undefined behavior: which 10 rows are returned?
SELECT * FROM large_table LIMIT 10;

-- Still undefined: rows with the same created_at can appear in any order
SELECT * FROM events ORDER BY created_at LIMIT 100;

-- Deterministic: unique tiebreaker ensures consistent results
SELECT * FROM events ORDER BY created_at, event_id LIMIT 100;
```

Snowflake's [documentation](https://community.snowflake.com/s/article/SELECT-query-with-LIMIT-clause-returns-non-deterministic-result-if-ORDER-BY-clause-exists-in-different-level) explicitly warns that `SELECT` with `LIMIT` returns non-deterministic results when the `ORDER BY` clause exists at a different subquery level.

### 1.4 GROUP BY Without ORDER BY

The order of groups in a `GROUP BY` result is undefined by the SQL standard. Most databases do not guarantee any particular order of grouped output:

```sql
-- The order of departments in the output is undefined
SELECT department_id, COUNT(*) AS emp_count
FROM employees
GROUP BY department_id;
-- Run 1: dept 3, dept 1, dept 2
-- Run 2: dept 1, dept 3, dept 2
```

If a validation system compares the *ordered output* of grouped results (e.g., by hashing the result set row by row), different group orderings will produce different hashes even though the data is identical.

### 1.5 LIMIT Without ORDER BY

Using `LIMIT` (or `TOP`, or `FETCH FIRST`) without `ORDER BY` is perhaps the most common source of non-determinism in practice. The rows returned are arbitrary and can change between executions, especially when:

- The table has been modified (inserts, updates, deletes change physical layout)
- The query plan changes (new statistics, different parallelism)
- The database engine uses different scan strategies

```sql
-- Which 5 rows? Nobody knows.
SELECT * FROM customers LIMIT 5;
```

### 1.6 Random Sampling (TABLESAMPLE)

`TABLESAMPLE` is explicitly non-deterministic by design. Without the `REPEATABLE` clause, each execution returns a different sample:

```sql
-- Non-deterministic: different rows each time
SELECT * FROM large_table TABLESAMPLE SYSTEM (10);

-- Deterministic: same sample with same seed
SELECT * FROM large_table TABLESAMPLE SYSTEM (10) REPEATABLE (42);
```

Important caveats about `REPEATABLE`:

- **SQL Server**: `TABLESAMPLE` operates on *pages*, not rows. It returns rows from approximately N% of pages, not N% of rows. The exact rows depend on the physical storage layout.
- **Snowflake**: The `SEED` parameter ensures the same data files are selected, but if the underlying micro-partitions change, results will differ.
- **PostgreSQL**: Supports both `SYSTEM` (block-level) and `BERNOULLI` (row-level) sampling. `BERNOULLI` is more uniform but slower.

### 1.7 UDF Non-Determinism

User-defined functions (UDFs) can introduce non-determinism in several ways:

```sql
-- Non-deterministic UDF: depends on external state
CREATE FUNCTION get_exchange_rate(currency TEXT)
RETURNS DECIMAL
AS $$
    -- Calls external API - result changes over time
    SELECT rate FROM exchange_rates WHERE currency_code = currency
    ORDER BY timestamp DESC LIMIT 1;
$$;

-- Query using non-deterministic UDF: validation results will differ
SELECT order_id,
       amount * get_exchange_rate(currency) AS amount_usd
FROM orders;
```

PostgreSQL allows marking functions with volatility categories:
- `IMMUTABLE`: Always returns the same result for the same arguments
- `STABLE`: Returns the same result within a single table scan
- `VOLATILE`: Can return different results on successive calls (default)

Misclassifying a `VOLATILE` function as `IMMUTABLE` can cause the optimizer to cache and reuse results inappropriately, leading to incorrect query results.

### 1.8 Summary Table: Sources of Non-Determinism

| Source | Affected Operations | Databases | Fix |
|--------|-------------------|-----------|-----|
| Parallel float aggregation | SUM, AVG, STDDEV | All with parallel execution | Use DECIMAL; Kahan summation |
| Window function ties | ROW_NUMBER, NTILE | All | Add unique tiebreaker to ORDER BY |
| Missing ORDER BY | SELECT with LIMIT | All | Always specify ORDER BY with unique key |
| GROUP BY order | Any GROUP BY | All | Add explicit ORDER BY after GROUP BY |
| TABLESAMPLE | Sampling queries | All | Use REPEATABLE/SEED clause |
| UDF volatility | Any UDF call | PostgreSQL, Snowflake, BigQuery | Mark functions correctly; avoid external calls |
| Set semantics | UNION, EXCEPT, INTERSECT | All | Use ORDER BY on final result |

---

## 2. Floating-Point Non-Reproducibility Deep Dive

Floating-point non-reproducibility is the most insidious source of validation failures because it affects *correct* data---the values haven't changed, but the computed aggregates differ between runs.

### 2.1 IEEE 754 and Parallel Accumulation Order

IEEE 754 defines the standard for floating-point arithmetic used by virtually all modern processors. The standard guarantees that each individual operation (addition, multiplication, etc.) produces the correctly rounded result. However, it says nothing about the *order* of operations in a sequence, and this is where reproducibility breaks down.

The core mathematical issue is that floating-point addition is **not associative**:

```
(a + b) + c  !=  a + (b + c)   (in general, for floating-point)
```

Concrete example:

```python
>>> a = 1e20
>>> b = -1e20
>>> c = 1.0
>>> (a + b) + c
1.0
>>> a + (b + c)
0.0
```

When a database engine parallelizes a `SUM` operation, each worker accumulates a partial sum over its assigned rows, and then the partial sums are combined. The assignment of rows to workers, the order of accumulation within each worker, and the order of combining partial sums can all vary between executions.

Research from ETH Zurich ([Mueller & Arteaga, 2018](https://arxiv.org/abs/1802.09883)) formalized this problem and demonstrated that even on the same hardware with the same data, parallel floating-point aggregation in RDBMSs can produce different results between runs. Their key finding: the problem is not theoretical---it manifests in practice with real-world data distributions.

### 2.2 PostgreSQL Parallel SUM vs Serial SUM

The PostgreSQL community has [documented this behavior](https://www.postgresql.org/message-id/CAFRJ5K0+ZZaUz0-ihX-aCj1h42H=s-CLWO+2Fb6nHCvXx19Diw@mail.gmail.com) extensively. When `max_parallel_workers_per_gather` is set to a value greater than 0, PostgreSQL may use parallel workers for aggregation, producing different results from serial execution:

```sql
-- Force serial execution
SET max_parallel_workers_per_gather = 0;
SELECT SUM(float_column) FROM large_table;
-- Result: 1234567890.123456

-- Allow parallel execution
SET max_parallel_workers_per_gather = 4;
SELECT SUM(float_column) FROM large_table;
-- Result: 1234567890.123457  (different!)
```

The PostgreSQL documentation for `numeric` types [explicitly states](https://www.postgresql.org/docs/current/datatype-numeric.html):

> The real and double precision types are inexact, variable-precision numeric types. [...] Inexact means that some values cannot be converted exactly to the internal format and are stored as approximations.

For user-defined aggregates, PostgreSQL even warns about inverse transition functions:

> An example of an aggregate for which adding an inverse transition function is problematic is `sum` over `float4` or `float8` inputs. [...] adding 1 to 1e20 results in 1e20 again, and so subtracting 1e20 from that yields 0, not 1.

### 2.3 Snowflake Worker Allocation Changes Between Runs

Snowflake's architecture introduces additional non-determinism because the number of workers allocated to a query can change between runs based on:

- **Warehouse load**: Each virtual warehouse distributes resources among concurrent queries. If two queries share a warehouse, each gets approximately half the compute. With ten queries, each gets roughly one-tenth.
- **Multi-cluster warehouses**: Snowflake automatically starts and stops additional clusters based on demand, meaning the same query may run on different numbers of nodes.
- **Query Acceleration Service**: Eligible queries may receive additional serverless compute resources unpredictably.

These factors mean that even with identical data, a `SUM(float_column)` query on Snowflake can produce different results between runs because the number of parallel workers and the distribution of rows across workers varies.

```sql
-- Snowflake: this query's float SUM may vary between runs
-- because the number of micro-partitions per worker can change
SELECT warehouse_name,
       SUM(credits_used) AS total_credits  -- FLOAT column
FROM snowflake.account_usage.warehouse_metering_history
GROUP BY warehouse_name;
```

### 2.4 The "80-Bit Extended Precision" Trap on x86

The x86 floating-point unit (x87 FPU) uses [80-bit extended precision](https://en.wikipedia.org/wiki/Extended_precision) internally for all calculations, even when operating on 64-bit `double` values. This creates a subtle trap:

1. Values loaded into x87 registers are promoted to 80-bit precision
2. Intermediate calculations are performed at 80-bit precision
3. When results are stored back to memory (as 64-bit doubles), they are rounded
4. Whether an intermediate value stays in a register or gets "spilled" to memory depends on the compiler's register allocation, which can change with optimization level

This means the same C code compiled with different optimization flags can produce different floating-point results, and since database engines are compiled C/C++ programs, their floating-point behavior can vary across builds.

```c
// This can produce different results depending on whether
// 'temp' is kept in an 80-bit register or spilled to a 64-bit memory location
double a = 1.0 / 3.0;
double b = a * 3.0;
// b might be exactly 1.0 (if computed at 80-bit precision)
// or 0.9999999999999999 (if rounded to 64-bit between operations)
```

As [Bruce Dawson documented](https://randomascii.wordpress.com/2012/03/21/intermediate-floating-point-precision/), intermediate floating-point precision is a persistent source of bugs. Modern x86-64 code typically uses SSE/AVX instructions (which operate at exactly 64-bit precision) rather than x87 instructions, but legacy code paths and certain database engines may still use x87 instructions in some cases.

**Practical impact on databases**: A database running on an older x86 system or compiled with x87 FPU instructions may produce slightly different aggregation results than the same database on a newer system using SSE2 instructions---even with identical data and identical query plans.

### 2.5 DECIMAL vs FLOAT for Reproducibility

The fundamental solution to floating-point non-reproducibility is to avoid floating-point types entirely for values that require exact comparison:

| Property | FLOAT/DOUBLE | DECIMAL/NUMERIC |
|----------|-------------|-----------------|
| Storage | Binary (IEEE 754) | Base-10 (exact) |
| Arithmetic | Hardware-accelerated | Software-emulated |
| Performance | Fast | 2-10x slower |
| Precision | ~15 significant digits | Up to 38+ digits (configurable) |
| Associativity | Non-associative | Associative |
| Reproducibility | Not guaranteed | Guaranteed |
| Use case | Scientific computing | Financial data, validation |

```sql
-- Non-reproducible: FLOAT
CREATE TABLE transactions_float (
    id BIGINT,
    amount DOUBLE PRECISION
);

-- Reproducible: DECIMAL
CREATE TABLE transactions_decimal (
    id BIGINT,
    amount DECIMAL(18, 4)
);

-- The SUM of DECIMAL values is always the same regardless of
-- parallelism, worker count, or execution order
SELECT SUM(amount) FROM transactions_decimal;
```

**MySQL's documentation** on this is particularly clear:

> A floating-point number sometimes surprises. Due to the fact that such values are not stored as exact values, attempts to treat them as exact in comparisons may lead to problems.

For validation checksums, always cast float columns to a fixed-precision representation before aggregation:

```sql
-- Convert float to string with fixed precision before hashing
SELECT MD5(
    GROUP_CONCAT(
        CAST(ROUND(amount, 4) AS CHAR)
        ORDER BY id
        SEPARATOR ','
    )
) AS checksum
FROM transactions;
```

### 2.6 Kahan Summation and Compensated Summation Algorithms

The [Kahan summation algorithm](https://en.wikipedia.org/wiki/Kahan_summation_algorithm) (1965) reduces floating-point accumulation error by maintaining a separate "compensation" variable that tracks the running error:

```python
def kahan_sum(values):
    total = 0.0
    compensation = 0.0
    for value in values:
        adjusted = value - compensation          # Step 1: compensate
        tentative_sum = total + adjusted         # Step 2: add
        compensation = (tentative_sum - total) - adjusted  # Step 3: compute new error
        total = tentative_sum                    # Step 4: update total
    return total
```

The Neumaier improvement (1974) handles the case where the new value is larger than the running total:

```python
def neumaier_sum(values):
    total = 0.0
    compensation = 0.0
    for value in values:
        tentative_sum = total + value
        if abs(total) >= abs(value):
            compensation += (total - tentative_sum) + value
        else:
            compensation += (value - tentative_sum) + total
        total = tentative_sum
    return total + compensation
```

**Database implementations**:

[QuestDB](https://questdb.com/blog/2020/05/12/interesting-things-we-learned-about-sums/) implemented vectorized Kahan summation using SIMD instructions, achieving:
- **68ms** over 1 billion double values with nulls (vs 139ms for ClickHouse)---approximately 2x faster
- Same speed as naive summation while providing compensated accuracy
- The implementation processes 8 values simultaneously using CPU vector instructions

The key insight from QuestDB's work: compensated summation is not just more accurate, it can be *faster* when implemented with SIMD vectorization and prefetching.

**Performance overhead** (from Mueller & Arteaga's research on reproducible aggregation):

| Approach | Overhead (aggregation) | Overhead (end-to-end) |
|----------|----------------------|----------------------|
| Custom numeric type (naive) | 4-12x slowdown | N/A |
| Optimized summation buffers | 1.9-2.4x slowdown | 2.7% |
| Sorting-based approach | 7x+ slowdown | N/A |

The 2.7% end-to-end overhead for summation buffers makes reproducible aggregation practical for production use. However, **no major commercial database has adopted reproducible floating-point aggregation as a default behavior**---it must be implemented in the application layer or through UDFs.

### 2.7 Practical Recommendations for Validation Systems

1. **Store monetary and financial values as DECIMAL**, never FLOAT
2. **Round before comparing**: `ROUND(value, N)` reduces the space of possible values
3. **Use tolerance-based comparison** for float aggregates: `ABS(a - b) < epsilon`
4. **Consider relative tolerance**: `ABS(a - b) / MAX(ABS(a), ABS(b)) < epsilon`
5. **Document expected precision**: If a SUM can vary by 1e-10, make that part of the validation contract
6. **Force serial execution for validation queries** when exact reproducibility is required:

```sql
-- PostgreSQL: force serial execution
SET max_parallel_workers_per_gather = 0;

-- DuckDB: single-threaded mode
SET threads = 1;
```

---

## 3. Hash Function Stability

Hash functions are the workhorse of data validation. Row-level hashes, column checksums, and table-level fingerprints all depend on hash function determinism. But "deterministic" has nuances: a hash function may be deterministic within a single database version yet produce different results across versions, platforms, or databases.

### 3.1 MD5: Implementation Differences

MD5 is standardized (RFC 1321), so the algorithm itself always produces the same 128-bit output for the same input. However, how databases expose this output varies:

```sql
-- PostgreSQL: returns 32-character hex string (lowercase)
SELECT MD5('hello');
-- '5d41402abc4b2a76b9719d911017c592'

-- MySQL: returns 32-character hex string (lowercase)
SELECT MD5('hello');
-- '5d41402abc4b2a76b9719d911017c592'

-- Snowflake: returns 32-character hex string (lowercase)
SELECT MD5('hello');
-- '5d41402abc4b2a76b9719d911017c592'

-- SQL Server: uses HASHBYTES, returns binary
SELECT HASHBYTES('MD5', 'hello');
-- 0x5D41402ABC4B2A76B9719D911017C592

-- To get hex string in SQL Server:
SELECT LOWER(CONVERT(VARCHAR(32), HASHBYTES('MD5', 'hello'), 2));
-- '5d41402abc4b2a76b9719d911017c592'
```

**Cross-database pitfalls**:

1. **Encoding**: MD5 operates on bytes, not characters. If one database uses UTF-8 and another uses Latin-1, the same "string" produces different hashes.
2. **NULL handling**: `MD5(NULL)` returns `NULL` in PostgreSQL and Snowflake, but MySQL's `MD5(NULL)` also returns `NULL`. However, concatenating with NULL (`MD5(CONCAT(col1, col2))`) where any column is NULL produces NULL in standard SQL but may silently skip NULLs in some databases.
3. **Trailing spaces**: Some databases pad CHAR types with trailing spaces; others don't. `MD5('hello')` != `MD5('hello   ')`.
4. **Case sensitivity**: The hex output is typically lowercase, but some implementations return uppercase. Always normalize.

### 3.2 SHA-256: Byte Order and Encoding

SHA-256 is more standardized than MD5 and universally produces a 256-bit (32-byte) output. Cross-database considerations:

```sql
-- PostgreSQL (requires pgcrypto extension)
SELECT encode(digest('hello', 'sha256'), 'hex');
-- '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'

-- Snowflake
SELECT SHA2('hello', 256);
-- '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'

-- BigQuery
SELECT TO_HEX(SHA256('hello'));
-- '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
```

SHA-256 is the recommended hash function for cross-database validation because:
- The algorithm is standardized (FIPS 180-4)
- Implementations are mature and consistent
- The output format is well-defined (hex encoding is universal)
- Collision probability is negligible for validation purposes

### 3.3 CRC32: Polynomial Differences

CRC32 has a critical gotcha: there are multiple CRC32 variants using different polynomials:

| Variant | Polynomial | Used By |
|---------|-----------|---------|
| CRC-32 (ISO 3309) | 0x04C11DB7 | zlib, Ethernet, PostgreSQL, MySQL `CRC32()` |
| CRC-32C (Castagnoli) | 0x1EDC6F41 | iSCSI, ext4, MySQL InnoDB, MariaDB `CRC32C()` |
| CRC-32K (Koopman) | 0x741B8CD7 | Less common |

[MariaDB](https://mariadb.com/docs/server/reference/sql-functions/numeric-functions/crc32c) provides both `CRC32()` (ISO 3309) and `CRC32C()` (Castagnoli) as separate functions. [MySQL 8.0.27](https://dev.mysql.com/blog-archive/faster-crc32-c-computation-in-mysql-8027/) added hardware-accelerated CRC32C support.

**Cross-database trap**: If one system uses CRC-32 and another uses CRC-32C, checksums will not match even for identical data. There are actually [32 different permutations](https://github.com/Michaelangel007/crc32) of bit shuffling in CRC32 implementations, of which only 4 are standardized.

### 3.4 Database-Native Hash Functions

#### Snowflake HASH()

Snowflake's `HASH()` function is [proprietary and explicitly documented as non-portable](https://docs.snowflake.com/en/sql-reference/functions/hash):

> HASH is a proprietary function [...] It is not a cryptographic hash function and should not be used as such.

Key properties:
- Returns a signed 64-bit integer
- Deterministic within Snowflake (same input always produces same output)
- **No stability guarantee across Snowflake versions** (the documentation does not promise version-to-version stability)
- Not compatible with any standard hash algorithm
- NULL never produces NULL output (unlike MD5/SHA)
- Type-sensitive: `HASH(10)` != `HASH('10')`

```sql
-- Snowflake: proprietary hash, not portable
SELECT HASH('hello');
-- Returns a signed 64-bit integer (e.g., -3682257888686364089)

-- For cross-platform validation, use SHA2 instead
SELECT SHA2('hello', 256);
```

#### Snowflake HASH_AGG()

[`HASH_AGG`](https://docs.snowflake.com/en/sql-reference/functions/hash_agg) is Snowflake's order-independent aggregate hash:

```sql
-- Order-independent: same result regardless of row order
SELECT HASH_AGG(*) FROM my_table;

-- Per-column validation
SELECT HASH_AGG(col1, col2, col3) FROM my_table;
```

Critical properties:
- **Order-independent**: row order does not affect the result
- **Column-order-dependent**: changing the order of input columns *does* change the result
- **NULL-sensitive**: unlike most aggregates, `HASH_AGG` does not ignore NULLs
- **Duplicate-sensitive**: duplicate rows influence the result
- Returns a signed 64-bit integer

#### PostgreSQL MD5()

PostgreSQL's `MD5()` is the standard RFC 1321 implementation returning a 32-character lowercase hex string. It is stable across PostgreSQL versions and platforms.

#### BigQuery FARM_FINGERPRINT()

[BigQuery's `FARM_FINGERPRINT()`](https://cloud.google.com/bigquery/docs/reference/standard-sql/hash_functions) uses Google's open-source FarmHash library:

> The output of this function for a particular input will never change.

This is one of the strongest stability guarantees among proprietary hash functions. `FARM_FINGERPRINT` returns a signed INT64 and is suitable for partitioning and sampling but should not be used for cross-platform comparison.

### 3.5 Are Hash Results Stable Across Versions?

| Hash Function | Stability Guarantee |
|--------------|-------------------|
| MD5 | Standardized (RFC 1321); stable across all databases and versions |
| SHA-256 | Standardized (FIPS 180-4); stable across all databases and versions |
| SHA-512 | Standardized (FIPS 180-4); stable across all databases and versions |
| CRC32 | Algorithm is stable, but verify which polynomial variant is used |
| Snowflake HASH() | No explicit cross-version stability guarantee |
| BigQuery FARM_FINGERPRINT() | Explicitly guaranteed to never change |
| PostgreSQL hashtext() | Explicitly *not* stable across major versions (uses internal hash) |
| SQL Server CHECKSUM() | Not guaranteed stable across versions |

**Recommendation for validation systems**: Use SHA-256 for all cross-database and cross-version validation. It is standardized, universally available, and has the strongest stability guarantees. Use database-native hash functions (HASH_AGG, FARM_FINGERPRINT) only for within-database comparisons where performance matters.

---

## 4. Timestamp Determinism

Timestamps appear deterministic but have subtle behaviors that vary across databases, isolation levels, and distributed architectures.

### 4.1 CURRENT_TIMESTAMP: Transaction-Level vs Statement-Level

Different databases evaluate `CURRENT_TIMESTAMP` at different granularities:

| Database | CURRENT_TIMESTAMP Behavior |
|----------|--------------------------|
| PostgreSQL | Transaction start time (frozen for entire transaction) |
| MySQL | Statement start time (changes between statements) |
| SQL Server | Statement start time |
| Snowflake | Statement start time |
| BigQuery | Query start time |

PostgreSQL provides [multiple timestamp functions](https://www.postgresql.org/docs/current/functions-datetime.html) at different granularities:

```sql
-- PostgreSQL: all return the SAME value within a transaction
BEGIN;
SELECT NOW();                    -- Transaction start time
SELECT CURRENT_TIMESTAMP;        -- Same as NOW()
SELECT transaction_timestamp();  -- Same as NOW()

-- These DO change within a transaction:
SELECT statement_timestamp();   -- Statement start time
SELECT clock_timestamp();       -- Actual wall clock time (changes mid-statement)
COMMIT;
```

**Impact on validation**: If a validation query records timestamps using `CURRENT_TIMESTAMP`, two queries within the same PostgreSQL transaction will record the same timestamp even if they run minutes apart. In MySQL, they would record different timestamps.

```sql
-- PostgreSQL: both inserts get the SAME timestamp
BEGIN;
INSERT INTO validation_log (checked_at, result) VALUES (NOW(), 'pass');
-- ... long validation query runs here ...
INSERT INTO validation_log (checked_at, result) VALUES (NOW(), 'pass');
COMMIT;

-- MySQL: each insert gets a DIFFERENT timestamp
START TRANSACTION;
INSERT INTO validation_log (checked_at, result) VALUES (NOW(), 'pass');
-- ... long validation query runs here ...
INSERT INTO validation_log (checked_at, result) VALUES (NOW(), 'pass');
COMMIT;
```

### 4.2 Clock Skew Across Distributed Nodes

In distributed databases, nodes have independent clocks that are synchronized via NTP (Network Time Protocol) or more precise mechanisms. Clock skew---the difference between clocks on different nodes---introduces timestamp non-determinism:

- **NTP**: Typical accuracy of 1-10ms within a datacenter, 10-100ms across datacenters
- **PTP (Precision Time Protocol)**: Sub-microsecond accuracy, but requires hardware support
- **Google TrueTime**: Keeps uncertainty within ~6ms using GPS receivers and atomic clocks

[Google Spanner](https://docs.google.com/spanner/docs/true-time-external-consistency) solves this with TrueTime, which returns a time *interval* rather than a point:

```
TrueTime.now() returns [earliest, latest]
where actual time is guaranteed to be within the interval
```

Spanner enforces a **commit wait** of 7ms before reporting a transaction as committed, ensuring that no subsequent transaction can have an earlier timestamp. This guarantees external consistency but adds latency.

[CockroachDB's approach](https://www.cockroachlabs.com/blog/living-without-atomic-clocks/) differs: it uses NTP and adjusts transaction timestamps dynamically when conflicts are detected within the uncertainty window, trading latency for consistency in the common case.

**Impact on validation**: In a distributed database, two queries executed "simultaneously" on different nodes may see slightly different `CURRENT_TIMESTAMP` values. If validation logic depends on timestamp comparison (e.g., "check all rows modified in the last 5 minutes"), clock skew can cause rows to be included or excluded unpredictably.

### 4.3 Snowflake's SYSTEM$LAST_CHANGE_COMMIT_TIME()

Snowflake provides [`SYSTEM$LAST_CHANGE_COMMIT_TIME()`](https://docs.snowflake.com/en/sql-reference/functions/system_last_change_commit_time) as a lightweight way to detect whether a table has changed:

```sql
-- Returns a token (nanosecond UTC timestamp) indicating last change
SELECT SYSTEM$LAST_CHANGE_COMMIT_TIME('my_schema.my_table');
-- Result: 1710345600000000000  (nanoseconds since epoch)
```

**Critical caveat** from Snowflake's documentation:

> The values are only approximations, in part because the precision and skew of the results can vary. Snowflake recommends using this value only as a change indicator.

This means you **cannot** use this function as a precise timestamp for validation. It is suitable only for detecting *whether* a change occurred, not *when* precisely it occurred.

### 4.4 BigQuery Streaming Buffer Commit Timestamps

BigQuery's [streaming buffer](https://cloud.google.com/bigquery/docs/streaming-data-into-bigquery) introduces significant timestamp non-determinism:

- Streamed data is available for querying within seconds
- But `_PARTITIONTIME` for ingestion-time partitioned tables is initially `NULL`
- The partition time is assigned asynchronously when data moves out of the streaming buffer
- **There is no SLA** for how long data remains in the `__UNPARTITIONED__` partition

```sql
-- Rows in the streaming buffer have NULL _PARTITIONTIME
SELECT *
FROM `project.dataset.table`
WHERE _PARTITIONTIME IS NULL;  -- Returns rows still in streaming buffer

-- These rows will eventually get a _PARTITIONTIME, but the exact
-- timestamp assigned is non-deterministic
```

For validation systems that depend on partition-based queries, this means:

1. Freshly streamed rows may be invisible to partition-filtered queries
2. The same row may appear in different partitions depending on when it leaves the streaming buffer
3. Row counts by partition can fluctuate without any new data being inserted

**Mitigation**: Use the BigQuery Storage Write API with committed streams, which makes data queryable immediately upon commit with well-defined semantics.

---

## 5. NULL Handling Non-Determinism

SQL's three-valued logic (TRUE, FALSE, UNKNOWN) makes NULL handling one of the most common sources of unexpected behavior in data validation.

### 5.1 NULL in Aggregations: COUNT vs COUNT(*)

```sql
-- Setup
CREATE TABLE test_nulls (id INT, value INT);
INSERT INTO test_nulls VALUES (1, 100), (2, NULL), (3, 200), (4, NULL);

-- COUNT(*) counts ALL rows (including those with NULL values)
SELECT COUNT(*) FROM test_nulls;
-- Result: 4

-- COUNT(value) counts only NON-NULL values
SELECT COUNT(value) FROM test_nulls;
-- Result: 2

-- SUM ignores NULLs silently
SELECT SUM(value) FROM test_nulls;
-- Result: 300 (not 300 + NULL + NULL)

-- AVG also ignores NULLs: 300/2 = 150, not 300/4 = 75
SELECT AVG(value) FROM test_nulls;
-- Result: 150
```

**Validation trap**: If a source table has NULLs and a target table has zeros instead, `SUM` will match but `AVG` and `COUNT` will not:

```sql
-- Source: has NULLs
-- SUM(value) = 300, AVG(value) = 150, COUNT(value) = 2

-- Target: NULLs replaced with 0
-- SUM(value) = 300, AVG(value) = 75, COUNT(value) = 4
-- SUM matches! But AVG and COUNT differ.
```

### 5.2 NULL in DISTINCT

NULLs are considered equal for `DISTINCT` purposes (unlike in comparison operators):

```sql
-- Multiple NULLs collapse into one NULL in DISTINCT
SELECT DISTINCT value FROM test_nulls;
-- Result: 100, 200, NULL  (not 100, 200, NULL, NULL)
```

This is consistent across major databases but is inconsistent with the general rule that `NULL != NULL`.

### 5.3 NULL in GROUP BY

Similarly, `GROUP BY` treats all NULLs as belonging to the same group:

```sql
SELECT value, COUNT(*) FROM test_nulls GROUP BY value;
-- Result:
--   100  | 1
--   200  | 1
--   NULL | 2
```

### 5.4 NULL Ordering in ORDER BY: The Cross-Database Minefield

The SQL standard does not define where NULLs appear in sorted output. Each database has its own default:

| Database | ASC Default | DESC Default | NULLS FIRST/LAST Support |
|----------|------------|-------------|------------------------|
| PostgreSQL | NULLS LAST | NULLS FIRST | Yes (native) |
| Oracle | NULLS LAST | NULLS FIRST | Yes (native) |
| MySQL | NULLS FIRST | NULLS LAST | No (workaround needed) |
| SQL Server | NULLS FIRST | NULLS LAST | No (workaround needed) |
| Snowflake | NULLS LAST (configurable) | NULLS FIRST | Yes (native) |
| BigQuery | NULLS LAST | NULLS FIRST | Yes (native) |
| SQLite | NULLS FIRST | NULLS LAST | Yes (since 3.30.0) |

This means a validation query that sorts results and computes a positional hash will produce different results across databases:

```sql
-- PostgreSQL: NULL appears last in ASC order
SELECT * FROM test_nulls ORDER BY value ASC;
-- 100, 200, NULL, NULL

-- MySQL: NULL appears first in ASC order
SELECT * FROM test_nulls ORDER BY value ASC;
-- NULL, NULL, 100, 200
```

**Snowflake** has a session parameter `DEFAULT_NULL_ORDERING` that defaults to `LAST` but can be changed:

```sql
-- Snowflake: configurable
ALTER SESSION SET DEFAULT_NULL_ORDERING = 'FIRST';
```

**Fix**: Always use explicit `NULLS FIRST` or `NULLS LAST` in validation queries:

```sql
SELECT * FROM test_nulls ORDER BY value ASC NULLS LAST;
```

For databases without native support (MySQL, SQL Server), use a workaround:

```sql
-- MySQL/SQL Server: simulate NULLS LAST
SELECT * FROM test_nulls
ORDER BY CASE WHEN value IS NULL THEN 1 ELSE 0 END,
         value ASC;
```

### 5.5 NULL in Comparison Operators: The NOT IN Trap

SQL's three-valued logic creates a devastating trap with `NOT IN` and NULLs:

```sql
-- Setup
CREATE TABLE departments (id INT);
INSERT INTO departments VALUES (1), (2), (NULL);

-- Find employees NOT in the departments list
SELECT * FROM employees WHERE department_id NOT IN (SELECT id FROM departments);
-- Returns: ZERO ROWS (even if employees have department_id = 99)
```

Why? Because `NOT IN (1, 2, NULL)` expands to:

```
department_id != 1 AND department_id != 2 AND department_id != NULL
```

The `department_id != NULL` evaluates to `UNKNOWN`, and `TRUE AND TRUE AND UNKNOWN = UNKNOWN`, which is not TRUE, so no rows pass the filter.

**Fix**: Use `NOT EXISTS` instead:

```sql
SELECT * FROM employees e
WHERE NOT EXISTS (
    SELECT 1 FROM departments d
    WHERE d.id = e.department_id
);
-- Correctly returns employees with department_id not in (1, 2)
```

Or filter NULLs from the subquery:

```sql
SELECT * FROM employees
WHERE department_id NOT IN (
    SELECT id FROM departments WHERE id IS NOT NULL
);
```

### 5.6 Three-Valued Logic Gotchas for Validation

```sql
-- These are NOT equivalent:
WHERE status != 'active'     -- Excludes NULLs (NULL != 'active' is UNKNOWN)
WHERE status IS DISTINCT FROM 'active'  -- Includes NULLs (SQL:2003 standard)
WHERE NOT (status = 'active')  -- Also excludes NULLs

-- NULL-safe equality (varies by database):
-- PostgreSQL: IS NOT DISTINCT FROM
-- MySQL: <=> (NULL-safe equal)
-- Snowflake: IS NOT DISTINCT FROM (or EQUAL_NULL())

-- Validation query that correctly handles NULLs
SELECT COUNT(*) AS mismatched_rows
FROM source s
FULL OUTER JOIN target t ON s.id = t.id
WHERE s.value IS DISTINCT FROM t.value;  -- Catches NULL-to-value and value-to-NULL changes
```

---

## 6. Collation and Locale Non-Determinism

String comparison is not as simple as comparing bytes. Collation rules define how characters are ordered, and these rules can change between operating system versions, causing silent data corruption.

### 6.1 The glibc 2.28 Sort Order Change (Real Incident)

In August 2018, glibc 2.28 was released with a major update to Unicode collation data (CLDR). This changed the sort order for virtually all locales, including `en_US`. The consequences for PostgreSQL were catastrophic.

**What happened**: PostgreSQL delegates string comparison to the operating system's C library (glibc on Linux). When glibc 2.28 changed collation rules, the sort order of strings changed---but PostgreSQL's B-tree indexes still reflected the *old* sort order. This created a state where:

1. **Index scans could miss rows**: A query looking for a value would search the index using the new sort order, but the index was built using the old order. The value could exist but not be found.
2. **Unique constraints could be violated**: Two strings that sorted differently under the old rules might sort equally under the new rules (or vice versa), allowing duplicate insertions.
3. **Range partitions could route to wrong partitions**: Text-based partition boundaries were evaluated with the new sort order against data organized with the old order.

As [Crunchy Data documented](https://www.crunchydata.com/blog/glibc-collations-and-data-corruption):

> If a new version of a collation provider changes the ordering of characters used in a previously built index, the persisted order in the index may no longer match the order specified by the collation library. [...] a query could fail to find data that is actually there, and an update could insert duplicate data that should be disallowed.

**Affected systems**:
- Ubuntu 18.10+
- RHEL/CentOS 8+ (glibc 2.17 -> 2.28)
- Debian 10+

**Not affected**:
- Databases using `C` or `POSIX` locale (byte-order comparison, no collation)
- Databases using ICU collations (PostgreSQL 10+)

**Recovery**: All text indexes needed to be rebuilt:

```sql
-- PostgreSQL 12+: concurrent reindex
REINDEX INDEX CONCURRENTLY idx_name;

-- Earlier versions: create new index, drop old, rename
CREATE INDEX CONCURRENTLY idx_name_new ON table (column);
DROP INDEX idx_name;
ALTER INDEX idx_name_new RENAME TO idx_name;
```

PostgreSQL 13+ now records the collation library version and emits warnings when a mismatch is detected:

```
WARNING: collation "en_US.UTF-8" has version mismatch
DETAIL:  The collation in the database was created using version 2.17,
         but the operating system provides version 2.28.
HINT:  Rebuild all objects affected by this collation and run
       ALTER COLLATION "en_US.UTF-8" REFRESH VERSION.
```

### 6.2 ICU vs glibc Collation

ICU (International Components for Unicode) provides an alternative collation provider that is:
- **Versioned**: ICU collation versions are explicit and tracked
- **Platform-independent**: Same ICU version produces same sort order on all platforms
- **Stable**: ICU provides backward compatibility guarantees within major versions

```sql
-- PostgreSQL: create database with ICU collation
CREATE DATABASE mydb
    LOCALE_PROVIDER = icu
    ICU_LOCALE = 'en-US';

-- Or create a specific ICU collation
CREATE COLLATION english_ci (
    PROVIDER = icu,
    LOCALE = 'en-US-u-ks-level2',  -- Case-insensitive
    DETERMINISTIC = false
);
```

PostgreSQL 16+ defaults to ICU for new databases on many platforms, finally breaking the dependency on glibc collations.

### 6.3 Case-Insensitive Comparison Differences

Case folding (uppercasing or lowercasing for comparison) is locale-dependent:

```sql
-- The Turkish 'I' problem
-- In Turkish locale: UPPER('i') = 'I' (with dot above: U+0130), not 'I'
-- In English locale: UPPER('i') = 'I'

-- This comparison may give different results depending on locale:
SELECT * FROM users WHERE UPPER(name) = 'ILHAN';
-- Turkish locale: won't match 'ilhan' (because UPPER('i') produces dotted I)
-- English locale: will match 'ilhan'
```

The German sharp S is another classic:

```sql
-- UPPER('strasse') in different locales:
-- Most locales: 'STRASSE'
-- Some older implementations: 'STRASSE' (no uppercase sharp S existed until Unicode 5.1)
```

### 6.4 Unicode Normalization (NFC vs NFD)

The same visible character can be represented in multiple ways in Unicode:

```
-- The character 'o' (o with diaeresis) can be represented as:
-- NFC (precomposed):  U+00F6 (single code point)
-- NFD (decomposed):   U+006F U+0308 (base 'o' + combining diaeresis)
```

These are *canonically equivalent* and should compare as equal, but byte-level comparison will find them different.

As [documented by PostgreSQL and Unicode experts](https://www.enterprisedb.com/blog/unicode-normalization-postgresql-13):

> Because of encoding differences, the NFD 'o' comes before 'u', while the NFC 'o' comes after 'u' in raw byte comparisons.

PostgreSQL 13+ provides the `normalize()` function:

```sql
-- PostgreSQL 13+: normalize strings before comparison
SELECT normalize('cafe\u0301', NFC);  -- Returns 'cafe' with precomposed e-acute

-- Check if a string is normalized
SELECT is_normalized('cafe\u0301', NFC);  -- Returns false
```

**Impact on validation**: If data is loaded through different paths (one normalizing to NFC, another to NFD), byte-level comparison or hashing will show differences even though the strings are semantically identical.

```sql
-- These produce DIFFERENT MD5 hashes:
SELECT MD5(E'caf\u00E9');     -- NFC form (e-acute as single code point)
SELECT MD5(E'cafe\u0301');    -- NFD form (e + combining acute)
-- Even though they display identically as 'cafe'!
```

### 6.5 macOS vs Linux Locale Behavior

macOS uses Apple's own locale implementation (based on ICU), while Linux uses glibc. This means:

- The same `en_US.UTF-8` locale produces different sort orders on macOS vs Linux
- Development on macOS and deployment on Linux can produce different validation results
- Docker containers using Alpine Linux (musl libc) differ from both glibc and macOS

```sql
-- Sort order may differ between macOS and Linux for:
-- - Accented characters (e, e with acute, e with grave, e with circumflex)
-- - Punctuation characters (-, _, .)
-- - Mixed case (A, a, B, b)
-- - Unicode symbols

-- Safest approach: use C/POSIX locale for validation
SET lc_collate = 'C';  -- Pure byte-order comparison
```

---

## 7. Concurrent Modification During Validation

Data validation queries often run against tables that are being modified concurrently. Without proper isolation, the validation may see an inconsistent view of the data.

### 7.1 Read Consistency Models

| Isolation Level | Dirty Reads | Non-Repeatable Reads | Phantom Reads |
|----------------|-------------|---------------------|---------------|
| READ UNCOMMITTED | Possible | Possible | Possible |
| READ COMMITTED | No | Possible | Possible |
| REPEATABLE READ | No | No | Possible |
| SERIALIZABLE | No | No | No |

Most databases default to READ COMMITTED, which means:

```sql
-- Transaction 1: Validation query
BEGIN;
SELECT COUNT(*) FROM orders;  -- Returns 1000

-- Transaction 2: Inserts new orders concurrently
INSERT INTO orders VALUES (...);

-- Transaction 1: Continues validation
SELECT SUM(amount) FROM orders;  -- May include the new row!
-- The validation sees an inconsistent state:
-- COUNT was 1000, but SUM includes 1001 rows
COMMIT;
```

For validation to be meaningful, **all validation queries must see the same snapshot of data**.

### 7.2 Snowflake Time Travel for Point-in-Time Comparison

Snowflake's [Time Travel](https://docs.snowflake.com/en/user-guide/data-time-travel) provides built-in snapshot isolation for validation:

```sql
-- Query data as it existed at a specific timestamp
SELECT COUNT(*) FROM my_table
AT (TIMESTAMP => '2024-01-15 10:30:00'::TIMESTAMP);

-- Query data as it existed before a specific statement
SELECT * FROM my_table
BEFORE (STATEMENT => '8e5d0ca9-005e-44e6-b858-a8f5b37c5726');

-- Query data as it existed 5 minutes ago
SELECT * FROM my_table
AT (OFFSET => -300);  -- 300 seconds ago
```

**Validation pattern with Time Travel**:

```sql
-- Pin both source and target to the same timestamp
SET validation_ts = CURRENT_TIMESTAMP()::STRING;

-- All validation queries use the same snapshot
SELECT COUNT(*) FROM source_table AT (TIMESTAMP => $validation_ts::TIMESTAMP);
SELECT COUNT(*) FROM target_table AT (TIMESTAMP => $validation_ts::TIMESTAMP);
SELECT SUM(amount) FROM source_table AT (TIMESTAMP => $validation_ts::TIMESTAMP);
SELECT SUM(amount) FROM target_table AT (TIMESTAMP => $validation_ts::TIMESTAMP);
```

Time Travel is available for up to 90 days (Enterprise Edition) or 1 day (Standard Edition).

### 7.3 BigQuery Snapshot Decorators

BigQuery supports [point-in-time queries](https://cloud.google.com/bigquery/docs/access-historical-data) using the `FOR SYSTEM_TIME AS OF` clause:

```sql
-- Query a table as it existed at a specific time
SELECT COUNT(*) FROM `project.dataset.table`
FOR SYSTEM_TIME AS OF '2024-01-15 10:30:00 UTC';

-- Query a table as it existed 1 hour ago
SELECT COUNT(*) FROM `project.dataset.table`
FOR SYSTEM_TIME AS OF TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 HOUR);
```

BigQuery maintains a 7-day history (up to 14 days with Enterprise Plus). A BigQuery table snapshot is [transactionally consistent](https://cloud.google.com/bigquery/docs/table-snapshots-intro) with the source table at the moment of creation.

**Validation pattern**:

```sql
-- Create explicit snapshots for validation
CREATE SNAPSHOT TABLE `project.dataset.source_snapshot`
  CLONE `project.dataset.source_table`
  FOR SYSTEM_TIME AS OF CURRENT_TIMESTAMP();

CREATE SNAPSHOT TABLE `project.dataset.target_snapshot`
  CLONE `project.dataset.target_table`
  FOR SYSTEM_TIME AS OF CURRENT_TIMESTAMP();

-- Validate against snapshots (immutable)
SELECT COUNT(*) FROM `project.dataset.source_snapshot`;
SELECT COUNT(*) FROM `project.dataset.target_snapshot`;
```

### 7.4 PostgreSQL REPEATABLE READ

PostgreSQL's REPEATABLE READ isolation level provides a consistent snapshot for the entire transaction:

```sql
-- Start a repeatable read transaction
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ;

-- All queries in this transaction see the same snapshot
SELECT COUNT(*) FROM source_table;     -- Snapshot at transaction start
SELECT COUNT(*) FROM target_table;     -- Same snapshot
SELECT SUM(amount) FROM source_table;  -- Same snapshot

-- Concurrent modifications are invisible
COMMIT;
```

PostgreSQL's [MVCC implementation](https://www.postgresql.org/docs/current/transaction-iso.html) guarantees that:

> A query in a repeatable read transaction sees a snapshot as of the start of the first non-transaction-control statement in the transaction, not as of the start of the current statement.

This is ideal for validation: all queries see exactly the same data regardless of concurrent modifications.

### 7.5 MVCC and Phantom Reads During Long-Running Validation

Multi-Version Concurrency Control (MVCC) is the mechanism most modern databases use to provide snapshot isolation. However, [MVCC has limitations](https://en.wikipedia.org/wiki/Multiversion_concurrency_control):

- **Read Committed** (default in PostgreSQL, Oracle): Each statement sees a new snapshot. Long-running validation transactions can see different data in different queries.
- **Repeatable Read**: The entire transaction sees one snapshot. New rows inserted by other transactions are invisible (no phantom reads).
- **Serializable**: Strongest guarantee, but may cause serialization failures requiring retry.

**Anti-pattern**: Running validation queries as individual statements outside a transaction:

```python
# WRONG: each query may see different data
count_source = db.execute("SELECT COUNT(*) FROM source").scalar()
count_target = db.execute("SELECT COUNT(*) FROM target").scalar()
# Between these two queries, data may have changed!

# RIGHT: use a single transaction with repeatable read
with db.begin() as txn:
    txn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
    count_source = txn.execute("SELECT COUNT(*) FROM source").scalar()
    count_target = txn.execute("SELECT COUNT(*) FROM target").scalar()
    # Both queries see the same snapshot
```

**Long-running validation considerations**:

- MVCC retains old row versions for as long as any transaction needs them
- A long-running validation transaction can cause table bloat (PostgreSQL) or increased storage (Snowflake)
- Some databases have timeout limits on transactions (e.g., Snowflake's statement timeout)
- Consider breaking validation into bounded chunks with explicit snapshot references rather than one long transaction

---

## 8. Making Validation Reproducible

### 8.1 Deterministic SQL Patterns

**Pattern 1: ORDER BY with unique tiebreaker**

Every `ORDER BY` clause should include a unique column as the final tiebreaker to ensure deterministic ordering:

```sql
-- Non-deterministic
SELECT * FROM orders ORDER BY created_at;

-- Deterministic
SELECT * FROM orders ORDER BY created_at, order_id;
```

**Pattern 2: Explicit NULLS FIRST/LAST**

```sql
-- Cross-database deterministic ordering
SELECT * FROM orders
ORDER BY amount ASC NULLS LAST, order_id ASC;
```

**Pattern 3: Deterministic window functions**

```sql
-- Always include enough columns to make ORDER BY unique
SELECT *,
       ROW_NUMBER() OVER (
           PARTITION BY department_id
           ORDER BY salary DESC, hire_date ASC, employee_id ASC
       ) AS rank
FROM employees;
```

**Pattern 4: Deterministic GROUP BY output**

```sql
-- Add ORDER BY after GROUP BY for deterministic output
SELECT department_id, COUNT(*) AS cnt
FROM employees
GROUP BY department_id
ORDER BY department_id;
```

### 8.2 Snapshot Isolation for Validation Queries

The fundamental rule: **all validation queries for a single validation run must see the same snapshot of data**.

```sql
-- PostgreSQL
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ;
-- All validation queries here
COMMIT;

-- Snowflake
SET validation_snapshot = CURRENT_TIMESTAMP()::STRING;
SELECT * FROM table AT (TIMESTAMP => $validation_snapshot::TIMESTAMP);

-- BigQuery
SELECT * FROM table
FOR SYSTEM_TIME AS OF TIMESTAMP '2024-01-15 10:30:00 UTC';
```

### 8.3 Checksum Algorithms That Handle Float Ordering

The core challenge: standard checksums (CRC32, MD5, SHA-256) are order-dependent---they hash a *sequence* of bytes. If the order of rows changes, the checksum changes. This is a problem for set-based validation where row order is undefined.

**Approach 1: Sort before hashing**

```sql
-- PostgreSQL: deterministic checksum via sorting
SELECT MD5(
    string_agg(
        ROW(id, name, amount)::TEXT,
        ',' ORDER BY id
    )
) AS table_checksum
FROM my_table;
```

This works but requires sorting the entire table, which is expensive for large tables.

**Approach 2: XOR-based checksums (commutative)**

XOR is both commutative and associative, making it order-independent:

```sql
-- Snowflake: XOR-based checksum
SELECT BIT_XOR(HASH(id, name, amount)) AS xor_checksum
FROM my_table;

-- PostgreSQL: XOR aggregate (requires custom aggregate or BIT_XOR)
SELECT BIT_XOR(('x' || MD5(ROW(id, name, amount)::TEXT))::BIT(64)::BIGINT)
FROM my_table;
```

**Limitations of XOR checksums**:
- Duplicate rows cancel out: `XOR(a, a) = 0`. If a row appears twice in the source but once in the target, the XOR checksum may still match.
- Not sensitive to multiplicity: fundamentally a set operation, not a multiset operation.
- Weak error detection: a single-bit error in one row can cancel with a single-bit error in another row.

**Approach 3: Snowflake HASH_AGG (purpose-built)**

```sql
-- Snowflake: built-in order-independent aggregate hash
SELECT HASH_AGG(*) AS table_checksum FROM my_table;

-- Per-column validation
SELECT HASH_AGG(col1, col2, col3) AS checksum FROM my_table;

-- Row-level checksums for identifying specific differences
SELECT HASH_AGG(*) AS row_hash
FROM my_table
GROUP BY id;
```

HASH_AGG is specifically designed for this use case:
- Order-independent (commutative)
- NULL-sensitive (does not ignore NULLs)
- Duplicate-sensitive (handles multisets correctly)
- 64-bit resolution (collision probability is low but nonzero)

**Approach 4: SUM of hashes (commutative but not XOR)**

```sql
-- SUM is commutative and handles duplicates correctly
-- (duplicate rows increase the sum, unlike XOR)
SELECT SUM(
    CAST(
        CONV(SUBSTRING(MD5(CONCAT_WS('|', id, name, amount)), 1, 16), 16, 10)
        AS UNSIGNED
    )
) AS checksum
FROM my_table;
```

This preserves multiplicity (duplicates increase the sum) but can overflow for very large tables.

### 8.4 DECIMAL Aggregation Instead of FLOAT

For validation that involves comparing aggregated values:

```sql
-- Cast FLOAT to DECIMAL before aggregation
SELECT SUM(CAST(amount AS DECIMAL(18, 4))) AS total
FROM transactions;

-- Or better: store as DECIMAL in the first place
ALTER TABLE transactions
    ALTER COLUMN amount TYPE DECIMAL(18, 4);
```

### 8.5 Caching and Result Pinning

For validation workflows that run multiple queries against the same data:

**PostgreSQL: Materialized views**

```sql
-- Create a materialized snapshot for validation
CREATE MATERIALIZED VIEW validation_snapshot AS
SELECT * FROM source_table;

-- All validation queries run against the snapshot
SELECT COUNT(*) FROM validation_snapshot;
SELECT SUM(amount) FROM validation_snapshot;

-- Clean up
DROP MATERIALIZED VIEW validation_snapshot;
```

**Snowflake: Temporary tables with Time Travel**

```sql
-- Create a temporary clone at a specific point in time
CREATE TEMPORARY TABLE validation_source
    CLONE source_table AT (TIMESTAMP => '2024-01-15 10:30:00'::TIMESTAMP);

CREATE TEMPORARY TABLE validation_target
    CLONE target_table AT (TIMESTAMP => '2024-01-15 10:30:00'::TIMESTAMP);

-- Validate against immutable snapshots
SELECT COUNT(*) FROM validation_source;
SELECT COUNT(*) FROM validation_target;
```

**BigQuery: Table snapshots**

```sql
-- Create immutable snapshots for validation
CREATE SNAPSHOT TABLE validation_source
    CLONE source_table
    FOR SYSTEM_TIME AS OF CURRENT_TIMESTAMP();
```

### 8.6 Comprehensive Validation Query Template

Putting it all together---a validation query pattern that handles all major sources of non-determinism:

```sql
-- PostgreSQL: Fully deterministic validation
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ;

-- Row count comparison
SELECT 'row_count' AS check_type,
       (SELECT COUNT(*) FROM source_table) AS source_value,
       (SELECT COUNT(*) FROM target_table) AS target_value;

-- Aggregate comparison (DECIMAL, not FLOAT)
SELECT 'amount_sum' AS check_type,
       (SELECT SUM(CAST(amount AS DECIMAL(18,4))) FROM source_table) AS source_value,
       (SELECT SUM(CAST(amount AS DECIMAL(18,4))) FROM target_table) AS target_value;

-- NULL count comparison
SELECT 'null_count' AS check_type,
       (SELECT COUNT(*) - COUNT(amount) FROM source_table) AS source_value,
       (SELECT COUNT(*) - COUNT(amount) FROM target_table) AS target_value;

-- Distinct value count
SELECT 'distinct_count' AS check_type,
       (SELECT COUNT(DISTINCT status) FROM source_table) AS source_value,
       (SELECT COUNT(DISTINCT status) FROM target_table) AS target_value;

-- Row-level hash comparison (order-independent)
SELECT 'hash_mismatch_count' AS check_type,
       COUNT(*) AS value
FROM (
    SELECT id, MD5(ROW(id, name, amount, status)::TEXT) AS row_hash
    FROM source_table
    EXCEPT
    SELECT id, MD5(ROW(id, name, amount, status)::TEXT) AS row_hash
    FROM target_table
) diff;

COMMIT;
```

```sql
-- Snowflake: Fully deterministic validation
SET validation_ts = CURRENT_TIMESTAMP()::STRING;

-- Row count comparison
SELECT 'row_count' AS check_type,
       (SELECT COUNT(*) FROM source_table
        AT (TIMESTAMP => $validation_ts::TIMESTAMP)) AS source_value,
       (SELECT COUNT(*) FROM target_table
        AT (TIMESTAMP => $validation_ts::TIMESTAMP)) AS target_value;

-- Order-independent table checksum
SELECT 'table_hash' AS check_type,
       (SELECT HASH_AGG(*) FROM source_table
        AT (TIMESTAMP => $validation_ts::TIMESTAMP)) AS source_value,
       (SELECT HASH_AGG(*) FROM target_table
        AT (TIMESTAMP => $validation_ts::TIMESTAMP)) AS target_value;

-- Aggregate comparison (using DECIMAL)
SELECT 'amount_sum' AS check_type,
       (SELECT SUM(amount::DECIMAL(18,4))
        FROM source_table AT (TIMESTAMP => $validation_ts::TIMESTAMP)) AS source_value,
       (SELECT SUM(amount::DECIMAL(18,4))
        FROM target_table AT (TIMESTAMP => $validation_ts::TIMESTAMP)) AS target_value;
```

---

## 9. Real-World Incidents

### 9.1 The glibc 2.28 Collation Catastrophe (2018-2019)

**What happened**: In August 2018, glibc 2.28 was released with updated Unicode CLDR collation data. This changed the sort order for virtually all non-C locales. When organizations upgraded their operating systems (RHEL 7 to RHEL 8, Ubuntu 18.04 to 18.10, Debian 9 to 10), PostgreSQL indexes built with the old sort order became silently corrupt.

**Symptoms**:
- Queries failed to find rows that existed in the table
- Unique constraint violations on data that was actually unique
- Range-partitioned tables routing data to wrong partitions
- Replication failures between servers running different OS versions

**Scale**: Every PostgreSQL installation using a non-C locale on affected Linux distributions was potentially impacted. The [Debian mailing list](https://lists.debian.org/debian-glibc/2019/03/msg00030.html) discussion reveals the widespread nature: "virtually all locales" were affected.

**Root cause**: PostgreSQL relied on the operating system's C library for string comparison, with no mechanism to detect when the library's behavior changed. B-tree indexes store data in sorted order, and when the sort order changed, the indexes became inconsistent with the collation rules used for queries.

**Recovery**:
- All text-column indexes needed to be rebuilt (`REINDEX`)
- AWS published a [compatibility library](https://github.com/awslabs/compat-collation-for-glibc) to maintain old sort order during transition
- PostgreSQL 13+ added collation version tracking and mismatch warnings
- The community began recommending ICU collations as the default

**A documented late-discovery case** (from [The Build blog, 2024](https://thebuild.com/blog/2024/11/15/the-doom-that-came-to-postgresql-when-collations-change/)): A PostgreSQL 15 database created on CentOS 7 (glibc 2.17) was being replicated to Rocky 8 (glibc 2.28). The collation mismatch warning appeared, forcing an accelerated migration timeline to rebuild all affected indexes.

**Lesson for validation systems**: String-based validation (comparing sorted output, computing checksums of string data) can produce different results on different platforms even with identical data if collation rules differ. Always use `C`/`POSIX` locale or ICU collations for validation, or normalize strings before comparison.

### 9.2 SQL Server Floating-Point SUM Discrepancies

**What happened**: A [documented case on SQLServerCentral](https://www.sqlservercentral.com/forums/topic/sumfloat-sumfloat) involved compute clauses in identical SELECT statements returning different results on different SQL Server 2000 Enterprise instances. One server ran on Intel x64 architecture, the other on AMD x32.

**Symptoms**:
- Reports showed different totals for identical data
- Discrepancies of approximately 20% were observed in some cases (when floating-point errors accumulated across many rows)
- The issue was intermittent---sometimes results matched, sometimes they didn't

**Root cause**: Different x86 CPU architectures handle floating-point operations differently. The Intel x64 processor used SSE2 instructions (64-bit precision), while the AMD x32 processor used x87 FPU instructions (80-bit extended precision with rounding to 64-bit on store). The different intermediate precision produced different accumulated rounding errors.

**The 20% discrepancy case**: As [documented on InsideSQL](https://www.insidesql.org/blogs/holgerschmeling/2010/11/02/did-you-know-aggregate-functions-on-floats-may-be-non-deterministic), a user reported that "numbers in our reports differed by about 20% with every execution" when using float aggregations in parallel execution plans. The massive discrepancy occurred because floating-point rounding errors compounded across millions of rows with values spanning many orders of magnitude.

**Lesson**: Float columns should never be used for financial data or any data requiring exact aggregation. Use DECIMAL/NUMERIC types, or at minimum, round before comparing.

### 9.3 MySQL SUM Precision Loss

**What happened**: [MySQL's documentation](https://dev.mysql.com/doc/refman/9.4/en/problems-with-float.html) includes explicit examples of SUM producing unexpected results with FLOAT types:

```sql
-- MySQL example from documentation
CREATE TABLE t1 (num FLOAT);
INSERT INTO t1 VALUES (50.12), (34.57), (12.75), (11.22), (51.28);

SELECT SUM(num) FROM t1;
-- Expected: 159.94
-- Actual:   159.94000005722
-- Error:    0.00000005722
```

In another [documented case](https://www.navicat.com/en/company/aboutus/blog/1768-floating-point-rounding-errors-in-mysql), a stacked bar chart showing percentage breakdowns consistently showed 98% or 99% instead of 100%, because floating-point rounding errors in the SUM prevented the percentages from adding up.

### 9.4 The Cosmos SDK Hash Incident (Blockchain)

**What happened**: The [Cosmos SDK blockchain framework](https://github.com/cosmos/cosmos-sdk/issues/10281) experienced an incident where a non-deterministic application hash caused nodes to become unable to make progress. An upgrade failed, persisting an incorrect AppHash that prevented consensus.

**Root cause**: The hash computation depended on iteration order over a map data structure in Go, which is intentionally randomized. Different nodes computed different hashes for the same state, breaking consensus.

**Relevance to data validation**: This illustrates the danger of hash-based validation when the hash computation is order-dependent but operates on unordered data structures. The same principle applies to SQL: if you hash rows from a GROUP BY without explicit ORDER BY, different execution plans can produce different hash orderings.

### 9.5 Python Hash Randomization Breaking Feature Flags

**What happened**: [FeatureHub](https://github.com/featurehub-io/featurehub/issues/1109) discovered that Python's hash randomization (introduced in Python 3.3 for security) caused feature flag evaluations to differ between server instances. One server would hash a user ID to bucket A, another to bucket B, because Python seeds its hash function with a random value at process startup.

**Root cause**: Python's `hash()` function is explicitly non-deterministic across processes (since Python 3.3). The feature flag system was using `hash()` instead of a deterministic hash like MD5 or SHA-256.

**Lesson for validation**: Never use language-level hash functions for data validation. Always use cryptographic or standardized hash functions (MD5, SHA-256) that produce identical output regardless of the process, runtime, or platform.

### 9.6 The Nondeterministic Hash (The Daily WTF)

[The Daily WTF](https://thedailywtf.com/articles/the-nondeterministic-hash) documented a case where a developer used .NET's `GetHashCode()` for data comparison. The function is explicitly documented as non-deterministic across .NET versions and application domains, but the developer used it to generate persistent keys. When the application was upgraded to a new .NET version, all the stored hash values became invalid.

### 9.7 Incidents Summary

| Incident | Root Cause | Impact | Prevention |
|----------|-----------|--------|------------|
| glibc 2.28 | Collation library update | Silent index corruption | Use C locale or ICU for validation |
| SQL Server float SUM | CPU architecture differences | 20% report discrepancies | Use DECIMAL for financial data |
| MySQL float SUM | IEEE 754 precision limits | Off-by-0.00000005722 | Use DECIMAL types |
| Cosmos SDK | Map iteration order | Blockchain consensus failure | Use deterministic hash ordering |
| FeatureHub | Python hash randomization | Inconsistent feature flags | Use cryptographic hash functions |
| .NET GetHashCode | Runtime version change | Invalid stored hashes | Use standardized hash algorithms |

---

## 10. References

### Academic Papers

1. Mueller, I. & Arteaga, A. (2018). "Reproducible Floating-Point Aggregation in RDBMSs." ETH Zurich. [arXiv:1802.09883](https://arxiv.org/abs/1802.09883)
2. Ahrens, W. (2015). "Efficient Reproducible Floating Point Summation and BLAS." UC Berkeley. [EECS-2015-229](https://www2.eecs.berkeley.edu/Pubs/TechRpts/2015/EECS-2015-229.pdf)
3. Collange, S., Defour, D., Graillat, S., & Iakymchuk, R. (2015). "Numerical reproducibility for the parallel reduction on multi- and many-core architectures." [ScienceDirect](https://www.sciencedirect.com/science/article/abs/pii/S0167819115001155)
4. Demmel, J. & Nguyen, H.D. (2020). "Algorithms for Efficient Reproducible Floating Point Summation." ACM TOMS. [DOI:10.1145/3389360](https://dl.acm.org/doi/10.1145/3389360)

### Database Documentation

5. PostgreSQL. "Non-deterministic behavior with floating point in parallel mode." [Mailing List](https://www.postgresql.org/message-id/CAFRJ5K0+ZZaUz0-ihX-aCj1h42H=s-CLWO+2Fb6nHCvXx19Diw@mail.gmail.com)
6. PostgreSQL. "Numeric Types." [Documentation](https://www.postgresql.org/docs/current/datatype-numeric.html)
7. PostgreSQL. "Date/Time Functions and Operators." [Documentation](https://www.postgresql.org/docs/current/functions-datetime.html)
8. PostgreSQL. "Transaction Isolation." [Documentation](https://www.postgresql.org/docs/current/transaction-iso.html)
9. Snowflake. "HASH Function." [Documentation](https://docs.snowflake.com/en/sql-reference/functions/hash)
10. Snowflake. "HASH_AGG Function." [Documentation](https://docs.snowflake.com/en/sql-reference/functions/hash_agg)
11. Snowflake. "SYSTEM$LAST_CHANGE_COMMIT_TIME." [Documentation](https://docs.snowflake.com/en/sql-reference/functions/system_last_change_commit_time)
12. Snowflake. "Understanding & Using Time Travel." [Documentation](https://docs.snowflake.com/en/user-guide/data-time-travel)
13. Snowflake. "ORDER BY." [Documentation](https://docs.snowflake.com/en/sql-reference/constructs/order-by)
14. BigQuery. "Hash Functions." [Documentation](https://cloud.google.com/bigquery/docs/reference/standard-sql/hash_functions)
15. BigQuery. "Access Historical Data." [Documentation](https://cloud.google.com/bigquery/docs/access-historical-data)
16. BigQuery. "Legacy Streaming API." [Documentation](https://cloud.google.com/bigquery/docs/streaming-data-into-bigquery)
17. DuckDB. "Non-Deterministic Behavior." [Documentation](https://duckdb.org/docs/stable/operations_manual/non-deterministic_behavior)
18. MySQL. "Problems with Floating-Point Values." [Documentation](https://dev.mysql.com/doc/refman/9.4/en/problems-with-float.html)
19. MySQL. "Faster CRC32-C computation in MySQL 8.0.27." [Blog](https://dev.mysql.com/blog-archive/faster-crc32-c-computation-in-mysql-8027/)
20. MariaDB. "CRC32C." [Documentation](https://mariadb.com/docs/server/reference/sql-functions/numeric-functions/crc32c)

### Blog Posts and Technical Articles

21. QuestDB. "Things we learned about sums." [Blog](https://questdb.com/blog/2020/05/12/interesting-things-we-learned-about-sums/)
22. Crunchy Data. "How to Correct and Identify Indexes Affected by the GNU C 2.28 Update." [Blog](https://www.crunchydata.com/blog/glibc-collations-and-data-corruption)
23. The Build. "The Doom That Came to PostgreSQL: When Collations Change." [Blog](https://thebuild.com/blog/2024/11/15/the-doom-that-came-to-postgresql-when-collations-change/)
24. AWS. "Manage collation changes in PostgreSQL on Amazon Aurora and Amazon RDS." [Blog](https://aws.amazon.com/blogs/database/manage-collation-changes-in-postgresql-on-amazon-aurora-and-amazon-rds/)
25. Bruce Dawson. "Intermediate Floating-Point Precision." [Random ASCII](https://randomascii.wordpress.com/2012/03/21/intermediate-floating-point-precision/)
26. Itzik Ben-Gan. "Row numbers with nondeterministic order." [SQLPerformance](https://sqlperformance.com/2019/11/t-sql-queries/row-numbers-with-nondeterministic-order)
27. Wikipedia. "Kahan summation algorithm." [Wikipedia](https://en.wikipedia.org/wiki/Kahan_summation_algorithm)
28. Wikipedia. "Extended precision." [Wikipedia](https://en.wikipedia.org/wiki/Extended_precision)
29. Wikipedia. "IEEE 754." [Wikipedia](https://en.wikipedia.org/wiki/IEEE_754)
30. CockroachDB. "Living without atomic clocks." [Blog](https://www.cockroachlabs.com/blog/living-without-atomic-clocks/)
31. Google Cloud. "Spanner: TrueTime and external consistency." [Documentation](https://cloud.google.com/spanner/docs/true-time-external-consistency)
32. EDB. "Unicode normalization in PostgreSQL 13." [Blog](https://www.enterprisedb.com/blog/unicode-normalization-postgresql-13)
33. InsideSQL. "Aggregate functions on floats may be non-deterministic." [Blog](https://www.insidesql.org/blogs/holgerschmeling/2010/11/02/did-you-know-aggregate-functions-on-floats-may-be-non-deterministic)
34. Infinite Lambda. "Data Validation After Refactoring in Snowflake." [Blog](https://infinitelambda.com/data-validation-refactoring-snowflake/)
35. Chen Hirsh. "SQL Windows Functions might be non-deterministic." [Blog](https://chenhirsh.com/sql-windows-functions-might-be-non-deterministic/)

### Incident Reports and Issue Trackers

36. Debian. "Glibc 2.28 breaks collation for PostgreSQL." [Mailing List](https://lists.debian.org/debian-glibc/2019/03/msg00030.html)
37. AWS. "compat-collation-for-glibc." [GitHub](https://github.com/awslabs/compat-collation-for-glibc)
38. Cosmos SDK. "Add rollback support in the event of an incorrect hash." [GitHub Issue #10281](https://github.com/cosmos/cosmos-sdk/issues/10281)
39. FeatureHub. "Non-deterministic hash seed." [GitHub Issue #1109](https://github.com/featurehub-io/featurehub/issues/1109)
40. The Daily WTF. "The Nondeterministic Hash." [Article](https://thedailywtf.com/articles/the-nondeterministic-hash)
41. PostgreSQL Wiki. "Locale data changes." [Wiki](https://wiki.postgresql.org/wiki/Locale_data_changes)
42. Snowflake Community. "SELECT query with LIMIT clause returns non-deterministic result." [Article](https://community.snowflake.com/s/article/SELECT-query-with-LIMIT-clause-returns-non-deterministic-result-if-ORDER-BY-clause-exists-in-different-level)
