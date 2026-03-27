import { describe, test, expect } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import { FileIgnore } from "../../src/file/ignore"

/**
 * E2E tests for file watcher ignore patterns.
 *
 * These tests verify that the watcher's ignore list correctly excludes
 * dbt dependency directories (dbt_packages, dbt_modules) which can contain
 * thousands of files and exhaust macOS file descriptor limits (EMFILE).
 *
 * See: https://github.com/AltimateAI/altimate-code/issues/500
 */

describe("watcher ignore: dbt directories", () => {
  test("dbt_packages is in FileIgnore.PATTERNS passed to the watcher", () => {
    expect(FileIgnore.PATTERNS).toContain("dbt_packages")
  })

  test("dbt_modules is in FileIgnore.PATTERNS passed to the watcher", () => {
    expect(FileIgnore.PATTERNS).toContain("dbt_modules")
  })

  test("FileIgnore.match ignores files inside dbt_packages at any depth", () => {
    // Root level
    expect(FileIgnore.match("dbt_packages")).toBe(true)
    expect(FileIgnore.match("dbt_packages/")).toBe(true)

    // Typical dbt package structure: macros, models, etc.
    expect(FileIgnore.match("dbt_packages/dbt_utils/macros/sql/generate_series.sql")).toBe(true)
    expect(FileIgnore.match("dbt_packages/dbt_utils/macros/sql/get_column_values.sql")).toBe(true)
    expect(FileIgnore.match("dbt_packages/dbt_expectations/macros/schema_tests/expect_column_values_to_be_unique.sql")).toBe(true)
    expect(FileIgnore.match("dbt_packages/codegen/macros/generate_source.sql")).toBe(true)

    // Deeply nested
    expect(FileIgnore.match("dbt_packages/pkg/a/b/c/d/e/model.sql")).toBe(true)
  })

  test("FileIgnore.match ignores files inside dbt_modules at any depth", () => {
    expect(FileIgnore.match("dbt_modules")).toBe(true)
    expect(FileIgnore.match("dbt_modules/")).toBe(true)
    expect(FileIgnore.match("dbt_modules/dbt_utils/macros/sql/generate_series.sql")).toBe(true)
    expect(FileIgnore.match("dbt_modules/pkg/a/b/c/model.sql")).toBe(true)
  })

  test("FileIgnore.match ignores dbt directories nested under project paths", () => {
    expect(FileIgnore.match("my_dbt_project/dbt_packages/dbt_utils/macros/union.sql")).toBe(true)
    expect(FileIgnore.match("projects/analytics/dbt_packages/pkg/model.sql")).toBe(true)
    expect(FileIgnore.match("src/dbt_modules/old_pkg/macros/macro.sql")).toBe(true)
  })

  test("FileIgnore.match does not false-positive on files containing dbt_packages in name", () => {
    // Files that have "dbt_packages" as part of their filename should NOT match
    expect(FileIgnore.match("install_dbt_packages.sh")).toBe(false)
    expect(FileIgnore.match("docs/about_dbt_packages.md")).toBe(false)
    expect(FileIgnore.match("scripts/setup_dbt_packages.py")).toBe(false)
    expect(FileIgnore.match("dbt_packages_list.txt")).toBe(false)
  })

  test("FileIgnore.match does not false-positive on files containing dbt_modules in name", () => {
    expect(FileIgnore.match("install_dbt_modules.sh")).toBe(false)
    expect(FileIgnore.match("dbt_modules_config.yml")).toBe(false)
  })

  test("whitelist can override dbt_packages ignore", () => {
    expect(
      FileIgnore.match("dbt_packages/custom_pkg/model.sql", {
        whitelist: ["dbt_packages/**"],
      }),
    ).toBe(false)
  })
})

