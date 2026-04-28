// altimate_change start — cross-DB join key inference
/**
 * Cross-DB join key inference.
 *
 * For each pair of (db, table, column) drawn from different warehouse
 * connections, look for a shared value-shape: both sides have a non-empty
 * common prefix that ends in a separator (`_`, `-`, `:`), the prefixes are
 * different, and stripping the prefixes leaves at least one matching suffix.
 *
 * The canonical pattern this targets: a `business_id` column whose values
 * look like `businessid_42` joins to a `business_ref` column with values
 * like `businessref_42`. The inference is purely value-based — it does not
 * inspect column names — so it survives schemas that disagree on naming
 * conventions.
 */

import * as Registry from "./registry"
import { quoteIdentForDialect, warehouseTypeToDialect } from "./data-diff"
import type { Connector } from "@altimateai/drivers"
import type {
  AltimateCoreDetectJoinCandidatesParams,
  AltimateCoreResult,
} from "../types"

const DEFAULT_SAMPLE_SIZE = 50
const DEFAULT_MAX_TABLES_PER_CONNECTION = 50
const SEPARATORS = ["_", "-", ":"] as const
/** Cap on the number of per-table sampling errors retained per connection. */
const MAX_PARTIAL_ERRORS_PER_CONNECTION = 20

/**
 * Longest common prefix across `values`, trimmed back to the last separator.
 *
 * Returns `""` if the prefix is empty or contains no separator — in that case
 * the values do not share a "join key shape" and should be skipped.
 */
export function commonPrefix(values: readonly string[]): string {
  const items = values.filter((v): v is string => typeof v === "string")
  if (items.length === 0) return ""

  let prefix = items[0]
  for (let k = 1; k < items.length; k++) {
    const s = items[k]
    let i = 0
    const limit = Math.min(prefix.length, s.length)
    while (i < limit && prefix[i] === s[i]) i++
    prefix = prefix.slice(0, i)
    if (prefix.length === 0) return ""
  }

  if (prefix.length === 0) return ""
  if (endsWithSeparator(prefix)) return prefix

  // Walk back to the last separator we can find — anything past it is
  // a partial token, not a join key prefix.
  let bestIdx = -1
  for (const sep of SEPARATORS) {
    const idx = prefix.lastIndexOf(sep)
    if (idx > bestIdx) bestIdx = idx
  }
  if (bestIdx < 0) return ""
  return prefix.slice(0, bestIdx + 1)
}

function endsWithSeparator(s: string): boolean {
  if (s.length === 0) return false
  const last = s[s.length - 1]
  return last === "_" || last === "-" || last === ":"
}

/** A single (db, table, column) bag of string sample values. */
export interface ColumnSampleBag {
  db: string
  table: string
  column: string
  values: string[]
}

export interface JoinCandidate {
  left_db: string
  left_table: string
  left_col: string
  right_db: string
  right_table: string
  right_col: string
  prefix_rule: { left: string; right: string }
  suffix_overlap: number
  /**
   * Heuristic match score in [0, 1]: `overlap / min(|left_suffixes|, |right_suffixes|)`.
   * Cheap and monotonic — NOT a probability. Two columns whose handful of
   * sampled values happen to share a suffix will score 1.0 even if the
   * underlying tables are mostly disjoint. Treat this as a ranking signal,
   * not a confidence interval.
   */
  match_score: number
}

/**
 * Pure (no I/O) detector. Exported so unit tests can drive it with synthetic
 * sample data — and so the integration test can use an in-memory SQLite fixture
 * without re-implementing the algorithm.
 */
