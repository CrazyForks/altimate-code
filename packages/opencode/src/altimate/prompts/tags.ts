/**
 * Tag normalization and expansion utilities for domain prompt composition.
 * Kept separate from compose.ts to avoid circular dependencies with fingerprint.
 */

/** Normalize driver type aliases to canonical tag names. */
export function normalizeTag(tag: string): string {
  const aliases: Record<string, string> = {
    postgresql: "postgres",
    mongo: "mongodb",
    mariadb: "mysql",
    mssql: "sqlserver",
  }
  return aliases[tag] ?? tag
}

/**
 * Tags that imply other tags. For example, dbt always generates SQL,
 * so detecting dbt should also include the sql domain module.
 * MongoDB is intentionally absent — it uses MQL, not SQL.
 */
export const TAG_IMPLICATIONS: Record<string, string[]> = {
  dbt: ["sql"],
  snowflake: ["sql"],
  bigquery: ["sql"],
  postgres: ["sql"],
  redshift: ["sql"],
  mysql: ["sql"],
  databricks: ["sql"],
  duckdb: ["sql"],
  sqlserver: ["sql"],
  oracle: ["sql"],
  sqlite: ["sql"],
}

/** Expand tags with implications (e.g., dbt -> sql). */
export function expandTags(tags: string[]): string[] {
  const expanded = new Set(tags)
  for (const tag of tags) {
    const implied = TAG_IMPLICATIONS[tag]
    if (implied) {
      for (const t of implied) expanded.add(t)
    }
  }
  return [...expanded]
}
