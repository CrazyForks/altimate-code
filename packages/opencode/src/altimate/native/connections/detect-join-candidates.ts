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
 *
 * The algorithm here is a TypeScript port of `_detect_join_candidates` /
 * `_common_prefix` from dab_bench's preindexer.
 */

import * as Registry from "./registry"
import type { Connector } from "@altimateai/drivers"
import type {
  AltimateCoreDetectJoinCandidatesParams,
  AltimateCoreResult,
} from "../types"

const DEFAULT_SAMPLE_SIZE = 50
const DEFAULT_MAX_TABLES_PER_CONNECTION = 50
const SEPARATORS = ["_", "-", ":"] as const

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
   * Confidence proxy in [0, 1]: overlap normalized by the smaller suffix bag.
   * Cheap and monotonic — not a probability.
   */
  confidence: number
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
      const confidence = denom > 0 ? overlap / denom : 0

      candidates.push({
        left_db: left.db,
        left_table: left.table,
        left_col: left.column,
        right_db: right.db,
        right_table: right.table,
        right_col: right.column,
        prefix_rule: { left: lp, right: rp },
        suffix_overlap: overlap,
        confidence,
      })
    }
  }

  candidates.sort((a, b) => {
    if (b.suffix_overlap !== a.suffix_overlap) return b.suffix_overlap - a.suffix_overlap
    return b.confidence - a.confidence
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
 * Quote a SQL identifier with double quotes — safe for every dialect we ship
 * a driver for. Embedded double-quotes are doubled per ANSI rules.
 */
function quoteIdent(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"'
}

/**
 * Fetch up to `sampleSize` non-null string sample values for one column.
 * Returns `[]` on any error so a single bad table never aborts the scan.
 */
async function fetchColumnSamples(
  connector: Connector,
  schema: string | undefined,
  table: string,
  column: string,
  sampleSize: number,
): Promise<string[]> {
  const target = schema ? `${quoteIdent(schema)}.${quoteIdent(table)}` : quoteIdent(table)
  const col = quoteIdent(column)
  const sql = `SELECT ${col} FROM ${target} WHERE ${col} IS NOT NULL LIMIT ${sampleSize}`
  try {
    const result = await connector.execute(sql, sampleSize)
    const out: string[] = []
    for (const row of result.rows) {
      const v = row[0]
      if (typeof v === "string" && v.length > 0) out.push(v)
    }
    return out
  } catch {
    return []
  }
}

/**
 * Build the per-(db,table,column) sample bag list across all `connections`.
 *
 * Errors connecting to or describing one warehouse must not abort the whole
 * run — the caller still wants candidates from the surviving connections.
 */
export async function collectSampleBags(
  params: AltimateCoreDetectJoinCandidatesParams,
): Promise<{ bags: ColumnSampleBag[]; errors: Record<string, string> }> {
  const sampleSize = params.sample_size ?? DEFAULT_SAMPLE_SIZE
  const maxTables = params.max_tables_per_connection ?? DEFAULT_MAX_TABLES_PER_CONNECTION
  const bags: ColumnSampleBag[] = []
  const errors: Record<string, string> = {}

  for (const name of params.connections) {
    try {
      const connector = await Registry.get(name)
      const schemas = params.schema_name
        ? [params.schema_name]
        : await safeListSchemas(connector)
      let tablesScanned = 0
      for (const schema of schemas) {
        if (tablesScanned >= maxTables) break
        const tables = await safeListTables(connector, schema)
        for (const t of tables) {
          if (tablesScanned >= maxTables) break
          tablesScanned++
          const columns = await safeDescribeTable(connector, schema, t.name)
          for (const c of columns) {
            if (!isStringLike(c.data_type)) continue
            const values = await fetchColumnSamples(
              connector,
              schema,
              t.name,
              c.name,
              sampleSize,
            )
            if (values.length === 0) continue
            bags.push({ db: name, table: `${schema}.${t.name}`, column: c.name, values })
          }
        }
      }
    } catch (e) {
      errors[name] = String(e)
    }
  }

  return { bags, errors }
}

async function safeListSchemas(connector: Connector): Promise<string[]> {
  try {
    return await connector.listSchemas()
  } catch {
    return ["public"]
  }
}

async function safeListTables(
  connector: Connector,
  schema: string,
): Promise<Array<{ name: string; type: string }>> {
  try {
    return await connector.listTables(schema)
  } catch {
    return []
  }
}

async function safeDescribeTable(
  connector: Connector,
  schema: string,
  table: string,
): Promise<Array<{ name: string; data_type: string }>> {
  try {
    const cols = await connector.describeTable(schema, table)
    return cols.map((c) => ({ name: c.name, data_type: c.data_type }))
  } catch {
    return []
  }
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
    const { bags, errors } = await collectSampleBags(params)
    const candidates = detectJoinCandidatesFromBags(bags)
    return {
      success: true,
      data: {
        candidates,
        bags_scanned: bags.length,
        connection_errors: errors,
      },
    }
  } catch (e) {
    return { success: false, data: {}, error: String(e) }
  }
}
// altimate_change end
