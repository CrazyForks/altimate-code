import { afterEach, describe, expect, test } from "bun:test"
import { Policy } from "../../src/router/policy"
import { Router } from "../../src/router/router"
import type { Verdict } from "../../src/router/verdict"

afterEach(() => {
  delete process.env["ALTIMATE_API_KEY"]
  delete process.env["ALTIMATE_API_URL"]
  delete process.env["ALTIMATE_ROUTER_LADDER"]
})

function fakeFetch(handler: (url: string, init: any) => { ok: boolean; json: () => any }) {
  const calls: { url: string; init: any }[] = []
  const fn = (async (url: string, init: any) => {
    calls.push({ url, init })
    const r = handler(url, init)
    return { ok: r.ok, json: async () => r.json() } as any
  }) as unknown as typeof fetch
  return Object.assign(fn, { calls })
}

describe("Policy.STATIC", () => {
  test("returns the calibrated default ladder", async () => {
    const tiers = await Policy.STATIC.tiers({})
    expect(tiers[0].label).toBe("deepseek-v4-flash")
    expect(Policy.STATIC.source).toBe("static")
  })
  test("honors the env ladder override", async () => {
    process.env["ALTIMATE_ROUTER_LADDER"] = "openrouter/x/y"
    expect((await Policy.STATIC.tiers({}))[0].label).toBe("y")
  })
})

describe("Policy.sanitizeTiers (defense against bad/compromised endpoint)", () => {
  test("keeps valid tiers + derives missing labels", () => {
    const t = Policy.sanitizeTiers([{ model: "p/a", label: "A" }, { model: "p/b" }])
    expect(t).toEqual([{ model: "p/a", label: "A" }, { model: "p/b", label: "b" }])
  })
  test("filters entries without a usable string model", () => {
    expect(Policy.sanitizeTiers([{ nope: 1 }, "str", null, { model: "" }, { model: 123 }, { model: "p/ok" }])).toEqual([
      { model: "p/ok", label: "ok" },
    ])
  })
  test("caps a cost-bomb ladder to MAX_TIERS", () => {
    const big = Array.from({ length: 1000 }, (_, i) => ({ model: `p/m${i}` }))
    expect(Policy.sanitizeTiers(big)!).toHaveLength(Policy.MAX_TIERS)
  })
  test("returns null for non-array / all-invalid (caller falls back to static)", () => {
    expect(Policy.sanitizeTiers(null)).toBeNull()
    expect(Policy.sanitizeTiers("nope")).toBeNull()
    expect(Policy.sanitizeTiers([{ nope: 1 }])).toBeNull()
  })
  test("rejects malformed model ids (no slash, whitespace, control chars, over-long)", () => {
    expect(Policy.sanitizeTiers([{ model: "noslash" }])).toBeNull()
    expect(Policy.sanitizeTiers([{ model: "p/ a" }])).toBeNull()
    expect(Policy.sanitizeTiers([{ model: "p/[31mx" }])).toBeNull()
    expect(Policy.sanitizeTiers([{ model: "p/" + "x".repeat(300) }])).toBeNull()
  })
  test("strips non-printable/ANSI from label (printed to terminal)", () => {
    const t = Policy.sanitizeTiers([{ model: "p/evil", label: "ok[31mbad" }])
    expect(t![0].label).toBe("ok[31mbad") // ESC + BEL stripped, printable kept
  })
})

describe("Policy.resolve", () => {
  test("static when no altimate key", () => {
    expect(Policy.resolve().source).toBe("static")
  })
  test("altimate (customer) policy when key present", () => {
    process.env["ALTIMATE_API_KEY"] = "sk-altimate-test"
    expect(Policy.resolve().source).toBe("altimate")
  })
})

describe("Policy.altimate (customer policy)", () => {
  test("fetches the per-context ladder with auth", async () => {
    const ff = fakeFetch(() => ({
      ok: true,
      json: () => ({ tiers: [{ model: "openrouter/acme/fast", label: "acme-fast" }] }),
    }))
    const p = Policy.altimate("sk-acme", "https://api.altimate.ai", ff)
    const tiers = await p.tiers({ taskId: "t1", projectType: "dbt" })
    expect(tiers[0].label).toBe("acme-fast")
    expect(ff.calls[0].url).toContain("/v1/router/policy")
    expect(ff.calls[0].init.headers.Authorization).toBe("Bearer sk-acme")
  })
  test("falls back to static ladder on non-ok response", async () => {
    const ff = fakeFetch(() => ({ ok: false, json: () => ({}) }))
    const tiers = await Policy.altimate("k", "https://api.altimate.ai", ff).tiers({})
    expect(tiers[0].label).toBe(Router.DEFAULT_LADDER[0].label)
  })
  test("falls back to static ladder when transport throws", async () => {
    const boom = (async () => {
      throw new Error("network down")
    }) as unknown as typeof fetch
    const tiers = await Policy.altimate("k", "https://api.altimate.ai", boom).tiers({})
    expect(tiers[0].label).toBe(Router.DEFAULT_LADDER[0].label)
  })
})

describe("Policy.reportOutcome", () => {
  const env: Verdict.Envelope = {
    schemaVersion: "1", solved: true, solvedBy: "glm-5.1", tier: 1, unverifiable: false, attempts: [], checks: [], evidenceHash: "djb2:0", createdAt: "2026-05-31T00:00:00Z",
  }
  test("no-op without a key", async () => {
    const ff = fakeFetch(() => ({ ok: true, json: () => ({}) }))
    await Policy.reportOutcome(env, "https://api.altimate.ai", ff)
    expect(ff.calls).toHaveLength(0)
  })
  test("posts the verdict envelope when a key is set", async () => {
    process.env["ALTIMATE_API_KEY"] = "sk-acme"
    const ff = fakeFetch(() => ({ ok: true, json: () => ({}) }))
    await Policy.reportOutcome(env, "https://api.altimate.ai", ff)
    expect(ff.calls[0].url).toContain("/v1/router/outcomes")
    expect(JSON.parse(ff.calls[0].init.body).solvedBy).toBe("glm-5.1")
  })
})
