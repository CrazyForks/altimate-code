import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { promises as fs } from "fs"
import { join } from "path"
import { tmpdir as osTmpdir } from "os"
import {
  extractLastJsonObject,
  modelNameFromPath,
  findDbtProjectRoot,
  modelsModifiedSince,
} from "../../../src/altimate/validators/validator-utils"

// ---------------------------------------------------------------------------
// extractLastJsonObject
// ---------------------------------------------------------------------------

describe("extractLastJsonObject", () => {
  test("returns null for empty string", () => {
    expect(extractLastJsonObject("")).toBeNull()
  })

  test("returns null for string with no JSON", () => {
    expect(extractLastJsonObject("no json here at all")).toBeNull()
  })

  test("returns null for JSON without any known envelope key", () => {
    // Stray dbt config fragment — should be rejected
    expect(extractLastJsonObject('{"config": "value", "random": 42}')).toBeNull()
  })

  test("fast-path: pure JSON stdout with stdout key", () => {
    const input = JSON.stringify({ stdout: "dbt output here" })
    const result = extractLastJsonObject(input)
    expect(result).not.toBeNull()
    expect(result!["stdout"]).toBe("dbt output here")
  })

  test("fast-path: pure JSON stdout with error key", () => {
    const input = JSON.stringify({ error: "something went wrong" })
    const result = extractLastJsonObject(input)
    expect(result).not.toBeNull()
    expect(result!["error"]).toBe("something went wrong")
  })

  test("fast-path: pure JSON stdout with verdict key", () => {
    const input = JSON.stringify({ verdict: "match", model: "my_model" })
    const result = extractLastJsonObject(input)
    expect(result).not.toBeNull()
    expect(result!["verdict"]).toBe("match")
  })

  test("extracts JSON object from noisy ANSI-prefixed stdout", () => {
    const ansiNoise = "\x1b[32m[dbt]\x1b[0m Running dbt test...\n"
    const json = JSON.stringify({ stdout: "Done. PASS=3 WARN=0 ERROR=0 SKIP=0 TOTAL=3" })
    const result = extractLastJsonObject(ansiNoise + json)
    expect(result).not.toBeNull()
    expect(result!["stdout"]).toContain("Done.")
  })

  test("returns LAST valid envelope when multiple JSON objects present", () => {
    // First object looks like a config snippet (no envelope key) — should be skipped
    // Second is the real verdict
    const first = '{"level": "info", "msg": "Starting"}'
    const second = JSON.stringify({ verdict: "mismatch", model: "orders" })
    const result = extractLastJsonObject(first + "\n" + second)
    expect(result).not.toBeNull()
    expect(result!["verdict"]).toBe("mismatch")
  })

  test("returns the valid envelope even when followed by trailing log noise", () => {
    const json = JSON.stringify({ error: "project not found" })
    const trailing = "\nsome log line after\n"
    const result = extractLastJsonObject(json + trailing)
    expect(result).not.toBeNull()
    expect(result!["error"]).toBe("project not found")
  })

  test("handles JSON with nested braces in string values", () => {
    const input = JSON.stringify({ stdout: 'nested {"inner": true} string', model: "test" })
    const result = extractLastJsonObject(input)
    expect(result).not.toBeNull()
    expect(result!["model"]).toBe("test")
  })

  test("handles JSON with escaped backslashes in strings", () => {
    const input = JSON.stringify({ error: "path C:\\Users\\foo", model: "bar" })
    const result = extractLastJsonObject(input)
    expect(result).not.toBeNull()
    expect(result!["model"]).toBe("bar")
  })

  test("handles columns_extra key as valid envelope", () => {
    const input = JSON.stringify({ columns_extra: ["col_a"], model: "my_model" })
    const result = extractLastJsonObject(input)
    expect(result).not.toBeNull()
    expect((result!["columns_extra"] as string[])[0]).toBe("col_a")
  })

  test("handles columns_missing key as valid envelope", () => {
    const input = JSON.stringify({ columns_missing: ["col_b"], model: "my_model" })
    const result = extractLastJsonObject(input)
    expect(result).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// modelNameFromPath
// ---------------------------------------------------------------------------

describe("modelNameFromPath", () => {
  test("extracts model name from simple path", () => {
    expect(modelNameFromPath("models/marts/foo.sql")).toBe("foo")
  })

  test("extracts model name from deep nested path", () => {
    expect(modelNameFromPath("/project/dbt/models/staging/stg_orders.sql")).toBe("stg_orders")
  })

  test("strips .sql case-insensitively", () => {
    expect(modelNameFromPath("models/foo.SQL")).toBe("foo")
  })

  test("returns basename for path with no slashes", () => {
    expect(modelNameFromPath("my_model.sql")).toBe("my_model")
  })
})

// ---------------------------------------------------------------------------
// findDbtProjectRoot
// ---------------------------------------------------------------------------

describe("findDbtProjectRoot", () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(join(osTmpdir(), "validator-test-"))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  test("returns cwd when dbt_project.yml is directly present", async () => {
    await fs.writeFile(join(tmpDir, "dbt_project.yml"), "name: test_project\n")
    const result = await findDbtProjectRoot(tmpDir)
    expect(result).toBe(tmpDir)
  })

  test("returns nested dir when dbt_project.yml is one level down", async () => {
    const nested = join(tmpDir, "my_dbt")
    await fs.mkdir(nested)
    await fs.writeFile(join(nested, "dbt_project.yml"), "name: test_project\n")
    const result = await findDbtProjectRoot(tmpDir)
    expect(result).toBe(nested)
  })

  test("returns null when no dbt_project.yml exists", async () => {
    const result = await findDbtProjectRoot(tmpDir)
    expect(result).toBeNull()
  })

  test("returns null for a non-existent directory", async () => {
    const result = await findDbtProjectRoot("/tmp/definitely-does-not-exist-xyzabc")
    expect(result).toBeNull()
  })

  test("prefers direct dbt_project.yml over nested one", async () => {
    await fs.writeFile(join(tmpDir, "dbt_project.yml"), "name: root_project\n")
    const nested = join(tmpDir, "sub")
    await fs.mkdir(nested)
    await fs.writeFile(join(nested, "dbt_project.yml"), "name: nested_project\n")
    const result = await findDbtProjectRoot(tmpDir)
    expect(result).toBe(tmpDir)
  })
})

// ---------------------------------------------------------------------------
// modelsModifiedSince
// ---------------------------------------------------------------------------

describe("modelsModifiedSince", () => {
  let tmpDir: string
  const FAR_PAST_MS = new Date("2000-01-01").getTime()
  const FAR_FUTURE_MS = Date.now() + 1_000_000

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(join(osTmpdir(), "models-test-"))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  test("returns empty array when no models directory exists", async () => {
    const result = await modelsModifiedSince(tmpDir, FAR_PAST_MS)
    expect(result).toEqual([])
  })

  test("returns SQL files under models/ ancestor modified since sinceMs", async () => {
    const modelsDir = join(tmpDir, "models", "marts")
    await fs.mkdir(modelsDir, { recursive: true })
    const sqlFile = join(modelsDir, "orders.sql")
    await fs.writeFile(sqlFile, "SELECT 1")
    const result = await modelsModifiedSince(tmpDir, FAR_PAST_MS)
    expect(result.length).toBe(1)
    expect(result[0]).toContain("orders.sql")
  })

  test("excludes SQL files outside of models/ directory", async () => {
    // File in analyses/ — not a model
    const analysesDir = join(tmpDir, "analyses")
    await fs.mkdir(analysesDir)
    await fs.writeFile(join(analysesDir, "ad_hoc.sql"), "SELECT 1")
    const result = await modelsModifiedSince(tmpDir, FAR_PAST_MS)
    expect(result).toEqual([])
  })

  test("excludes files not modified since sinceMs", async () => {
    const modelsDir = join(tmpDir, "models")
    await fs.mkdir(modelsDir)
    const sqlFile = join(modelsDir, "old_model.sql")
    await fs.writeFile(sqlFile, "SELECT 1")
    // Use a future sinceMs so the file is "too old"
    const result = await modelsModifiedSince(tmpDir, FAR_FUTURE_MS)
    expect(result).toEqual([])
  })

  test("skips node_modules and target directories", async () => {
    const nodeModels = join(tmpDir, "node_modules", "models")
    await fs.mkdir(nodeModels, { recursive: true })
    await fs.writeFile(join(nodeModels, "bad.sql"), "SELECT 1")
    const targetModels = join(tmpDir, "target", "models")
    await fs.mkdir(targetModels, { recursive: true })
    await fs.writeFile(join(targetModels, "bad2.sql"), "SELECT 1")
    const result = await modelsModifiedSince(tmpDir, FAR_PAST_MS)
    expect(result).toEqual([])
  })

  test("skips hidden directories", async () => {
    const hiddenDir = join(tmpDir, ".hidden", "models")
    await fs.mkdir(hiddenDir, { recursive: true })
    await fs.writeFile(join(hiddenDir, "secret.sql"), "SELECT 1")
    const result = await modelsModifiedSince(tmpDir, FAR_PAST_MS)
    expect(result).toEqual([])
  })

  test("returns multiple model files from nested directories", async () => {
    const staging = join(tmpDir, "models", "staging")
    const marts = join(tmpDir, "models", "marts")
    await fs.mkdir(staging, { recursive: true })
    await fs.mkdir(marts, { recursive: true })
    await fs.writeFile(join(staging, "stg_orders.sql"), "SELECT 1")
    await fs.writeFile(join(marts, "fct_orders.sql"), "SELECT 1")
    const result = await modelsModifiedSince(tmpDir, FAR_PAST_MS)
    expect(result.length).toBe(2)
    const names = result.map((p) => p.split("/").pop())
    expect(names).toContain("stg_orders.sql")
    expect(names).toContain("fct_orders.sql")
  })
})
