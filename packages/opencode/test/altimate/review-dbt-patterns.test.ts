import { describe, test, expect } from "bun:test"
import {
  detectModelPatterns,
  detectSchemaYmlPatterns,
  DEFAULT_RUBRIC,
  type ChangedFile,
} from "../../src/altimate/review"

// Build a modified-model ChangedFile from a new-SQL body + a synthetic diff
// where the given lines are "added" (prefixed with +).
function modelFile(path: string, newSql: string, addedLines: string[], removedLines: string[] = []): ChangedFile {
  const diff = [...addedLines.map((l) => "+" + l), ...removedLines.map((l) => "-" + l)].join("\n")
  return { path, status: "modified", diff }
}

const has = (fs: any[], category: string, sev?: string) =>
  fs.some((f) => f.category === category && (!sev || f.severity === sev))

describe("dbt-patterns detectors", () => {
  test("LEFT JOIN → INNER via WHERE on the outer table → critical join_risk", () => {
    const sql = `select c.id, o.amount
from {{ ref('customers') }} c
left join {{ ref('orders') }} o on c.id = o.customer_id
where o.amount > 0`
    const f = detectModelPatterns(modelFile("models/marts/m.sql", sql, ["where o.amount > 0"]), sql, DEFAULT_RUBRIC)
    expect(has(f, "join_risk", "critical")).toBe(true)
  })

  test("IS NULL anti-join on outer table is NOT flagged (no false positive)", () => {
    const sql = `select c.id
from {{ ref('customers') }} c
left join {{ ref('orders') }} o on c.id = o.customer_id
where o.customer_id is null`
    const f = detectModelPatterns(
      modelFile("models/marts/m.sql", sql, ["where o.customer_id is null"]),
      sql,
      DEFAULT_RUBRIC,
    )
    expect(has(f, "join_risk")).toBe(false)
  })

  test("CROSS JOIN → critical join_risk", () => {
    const sql = `select * from a cross join b`
    const f = detectModelPatterns(
      modelFile("models/marts/m.sql", sql, ["cross join {{ ref('b') }} b"]),
      sql,
      DEFAULT_RUBRIC,
    )
    expect(has(f, "join_risk", "critical")).toBe(true)
  })

  test("incremental model with no is_incremental() guard → materialization warning", () => {
    const sql = `{{ config(materialized='incremental', unique_key='id') }}\nselect * from {{ ref('raw') }}`
    const f = detectModelPatterns(
      modelFile("models/marts/m.sql", sql, ["{{ config(materialized='incremental', unique_key='id') }}"]),
      sql,
      DEFAULT_RUBRIC,
    )
    expect(has(f, "materialization", "warning")).toBe(true)
  })

  test("incremental WITH is_incremental() guard → not flagged", () => {
    const sql = `{{ config(materialized='incremental', unique_key='id') }}\nselect * from {{ ref('raw') }}\n{% if is_incremental() %} where ts > (select max(ts) from {{ this }}) {% endif %}`
    const f = detectModelPatterns(
      modelFile("models/marts/m.sql", sql, ["{% if is_incremental() %}"]),
      sql,
      DEFAULT_RUBRIC,
    )
    expect(f.some((x) => x.title.includes("is_incremental"))).toBe(false)
  })

  test("current_timestamp() in transform → idempotency warning", () => {
    const sql = `select id, current_timestamp() as processed_at from {{ ref('x') }}`
    const f = detectModelPatterns(
      modelFile("models/staging/m.sql", sql, ["    , current_timestamp() as processed_at"]),
      sql,
      DEFAULT_RUBRIC,
    )
    expect(has(f, "idempotency", "warning")).toBe(true)
  })

  test("clock function on an audit column is NOT flagged", () => {
    const sql = `select id, current_timestamp() as _loaded_at from {{ ref('x') }}`
    const f = detectModelPatterns(
      modelFile("models/staging/m.sql", sql, ["    , current_timestamp() as _loaded_at"]),
      sql,
      DEFAULT_RUBRIC,
    )
    expect(has(f, "idempotency")).toBe(false)
  })

  test("NOT IN (subquery) → sql_correctness warning", () => {
    const sql = `select * from a where id not in (select id from b)`
    const f = detectModelPatterns(
      modelFile("models/marts/m.sql", sql, ["where id not in (select id from {{ ref('b') }})"]),
      sql,
      DEFAULT_RUBRIC,
    )
    expect(has(f, "sql_correctness", "warning")).toBe(true)
  })

  test("SELECT * added → warehouse_cost suggestion; passthrough select * from {{ ref }} is NOT flagged", () => {
    const flagged = detectModelPatterns(
      modelFile("models/marts/m.sql", "select *, 1 from x", ["    select *, 1 from x"]),
      "x",
      DEFAULT_RUBRIC,
    )
    expect(has(flagged, "warehouse_cost")).toBe(true)
    const passthrough = detectModelPatterns(
      modelFile("models/staging/m.sql", "select * from {{ ref('x') }}", ["select * from {{ ref('x') }}"]),
      "x",
      DEFAULT_RUBRIC,
    )
    expect(has(passthrough, "warehouse_cost")).toBe(false)
  })

  test("ROW_NUMBER() dedup without unique tiebreaker → dedup warning; with tiebreaker → clean", () => {
    const bad = `qualify row_number() over (partition by id order by updated_at desc) = 1`
    const f1 = detectModelPatterns(modelFile("models/staging/m.sql", bad, [bad]), bad, DEFAULT_RUBRIC)
    expect(has(f1, "dedup", "warning")).toBe(true)
    const good = `qualify row_number() over (partition by id order by updated_at desc, id asc) = 1`
    const f2 = detectModelPatterns(modelFile("models/staging/m.sql", good, [good]), good, DEFAULT_RUBRIC)
    expect(has(f2, "dedup")).toBe(false)
  })

  test("PII column added to a marts model → pii_exposure; ssn → critical", () => {
    const sql = `select o.id, c.ssn from o join c using (id)`
    const f = detectModelPatterns(modelFile("models/marts/m.sql", sql, ["        c.ssn,"]), sql, DEFAULT_RUBRIC)
    expect(has(f, "pii_exposure", "critical")).toBe(true)
    // same column in a staging model is not a mart-exposure finding
    const stg = detectModelPatterns(modelFile("models/staging/m.sql", sql, ["        c.ssn,"]), sql, DEFAULT_RUBRIC)
    expect(has(stg, "pii_exposure")).toBe(false)
  })

  test("partition-pruning-defeating function in WHERE → warehouse_cost suggestion", () => {
    const sql = `select * from x where extract(year from event_date) = 2024`
    const f = detectModelPatterns(
      modelFile("models/marts/m.sql", sql, ["where extract(year from event_date) = 2024"]),
      sql,
      DEFAULT_RUBRIC,
    )
    expect(has(f, "warehouse_cost")).toBe(true)
  })

  test("COUNT(distinct) → COUNT downgrade → sql_correctness warning", () => {
    const sql = `select count(order_id) from x`
    const f = detectModelPatterns(
      modelFile(
        "models/marts/m.sql",
        sql,
        ["    count(oi.order_id) as orders,"],
        ["    count(distinct oi.order_id) as orders,"],
      ),
      sql,
      DEFAULT_RUBRIC,
    )
    expect(has(f, "sql_correctness", "warning")).toBe(true)
  })

  test("fanout: new join into an aggregating model → fanout warning", () => {
    const sql = `select customer_id, sum(amount) from o left join {{ ref('items') }} i on i.oid = o.id group by 1`
    const f = detectModelPatterns(
      modelFile("models/marts/m.sql", sql, ["left join {{ ref('items') }} i on i.oid = o.id"]),
      sql,
      DEFAULT_RUBRIC,
    )
    expect(has(f, "fanout", "warning")).toBe(true)
  })

  test("schema.yml: removed unique/not_null test → test_coverage finding", () => {
    const f = detectSchemaYmlPatterns(
      { path: "models/marts/_models.yml", status: "modified", diff: "-          - unique\n-          - not_null" },
      DEFAULT_RUBRIC,
    )
    expect(has(f, "test_coverage")).toBe(true)
  })

  test("benign additive column produces NO dbt-pattern finding (precision)", () => {
    const sql = `select id, upper(status) as status_upper from {{ ref('x') }}`
    const f = detectModelPatterns(
      modelFile("models/staging/m.sql", sql, ["    upper(status) as status_upper,"]),
      sql,
      DEFAULT_RUBRIC,
    )
    expect(f.length).toBe(0)
  })
})

