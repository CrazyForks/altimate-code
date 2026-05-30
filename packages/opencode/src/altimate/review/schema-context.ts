/**
 * Build the schema context the Rust core needs to resolve table/column
 * references when proving query equivalence.
 *
 * Without a schema the engine cannot resolve columns and equivalence is
 * undecidable (→ a conservative WARNING). Feeding it the manifest's model and
 * source columns is what moves equivalence from "could not decide" to a real
 * "provably equivalent / NOT equivalent" verdict on parseable (compiled) SQL.
 *
 * Format matches core.Schema.fromJson(): { tables: { <name>: { columns } }, version }.
 */

export interface SchemaContext {
  tables: Record<string, { columns: Array<{ name: string; type: string }> }>
  version: string
}

/** A manifest node with typed columns, as returned by the dbt.manifest RPC. */
export interface SchemaNode {
  name: string
  alias?: string
  schema_name?: string
  database?: string
  columns?: Array<{ name: string; data_type?: string; type?: string }>
}

/**
 * Build a schema context from manifest nodes (models, sources, seeds,
 * snapshots).
 *
 * dbt `ref()`/`source()` compile to fully-qualified relations
 * (`database.schema.identifier`), so keying only by the short name would leave
 * the engine unable to resolve columns in compiled SQL — falsely degrading
 * equivalence to undecidable. We therefore register EACH node under every
 * plausible relation key (bare, `schema.name`, `database.schema.name`, plus the
 * alias forms) so a qualified reference still hits. Returns undefined when no
 * node carries column metadata — the caller then treats equivalence as
 * undecidable rather than guessing.
 */
export function buildReviewSchemaContext(...nodeGroups: Array<SchemaNode[] | undefined>): SchemaContext | undefined {
  const tables: SchemaContext["tables"] = {}
  for (const group of nodeGroups) {
    for (const node of group ?? []) {
      if (!node.columns?.length) continue
      const columns = node.columns
        .filter((c) => c.name)
        .map((c) => ({ name: c.name, type: c.data_type ?? c.type ?? "" }))
      if (!columns.length) continue
      const ids = new Set<string>()
      for (const base of [node.alias, node.name]) {
        if (!base) continue
        ids.add(base)
        if (node.schema_name) {
          ids.add(`${node.schema_name}.${base}`)
          if (node.database) ids.add(`${node.database}.${node.schema_name}.${base}`)
        }
      }
      for (const id of ids) tables[id] = { columns }
    }
  }
  return Object.keys(tables).length ? { tables, version: "1" } : undefined
}
