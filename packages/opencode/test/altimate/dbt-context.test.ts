// @ts-nocheck
import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import { DbtContext } from "../../src/altimate/context/dbt"
import fs from "fs"
import path from "path"
import os from "os"

let tmpDir: string

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dbt-context-test-"))
})

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function makeProject(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(tmpDir, "proj-"))
  for (const [relPath, content] of Object.entries(files)) {
    const full = path.join(dir, relPath)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content)
  }
  return dir
}

describe("DbtContext.collect", () => {
  test("returns undefined for non-dbt directory", async () => {
    const dir = makeProject({ "package.json": "{}" })
    const result = await DbtContext.collect(dir)
    expect(result).toBeUndefined()
  })

  test("extracts project name and profile", async () => {
    const dir = makeProject({
      "dbt_project.yml": "name: my_project\nprofile: my_profile\n",
    })
    const result = await DbtContext.collect(dir)
    expect(result).toContain("Project: my_project")
    expect(result).toContain("Profile: my_profile")
  })

  test("extracts adapter from profiles.yml", async () => {
    const dir = makeProject({
      "dbt_project.yml": "name: test\nprofile: test\n",
      "profiles.yml": "test:\n  target: dev\n  outputs:\n    dev:\n      type: duckdb\n",
    })
    const result = await DbtContext.collect(dir)
    expect(result).toContain("Adapter: duckdb")
    expect(result).toContain("--profiles-dir .")
  })

  test("omits adapter when no profiles.yml", async () => {
    const dir = makeProject({
      "dbt_project.yml": "name: test\n",
    })
    const result = await DbtContext.collect(dir)
    expect(result).not.toContain("Adapter:")
    expect(result).not.toContain("--profiles-dir")
  })

  test("includes altimate_core_parse_dbt instruction", async () => {
    const dir = makeProject({
      "dbt_project.yml": "name: test\n",
    })
    const result = await DbtContext.collect(dir)
    expect(result).toContain("altimate_core_parse_dbt")
    expect(result).toContain(dir)
  })

  test("includes run command", async () => {
    const dir = makeProject({
      "dbt_project.yml": "name: test\n",
      "profiles.yml": "test:\n  target: dev\n  outputs:\n    dev:\n      type: duckdb\n",
    })
    const result = await DbtContext.collect(dir)
    expect(result).toContain("dbt run --profiles-dir . --project-dir .")
  })

  test("caches result for same cwd", async () => {
    const dir = makeProject({
      "dbt_project.yml": "name: cached_test\n",
    })
    const r1 = await DbtContext.collect(dir)
    fs.writeFileSync(path.join(dir, "dbt_project.yml"), "name: changed\n")
    const r2 = await DbtContext.collect(dir)
    expect(r2).toBe(r1)
  })
})
