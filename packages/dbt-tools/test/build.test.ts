import { describe, test, expect, mock } from "bun:test"
import { build } from "../src/commands/build"
import type { DBTProjectIntegrationAdapter } from "@altimateai/dbt-integration"

function makeAdapter(overrides: Partial<DBTProjectIntegrationAdapter> = {}): DBTProjectIntegrationAdapter {
  return {
    unsafeBuildModelImmediately: mock(() => Promise.resolve({ stdout: "model built", stderr: "" })),
    unsafeBuildProjectImmediately: mock(() => Promise.resolve({ stdout: "project built", stderr: "" })),
    unsafeRunModelImmediately: mock(() => Promise.resolve({ stdout: "", stderr: "" })),
    unsafeRunModelTestImmediately: mock(() => Promise.resolve({ stdout: "", stderr: "" })),
    // Auto-trigger after `build --model X` calls schema-verify too. Mock its
    // dependencies so the test exercises the build path without erroring on
    // missing adapter methods.
    parseManifest: mock(() => Promise.resolve({
      nodeMetaMap: { lookupByBaseName: mock(() => undefined), lookupByUniqueId: mock(() => undefined), nodes: mock(() => []) },
    })),
    getColumnsOfModel: mock(() => Promise.resolve([])),
    dispose: mock(() => Promise.resolve()),
    ...overrides,
  } as unknown as DBTProjectIntegrationAdapter
}

describe("build command", () => {
  test("build without --model builds entire project", async () => {
    const adapter = makeAdapter()
    const result = await build(adapter, [])
    expect(adapter.unsafeBuildProjectImmediately).toHaveBeenCalledTimes(1)
    expect(adapter.unsafeBuildModelImmediately).not.toHaveBeenCalled()
    expect(result).toEqual({ stdout: "project built" })
  })

  test("build --model <name> builds single model and auto-runs schema-verify", async () => {
    const adapter = makeAdapter()
    const result = await build(adapter, ["--model", "orders"])
    expect(adapter.unsafeBuildModelImmediately).toHaveBeenCalledTimes(1)
    expect(adapter.unsafeBuildModelImmediately).toHaveBeenCalledWith({
      plusOperatorLeft: "",
      modelName: "orders",
      plusOperatorRight: "",
    })
    expect(adapter.unsafeBuildProjectImmediately).not.toHaveBeenCalled()
    // After a successful single-model build, schema-verify is auto-run and
    // its result appears under `schema_verify`. The agent cannot see a green
    // build without also seeing the shape diff.
    expect(adapter.parseManifest).toHaveBeenCalledTimes(1)
    expect((result as Record<string, unknown>).stdout).toBe("model built")
    expect((result as Record<string, unknown>).schema_verify).toBeDefined()
  })

  test("build --model <name> --downstream sets plusOperatorRight", async () => {
    const adapter = makeAdapter()
    await build(adapter, ["--model", "orders", "--downstream"])
    expect(adapter.unsafeBuildModelImmediately).toHaveBeenCalledWith({
      plusOperatorLeft: "",
      modelName: "orders",
      plusOperatorRight: "+",
    })
  })

  test("build --downstream without --model returns error", async () => {
    const adapter = makeAdapter()
    const result = await build(adapter, ["--downstream"])
    expect(result).toEqual({ error: "--downstream requires --model" })
    expect(adapter.unsafeBuildProjectImmediately).not.toHaveBeenCalled()
    expect(adapter.unsafeBuildModelImmediately).not.toHaveBeenCalled()
  })

  test("build surfaces stderr as error", async () => {
    const adapter = makeAdapter({
      unsafeBuildProjectImmediately: mock(() =>
        Promise.resolve({ stdout: "partial output", stderr: "compilation error", fullOutput: "" }),
      ),
    })
    const result = await build(adapter, [])
    expect(result).toEqual({ error: "compilation error", stdout: "partial output" })
  })
})
