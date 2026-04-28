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