describe("watcher ignore: dbt project simulation", () => {
  test("watcher ignore list covers a realistic dbt project structure", async () => {
    await using tmp = await tmpdir()

    // Simulate a dbt project directory structure
    const dirs = [
      "models/staging",
      "models/marts",
      "macros",
      "seeds",
      "tests",
      "snapshots",
      "analyses",
      // dbt dependencies - these should be ignored
      "dbt_packages/dbt_utils/macros/sql",
      "dbt_packages/dbt_utils/macros/cross_db_utils",
      "dbt_packages/dbt_expectations/macros/schema_tests",
      "dbt_packages/codegen/macros",
      "dbt_packages/audit_helper/macros",
      "dbt_modules/legacy_pkg/macros",
      // Other dirs that should be ignored
      "target/compiled/my_project/models",
      "target/run/my_project/models",
      "logs",
      "node_modules/.cache",
    ]

    for (const dir of dirs) {
      await fs.mkdir(path.join(tmp.path, dir), { recursive: true })
    }

    // Create files in each directory
    const files = [
      // User files - should NOT be ignored
      "dbt_project.yml",
      "packages.yml",
      "models/staging/stg_orders.sql",
      "models/marts/dim_customers.sql",
      "macros/generate_schema_name.sql",
      "seeds/country_codes.csv",
      // dbt_packages files - SHOULD be ignored
      "dbt_packages/dbt_utils/macros/sql/generate_series.sql",
      "dbt_packages/dbt_utils/macros/sql/get_column_values.sql",
      "dbt_packages/dbt_utils/macros/sql/pivot.sql",
      "dbt_packages/dbt_utils/macros/sql/union.sql",
      "dbt_packages/dbt_utils/macros/sql/star.sql",
      "dbt_packages/dbt_utils/macros/cross_db_utils/dateadd.sql",
      "dbt_packages/dbt_expectations/macros/schema_tests/expect_column_values_to_be_unique.sql",
      "dbt_packages/codegen/macros/generate_source.sql",
      "dbt_packages/audit_helper/macros/compare_relations.sql",
      // dbt_modules files - SHOULD be ignored
      "dbt_modules/legacy_pkg/macros/old_macro.sql",
      // target files - SHOULD be ignored
      "target/compiled/my_project/models/stg_orders.sql",
      "target/run/my_project/models/stg_orders.sql",
    ]

    for (const file of files) {
      await fs.writeFile(path.join(tmp.path, file), `-- ${file}`)
    }

    // Verify user project files are NOT ignored
    const userFiles = [
      "dbt_project.yml",
      "packages.yml",
      "models/staging/stg_orders.sql",
      "models/marts/dim_customers.sql",
      "macros/generate_schema_name.sql",
      "seeds/country_codes.csv",
    ]
    for (const file of userFiles) {
      expect(FileIgnore.match(file)).toBe(false)
    }

    // Verify dbt_packages files ARE ignored
    const dbtPackageFiles = [
      "dbt_packages/dbt_utils/macros/sql/generate_series.sql",
      "dbt_packages/dbt_utils/macros/sql/get_column_values.sql",
      "dbt_packages/dbt_utils/macros/sql/pivot.sql",
      "dbt_packages/dbt_utils/macros/sql/union.sql",
      "dbt_packages/dbt_utils/macros/sql/star.sql",
      "dbt_packages/dbt_utils/macros/cross_db_utils/dateadd.sql",
      "dbt_packages/dbt_expectations/macros/schema_tests/expect_column_values_to_be_unique.sql",
      "dbt_packages/codegen/macros/generate_source.sql",
      "dbt_packages/audit_helper/macros/compare_relations.sql",
    ]
    for (const file of dbtPackageFiles) {
      expect(FileIgnore.match(file)).toBe(true)
    }

    // Verify dbt_modules files ARE ignored
    expect(FileIgnore.match("dbt_modules/legacy_pkg/macros/old_macro.sql")).toBe(true)

    // Verify target files ARE ignored
    expect(FileIgnore.match("target/compiled/my_project/models/stg_orders.sql")).toBe(true)
    expect(FileIgnore.match("target/run/my_project/models/stg_orders.sql")).toBe(true)
  })

  test("PATTERNS array has sufficient coverage for dbt ecosystem", () => {
    // All dbt dependency directories should be in PATTERNS
    expect(FileIgnore.PATTERNS).toContain("dbt_packages")
    expect(FileIgnore.PATTERNS).toContain("dbt_modules")

    // target/ (build artifacts) should also be covered
    expect(FileIgnore.PATTERNS).toContain("target")

    // logs/ should be covered by glob pattern
    expect(FileIgnore.match("logs/dbt.log")).toBe(true)
  })
})

