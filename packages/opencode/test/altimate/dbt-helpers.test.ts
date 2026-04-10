/**
 * Unit tests for dbt helper functions: loadRawManifest, getUniqueId,
 * extractColumns, and listModelNames.
 *
 * These pure/cached functions are shared foundations used by dbtLineage(),
 * generateDbtUnitTests(), and parseManifest(). Zero tests existed.
 *
 * Risk: a bug in loadRawManifest's mtime cache silently serves stale
 * manifest data to every dbt tool (lineage, unit-test gen, manifest).
 * A bug in extractColumns produces wrong column types in generated YAML.
 * A bug in getUniqueId means model lookup fails silently.
 */

import { describe, test, expect, afterEach } from "bun:test"
import { writeFileSync, mkdtempSync, rmSync, symlinkSync, utimesSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import {
  loadRawManifest,
  getUniqueId,
  extractColumns,
  listModelNames,
} from "../../src/altimate/native/dbt/helpers"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmpDirs: string[] = []

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "dbt-helpers-test-"))
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
  tmpDirs = []
})

const NODES: Record<string, any> = {
  "model.proj.orders": {
    resource_type: "model",
    name: "orders",
  },
  "model.proj.users": {
    resource_type: "model",
    name: "users",
  },
  "test.proj.not_null": {
    resource_type: "test",
    name: "not_null",
  },
  "seed.proj.country_codes": {
    resource_type: "seed",
    name: "country_codes",
  },
}

// ---------------------------------------------------------------------------
// loadRawManifest
//
// NOTE: loadRawManifest uses a module-level cache keyed by (resolved path,
// mtime). Every test uses a unique file name within its own tmpdir to avoid
// cross-test cache contamination. Assertions use content equality (not object
// identity) unless the test is explicitly verifying cache behaviour.
// ---------------------------------------------------------------------------

