/**
 * dbt-aware diff filtering.
 *
 * Cloudflare strips lock files / vendored / minified / generated assets but
 * deliberately keeps migrations. The dbt analogue: strip build artifacts and
 * vendored packages, but NEVER skip the things that change data semantics —
 * snapshots, macros, schema.yml contract blocks, seeds.
 */

/** Paths that are build output / vendored and carry no review signal. */
const SKIP_DIR_PATTERNS = [
  /(^|\/)target\//,
  /(^|\/)dbt_packages\//,
  /(^|\/)dbt_modules\//,
  /(^|\/)compiled\//,
  /(^|\/)run\//,
  /(^|\/)logs\//,
  /(^|\/)\.venv\//,
  /(^|\/)node_modules\//,
  /(^|\/)\.git\//,
]

/** Specific generated files to skip. */
const SKIP_FILE_PATTERNS = [
  /(^|\/)catalog\.json$/,
  /(^|\/)manifest\.json$/,
  /(^|\/)run_results\.json$/,
  /(^|\/)graph\.gpickle$/,
  /(^|\/)partial_parse\.msgpack$/,
  /(^|\/)index\.html$/,
  /\.lock$/,
]

/** Extensions worth reviewing for a dbt project. */
const REVIEWABLE_EXT = [".sql", ".yml", ".yaml", ".csv", ".py"]

/** True when a changed path should be reviewed (not a build artifact). */
export function shouldReview(path: string): boolean {
  const p = path.replace(/\\/g, "/")
  if (SKIP_DIR_PATTERNS.some((re) => re.test(p))) return false
  if (SKIP_FILE_PATTERNS.some((re) => re.test(p))) return false
  return REVIEWABLE_EXT.some((ext) => p.toLowerCase().endsWith(ext))
}

export type DbtFileKind =
  | "model_sql" // models/**.sql
  | "schema_yml" // models/**/*.yml (contracts, tests, descriptions)
  | "source_yml" // a yml declaring sources:
  | "macro" // macros/**
  | "snapshot" // snapshots/**
  | "seed" // seeds/**.csv
  | "test" // tests/**.sql or data tests
  | "analysis" // analyses/**
  | "python_model" // models/**.py
  | "project_config" // dbt_project.yml / profiles.yml / packages.yml
  | "other"

/** Classify a changed file by its role in a dbt project. */
export function classifyDbtFile(path: string): DbtFileKind {
  const p = path.replace(/\\/g, "/").toLowerCase()
  if (/(^|\/)(dbt_project|profiles|packages|dependencies)\.ya?ml$/.test(p)) return "project_config"
  if (/(^|\/)macros\//.test(p)) return "macro"
  if (/(^|\/)snapshots\//.test(p)) return "snapshot"
  if (/(^|\/)seeds\//.test(p) && p.endsWith(".csv")) return "seed"
  if (/(^|\/)tests\//.test(p) && p.endsWith(".sql")) return "test"
  if (/(^|\/)analyses\//.test(p)) return "analysis"
  if (/(^|\/)models\//.test(p) && p.endsWith(".py")) return "python_model"
  if (/(^|\/)models\//.test(p) && p.endsWith(".sql")) return "model_sql"
  if (p.endsWith(".yml") || p.endsWith(".yaml")) return "schema_yml"
  return "other"
}

/** A changed file as reported by the VCS. */
export interface ChangedFile {
  path: string
  status: "added" | "modified" | "deleted" | "renamed"
  /** Unified diff hunk text, when available. */
  diff?: string
  /** Previous path for renames. */
  oldPath?: string
}

/** Filter changed files down to the reviewable set, with their dbt kind. */
export function filterChangedFiles(
  files: ChangedFile[],
  extraExcludeGlobs: string[] = [],
): Array<ChangedFile & { kind: DbtFileKind }> {
  return files
    .filter((f) => shouldReview(f.path))
    .filter((f) => !extraExcludeGlobs.some((g) => f.path.endsWith(g.replace(/^\*+/, ""))))
    .map((f) => ({ ...f, kind: classifyDbtFile(f.path) }))
}

/** Heuristic: does a yml diff declare dbt `sources:`? Tolerates unified-diff
 *  line prefixes (`+`/`-`/space) so it matches an added `+sources:` hunk. */
export function looksLikeSourceYml(diff: string | undefined): boolean {
  return !!diff && /^[+\-\s]*sources:\s*$/m.test(diff)
}

/** Heuristic: does a yml diff touch a `contract:` / `enforced:` block? */
export function touchesContract(diff: string | undefined): boolean {
  return !!diff && /\bcontract:|\benforced:\s*true/.test(diff)
}

/** Count added/removed SQL lines in a unified diff hunk. */
export function countChangedLines(diff: string | undefined): number {
  if (!diff) return 0
  let n = 0
  for (const line of diff.split("\n")) {
    if ((line.startsWith("+") && !line.startsWith("+++")) || (line.startsWith("-") && !line.startsWith("---"))) n++
  }
  return n
}
