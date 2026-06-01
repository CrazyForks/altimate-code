/**
 * Verifier-gated model router — the escalation ladder.
 *
 * Run the CHEAP tier first; verify the workspace deterministically (Verifier);
 * if the verdict is not ok, escalate to the next stronger tier, handing it the
 * exact failing checks so it fixes rather than restarts blind. Stop at the first
 * passing verdict (or the top of the ladder).
 *
 * Because the cheap tier handles most tasks, escalation is rare. The default ladder
 * is ordered cheapest → strongest and can be overridden per deployment.
 *
 * Pure orchestration: `runAgent` + `verify` are injected → unit-testable without
 * a live model or dbt. Flag-gated (`ALTIMATE_ROUTER`); default off.
 */
import { Verifier } from "./verifier"

export namespace Router {
  export interface Tier {
    model: string
    label: string
  }

  /**
   * Default ladder, ordered cheapest → strongest. A tier is only reached when the
   * previous tier's output fails verification, so most runs complete at the cheap tier.
   * Override per deployment via `ALTIMATE_ROUTER_LADDER` or an injected policy.
   */
  export const DEFAULT_LADDER: Tier[] = [
    { model: "openrouter/deepseek/deepseek-v4-flash", label: "deepseek-v4-flash" },
    { model: "openrouter/z-ai/glm-5.1", label: "glm-5.1" },
    { model: "openrouter/anthropic/claude-opus-4.8", label: "claude-opus-4.8" },
  ]

  export function enabled(): boolean {
    return process.env["ALTIMATE_ROUTER"] === "1"
  }

  /** Ladder from `ALTIMATE_ROUTER_LADDER` (comma-separated provider/model ids) or the default. */
  export function ladder(): Tier[] {
    const env = process.env["ALTIMATE_ROUTER_LADDER"]
    if (!env) return DEFAULT_LADDER
    const tiers = env
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((model) => ({ model, label: model.split("/").pop() || model }))
    return tiers.length ? tiers : DEFAULT_LADDER
  }

  /**
   * Escalate iff the verdict is escalation-worthy AND a stronger tier remains.
   *
   * Decision-aware: escalate on a build/test FAILURE or a PROVEN_DIFFERENT equivalence
   * verdict, but NOT on UNDECIDABLE — a stronger model does not make an undecidable
   * query decidable, and escalating on uncertainty is the gated-build cost-blowup
   * failure mode. UNDECIDABLE is handled by the verifier's own build/test fallback.
   * Falls back to the legacy `!ok` rule when a verdict carries no `decision` (back-compat).
   */
  export function shouldEscalate(verdict: Verifier.Verdict, tierIndex: number, tiers: Tier[]): boolean {
    if (tierIndex >= tiers.length - 1) return false
    if (verdict.decision === undefined) return !verdict.ok
    return (
      verdict.decision === Verifier.Decision.FAILED ||
      verdict.decision === Verifier.Decision.PROVEN_DIFFERENT
    )
  }

  /** The note handed to the next tier — names the exact failing checks so it fixes them. */
  export function escalationContext(prev: Tier, verdict: Verifier.Verdict): string {
    const failing = verdict.checks.filter((c) => !c.ok).map((c) => c.name)
    const lines = [
      `A previous attempt (by ${prev.label}) did not pass verification.`,
      verdict.reason ? `Verifier reason: ${verdict.reason}` : "",
      failing.length ? `Failing checks to fix: ${failing.join(", ")}.` : "",
      `The prior changes are in the workspace — fix these specific failures; do not start over.`,
    ]
    return lines.filter(Boolean).join("\n")
  }

  export interface Attempt {
    tier: Tier
    verdict: Verifier.Verdict
  }

  export interface RouteResult {
    solved: boolean
    solvedBy?: Tier
    attempts: Attempt[]
  }

  /**
   * Drive the ladder: run each tier, verify, escalate on failure with context,
   * stop at the first ok verdict. `runAgent(model, escalationNote?)` performs the
   * agent run in the shared workspace; `verify()` judges the post-run workspace.
   */
  export async function route(params: {
    tiers?: Tier[]
    runAgent: (model: string, escalationNote?: string) => Promise<void>
    verify: () => Promise<Verifier.Verdict>
  }): Promise<RouteResult> {
    const tiers = params.tiers ?? ladder()
    const attempts: Attempt[] = []
    let note: string | undefined
    for (let i = 0; i < tiers.length; i++) {
      const tier = tiers[i]
      // A thrown agent/verify error is treated as a failed attempt so the ladder can
      // escalate, rather than aborting the whole run on a transient failure in one tier.
      let verdict: Verifier.Verdict
      try {
        await params.runAgent(tier.model, note)
        verdict = await params.verify()
      } catch (e) {
        // A thrown tier is a FAILED attempt (escalate to the next tier), at UNVERIFIABLE
        // strength since no gate actually judged the output.
        verdict = {
          ok: false,
          strength: Verifier.Strength.UNVERIFIABLE,
          decision: Verifier.Decision.FAILED,
          reason: `tier error: ${String(e)}`,
          checks: [],
        }
      }
      attempts.push({ tier, verdict })
      if (verdict.ok) return { solved: true, solvedBy: tier, attempts }
      if (!shouldEscalate(verdict, i, tiers)) break
      note = escalationContext(tier, verdict)
    }
    return { solved: false, attempts }
  }
}