export function detectJoinCandidatesFromBags(bags: ColumnSampleBag[]): JoinCandidate[] {
  const candidates: JoinCandidate[] = []
  for (let i = 0; i < bags.length; i++) {
    const left = bags[i]
    if (left.values.length === 0) continue
    const lp = commonPrefix(left.values)
    if (!lp) continue
    const lsuf = stripPrefixSet(left.values, lp)
    if (lsuf.size === 0) continue

    for (let j = i + 1; j < bags.length; j++) {
      const right = bags[j]
      if (right.db === left.db) continue // cross-DB only
      if (right.values.length === 0) continue
      const rp = commonPrefix(right.values)
      if (!rp || rp === lp) continue
      const rsuf = stripPrefixSet(right.values, rp)
      if (rsuf.size === 0) continue

      let overlap = 0
      for (const s of lsuf) if (rsuf.has(s)) overlap++
      if (overlap === 0) continue

      const denom = Math.min(lsuf.size, rsuf.size)
      const matchScore = denom > 0 ? overlap / denom : 0

      candidates.push({
        left_db: left.db,
        left_table: left.table,
        left_col: left.column,
        right_db: right.db,
        right_table: right.table,
        right_col: right.column,
        prefix_rule: { left: lp, right: rp },
        suffix_overlap: overlap,
        match_score: matchScore,
      })
    }
  }

  candidates.sort((a, b) => {
    if (b.suffix_overlap !== a.suffix_overlap) return b.suffix_overlap - a.suffix_overlap
    return b.match_score - a.match_score
  })
  return candidates
}

