import { describe, test, expect, beforeEach } from "bun:test"
import { normalizeTag, expandTags, TAG_IMPLICATIONS } from "../../src/altimate/prompts/tags"
import { resolveTags } from "../../src/altimate/prompts/compose"
import { Fingerprint } from "../../src/altimate/fingerprint"
import { tmpdir } from "../fixture/fixture"

describe("normalizeTag", () => {
  test("normalizes postgresql to postgres", () => {
    expect(normalizeTag("postgresql")).toBe("postgres")
  })

  test("normalizes mongo to mongodb", () => {
    expect(normalizeTag("mongo")).toBe("mongodb")
  })

  test("normalizes mariadb to mysql", () => {
    expect(normalizeTag("mariadb")).toBe("mysql")
  })

  test("normalizes mssql to sqlserver", () => {
    expect(normalizeTag("mssql")).toBe("sqlserver")
  })

  test("passes through canonical tags unchanged", () => {
    expect(normalizeTag("postgres")).toBe("postgres")
    expect(normalizeTag("snowflake")).toBe("snowflake")
    expect(normalizeTag("mongodb")).toBe("mongodb")
    expect(normalizeTag("dbt")).toBe("dbt")
    expect(normalizeTag("sql")).toBe("sql")
    expect(normalizeTag("airflow")).toBe("airflow")
  })

  test("passes through unknown tags unchanged", () => {
    expect(normalizeTag("unknown")).toBe("unknown")
    expect(normalizeTag("custom-tag")).toBe("custom-tag")
  })
})

describe("expandTags", () => {
  test("dbt implies sql", () => {
    const result = expandTags(["dbt"])
    expect(result).toContain("dbt")
    expect(result).toContain("sql")
  })

  test("snowflake implies sql", () => {
    const result = expandTags(["snowflake"])
    expect(result).toContain("snowflake")
    expect(result).toContain("sql")
  })

  test("postgres implies sql", () => {
    const result = expandTags(["postgres"])
    expect(result).toContain("postgres")
    expect(result).toContain("sql")
  })

  test("bigquery implies sql", () => {
    const result = expandTags(["bigquery"])
    expect(result).toContain("bigquery")
    expect(result).toContain("sql")
  })

  test("mongodb does NOT imply sql", () => {
    const result = expandTags(["mongodb"])
    expect(result).toContain("mongodb")
    expect(result).not.toContain("sql")
  })

  test("multiple tags are expanded correctly", () => {
    const result = expandTags(["dbt", "snowflake"])
    expect(result).toContain("dbt")
    expect(result).toContain("snowflake")
    expect(result).toContain("sql")
    // sql should appear only once
    expect(result.filter((t) => t === "sql").length).toBe(1)
  })

  test("already-present sql is not duplicated", () => {
    const result = expandTags(["sql", "dbt"])
    expect(result.filter((t) => t === "sql").length).toBe(1)
  })

  test("empty tags returns empty", () => {
    expect(expandTags([])).toEqual([])
  })

  test("tags with no implications are preserved", () => {
    const result = expandTags(["airflow"])
    expect(result).toEqual(["airflow"])
  })

  test("mixed SQL and non-SQL databases", () => {
    const result = expandTags(["mongodb", "postgres"])
    expect(result).toContain("mongodb")
    expect(result).toContain("postgres")
    expect(result).toContain("sql")
  })
})

describe("TAG_IMPLICATIONS", () => {
  test("all SQL databases imply sql", () => {
    const sqlDatabases = ["snowflake", "bigquery", "postgres", "redshift", "mysql", "databricks", "duckdb", "sqlserver", "oracle", "sqlite"]
    for (const db of sqlDatabases) {
      expect(TAG_IMPLICATIONS[db]).toContain("sql")
    }
  })

  test("mongodb is not in implications", () => {
    expect(TAG_IMPLICATIONS["mongodb"]).toBeUndefined()
  })

  test("dbt implies sql", () => {
    expect(TAG_IMPLICATIONS["dbt"]).toContain("sql")
  })
})

