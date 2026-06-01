/**
 * Pre-execution critic gate.
 *
 * Before a SIDE-EFFECTING tool runs (bash, write, edit, sql_execute, dbt_*), a
 * verifier checks the proposed args; on hard failure the call is denied and the
 * reason is fed back so the model can retry — instead of executing a bad action.
 *
 * The judgment plugs in via the `Verifier` interface; the default verifier ALLOWS
 * everything (ungated) and a real verifier is injected by the caller.
 *
 * Pure + testable. Wiring point: session/prompt.ts execute wrapper, just before
 * `item.execute(args, ctx)`.
 */

export namespace Critic {
  /** Side-effecting tools worth gating. Reads (glob/grep/read) are never gated. */
  export const DEFAULT_GATED = ["bash", "write", "edit", "sql_execute", "dbt_run", "patch"]

  export interface Verdict {
    ok: boolean
    reason?: string
  }

  /** The judgment interface. Default impl allows all (open). Product plugs altimate-core. */
  export interface Verifier {
    verify(toolName: string, args: Record<string, any>): Verdict | Promise<Verdict>
  }

  export const ALLOW_ALL: Verifier = { verify: () => ({ ok: true }) }

  export function enabled(): boolean {
    return process.env["ALTIMATE_CRITIC_GATE"] === "1"
  }

  export function isGated(toolName: string, gated: string[] = DEFAULT_GATED): boolean {
    return gated.includes(toolName)
  }

  export interface GateResult {
    allow: boolean
    /** when blocked, the message to feed back to the model in place of execution. */
    feedback?: string
  }

  /**
   * Decide whether a proposed tool call may execute. Non-gated tools always pass.
   * Gated tools are checked by the verifier; a not-ok verdict blocks with feedback.
   * NEVER throws — a critic failure must not break the agent (fail-open on error).
   */
  export async function gate(
    toolName: string,
    args: Record<string, any>,
    verifier: Verifier = ALLOW_ALL,
    gated: string[] = DEFAULT_GATED,
  ): Promise<GateResult> {
    if (!enabled() || !isGated(toolName, gated)) return { allow: true }
    try {
      const v = await verifier.verify(toolName, args)
      if (v.ok) return { allow: true }
      return {
        allow: false,
        feedback: `Blocked by altimate verifier before execution: ${v.reason ?? "failed validation"}. Fix and retry.`,
      }
    } catch {
      // Fail-open: observability/governance must never break core functionality.
      return { allow: true }
    }
  }
}
