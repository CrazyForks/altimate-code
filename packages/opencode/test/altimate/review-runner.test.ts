import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createDispatcherRunner } from "../../src/altimate/review/runner"

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("review manifest loading", () => {
  test("loads a valid manifest without initializing the native dispatcher", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "altimate-review-manifest-"))
    tempDirs.push(dir)
    const manifestPath = path.join(dir, "manifest.json")
    writeFileSync(
      manifestPath,
      JSON.stringify({
        metadata: { adapter_type: "duckdb" },
        nodes: {
          "model.demo.orders": {
            resource_type: "model",
            name: "orders",
            original_file_path: "models/orders.sql",
            config: { materialized: "table" },
            depends_on: { nodes: [] },
            columns: {},
          },
        },
        sources: {},
      }),
    )

    const runner = createDispatcherRunner({ manifestPath })
    expect(await runner.manifestAvailable?.()).toBe(true)
    expect(await runner.impact("orders")).toEqual({
      hasManifest: true,
      severity: "SAFE",
      directCount: 0,
      transitiveCount: 0,
      testCount: 0,
    })
  })
})