describe("resolveTags", () => {
  beforeEach(() => {
    Fingerprint.reset()
  })

  test("uses config domains override when set", async () => {
    const cfg = { experimental: { domains: ["mongodb", "postgres"] } }
    const result = await resolveTags(cfg)
    expect(result).toContain("mongodb")
    expect(result).toContain("postgres")
    // postgres implies sql
    expect(result).toContain("sql")
    // mongodb does NOT imply sql
  })

  test("config domains are normalized", async () => {
    const cfg = { experimental: { domains: ["postgresql", "mongo"] } }
    const result = await resolveTags(cfg)
    expect(result).toContain("postgres")
    expect(result).toContain("mongodb")
  })

  test("returns expanded fingerprint tags when no config override", async () => {
    await using tmp = await tmpdir()
    await Fingerprint.detect(tmp.path)
    const cfg = { experimental: {} }
    const result = await resolveTags(cfg)
    // Empty dir — result should match expanded fingerprint tags (empty or env-derived)
    expect(result).toEqual(expandTags(Fingerprint.get()?.tags ?? []))
  })

  test("empty config domains array means no domains (not fallthrough)", async () => {
    await using tmp = await tmpdir()
    await Fingerprint.detect(tmp.path)
    const cfg = { experimental: { domains: [] as string[] } }
    const result = await resolveTags(cfg)
    // Explicit empty array = user wants no domain modules, returns empty tags
    expect(result).toEqual([])
  })
})

describe("resolveTags with fingerprint cache", () => {
  beforeEach(() => {
    Fingerprint.reset()
  })

  test("returns tags from fingerprint when no config override", async () => {
    await using tmp = await tmpdir()
    await Fingerprint.detect(tmp.path)
    const fp = Fingerprint.get()
    expect(fp).toBeDefined()
    const cfg = { experimental: {} }
    const result = await resolveTags(cfg)
    expect(result).toEqual(expandTags(fp?.tags ?? []))
  })

  test("config override takes precedence over fingerprint", async () => {
    await using tmp = await tmpdir()
    await Fingerprint.detect(tmp.path)
    const cfg = { experimental: { domains: ["mongodb"] } }
    const result = await resolveTags(cfg)
    expect(result).toContain("mongodb")
    expect(result).not.toContain("sql")
  })
})

describe("MQL classification via production classifier", () => {
  const { classify, classifyAndCheck } = require("../../src/altimate/tools/sql-classify")

  test("find command is classified as read", () => {
    expect(classify('{"command": "find", "collection": "users", "limit": 10}')).toBe("read")
  })

  test("aggregate command is classified as read", () => {
    expect(classify('{"command": "aggregate", "collection": "orders", "pipeline": []}')).toBe("read")
  })

  test("countDocuments command is classified as read", () => {
    expect(classify('{"command": "countDocuments", "collection": "events", "filter": {}}')).toBe("read")
  })

  test("deleteMany command is classified as write", () => {
    expect(classify('{"command": "deleteMany", "collection": "users", "filter": {}}')).toBe("write")
  })

  test("insertOne command is classified as write", () => {
    expect(classify('{"command": "insertOne", "collection": "users", "document": {}}')).toBe("write")
  })

  test("updateMany command is classified as write", () => {
    expect(classify('{"command": "updateMany", "collection": "users", "filter": {}, "update": {}}')).toBe("write")
  })

  test("dropCollection is classified as write and blocked", () => {
    const result = classifyAndCheck('{"command": "dropCollection", "collection": "users"}')
    expect(result.queryType).toBe("write")
    expect(result.blocked).toBe(true)
  })

  test("createIndex is classified as write but not blocked", () => {
    const result = classifyAndCheck('{"command": "createIndex", "collection": "users", "keys": {"name": 1}}')
    expect(result.queryType).toBe("write")
    expect(result.blocked).toBe(false)
  })

  test("SQL string falls through MQL check (does not start with {)", () => {
    // This will hit the SQL classifier path (may use fallback if altimate-core unavailable)
    const result = classify("SELECT * FROM users")
    expect(typeof result).toBe("string")
  })

  test("invalid JSON falls through MQL check", () => {
    const result = classify("{not valid json}")
    expect(typeof result).toBe("string")
  })

  test("unknown MQL command defaults to write (fail-safe)", () => {
    expect(classify('{"command": "findOneAndUpdate", "collection": "users"}')).toBe("write")
  })

  test("dropDatabase is blocked", () => {
    const result = classifyAndCheck('{"command": "dropDatabase"}')
    expect(result.queryType).toBe("write")
    expect(result.blocked).toBe(true)
  })

  test("aggregate with $out is classified as write", () => {
    expect(classify('{"command": "aggregate", "collection": "orders", "pipeline": [{"$match": {}}, {"$out": "results"}]}')).toBe("write")
  })

  test("aggregate with $merge is classified as write", () => {
    expect(classify('{"command": "aggregate", "collection": "orders", "pipeline": [{"$merge": {"into": "output"}}]}')).toBe("write")
  })

  test("aggregate without write stages is read", () => {
    expect(classify('{"command": "aggregate", "collection": "orders", "pipeline": [{"$match": {}}, {"$group": {"_id": "$x"}}]}')).toBe("read")
  })
})
