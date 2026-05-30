import path from "node:path"
import { loadReviewConfig, resolveRubric } from "./config"
import type { Severity } from "./finding"
import { collectChangedFiles, makeContentResolver, defaultBaseRef, manifestHash } from "./git"
import { createDispatcherRunner } from "./runner"
import { runReview } from "./orchestrate"
import type { ReviewMode, VerdictEnvelope } from "./verdict"
import type { ChangedFile } from "./diff-filter"

/**
 * End-to-end review entry point: load `.altimate/review.yml`, collect the diff,
 * run the deterministic recipe against the Rust core, and return a signed
 * verdict envelope. Used by both the `dbt_pr_review` tool and the
 * `altimate review` CLI command so they can never diverge.
 */

export interface ReviewPullRequestOptions {
  cwd: string
  /** Base ref; defaults to merge-base with origin/main. */
  base?: string
  /** Head ref; omit to diff against the working tree. */
  head?: string
  /** Override the manifest path from config. */
  manifestPath?: string
  /** Override the review mode from config. */
  mode?: ReviewMode
  /** Override the minimum severity to surface. */
  severityThreshold?: Severity
  /** Pre-collected changed files (skips git; used by CI providers). */
  changedFiles?: ChangedFile[]
  /** Resolver for file contents (used when changedFiles is pre-supplied). */
  getContent?: (file: string, side: "old" | "new") => Promise<string | undefined>
  /** Model identifier recorded in the envelope. */
  modelVersion?: string
  coreVersion?: string
}

export async function reviewPullRequest(opts: ReviewPullRequestOptions): Promise<VerdictEnvelope> {
  const config = await loadReviewConfig(opts.cwd)
  if (opts.manifestPath) config.manifestPath = opts.manifestPath
  if (opts.mode) config.mode = opts.mode
  if (opts.severityThreshold) config.severityThreshold = opts.severityThreshold
  const rubric = resolveRubric(config)

  const base = opts.base ?? (await defaultBaseRef(opts.cwd))
  const changedFiles = opts.changedFiles ?? (await collectChangedFiles({ base, head: opts.head, cwd: opts.cwd }))
  const getContent = opts.getContent ?? makeContentResolver({ base, head: opts.head, cwd: opts.cwd })

  // Resolve the manifest against the PROJECT being reviewed (cwd), not the
  // binary's process.cwd() — otherwise a relative path silently misses when the
  // CLI is invoked from elsewhere, degrading every review to lint-only.
  const manifestAbs = path.isAbsolute(config.manifestPath)
    ? config.manifestPath
    : path.join(opts.cwd, config.manifestPath)

  const runner = createDispatcherRunner({ manifestPath: manifestAbs })
  const mhash = await manifestHash(manifestAbs, opts.cwd)

  return runReview({
    changedFiles,
    config,
    rubric,
    mode: config.mode,
    runner,
    getContent,
    generatedAt: new Date().toISOString(),
    manifestHash: mhash,
    modelVersion: opts.modelVersion,
    coreVersion: opts.coreVersion,
  })
}
