import { Filesystem } from "../../util/filesystem"
import { Glob } from "../../util/glob"
import { Log } from "../../util/log"
import { Tracer } from "../observability/tracing"
import { normalizeTag } from "../prompts/tags"
import path from "path"
import os from "os"

const log = Log.create({ service: "fingerprint" })

export namespace Fingerprint {
  export interface Result {
    tags: string[]
    detectedAt: number
    cwd: string
  }

  let cached: Result | undefined

  export function get(): Result | undefined {
    return cached
  }

  /** Reset the fingerprint cache (exported for testing) */
  export function reset(): void {
    cached = undefined
  }

  export async function refresh(): Promise<Result> {
    const previousCwd = cached?.cwd ?? process.cwd()
    cached = undefined
    return detect(previousCwd)
  }

  export async function detect(cwd: string, root?: string): Promise<Result> {
    if (cached && cached.cwd === cwd) return cached

    const startTime = Date.now()
    const timer = log.time("detect", { cwd, root })
    const tags: string[] = []

    const dirs = root && root !== cwd ? [cwd, root] : [cwd]

    await Promise.all([
      ...dirs.map((dir) => detectDir(dir, tags)),
      ...dirs.map((dir) => detectDependencies(dir, tags)),
      detectConnections(tags),
      detectDbtProfiles(tags),
      detectEnvVars(tags),
    ])

    // Deduplicate and normalize
    const unique = [...new Set(tags.map(normalizeTag))]

    const result: Result = {
      tags: unique,
      detectedAt: Date.now(),
      cwd,
    }

    cached = result
    timer.stop()
    log.info("detected", { tags: unique.join(","), cwd })

    Tracer.active?.logSpan({
      name: "fingerprint",
      startTime,
      endTime: Date.now(),
      input: { cwd, root },
      output: { tags: unique },
    })

    return result
  }

  async function detectDir(dir: string, tags: string[]): Promise<void> {
    // Data-engineering detections only
    const [
      hasDbtProject,
      hasProfilesYml,
      hasSqlfluff,
      hasDbtPackagesYml,
      hasAirflowCfg,
      hasDagsDir,
      hasDatabricksYml,
    ] = await Promise.all([
      Filesystem.exists(path.join(dir, "dbt_project.yml")),
      Filesystem.exists(path.join(dir, "profiles.yml")),
      Filesystem.exists(path.join(dir, ".sqlfluff")),
      Filesystem.exists(path.join(dir, "dbt_packages.yml")),
      Filesystem.exists(path.join(dir, "airflow.cfg")),
      Filesystem.isDir(path.join(dir, "dags")),
      Filesystem.exists(path.join(dir, "databricks.yml")),
    ])

    // dbt detection
    if (hasDbtProject) {
      tags.push("dbt", "data-engineering")
    }

    // dbt packages
    if (hasDbtPackagesYml) {
      tags.push("dbt-packages")
    }

    // profiles.yml - extract adapter type
    if (hasProfilesYml) {
      try {
        const content = await Filesystem.readText(path.join(dir, "profiles.yml"))
        const adapterMatch = content.match(
          /type:\s*(snowflake|bigquery|redshift|databricks|postgres|mysql|sqlite|duckdb|trino|spark|clickhouse)/i,
        )
        if (adapterMatch) {
          tags.push(adapterMatch[1]!.toLowerCase())
        }
      } catch (e) {
        log.debug("profiles.yml unreadable", { dir, error: e })
      }
    }

    // SQL - check for .sqlfluff or any .sql files
    if (hasSqlfluff) {
      tags.push("sql")
    } else {
      try {
        const sqlFiles = await Glob.scan("*.sql", {
          cwd: dir,
          include: "file",
        })
        if (sqlFiles.length > 0) {
          tags.push("sql")
        }
      } catch (e) {
        log.debug("sql glob scan failed", { dir, error: e })
      }
    }

    // Airflow
    if (hasAirflowCfg || hasDagsDir) {
      tags.push("airflow")
    }

    // Databricks
    if (hasDatabricksYml) {
      tags.push("databricks")
    }
  }

  /** Signal 2: Detect warehouse types from the connection registry.
   *  Uses listTypes() to avoid triggering the one-time telemetry census. */
  async function detectConnections(tags: string[]): Promise<void> {
    try {
      const { listTypes } = await import("../native/connections/registry")
      for (const t of listTypes()) {
        tags.push(t.toLowerCase())
      }
    } catch (e) {
      log.debug("connection registry not available for fingerprint", { error: e })
    }
  }

