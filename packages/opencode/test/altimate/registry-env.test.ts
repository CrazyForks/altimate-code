// altimate_change start — unit tests for ConnectionRegistry loadFromEnv code path
import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import * as Registry from "../../src/altimate/native/connections/registry"

// ---------------------------------------------------------------------------
// loadFromEnv — env-var based connection configuration
// ---------------------------------------------------------------------------
// These tests exercise the ALTIMATE_CODE_CONN_* env-var parsing in
// registry.ts → loadFromEnv(). CI/CD users rely on this to inject
// warehouse connections without config files on disk.
//
// NOTE: Registry.load() also reads from ~/.altimate-code/connections.json
// and .altimate-code/connections.json. The assertions below only check for
// specific keys set via env vars, so unrelated entries from disk do not
// interfere.
// ---------------------------------------------------------------------------

describe("ConnectionRegistry: loadFromEnv", () => {
  // Track env vars we set so we can clean them up
  const envVarsSet: string[] = []

  function setEnv(key: string, value: string) {
    process.env[key] = value
    envVarsSet.push(key)
  }

  beforeEach(() => {
    Registry.reset()
  })

  afterEach(() => {
    for (const key of envVarsSet) {
      delete process.env[key]
    }
    envVarsSet.length = 0
  })

  test("parses valid ALTIMATE_CODE_CONN_* env var and lowercases the name", () => {
    setEnv("ALTIMATE_CODE_CONN_MYDB", JSON.stringify({ type: "postgres", host: "localhost", port: 5432 }))
    Registry.load()

    const config = Registry.getConfig("mydb")
    expect(config).toBeDefined()
    expect(config?.type).toBe("postgres")
    expect(config?.host).toBe("localhost")
  })

  test("ignores malformed JSON in env var without crashing", () => {
    setEnv("ALTIMATE_CODE_CONN_BAD", "not-valid-json{{{")
    Registry.load()

    // The malformed env var should be silently skipped
    expect(Registry.getConfig("bad")).toBeUndefined()
  })

  test("ignores env var config objects missing the type field", () => {
    setEnv("ALTIMATE_CODE_CONN_NOTYPE", JSON.stringify({ host: "localhost", port: 5432 }))
    Registry.load()

    // Without a type field, the config should not be registered
    expect(Registry.getConfig("notype")).toBeUndefined()
  })

  test("ignores env vars with empty values", () => {
    setEnv("ALTIMATE_CODE_CONN_EMPTY", "")
    Registry.load()

    expect(Registry.getConfig("empty")).toBeUndefined()
  })

  test("parses multiple env var connections", () => {
    setEnv("ALTIMATE_CODE_CONN_PG", JSON.stringify({ type: "postgres", host: "pg.example.com" }))
    setEnv("ALTIMATE_CODE_CONN_SF", JSON.stringify({ type: "snowflake", account: "abc123" }))
    Registry.load()

    expect(Registry.getConfig("pg")?.type).toBe("postgres")
    expect(Registry.getConfig("sf")?.type).toBe("snowflake")
  })
})
// altimate_change end
