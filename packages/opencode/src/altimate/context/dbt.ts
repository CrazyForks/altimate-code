/**
 * Lightweight dbt project detection for system prompt injection.
 * Detects if cwd is a dbt project and extracts minimal metadata.
 * Tells the agent to use `altimate_core_parse_dbt` for full context.
 */

import { existsSync, readFileSync } from "fs"
import path from "path"
import { Log } from "../../util/log"

const log = Log.create({ service: "dbt-context" })

let cached: { cwd: string; result: string | undefined } | undefined

export namespace DbtContext {
  export function get(): string | undefined {
    return cached?.result
  }

  export async function collect(cwd: string): Promise<string | undefined> {
    if (cached && cached.cwd === cwd) return cached.result

    const result = detect(cwd)
    cached = { cwd, result }
    if (result) log.info("dbt project detected", { cwd })
    return result
  }
}

function detect(cwd: string): string | undefined {
  const dbtProjectPath = path.join(cwd, "dbt_project.yml")
  if (!existsSync(dbtProjectPath)) return undefined

  let projectName = "unknown"
  let profile: string | undefined
  let adapter: string | undefined

  try {
    const content = readFileSync(dbtProjectPath, "utf-8")
    const nameMatch = content.match(/^name:\s*['"]?([^'"\\n]+?)['"]?\s*$/m)
    if (nameMatch) projectName = nameMatch[1]!.trim()
    const profileMatch = content.match(/^profile:\s*['"]?([^'"\\n]+?)['"]?\s*$/m)
    if (profileMatch) profile = profileMatch[1]!.trim()
  } catch {}

  const profilesPath = path.join(cwd, "profiles.yml")
  if (existsSync(profilesPath)) {
    try {
      const content = readFileSync(profilesPath, "utf-8")
      const match = content.match(/type:\s*(snowflake|bigquery|redshift|databricks|postgres|mysql|sqlite|duckdb|trino|spark|clickhouse)/i)
      if (match) adapter = match[1]!.toLowerCase()
    } catch {}
  }

  const header = [`Project: ${projectName}`]
  if (profile) header.push(`Profile: ${profile}`)
  if (adapter) header.push(`Adapter: ${adapter}`)

  const hasProfiles = existsSync(profilesPath)
  const runCmd = hasProfiles
    ? "dbt run --profiles-dir . --project-dir ."
    : "dbt run --project-dir ."

  return [
    `This is a dbt project. ${header.join(" | ")}`,
    `IMPORTANT: Before writing any SQL or dbt models, run \`altimate_core_parse_dbt\` with project_dir="${cwd}" to understand the full project structure — models, sources, tests, and columns defined in schema.yml.`,
    `Run command: ${runCmd}`,
  ].join("\n")
}