  /**
   * Signal 3: Detect warehouse adapter types from ~/.dbt/profiles.yml.
   * Only infers adapter types (snowflake, postgres, etc.), NOT the "dbt" tag.
   * The "dbt" tag is only added by detectDir when dbt_project.yml exists
   * in the project directory — global profiles are machine-wide, not project evidence.
   */
  async function detectDbtProfiles(tags: string[]): Promise<void> {
    try {
      const profilesPath = path.join(os.homedir(), ".dbt", "profiles.yml")
      const exists = await Filesystem.exists(profilesPath)
      if (!exists) return

      const { parseDbtProfiles } = await import("../native/connections/dbt-profiles")
      const connections = await parseDbtProfiles(profilesPath)
      for (const conn of connections) {
        if (conn.type) {
          tags.push(conn.type.toLowerCase())
        }
      }
    } catch (e) {
      log.debug("dbt profiles detection failed", { error: e })
    }
  }

  /** Signal 5: Detect technologies from dependency manifests.
   *  Greps for unambiguous package names across all common manifest formats.
   *  Higher signal than env vars — dependencies are intentional declarations. */
  const DEPENDENCY_MANIFESTS = [
    "requirements.txt", "pyproject.toml", "setup.cfg", "Pipfile",
    "package.json", "go.mod", "Cargo.toml", "Gemfile",
    "build.gradle", "build.gradle.kts", "pom.xml",
  ]
  const DEPENDENCY_SIGNALS: [RegExp, string][] = [
    [/snowflake[-_]connector|snowflake[-_]sdk|gosnowflake|snowflake[-_]sqlalchemy/i, "snowflake"],
    [/psycopg|asyncpg|pg8000|node-postgres|jackc\/pgx/i, "postgres"],
    [/pymongo|mongoengine|mongoose|mongoc|mongo[-_]driver/i, "mongodb"],
    [/dbt[-_]core/i, "dbt"],
    [/dbt[-_]snowflake/i, "snowflake"],
    [/dbt[-_]bigquery/i, "bigquery"],
    [/dbt[-_]postgres/i, "postgres"],
    [/dbt[-_]redshift/i, "redshift"],
    [/dbt[-_]databricks/i, "databricks"],
    [/dbt[-_]mysql/i, "mysql"],
    [/dbt[-_]sqlserver/i, "sqlserver"],
    [/apache[-_]airflow\b/i, "airflow"],
    [/airflow[-_]providers[-_]snowflake/i, "snowflake"],
    [/airflow[-_]providers[-_]google/i, "bigquery"],
    [/airflow[-_]providers[-_]postgres/i, "postgres"],
    [/airflow[-_]providers[-_]databricks/i, "databricks"],
    [/google[-_]cloud[-_]bigquery|@google-cloud\/bigquery/i, "bigquery"],
    [/databricks[-_]sdk|databricks[-_]connect/i, "databricks"],
    [/mysqlclient|PyMySQL|mysql2|mysql[-_]connector/i, "mysql"],
    [/clickhouse[-_]connect|clickhouse[-_]driver/i, "clickhouse"],
    [/oracledb|cx[-_]Oracle/i, "oracle"],
    [/redshift[-_]connector/i, "redshift"],
  ]

  async function detectDependencies(dir: string, tags: string[]): Promise<void> {
    try {
      const found = await Promise.all(
        DEPENDENCY_MANIFESTS.map((f) => Filesystem.readText(path.join(dir, f)).catch(() => null)),
      )
      const content = found.filter(Boolean).join("\n")
      if (!content) return

      for (const [pattern, tag] of DEPENDENCY_SIGNALS) {
        if (pattern.test(content)) tags.push(tag)
      }
    } catch (e) {
      log.debug("dependency scanning failed", { dir, error: e })
    }
  }

  /** Signal 4: Detect warehouse types from well-known environment variables. */
  async function detectEnvVars(tags: string[]): Promise<void> {
    const checks: [string[], string][] = [
      [["SNOWFLAKE_ACCOUNT"], "snowflake"],
      [["PGHOST", "PGDATABASE"], "postgres"],
      [["DATABRICKS_HOST", "DATABRICKS_SERVER_HOSTNAME"], "databricks"],
      [["BIGQUERY_PROJECT", "GCP_PROJECT"], "bigquery"],
      [["MYSQL_HOST", "MYSQL_DATABASE"], "mysql"],
      [["ORACLE_HOST", "ORACLE_SID"], "oracle"],
      [["MONGODB_URI", "MONGO_URI"], "mongodb"],
      [["REDSHIFT_HOST"], "redshift"],
      [["MSSQL_HOST", "SQLSERVER_HOST"], "sqlserver"],
    ]
    for (const [vars, tag] of checks) {
      if (vars.some((v) => process.env[v])) {
        tags.push(tag)
      }
    }

    // DATABASE_URL scheme parsing
    const dbUrl = process.env.DATABASE_URL
    if (dbUrl) {
      const scheme = dbUrl.split("://")[0]?.toLowerCase()
      const schemeMap: Record<string, string> = {
        postgres: "postgres",
        postgresql: "postgres",
        mysql: "mysql",
        mongodb: "mongodb",
        "mongodb+srv": "mongodb",
      }
      if (scheme && schemeMap[scheme]) {
        tags.push(schemeMap[scheme])
      }
    }
  }
}