describe("dbt-patterns extended battery", () => {
  const M = "models/marts/m.sql"
  const fire = (newSql: string, added: string[], removed: string[] = []) =>
    detectModelPatterns(modelFile(M, newSql, added, removed), newSql, DEFAULT_RUBRIC)

  test("COALESCE removed → semantic_change", () =>
    expect(has(fire("select a from t", [], ["coalesce(a, 0) as a"]), "semantic_change")).toBe(true))
  test("SELECT DISTINCT added → semantic_change", () =>
    expect(has(fire("select distinct a from t", ["select distinct a from t"]), "semantic_change")).toBe(true))
  test("UNION ALL → UNION → warehouse_cost", () =>
    expect(has(fire("a union b", ["select 1 union select 2"], ["select 1 union all select 2"]), "warehouse_cost")).toBe(
      true,
    ))
  test("UNION → UNION ALL → sql_correctness", () =>
    expect(
      has(fire("a union all b", ["select 1 union all select 2"], ["select 1 union select 2"]), "sql_correctness"),
    ).toBe(true))
  test("GROUP BY change → semantic_change", () =>
    expect(has(fire("g", ["group by 1, 2"], ["group by 1"]), "semantic_change")).toBe(true))
  test("DML in model → critical sql_correctness", () =>
    expect(has(fire("delete from t", ["delete from t where 1=1"]), "sql_correctness", "critical")).toBe(true))
  test("LIMIT in model → sql_correctness", () => expect(has(fire("x", ["limit 100"]), "sql_correctness")).toBe(true))
  test("random() → idempotency", () => expect(has(fire("x", ["select rand() as r"]), "idempotency")).toBe(true))
  test("= NULL → sql_correctness", () => expect(has(fire("x", ["where a = null"]), "sql_correctness")).toBe(true))
  test("type narrowing → contract_violation", () =>
    expect(has(fire("x", ["cast(a as int64)"], ["cast(a as numeric)"]), "contract_violation")).toBe(true))
  test("full_refresh=true → materialization", () =>
    expect(has(fire("{{ config(full_refresh=true) }}", ["{{ config(full_refresh=true) }}"]), "materialization")).toBe(
      true,
    ))
  test("incremental no unique_key → dedup", () =>
    expect(
      has(
        fire("{{ config(materialized='incremental') }}\n{% if is_incremental() %}where 1=1{% endif %}", ["where 1=1"]),
        "dedup",
      ),
    ).toBe(true))
  test("max() subquery boundary → warehouse_cost", () =>
    expect(has(fire("x", ["where ts >= (select max(ts) from {{ this }})"]), "warehouse_cost")).toBe(true))
  test("ORDER BY no LIMIT → warehouse_cost", () =>
    expect(has(fire("select a from t order by 1", ["order by 1"]), "warehouse_cost")).toBe(true))
  test("leading-wildcard LIKE → warehouse_cost", () =>
    expect(has(fire("x", ["where name like '%x'"]), "warehouse_cost")).toBe(true))
  test("constant join ON 1=1 → join_risk", () => expect(has(fire("x", ["join t on 1=1"]), "join_risk")).toBe(true))
  test("hardcoded relation → sql_quality", () =>
    expect(has(fire("x", ["from analytics.prod.orders"]), "sql_quality")).toBe(true))
  test("var() no default → sql_quality", () =>
    expect(has(fire("x", ["where d > {{ var('cutoff') }}"]), "sql_quality")).toBe(true))
  test("hardcoded date literal → freshness", () =>
    expect(has(fire("x", ["where created_at >= '2024-01-01'"]), "freshness")).toBe(true))
  test("timestamp→date cast → sql_correctness", () =>
    expect(has(fire("x", ["cast(order_at as date)"]), "sql_correctness")).toBe(true))
  test("HAVING without GROUP BY → sql_correctness", () =>
    expect(has(fire("select a from t having count(*) > 1", ["having count(*) > 1"]), "sql_correctness")).toBe(true))
  test("CASE without ELSE → sql_correctness", () =>
    expect(has(fire("x", ["case when a > 0 then 1 end"]), "sql_correctness")).toBe(true))
  test("removed predicate → semantic_change", () =>
    expect(has(fire("select a from t", [], ["where status = 'active'"]), "semantic_change")).toBe(true))
  test("comma join → join_risk", () => expect(has(fire("x", ["from a, b"]), "join_risk")).toBe(true))
  test("NATURAL JOIN → join_risk", () => expect(has(fire("x", ["natural join t"]), "join_risk")).toBe(true))
  test("self-join (same ref twice) → join_risk", () =>
    expect(
      has(
        fire("from {{ ref('o') }} a join {{ ref('o') }} b on a.id=b.id", ["join {{ ref('o') }} b on a.id=b.id"]),
        "join_risk",
      ),
    ).toBe(true))
  test("window without PARTITION BY → sql_correctness", () =>
    expect(has(fire("x", ["sum(a) over (order by b) as r"]), "sql_correctness")).toBe(true))
  test("BETWEEN on timestamp → sql_correctness", () =>
    expect(has(fire("x", ["where created_at between '2024-01-01' and '2024-12-31'"]), "sql_correctness")).toBe(true))
  test("float equality → sql_correctness", () =>
    expect(has(fire("x", ["where price = 9.99"]), "sql_correctness")).toBe(true))
  test("division no guard → sql_correctness", () =>
    expect(has(fire("x", ["select a / b as r"]), "sql_correctness")).toBe(true))
  test("AND/OR no parens → sql_correctness", () =>
    expect(has(fire("x", ["where a = 1 and b = 2 or c = 3"]), "sql_correctness")).toBe(true))
  test("OFFSET no ORDER BY → sql_correctness", () =>
    expect(has(fire("select a from t offset 5", ["offset 5"]), "sql_correctness")).toBe(true))
  test("multiple COUNT(DISTINCT) → warehouse_cost", () =>
    expect(has(fire("x", ["count(distinct a), count(distinct b)"]), "warehouse_cost")).toBe(true))

  // precision: a benign additive change fires NONE of the new detectors
  test("benign additive column → 0 findings (precision)", () =>
    expect(
      fire("select id, upper(name) as name_upper from {{ ref('x') }}", ["    upper(name) as name_upper,"]).length,
    ).toBe(0))
  test("division by literal is NOT flagged", () =>
    expect(has(fire("x", ["select amount / 100 as dollars"]), "sql_correctness")).toBe(false))
  test("safe_divide is NOT flagged", () =>
    expect(has(fire("x", ["select safe_divide(a, b) as r"]), "sql_correctness")).toBe(false))
})
