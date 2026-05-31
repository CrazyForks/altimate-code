/**
 * Routing policy — the decision of WHAT to route to, kept separate from the
 * mechanism that executes it.
 *
 * Two sources:
 *  - `STATIC`: the built-in default ladder, always available.
 *  - `altimate(key)`: when an altimate API key is configured, the routing policy is
 *    fetched per-context from the altimate API and used instead, and verified
 *    outcomes are reported back so the policy can be tuned over time.
 *
 * The client executes whatever policy it is handed. The SaaS policy activates only
 * when `ALTIMATE_API_KEY` is present, otherwise the static ladder is used.
 * Network/transport failures degrade to STATIC.
 */
import { Router } from "./router"
import type { Verdict } from "./verdict"

export namespace Policy {
  /** Signals available for routing decisions (extended over time). */
  export interface RoutingContext {
    prompt?: string
    projectType?: string
    taskId?: string
  }

  export interface RoutingPolicy {
    source: "static" | "altimate"
    tiers(ctx: RoutingContext): Promise<Router.Tier[]>
  }

  type Fetch = typeof globalThis.fetch

  /** Defensive cap: a bad/compromised policy endpoint must not inject a cost-bomb ladder. */
  export const MAX_TIERS = 8

  /**
   * Validate + cap a ladder returned by the policy endpoint. Keeps only entries with a
   * non-empty string `model`, derives a label when missing, caps to MAX_TIERS. Returns
   * null if nothing usable (caller falls back to the static ladder).
   */
  /** A model id must look like `provider/model[/...]` — plain chars only, no whitespace/control. */
  const MODEL_RE = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+$/

  export function sanitizeTiers(raw: unknown): Router.Tier[] | null {
    if (!Array.isArray(raw)) return null
    const out: Router.Tier[] = []
    for (const t of raw) {
      const model = (t as any)?.model
      if (typeof model !== "string") continue
      const m = model.trim()
      if (!m || m.length > 200 || !MODEL_RE.test(m)) continue
      const rawLabel = typeof (t as any)?.label === "string" && (t as any).label ? (t as any).label : m.split("/").pop() || m
      // Strip non-printable/ANSI — the label is printed to the terminal.
      const label = String(rawLabel).replace(/[^\x20-\x7E]/g, "").slice(0, 100) || m
      out.push({ model: m, label })
      if (out.length >= MAX_TIERS) break
    }
    return out.length ? out : null
  }

  export function apiKey(): string | undefined {
    return process.env["ALTIMATE_API_KEY"] || undefined
  }

  export function baseUrl(): string {
    return process.env["ALTIMATE_API_URL"] || "https://api.altimate.ai"
  }

  /** Built-in default ladder (env-overridable via ALTIMATE_ROUTER_LADDER). */
  export const STATIC: RoutingPolicy = {
    source: "static",
    async tiers() {
      return Router.ladder()
    },
  }

  /**
   * Customer routing policy served by the altimate API. Resolves the per-context
   * ladder for this account; degrades to the static ladder if the service is
   * unreachable or returns nothing usable.
   */
  export function altimate(key: string, base: string = baseUrl(), fetchImpl: Fetch = fetch): RoutingPolicy {
    return {
      source: "altimate",
      async tiers(ctx: RoutingContext): Promise<Router.Tier[]> {
        try {
          const res = await fetchImpl(`${base}/v1/router/policy`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
            body: JSON.stringify(ctx),
            signal: AbortSignal.timeout(3000),
          })
          if (!res.ok) return Router.ladder()
          const data = (await res.json()) as { tiers?: unknown }
          return sanitizeTiers(data?.tiers) ?? Router.ladder()
        } catch {
          return Router.ladder()
        }
      },
    }
  }

  /** The active policy: customer policy when an altimate key is set, else the static ladder. */
  export function resolve(fetchImpl: Fetch = fetch): RoutingPolicy {
    const key = apiKey()
    return key ? altimate(key, baseUrl(), fetchImpl) : STATIC
  }

  /**
   * Report a verified outcome back to the altimate service so the customer's policy
   * improves. Best-effort and key-gated — a no-op without a key, and never throws.
   */
  export async function reportOutcome(
    envelope: Verdict.Envelope,
    base: string = baseUrl(),
    fetchImpl: Fetch = fetch,
  ): Promise<void> {
    const key = apiKey()
    if (!key) return
    try {
      await fetchImpl(`${base}/v1/router/outcomes`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify(envelope),
        signal: AbortSignal.timeout(3000),
      })
    } catch {
      /* best-effort: outcome reporting must never break the run */
    }
  }
}
