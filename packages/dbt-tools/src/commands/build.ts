import type { DBTProjectIntegrationAdapter, CommandProcessResult } from "@altimateai/dbt-integration"
import { schemaVerify } from "./schema-verify"

export async function build(adapter: DBTProjectIntegrationAdapter, args: string[]) {
  const model = flag(args, "model")
  const downstream = args.includes("--downstream")
  if (!model) {
    if (downstream) return { error: "--downstream requires --model" }
    return project(adapter)
  }
  const result = await adapter.unsafeBuildModelImmediately({
    plusOperatorLeft: "",
    modelName: model,
    plusOperatorRight: downstream ? "+" : "",
  })
  const formatted = format(result)

  // Auto-run schema-verify after a successful single-model build. Surfacing
  // the verdict in the same tool result the agent just received is the
  // closest a CLI command can get to harness-level enforcement: the agent
  // cannot see a green build without also seeing the schema-verify diff.
  // Failures here are non-fatal — verify is advisory feedback, not a build
  // step. `no-spec` is reported so the agent knows there was no spec to
  // grade against.
  if (!("error" in formatted)) {
    try {
      const verify = await schemaVerify(adapter, ["--model", model])
      return { ...formatted, schema_verify: verify }
    } catch (e) {
      // Don't let verify failures mask a successful build.
      return {
        ...formatted,
        schema_verify: {
          error: `schema-verify failed: ${e instanceof Error ? e.message : String(e)}. Run \`altimate-dbt schema-verify --model ${model}\` manually to inspect.`,
        },
      }
    }
  }

  return formatted
}

export async function run(adapter: DBTProjectIntegrationAdapter, args: string[]) {
  const model = flag(args, "model")
  if (!model) return { error: "Missing --model" }
  const downstream = args.includes("--downstream")
  const result = await adapter.unsafeRunModelImmediately({
    plusOperatorLeft: "",
    modelName: model,
    plusOperatorRight: downstream ? "+" : "",
  })
  return format(result)
}

export async function test(adapter: DBTProjectIntegrationAdapter, args: string[]) {
  const model = flag(args, "model")
  if (!model) return { error: "Missing --model" }
  const result = await adapter.unsafeRunModelTestImmediately(model)
  return format(result)
}

export async function project(adapter: DBTProjectIntegrationAdapter) {
  const result = await adapter.unsafeBuildProjectImmediately()
  return format(result)
}

// TODO: dbt writes info/progress logs to stderr even on success — checking stderr
// alone causes false failures. CommandProcessResult has no exit_code field, so we
// can't distinguish real errors yet. Revisit when the type is extended.
function format(result?: CommandProcessResult) {
  if (result?.stderr) return { error: result.stderr, stdout: result.stdout }
  return { stdout: result?.stdout ?? "" }
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
