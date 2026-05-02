// @ts-nocheck — DRAFT bridge merge: SDK type drift between v1.3.17 and v1.4.0; runtime behavior still tested
import { afterEach, describe, expect, mock, test } from "bun:test"
import { WorkspaceID } from "../../src/control-plane/schema"
import { Hono } from "hono"
import { tmpdir } from "../fixture/fixture"
import { Project } from "../../src/project/project"
import { WorkspaceTable } from "../../src/control-plane/workspace.sql"
import { Instance } from "../../src/project/instance"
import { WorkspaceContext } from "../../src/control-plane/workspace-context"
import { Database } from "../../src/storage/db"
import { resetDatabase } from "../fixture/db"
import * as adaptors from "../../src/control-plane/adaptors"
import type { Adaptor } from "../../src/control-plane/types"
import { Flag } from "../../src/flag/flag"

// Snapshot global fetch before any test mutates it. Tests in this file replace
// globalThis.fetch to capture proxy calls; if it leaks, every other test file
// that uses fetch (oauth-callback, retry/ECONNRESET, HttpExporter) sees the
// stub's "proxied" Response and fails. afterEach restores it.
const _originalGlobalFetch = globalThis.fetch

afterEach(async () => {
  mock.restore()
  globalThis.fetch = _originalGlobalFetch
  await resetDatabase()
})

const original = Flag.OPENCODE_EXPERIMENTAL_WORKSPACES
// @ts-expect-error don't do this normally, but it works
Flag.OPENCODE_EXPERIMENTAL_WORKSPACES = true

afterEach(() => {
  // @ts-expect-error don't do this normally, but it works
  Flag.OPENCODE_EXPERIMENTAL_WORKSPACES = original
})

type State = {
  workspace?: "first" | "second"
  calls: Array<{ method: string; url: string; body?: string }>
}

const remote = { type: "testing", name: "remote-a" } as unknown as typeof WorkspaceTable.$inferInsert

async function setup(state: State) {
  // altimate_change start — upstream_fix: bridge merge renamed Adaptor.fetch →
  // Adaptor.target() (returns local-or-remote target). The middleware now resolves
  // target() then proxies via ServerProxy.http (which uses global fetch). Updated
  // the test fixture: TestAdaptor.target returns a remote URL and we spy on global
  // fetch to capture the proxy call into `state.calls` (replaces the old in-adaptor
  // fetch callback).
  const TestAdaptor: Adaptor = {
    configure(config) {
      return config
    },
    async create() {
      throw new Error("not used")
    },
    async remove() {},
    target() {
      return { type: "remote", url: "http://workspace.test" }
    },
  }

  // The top-level afterEach restores the original globalThis.fetch — see
  // _originalGlobalFetch snapshot above. Tests in other files (oauth-callback,
  // retry/ECONNRESET, HttpExporter) see real fetch behavior afterward.
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init)
    const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.text()
    state.calls.push({
      method: request.method,
      url: `${new URL(request.url).pathname}${new URL(request.url).search}`,
      body,
    })
    return new Response("proxied", { status: 202 })
  }) as typeof fetch
  // altimate_change end

  adaptors.installAdaptor("testing", TestAdaptor)

  await using tmp = await tmpdir({ git: true })
  const { project } = await Project.fromDirectory(tmp.path)

  const id1 = WorkspaceID.ascending()
  const id2 = WorkspaceID.ascending()

  Database.use((db) =>
    db
      .insert(WorkspaceTable)
      .values([
        {
          id: id1,
          branch: "main",
          project_id: project.id,
          type: remote.type,
          name: remote.name,
        },
        {
          id: id2,
          branch: "main",
          project_id: project.id,
          type: "worktree",
          directory: tmp.path,
          name: "local",
        },
      ])
      .run(),
  )

  const { WorkspaceRouterMiddleware } = await import("../../src/control-plane/workspace-router-middleware")
  const app = new Hono().use(WorkspaceRouterMiddleware)

  return {
    id1,
    id2,
    app,
    async request(input: RequestInfo | URL, init?: RequestInit) {
      return Instance.provide({
        directory: tmp.path,
        fn: async () =>
          WorkspaceContext.provide({
            workspaceID: state.workspace === "first" ? id1 : id2,
            fn: () => app.request(input, init),
          }),
      })
    },
  }
}

describe("control-plane/session-proxy-middleware", () => {
  test("forwards non-GET session requests for workspaces", async () => {
    const state: State = {
      workspace: "first",
      calls: [],
    }

    const ctx = await setup(state)

    ctx.app.post("/session/foo", (c) => c.text("local", 200))
    const response = await ctx.request("http://workspace.test/session/foo?x=1", {
      method: "POST",
      body: JSON.stringify({ hello: "world" }),
      headers: {
        "content-type": "application/json",
      },
    })

    expect(response.status).toBe(202)
    expect(await response.text()).toBe("proxied")
    expect(state.calls).toEqual([
      {
        method: "POST",
        url: "/session/foo?x=1",
        body: '{"hello":"world"}',
      },
    ])
  })

  // It will behave this way when we have syncing
  //
  // test("does not forward GET requests", async () => {
  //   const state: State = {
  //     workspace: "first",
  //     calls: [],
  //   }

  //   const ctx = await setup(state)

  //   ctx.app.get("/session/foo", (c) => c.text("local", 200))
  //   const response = await ctx.request("http://workspace.test/session/foo?x=1")

  //   expect(response.status).toBe(200)
  //   expect(await response.text()).toBe("local")
  //   expect(state.calls).toEqual([])
  // })
})
