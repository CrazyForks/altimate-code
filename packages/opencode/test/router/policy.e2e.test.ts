import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { Policy } from "../../src/router/policy"
import { Router } from "../../src/router/router"

// REAL network: a live local HTTP server (Bun.serve) + the real (unreachable) api.altimate.ai.
let server: ReturnType<typeof Bun.serve>
let base = ""
let mode = "good"
const outcomes: any[] = []

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname.endsWith("/outcomes")) {
        outcomes.push(await req.json().catch(() => null))
        return new Response("{}", { status: 200 })
      }
      switch (mode) {
        case "good":
          return Response.json({ tiers: [{ model: "openrouter/acme/fast", label: "acme-fast" }, { model: "openrouter/acme/strong" }] })
        case "500":
          return new Response("upstream error", { status: 500 })
        case "malformed":
          return new Response("not json {{{", { status: 200 })
        case "empty":
          return Response.json({ tiers: [] })
        case "garbage":
          return Response.json({ tiers: [{ nope: 1 }, "str", null, { model: "" }, { model: 123 }] })
        case "bomb":
          return Response.json({ tiers: Array.from({ length: 1000 }, (_, i) => ({ model: `openrouter/x/m${i}` })) })
        case "injection":
          return Response.json({ tiers: [{ model: "openrouter/evil/m", label: "<script>alert(1)</script>" }] })
        default:
          return new Response("", { status: 404 })
      }
    },
  })
  base = `http://localhost:${server.port}`
})
afterAll(() => server?.stop(true))
afterEach(() => {
  delete process.env["ALTIMATE_API_KEY"]
  delete process.env["ALTIMATE_ROUTER_LADDER"]
})

const STATIC0 = Router.DEFAULT_LADDER[0].label

describe("Policy × REAL network (no mocks)", () => {
  test("resolve() is static with no key (no network)", () => {
    expect(Policy.resolve().source).toBe("static")
  })

  test("good endpoint: fetches the customer ladder over real HTTP", async () => {
    mode = "good"
    const tiers = await Policy.altimate("k", base).tiers({ taskId: "t" })
    expect(tiers[0].label).toBe("acme-fast")
    expect(tiers[1].label).toBe("strong") // label derived from model
  })

  test("real UNREACHABLE endpoint (api.altimate.ai) → graceful fallback to static", async () => {
    const tiers = await Policy.altimate("k", "https://api.altimate.ai").tiers({})
    expect(tiers[0].label).toBe(STATIC0)
  }, 30_000)

  test("reportOutcome posts to a real server when keyed; best-effort (no throw) when unreachable", async () => {
    process.env["ALTIMATE_API_KEY"] = "k"
    await Policy.reportOutcome(
      { schemaVersion: "1", solved: true, solvedBy: "glm-5.1", tier: 1, unverifiable: false, attempts: [], checks: [], evidenceHash: "djb2:0", createdAt: "t" },
      base,
    )
    expect(outcomes.at(-1)?.solvedBy).toBe("glm-5.1")
    // unreachable host must not throw
    await Policy.reportOutcome(
      { schemaVersion: "1", solved: false, solvedBy: null, tier: null, unverifiable: false, attempts: [], checks: [], evidenceHash: "djb2:0", createdAt: "t" },
      "https://api.altimate.ai",
    )
  }, 30_000)
})

describe("Policy × REAL network — ADVERSARIAL endpoint responses", () => {
  const cases: [string, (t: Router.Tier[]) => void][] = [
    ["500", (t) => expect(t[0].label).toBe(STATIC0)],
    ["malformed", (t) => expect(t[0].label).toBe(STATIC0)],
    ["empty", (t) => expect(t[0].label).toBe(STATIC0)],
    ["garbage", (t) => expect(t[0].label).toBe(STATIC0)], // no valid model → fallback
  ]
  for (const [m, assert] of cases) {
    test(`'${m}' response → graceful fallback to static`, async () => {
      mode = m
      assert(await Policy.altimate("k", base).tiers({}))
    })
  }

  test("'bomb' (1000-tier cost bomb) → capped to MAX_TIERS", async () => {
    mode = "bomb"
    const tiers = await Policy.altimate("k", base).tiers({})
    expect(tiers.length).toBe(Policy.MAX_TIERS)
  })

  test("'injection' label → kept as inert string, does not crash; single tier", async () => {
    mode = "injection"
    const tiers = await Policy.altimate("k", base).tiers({})
    expect(tiers).toHaveLength(1)
    expect(tiers[0].model).toBe("openrouter/evil/m")
    expect(typeof tiers[0].label).toBe("string")
  })
})
