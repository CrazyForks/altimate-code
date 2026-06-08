import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Router } from "../../src/router/router"
import { Verifier } from "../../src/router/verifier"
import { Verdict } from "../../src/router/verdict"

// REAL OpenRouter calls + REAL dbt. No mocks.
const KEY = process.env["OPENROUTER_API_KEY"] || ""
const IMG = process.env["E2E_IMG"] || "" // provide a docker image with dbt-duckdb; no default
const OR = "https://openrouter.ai/api/v1"
// Opt-in, infra-dependent suite: skipped (not failed) without a key + image (e.g. CI).
const SKIP = !KEY || !IMG

const dirs: string[] = []
function project(models: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "e2e-router-"))
  dirs.push(dir)
  writeFileSync(join(dir, "dbt_project.yml"), `name: e2e\nprofile: e2e\nversion: "1.0"\nflags:\n  send_anonymous_usage_stats: false\nmodels:\n  e2e:\n    +materialized: table\n`)
  writeFileSync(join(dir, "profiles.yml"), `e2e:\n  target: dev\n  outputs:\n    dev:\n      type: duckdb\n      path: /proj/e2e.duckdb\n`)
  mkdirSync(join(dir, "models"))
  for (const [n, sql] of Object.entries(models)) writeFileSync(join(dir, "models", n), sql)
  return dir
}

async function realVerify(dir: string): Promise<Verifier.Verdict> {
  return Verifier.dbtVerifier((cmd, workdir) => {
    const p = Bun.spawnSync(
      ["docker", "run", "--rm", "-v", `${workdir}:/proj`, "-w", "/proj", IMG, "bash", "-lc", `${cmd} --profiles-dir /proj 2>&1`],
      { stdout: "pipe", stderr: "pipe" },
    )
    return Promise.resolve({ output: (p.stdout?.toString() ?? "") + (p.stderr?.toString() ?? ""), exitCode: p.exitCode ?? 1 })
  }).verify(dir)
}

function extractSql(s: string): string {
  const fenced = s.match(/```(?:sql)?\s*([\s\S]*?)```/i)
  return (fenced ? fenced[1] : s).trim()
}

// A real model call that writes the requested dbt model into the workspace.
async function realRunAgent(model: string, note: string | undefined, dir: string, task: string, log: { model: string; note?: string }[]) {
  log.push({ model, note })
  const apiModel = model.replace(/^openrouter\//, "")
  const res = await fetch(`${OR}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: apiModel,
      messages: [
        { role: "system", content: "You are a dbt engineer. Output ONLY the SQL for the requested model in a ```sql code block. No prose, no schema.yml." },
        { role: "user", content: task + (note ? `\n\nA PREVIOUS ATTEMPT FAILED VERIFICATION:\n${note}` : "") },
      ],
      max_tokens: 600,
      temperature: 0,
    }),
  })
  const j: any = await res.json()
  const sql = extractSql(j?.choices?.[0]?.message?.content ?? "select 1 as id")
  writeFileSync(join(dir, "models", "answer.sql"), sql)
}

beforeAll(() => {
  if (SKIP) return
  if (Bun.spawnSync(["docker", "image", "inspect", IMG], { stdout: "ignore", stderr: "ignore" }).exitCode !== 0)
    throw new Error(`image ${IMG} missing`)
})
afterAll(() => {
  for (const d of dirs) try { Bun.spawnSync(["sudo", "rm", "-rf", d]); rmSync(d, { recursive: true, force: true }) } catch {}
})

describe.skipIf(SKIP)("Router × REAL OpenRouter + REAL dbt (no mocks)", () => {
  test("solves at the cheap tier → no escalation (1 real call)", async () => {
    const dir = project({})
    const log: { model: string; note?: string }[] = []
    const task = "Create a dbt model named `answer` that selects the integer 42 aliased as `value`. Materialized as a table."
    const result = await Router.route({
      tiers: [{ model: "openrouter/deepseek/deepseek-v4-flash", label: "deepseek-v4-flash" }],
      runAgent: (m, note) => realRunAgent(m, note, dir, task, log),
      verify: () => realVerify(dir),
    })
    expect(result.solved).toBe(true)
    expect(result.solvedBy?.label).toBe("deepseek-v4-flash")
    expect(log).toHaveLength(1) // only the cheap tier ran
    // verdict envelope from a real run
    const env = Verdict.build(result, { now: "2026-05-31T00:00:00Z" })
    expect(env.solved).toBe(true)
    expect(env.tier).toBe(0)
  }, 180_000)

  test("ADVERSARIAL: unsatisfiable workspace → escalates through every real tier, caps, threads failure context", async () => {
    // An unrelated, locked broken model makes verification fail no matter what the agent writes,
    // forcing real escalation through both tiers. Tests real multi-model escalation + capping +
    // that the exact failing node is handed to the next real model.
    const dir = project({ "locked_broken.sql": "select notacolumn as x" })
    const log: { model: string; note?: string }[] = []
    const task = "Create a dbt model named `answer` selecting 1 as id."
    const result = await Router.route({
      tiers: [
        { model: "openrouter/deepseek/deepseek-v4-flash", label: "deepseek-v4-flash" },
        { model: "openrouter/z-ai/glm-5.1", label: "glm-5.1" },
      ],
      runAgent: (m, note) => realRunAgent(m, note, dir, task, log),
      verify: () => realVerify(dir),
    })
    expect(result.solved).toBe(false) // genuinely unsolvable here
    expect(result.attempts).toHaveLength(2) // escalated through BOTH real tiers
    expect(log.map((l) => l.model)).toEqual([
      "openrouter/deepseek/deepseek-v4-flash",
      "openrouter/z-ai/glm-5.1",
    ])
    expect(log[0].note).toBeUndefined()
    expect(log[1].note ?? "").toMatch(/locked_broken|did not pass/i) // real failing-check context threaded
  }, 240_000)
})