describe("watcher ignore: file descriptor exhaustion prevention", () => {
  test("simulated large dbt_packages tree is fully ignored", async () => {
    // Simulate the scenario from issue #500: 443+ macro files
    // Verify that ALL paths within dbt_packages would be ignored by the watcher
    const packages = ["dbt_utils", "dbt_expectations", "codegen", "audit_helper", "dbt_date", "dbt_profiler"]
    const subdirs = ["macros/sql", "macros/cross_db", "macros/schema_tests", "models", "tests"]

    let totalFiles = 0
    let ignoredFiles = 0

    for (const pkg of packages) {
      for (const sub of subdirs) {
        for (let i = 0; i < 15; i++) {
          const filePath = `dbt_packages/${pkg}/${sub}/file_${i}.sql`
          totalFiles++
          if (FileIgnore.match(filePath)) {
            ignoredFiles++
          }
        }
      }
    }

    // All 450 files (6 packages * 5 subdirs * 15 files) should be ignored
    expect(totalFiles).toBe(450)
    expect(ignoredFiles).toBe(totalFiles)
  })

  test("watcher ignore list covers common dbt dependency structures", () => {
    // Real-world dbt package paths that caused EMFILE
    const realWorldPaths = [
      "dbt_packages/dbt_utils/macros/sql/generate_series.sql",
      "dbt_packages/dbt_utils/macros/sql/get_column_values.sql",
      "dbt_packages/dbt_utils/macros/sql/pivot.sql",
      "dbt_packages/dbt_utils/macros/sql/union.sql",
      "dbt_packages/dbt_utils/macros/sql/star.sql",
      "dbt_packages/dbt_utils/macros/sql/deduplicate.sql",
      "dbt_packages/dbt_utils/macros/sql/safe_subtract.sql",
      "dbt_packages/dbt_utils/macros/sql/unpivot.sql",
      "dbt_packages/dbt_utils/macros/cross_db_utils/dateadd.sql",
      "dbt_packages/dbt_utils/macros/cross_db_utils/datediff.sql",
      "dbt_packages/dbt_utils/macros/cross_db_utils/hash.sql",
      "dbt_packages/dbt_utils/macros/cross_db_utils/split_part.sql",
      "dbt_packages/dbt_utils/macros/web/get_url_parameter.sql",
      "dbt_packages/dbt_utils/macros/generic_tests/at_least_one.sql",
      "dbt_packages/dbt_utils/macros/generic_tests/not_constant.sql",
      "dbt_packages/dbt_utils/macros/generic_tests/recency.sql",
      "dbt_packages/dbt_utils/macros/materializations/insert_by_period.sql",
      "dbt_packages/dbt_expectations/macros/schema_tests/expect_column_values_to_be_unique.sql",
      "dbt_packages/dbt_expectations/macros/schema_tests/expect_column_to_exist.sql",
      "dbt_packages/dbt_expectations/macros/schema_tests/expect_table_row_count_to_equal.sql",
      "dbt_packages/codegen/macros/generate_source.sql",
      "dbt_packages/codegen/macros/generate_model_yaml.sql",
      "dbt_packages/codegen/macros/generate_base_model.sql",
    ]

    for (const p of realWorldPaths) {
      expect(FileIgnore.match(p)).toBe(true)
    }
  })
})