function stripPrefixSet(values: readonly string[], prefix: string): Set<string> {
  const out = new Set<string>()
  for (const v of values) {
    if (typeof v === "string" && v.startsWith(prefix)) {
      const suf = v.slice(prefix.length)
      if (suf.length > 0) out.add(suf)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// I/O: pull sample bags from live connectors
// ---------------------------------------------------------------------------

/** Heuristic: data types we treat as "string-like" for sampling. */
const STRING_TYPE_PATTERN =
  /^(varchar|char|character|text|string|nvarchar|nchar|clob|json|uuid|citext|bpchar|name)/i

function isStringLike(dataType: string | undefined): boolean {
  if (!dataType) return false
  return STRING_TYPE_PATTERN.test(dataType.trim())
}

/**
 * Build the per-column sampling SQL for a given dialect. Identifier quoting is
 * dialect-aware (delegates to `quoteIdentForDialect`), and the row cap is
 * delegated to the driver via `connector.execute(sql, sampleSize)` so each
 * driver applies its native limit syntax (`LIMIT`, `TOP`, `FETCH FIRST`, ...).
 *
 * Extracted into a pure helper so tests can snapshot the SQL per dialect
 * without going through I/O.
 */
export function buildSampleSql(
  dialect: string,
  schema: string | undefined,
  table: string,
  column: string,
): string {
  const quotedCol = quoteIdentForDialect(column, dialect)
  const quotedTarget = schema
    ? `${quoteIdentForDialect(schema, dialect)}.${quoteIdentForDialect(table, dialect)}`
    : quoteIdentForDialect(table, dialect)
  return `SELECT ${quotedCol} FROM ${quotedTarget} WHERE ${quotedCol} IS NOT NULL`
}

/**
 * Resolve the SQL dialect for a configured warehouse connection. Falls back to
 * `"generic"` if the connection isn't registered — `quoteIdentForDialect` then
 * uses ANSI double-quote rules.
 */
function resolveDialectForConnection(name: string): string {
  const cfg = Registry.getConfig(name)
  return warehouseTypeToDialect(cfg?.type ?? "generic")
}

/**
 * Fetch up to `sampleSize` non-null string sample values for one column.
 *
 * Lets exceptions propagate so callers can attach a (table, column) breadcrumb
 * to the per-connection partial-error list, rather than silently dropping
 * permission errors.
 */
async function fetchColumnSamples(
  connector: Connector,
  dialect: string,
  schema: string | undefined,
  table: string,
  column: string,
  sampleSize: number,
): Promise<string[]> {
  const sql = buildSampleSql(dialect, schema, table, column)
  const result = await connector.execute(sql, sampleSize)
  const out: string[] = []
  for (const row of result.rows) {
    const v = row[0]
    if (typeof v === "string" && v.length > 0) out.push(v)
  }
  return out
}

interface ConnectionResult {
  bags: ColumnSampleBag[]
  /** One entry when the whole connection failed (auth, registry lookup, etc.). */
  connectionError?: string
  /** Bounded list of per-(table, column) sampling errors. */
  partialErrors: string[]
}

/**
 * Sample one connection independently. Surfaces three classes of failure:
 *   1. Connection-level (resolving the connector, listing schemas) → `connectionError`.
 *   2. Per-table (listTables/describeTable) → recorded in `partialErrors`.
 *   3. Per-column (the SELECT sample) → recorded in `partialErrors`.
 */
async function sampleConnection(
  name: string,
  params: AltimateCoreDetectJoinCandidatesParams,
): Promise<ConnectionResult> {
  const sampleSize = params.sample_size ?? DEFAULT_SAMPLE_SIZE
  const maxTables = params.max_tables_per_connection ?? DEFAULT_MAX_TABLES_PER_CONNECTION
  const bags: ColumnSampleBag[] = []
  const partialErrors: string[] = []
  const recordPartialError = (msg: string) => {
    if (partialErrors.length < MAX_PARTIAL_ERRORS_PER_CONNECTION) partialErrors.push(msg)
  }

  let connector: Connector
  try {
    connector = await Registry.get(name)
  } catch (e) {
    return { bags: [], partialErrors: [], connectionError: String(e) }
  }

  const dialect = resolveDialectForConnection(name)

  let schemas: string[]
  try {
    schemas = params.schema_name
      ? [params.schema_name]
      : await connector.listSchemas()
  } catch (e) {
    return {
      bags: [],
      partialErrors: [],
      connectionError: `Failed to list schemas: ${String(e)}`,
    }
  }

  let tablesScanned = 0
  for (const schema of schemas) {
    if (tablesScanned >= maxTables) break

    let tables: Array<{ name: string; type: string }>
    try {
      tables = await connector.listTables(schema)
    } catch (e) {
      recordPartialError(`listTables(${schema}): ${String(e)}`)
      continue
    }

    for (const t of tables) {
      if (tablesScanned >= maxTables) break
      tablesScanned++

      let columns: Array<{ name: string; data_type: string }>
      try {
        const cols = await connector.describeTable(schema, t.name)
        columns = cols.map((c) => ({ name: c.name, data_type: c.data_type }))
      } catch (e) {
        recordPartialError(`describeTable(${schema}.${t.name}): ${String(e)}`)
        continue
      }

      for (const c of columns) {
        if (!isStringLike(c.data_type)) continue
        try {
          const values = await fetchColumnSamples(
            connector,
            dialect,
            schema,
            t.name,
            c.name,
            sampleSize,
          )
          if (values.length === 0) continue
          bags.push({
            db: name,
            table: `${schema}.${t.name}`,
            column: c.name,
            values,
          })
        } catch (e) {
          recordPartialError(`sample(${schema}.${t.name}.${c.name}): ${String(e)}`)
        }
      }
    }
  }

  return { bags, partialErrors }
}

/**
 * Build the per-(db,table,column) sample bag list across all `connections`.
 *
 * Connections are sampled in parallel — each connection is independent and the
 * default 50-tables-per-connection cap keeps the per-connection blast radius
 * bounded. Connection-level failures are recorded in `errors`; per-table /
 * per-column failures are surfaced in `partialErrors`.
 */
export async function collectSampleBags(
  params: AltimateCoreDetectJoinCandidatesParams,
): Promise<{
  bags: ColumnSampleBag[]
  errors: Record<string, string>
  partialErrors: Record<string, string[]>
}> {
  const results = await Promise.all(
    params.connections.map((name) => sampleConnection(name, params)),
  )

  const bags: ColumnSampleBag[] = []
  const errors: Record<string, string> = {}
  const partialErrors: Record<string, string[]> = {}

  for (let i = 0; i < params.connections.length; i++) {
    const name = params.connections[i]
    const r = results[i]
    if (r.connectionError) {
      errors[name] = r.connectionError
    } else {
      bags.push(...r.bags)
    }
    if (r.partialErrors.length > 0) {
      partialErrors[name] = r.partialErrors
    }
  }

  return { bags, errors, partialErrors }
}

// ---------------------------------------------------------------------------
// Native handler entrypoint
// ---------------------------------------------------------------------------

export async function detectJoinCandidates(
  params: AltimateCoreDetectJoinCandidatesParams,
): Promise<AltimateCoreResult> {
  if (!Array.isArray(params.connections) || params.connections.length < 2) {
    return {
      success: false,
      data: {},
      error: "detect_join_candidates requires at least two warehouse connections.",
    }
  }
  try {
    const { bags, errors, partialErrors } = await collectSampleBags(params)
    const candidates = detectJoinCandidatesFromBags(bags)
    return {
      success: true,
      data: {
        candidates,
        bags_scanned: bags.length,
        connection_errors: errors,
        partial_errors: partialErrors,
      },
    }
  } catch (e) {
    return { success: false, data: {}, error: String(e) }
  }
}
// altimate_change end
