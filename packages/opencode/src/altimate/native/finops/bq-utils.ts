/**
 * Shared BigQuery helpers for the finops module.
 *
 * INFORMATION_SCHEMA queries on BigQuery must be region-qualified —
 * `` `region-<location>.INFORMATION_SCHEMA.<view>` ``. The finops tools read
 * the connection's configured `location` (e.g. "us", "eu", "us-central1") and
 * interpolate it into each SQL template via a `{region}` placeholder.
 *
 * Kept in its own file so the sanitize + interpolate logic doesn't drift across
 * query-history, credit-analyzer, warehouse-advisor, role-access, and
 * unused-resources.
 */

import * as Registry from "../connections/registry"

/**
 * Sanitize a BigQuery region/location string for safe interpolation into a
 * region-qualified INFORMATION_SCHEMA reference. The result is always safe to
 * inject into `` `region-<result>.INFORMATION_SCHEMA.X` `` — the allow-list
 * `[a-z0-9-]` cannot close the backtick context or introduce SQL delimiters.
 *
 * Transformations:
 *   - lowercase + trim
 *   - strip anything outside [a-z0-9-]
 *   - trim leading/trailing hyphens (BQ region names never start or end with -)
 *   - cap length at 64 chars (BQ region names are short; this guards against
 *     pathological inputs)
 *   - fall back to "us" on empty input (historical default)
 */
export function sanitizeBqRegion(location: unknown): string {
  const raw = typeof location === "string" ? location : ""
  const cleaned = raw
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-]/g, "")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
  return cleaned || "us"
}

/**
 * Substitute the `{region}` placeholder in a BQ SQL template with the sanitized
 * region for a given warehouse config. Uses replaceAll so future templates that
 * reference multiple region-qualified views (e.g. JOINs) are handled safely.
 */
export function interpolateBqRegion(sqlTemplate: string, bqRegion?: unknown): string {
  return sqlTemplate.replaceAll("{region}", sanitizeBqRegion(bqRegion))
}

/**
 * Resolve the BigQuery `location` for a registered warehouse. Returns undefined
 * when the warehouse is not BigQuery or has no location set — callers pass the
 * result through `sanitizeBqRegion`, which defaults to "us".
 */
export function bqRegionFor(warehouse: string): unknown {
  return Registry.getConfig(warehouse)?.location
}

/**
 * Append a region-hint to a BigQuery error message when the error looks
 * region-related (missing dataset, region-not-found, unknown INFORMATION_SCHEMA
 * view). The hint tells the user which region the query ran against and how to
 * change it — the root cause on non-US projects is almost always an unset or
 * mis-typed `location` on the warehouse config.
 *
 * Returns the original error string unchanged when no region signal is present,
 * so non-region failures (bad syntax, auth, quota) stay legible.
 */
export function augmentBqError(error: unknown, sanitizedRegion: string): string {
  const msg = String(error)
  // Signals we treat as region-related:
  //   1. A backticked region-qualified INFORMATION_SCHEMA reference, which is
  //      what BigQuery emits when the dataset can't be resolved in the queried
  //      region: `region-eu.INFORMATION_SCHEMA.JOBS not found`.
  //   2. A "Not found: ... INFORMATION_SCHEMA" line — covers cases where BQ
  //      mentions the view name but not the region prefix.
  //   3. The literal "Not found: Dataset region-..." form some BQ surfaces use.
  // Anchored to these specific shapes so unrelated text containing "region-"
  // (e.g. "region-based routing denied", "multi-region-aware feature disabled")
  // does NOT trigger the BigQuery-connection hint.
  const hasRegionSignal =
    /region-[a-z0-9]+[a-z0-9-]*\.INFORMATION_SCHEMA/i.test(msg) ||
    /Not\s+found:.*INFORMATION_SCHEMA/i.test(msg) ||
    /Not\s+found:\s*Dataset\s+region-[a-z0-9]+/i.test(msg)
  if (!hasRegionSignal) return msg
  // Idempotent — don't append twice if this helper runs in nested catches
  if (msg.includes('set "location" on the BigQuery connection')) return msg
  return `${msg} (queried region-${sanitizedRegion}; set "location" on the BigQuery connection to change this)`
}

/**
 * Detect errors raised by BigQuery when the caller lacks the org-level
 * permissions required by views such as `INFORMATION_SCHEMA.TABLE_STORAGE`
 * (used by `finops_unused_resources`). Most project-scoped service accounts
 * lack `bigquery.resourceAdmin` at the org and hit this path first.
 */
export function isBqPermissionError(error: unknown): boolean {
  const msg = String(error).toLowerCase()
  // Word-boundary regex on `403` so `4031`, `40322`, `port 4030`, and similar
  // numeric prefixes don't false-positive into the permission-error branch.
  // The two `accessdenied` / `access denied` checks are intentional and not
  // redundant — Google's BigQuery SDKs emit `AccessDenied` (camelCase),
  // which `.toLowerCase()` collapses to `accessdenied` (no space) and would
  // not be caught by the `access denied` substring check.
  return (
    msg.includes("permission denied") ||
    msg.includes("access denied") ||
    msg.includes("accessdenied") ||
    msg.includes("bigquery.resourceadmin") ||
    msg.includes("iam permission") ||
    /\b403\b/.test(msg)
  )
}
