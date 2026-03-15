import type { DBTProjectIntegrationAdapter } from "@altimateai/dbt-integration"

export async function columns(adapter: DBTProjectIntegrationAdapter, args: string[]) {
  const model = flag(args, "model")
  if (!model) return { error: "Missing --model" }
  return adapter.getColumnsOfModel(model)
}

export async function source(adapter: DBTProjectIntegrationAdapter, args: string[]) {
  const name = flag(args, "source")
  const table = flag(args, "table")
  if (!name) return { error: "Missing --source" }
  if (!table) return { error: "Missing --table" }
  return adapter.getColumnsOfSource(name, table)
}

export async function values(adapter: DBTProjectIntegrationAdapter, args: string[]) {
  const model = flag(args, "model")
  const col = flag(args, "column")
  if (!model) return { error: "Missing --model" }
  if (!col) return { error: "Missing --column" }
  return adapter.getColumnValues(model, col)
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
