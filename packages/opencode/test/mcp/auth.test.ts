import { describe, test, expect } from "bun:test"
import { McpAuth } from "../../src/mcp/auth"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

/**
 * Tests for MCP auth credential storage (auth.ts).
 *
 * Focuses on getForUrl (URL-based credential validation) and isTokenExpired
 * (token expiry computation) — both security-critical for preventing stale
 * credential reuse when MCP server URLs change.
 */

describe("McpAuth.getForUrl: URL-based credential validation", () => {
  test("returns entry when serverUrl matches", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await McpAuth.updateTokens(
          "test-server",
          { accessToken: "tok-123", refreshToken: "ref-456" },
          "https://example.com/mcp",
        )

        const entry = await McpAuth.getForUrl("test-server", "https://example.com/mcp")
        expect(entry).toBeDefined()
        expect(entry!.tokens!.accessToken).toBe("tok-123")
      },
    })
  })

  test("returns undefined when serverUrl does not match (URL changed)", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await McpAuth.updateTokens(
          "moved-server",
          { accessToken: "old-token" },
          "https://old-url.com/mcp",
        )

        // User changed the MCP server URL — old credentials must NOT be returned
        const entry = await McpAuth.getForUrl("moved-server", "https://new-url.com/mcp")
        expect(entry).toBeUndefined()
      },
    })
  })

  test("returns undefined when no serverUrl is stored (old version migration)", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // Simulate an entry from an older version that didn't store serverUrl
        await McpAuth.set("legacy-server", {
          tokens: { accessToken: "legacy-token" },
        })

        const entry = await McpAuth.getForUrl("legacy-server", "https://example.com/mcp")
        expect(entry).toBeUndefined()
      },
    })
  })

  test("returns undefined for nonexistent server name", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const entry = await McpAuth.getForUrl("no-such-server", "https://example.com/mcp")
        expect(entry).toBeUndefined()
      },
    })
  })
})

describe("McpAuth.isTokenExpired", () => {
  test("returns null when no tokens exist", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const result = await McpAuth.isTokenExpired("nonexistent")
        expect(result).toBeNull()
      },
    })
  })

  test("returns false when token has no expiresAt", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await McpAuth.updateTokens("no-expiry", {
          accessToken: "forever-token",
        })

        const result = await McpAuth.isTokenExpired("no-expiry")
        expect(result).toBe(false)
      },
    })
  })

  test("returns true when token expiresAt is in the past", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await McpAuth.updateTokens("expired", {
          accessToken: "old-token",
          expiresAt: 1, // epoch second 1 — safely in the past
        })

        const result = await McpAuth.isTokenExpired("expired")
        expect(result).toBe(true)
      },
    })
  })

  test("returns false when token expiresAt is in the future", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await McpAuth.updateTokens("fresh", {
          accessToken: "fresh-token",
          expiresAt: Date.now() / 1000 + 3600, // 1 hour from now
        })

        const result = await McpAuth.isTokenExpired("fresh")
        expect(result).toBe(false)
      },
    })
  })
})

describe("McpAuth: CRUD operations preserve data correctly", () => {
  test("updateTokens merges with existing entry", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // First store client info
        await McpAuth.updateClientInfo("merge-test", {
          clientId: "client-1",
          clientSecret: "secret-1",
        })

        // Then store tokens — should not clobber client info
        await McpAuth.updateTokens("merge-test", {
          accessToken: "tok-1",
        })

        const entry = await McpAuth.get("merge-test")
        expect(entry!.clientInfo!.clientId).toBe("client-1")
        expect(entry!.tokens!.accessToken).toBe("tok-1")
      },
    })
  })

  test("set with serverUrl stores the URL", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await McpAuth.set(
          "url-test",
          { tokens: { accessToken: "tok" } },
          "https://my-mcp.example.com",
        )

        const entry = await McpAuth.get("url-test")
        expect(entry!.serverUrl).toBe("https://my-mcp.example.com")
      },
    })
  })

  test("remove deletes the entry entirely", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await McpAuth.updateTokens("to-remove", { accessToken: "tok" })
        expect(await McpAuth.get("to-remove")).toBeDefined()

        await McpAuth.remove("to-remove")
        expect(await McpAuth.get("to-remove")).toBeUndefined()
      },
    })
  })

  test("clearCodeVerifier removes only codeVerifier", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await McpAuth.updateCodeVerifier("verifier-test", "my-verifier")
        await McpAuth.updateOAuthState("verifier-test", "my-state")

        await McpAuth.clearCodeVerifier("verifier-test")

        const entry = await McpAuth.get("verifier-test")
        expect(entry!.codeVerifier).toBeUndefined()
        expect(entry!.oauthState).toBe("my-state")
      },
    })
  })
})
