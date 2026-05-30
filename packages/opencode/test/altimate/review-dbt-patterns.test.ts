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
