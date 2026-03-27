// altimate_change start — unit tests for connection registry pure functions
import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import {
  detectAuthMethod,
  categorizeConnectionError,
  reset,
  load,
  getConfig,
  list,
  setConfigs,
} from "../../src/altimate/native/connections/registry"

// ---------------------------------------------------------------------------
// 1. detectAuthMethod — MongoDB paths (added in #482, zero coverage)
// ---------------------------------------------------------------------------

describe("detectAuthMethod: MongoDB", () => {
  test('returns "password" when mongodb config has a password', () => {
    // Note: this actually hits the generic `config.password` check (line 226)
    // before the MongoDB-specific branch, but the behavior is still correct
    // and worth pinning.
    expect(detectAuthMethod({ type: "mongodb", password: "secret" })).toBe("password")
  })

  test('returns "connection_string" when mongodb config has no password', () => {
    // This is the MongoDB-specific branch at line 229 of registry.ts
    expect(detectAuthMethod({ type: "mongodb" })).toBe("connection_string")
  })

  test('returns "connection_string" when mongo (alias) has no password', () => {
    expect(detectAuthMethod({ type: "mongo" })).toBe("connection_string")
  })

  test('returns "password" when mongo (alias) has a password', () => {
    expect(detectAuthMethod({ type: "mongo", password: "secret" })).toBe("password")
  })

  test('returns "connection_string" when mongodb has connection_string field', () => {
    // connection_string check (line 216) fires BEFORE the type check,
    // so this should return "connection_string" — verify the priority is correct
    expect(detectAuthMethod({ type: "mongodb", connection_string: "mongodb://localhost" })).toBe("connection_string")
  })

  test('returns "token" when mongodb has access_token', () => {
    // Token check fires before MongoDB type check
    expect(detectAuthMethod({ type: "mongodb", access_token: "tok" })).toBe("token")
  })
})

// ---------------------------------------------------------------------------
// 2. loadFromEnv via public API (reset + load + getConfig)
// ---------------------------------------------------------------------------

describe("loadFromEnv via public API", () => {
  const envVars: string[] = []

  function setEnv(key: string, value: string) {
    process.env[key] = value
    envVars.push(key)
  }

  beforeEach(() => {
    reset()
  })

  afterEach(() => {
    for (const key of envVars) {
      delete process.env[key]
    }
    envVars.length = 0
    reset()
  })

  test("parses valid ALTIMATE_CODE_CONN_* env var into a connection config", () => {
    setEnv("ALTIMATE_CODE_CONN_MYDB", JSON.stringify({ type: "postgres", host: "localhost", port: 5432 }))
    load()
    const config = getConfig("mydb")
    expect(config).toBeDefined()
    expect(config!.type).toBe("postgres")
    expect(config!.host).toBe("localhost")
  })

  test("lowercases the connection name from env var suffix", () => {
    setEnv("ALTIMATE_CODE_CONN_MYUPPERDB", JSON.stringify({ type: "postgres" }))
    load()
    // The name should be lowercased
    expect(getConfig("myupperdb")).toBeDefined()
    // Original case should not exist as a separate entry
    expect(getConfig("MYUPPERDB")).toBeUndefined()
  })

  test("ignores env var with malformed JSON", () => {
    setEnv("ALTIMATE_CODE_CONN_BAD", "not valid json {{{")
    load()
    expect(getConfig("bad")).toBeUndefined()
  })

  test("ignores env var with missing type field", () => {
    setEnv("ALTIMATE_CODE_CONN_NOTYPE", JSON.stringify({ host: "localhost" }))
    load()
    expect(getConfig("notype")).toBeUndefined()
  })

  test("ignores env var with null JSON value", () => {
    setEnv("ALTIMATE_CODE_CONN_NULLVAL", "null")
    load()
    expect(getConfig("nullval")).toBeUndefined()
  })

  test("ignores env var with empty string value", () => {
    // Empty string is falsy, so the `if (!value) continue` guard should skip it
    process.env["ALTIMATE_CODE_CONN_EMPTY"] = ""
    envVars.push("ALTIMATE_CODE_CONN_EMPTY")
    load()
    expect(getConfig("empty")).toBeUndefined()
  })

  test("env vars are included in list() output", () => {
    setEnv("ALTIMATE_CODE_CONN_ENVDB", JSON.stringify({ type: "duckdb", database: "test.db" }))
    load()
    const { warehouses } = list()
    const found = warehouses.find((w) => w.name === "envdb")
    expect(found).toBeDefined()
    expect(found!.type).toBe("duckdb")
  })
})

// ---------------------------------------------------------------------------
// 3. setConfigs + list round-trip (public API sanity)
// ---------------------------------------------------------------------------

describe("setConfigs and list", () => {
  beforeEach(() => {
    reset()
  })

  afterEach(() => {
    reset()
  })

  test("setConfigs populates configs readable via getConfig", () => {
    setConfigs({
      prod: { type: "postgres", host: "prod.example.com" },
      staging: { type: "snowflake", account: "acme" },
    })
    expect(getConfig("prod")).toBeDefined()
    expect(getConfig("prod")!.type).toBe("postgres")
    expect(getConfig("staging")).toBeDefined()
    expect(getConfig("staging")!.type).toBe("snowflake")
  })

  test("list returns all configured warehouses", () => {
    setConfigs({
      a: { type: "postgres" },
      b: { type: "mongodb", database: "mydb" },
    })
    const { warehouses } = list()
    expect(warehouses).toHaveLength(2)
    const names = warehouses.map((w) => w.name).sort()
    expect(names).toEqual(["a", "b"])
  })

  test("setConfigs clears previous configs", () => {
    setConfigs({ old: { type: "postgres" } })
    setConfigs({ new: { type: "duckdb" } })
    expect(getConfig("old")).toBeUndefined()
    expect(getConfig("new")).toBeDefined()
  })
})
// altimate_change end