describe("loadRawManifest", () => {
  test("returns null for non-existent file", () => {
    const result = loadRawManifest("/tmp/does-not-exist-manifest-" + Date.now() + ".json")
    expect(result).toBeNull()
  })

  test("parses valid JSON manifest and returns object", () => {
    const dir = makeTmpDir()
    const manifestPath = join(dir, "valid-manifest.json")
    const data = { metadata: { adapter_type: "snowflake" }, nodes: {} }
    writeFileSync(manifestPath, JSON.stringify(data))

    const result = loadRawManifest(manifestPath)
    expect(result).toEqual(data)
  })

  test("throws on invalid JSON", () => {
    const dir = makeTmpDir()
    const manifestPath = join(dir, "bad-json.json")
    writeFileSync(manifestPath, "not json {{{")

    expect(() => loadRawManifest(manifestPath)).toThrow()
  })

  test("does not throw for JSON array (typeof [] is 'object')", () => {
    // Note: the guard in loadRawManifest checks `typeof parsed !== "object"`.
    // In JavaScript, `typeof [] === "object"`, so arrays pass through.
    // This is a known edge case — a manifest that is a bare array is invalid
    // but the guard won't catch it. The callers handle this gracefully since
    // they access .nodes/.sources which will be undefined on an array.
    const dir = makeTmpDir()
    const manifestPath = join(dir, "array-manifest.json")
    writeFileSync(manifestPath, "[1, 2, 3]")

    const result = loadRawManifest(manifestPath)
    expect(Array.isArray(result)).toBe(true)
  })

  test("throws when manifest is a JSON primitive (string)", () => {
    const dir = makeTmpDir()
    const manifestPath = join(dir, "string-manifest.json")
    writeFileSync(manifestPath, '"just a string"')

    expect(() => loadRawManifest(manifestPath)).toThrow("Manifest is not a JSON object")
  })

  test("returns cached result when file unchanged (same ref)", () => {
    const dir = makeTmpDir()
    const manifestPath = join(dir, "cache-hit.json")
    const data = { metadata: {}, nodes: { a: 1 } }
    writeFileSync(manifestPath, JSON.stringify(data))

    const first = loadRawManifest(manifestPath)
    const second = loadRawManifest(manifestPath)
    // Same object reference means cache was used (same path + same mtime)
    expect(first).toBe(second)
  })

  test("re-reads file when content and mtime change", () => {
    const dir = makeTmpDir()
    const manifestPath = join(dir, "cache-miss.json")
    const data1 = { metadata: {}, nodes: { version: 1 } }
    writeFileSync(manifestPath, JSON.stringify(data1))

    const first = loadRawManifest(manifestPath)
    expect(first.nodes.version).toBe(1)

    // Write new content, then bump mtime to guarantee it differs from the
    // cached mtime (some filesystems have 1-second granularity).
    const data2 = { metadata: {}, nodes: { version: 2 } }
    writeFileSync(manifestPath, JSON.stringify(data2))
    const futureMs = Date.now() / 1000 + 5
    utimesSync(manifestPath, futureMs, futureMs)

    const second = loadRawManifest(manifestPath)
    expect(second.nodes.version).toBe(2)
  })

  test("resolves symlinks before caching", () => {
    const dir = makeTmpDir()
    const realPath = join(dir, "real-for-symlink.json")
    const symPath = join(dir, "link-for-symlink.json")
    const data = { metadata: {}, nodes: { sym: true } }
    writeFileSync(realPath, JSON.stringify(data))
    symlinkSync(realPath, symPath)

    const viaReal = loadRawManifest(realPath)
    const viaSym = loadRawManifest(symPath)
    // Both resolve to the same real path + same mtime → content must match
    expect(viaSym).toEqual(viaReal)
    expect(viaSym.nodes.sym).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// getUniqueId
// ---------------------------------------------------------------------------

describe("getUniqueId", () => {
  test("returns unique_id when passed a unique_id key directly", () => {
    expect(getUniqueId(NODES, "model.proj.orders")).toBe("model.proj.orders")
  })

  test("returns unique_id when passed a model name", () => {
    expect(getUniqueId(NODES, "orders")).toBe("model.proj.orders")
  })

  test("returns undefined for non-existent model", () => {
    expect(getUniqueId(NODES, "nonexistent")).toBeUndefined()
  })

  test("does not match test nodes by name", () => {
    expect(getUniqueId(NODES, "not_null")).toBeUndefined()
  })

  test("does not match seed nodes by name", () => {
    expect(getUniqueId(NODES, "country_codes")).toBeUndefined()
  })

  test("does not match by unique_id if resource_type is not model", () => {
    expect(getUniqueId(NODES, "test.proj.not_null")).toBeUndefined()
    expect(getUniqueId(NODES, "seed.proj.country_codes")).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// extractColumns
// ---------------------------------------------------------------------------

describe("extractColumns", () => {
  test("extracts columns with name and data_type", () => {
    const dict = {
      id: { name: "id", data_type: "INTEGER" },
      email: { name: "email", data_type: "VARCHAR" },
    }
    const result = extractColumns(dict)
    expect(result).toHaveLength(2)
    expect(result).toContainEqual({ name: "id", data_type: "INTEGER", description: undefined })
    expect(result).toContainEqual({ name: "email", data_type: "VARCHAR", description: undefined })
  })

  test("falls back to dict key when col.name is missing", () => {
    const dict = {
      user_id: { data_type: "BIGINT" },
    }
    const result = extractColumns(dict)
    expect(result[0].name).toBe("user_id")
    expect(result[0].data_type).toBe("BIGINT")
  })

  test("falls back to col.type when data_type is missing", () => {
    const dict = {
      amount: { name: "amount", type: "DECIMAL(10,2)" },
    }
    const result = extractColumns(dict)
    expect(result[0].data_type).toBe("DECIMAL(10,2)")
  })

  test("includes description when present", () => {
    const dict = {
      status: { name: "status", data_type: "VARCHAR", description: "Order status" },
    }
    const result = extractColumns(dict)
    expect(result[0].description).toBe("Order status")
  })

  test("returns empty array for empty dict", () => {
    expect(extractColumns({})).toEqual([])
  })

  test("handles both name and type fallbacks simultaneously", () => {
    const dict = {
      my_col: { type: "TEXT" },
    }
    const result = extractColumns(dict)
    expect(result[0].name).toBe("my_col")
    expect(result[0].data_type).toBe("TEXT")
    expect(result[0].description).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// listModelNames
// ---------------------------------------------------------------------------

describe("listModelNames", () => {
  test("returns only model names, not tests or seeds", () => {
    const result = listModelNames(NODES)
    expect(result).toContain("orders")
    expect(result).toContain("users")
    expect(result).not.toContain("not_null")
    expect(result).not.toContain("country_codes")
    expect(result).toHaveLength(2)
  })

  test("returns empty for nodes with no models", () => {
    const result = listModelNames({
      "test.proj.x": { resource_type: "test", name: "x" },
      "seed.proj.y": { resource_type: "seed", name: "y" },
    })
    expect(result).toEqual([])
  })

  test("returns empty for empty nodes", () => {
    expect(listModelNames({})).toEqual([])
  })
})
