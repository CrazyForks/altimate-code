// altimate_change start — rewritten to drop mock.module() (which leaks across
// test files in Bun's multi-file runner — was the root cause of issue #704
// theme tests + several other suites failing under parallel load).
//
// The original test mocked @/util/log, @/project/instance, @/util/rpc and
// @/cli/cmd/tui/app via mock.module() to intercept what `directory` got
// passed downstream. Those mocks survived to subsequent test files and
// turned Log.Default.* into no-ops, breaking any later test that depended
// on real logger behaviour.
//
// Fix: src/cli/cmd/tui/thread.ts now exposes the directory-resolution logic
// as a pure helper `resolveProjectDirectory(project, pwd, cwd)`. Tests call
// it directly with controlled inputs — no mocks, no leakage.
// altimate_change end
import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { tmpdir } from "../../fixture/fixture"
import { resolveProjectDirectory } from "../../../src/cli/cmd/tui/thread"

describe("tui thread > resolveProjectDirectory", () => {
  test("uses the real cwd when PWD points at a symlink", async () => {
    await using tmp = await tmpdir({ git: true })
    const link = path.join(path.dirname(tmp.path), path.basename(tmp.path) + "-link")
    const linkType = process.platform === "win32" ? "junction" : "dir"
    await fs.symlink(tmp.path, link, linkType)
    try {
      // The first arg is the symlink path (acting as the env var pointing at
      // the symlink); the second arg is the real cwd. With no project arg the
      // resolver should return realpath(cwd) which equals tmp.path.
      const resolved = resolveProjectDirectory(undefined, link, tmp.path)
      expect(resolved).toBe(tmp.path)
    } finally {
      await fs.rm(link, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  test("uses the real cwd after resolving a relative project from PWD", async () => {
    await using tmp = await tmpdir({ git: true })
    const link = path.join(path.dirname(tmp.path), path.basename(tmp.path) + "-link")
    const linkType = process.platform === "win32" ? "junction" : "dir"
    await fs.symlink(tmp.path, link, linkType)
    try {
      // project arg is ".", second arg is the symlink path. The resolver
      // joins them and runs realpath, which should return tmp.path.
      const resolved = resolveProjectDirectory(".", link, tmp.path)
      expect(resolved).toBe(tmp.path)
    } finally {
      await fs.rm(link, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  test("absolute --project bypasses the env-supplied root entirely", async () => {
    await using tmp = await tmpdir({ git: true })
    const resolved = resolveProjectDirectory(tmp.path, "/some/unrelated/root", "/another/cwd")
    expect(resolved).toBe(tmp.path)
  })

  test("falls back to cwd when project is missing", async () => {
    await using tmp = await tmpdir({ git: true })
    const resolved = resolveProjectDirectory(undefined, tmp.path, tmp.path)
    expect(resolved).toBe(tmp.path)
  })
})
