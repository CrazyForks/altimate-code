import { describe, test, expect } from "bun:test"
import { McpOAuthProvider } from "../../src/mcp/oauth-provider"
import { McpAuth } from "../../src/mcp/auth"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

/**
 * Tests for McpOAuthProvider (oauth-provider.ts).
 *
 * Focuses on clientInformation() expiry logic, invalidateCredentials() mode
 * correctness, and tokens() format mapping — all integration tests using
 * real McpAuth storage (no mocks).
 */

describe("McpOAuthProvider.clientInformation: expiry handling", () => {
  test("returns config-based client info when clientId is set in config", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const provider = new McpOAuthProvider(
          "config-client",
          "https://example.com/mcp",
          { clientId: "my-client-id", clientSecret: "my-secret" },
          { onRedirect: async () => {} },
        )

        const info = await provider.clientInformation()
        expect(info).toEqual({
          client_id: "my-client-id",
          client_secret: "my-secret",
        })
      },
    })
  })

  test("returns stored client info from dynamic registration", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // Pre-populate stored client info (simulating dynamic registration)
        await McpAuth.updateClientInfo(
          "dynamic-client",
          { clientId: "dyn-id", clientSecret: "dyn-secret" },
          "https://example.com/mcp",
        )

        const provider = new McpOAuthProvider(
          "dynamic-client",
          "https://example.com/mcp",
          {}, // no config-based client
          { onRedirect: async () => {} },
        )

        const info = await provider.clientInformation()
        expect(info).toEqual({
          client_id: "dyn-id",
          client_secret: "dyn-secret",
        })
      },
    })
  })

  test("returns undefined when stored client secret has expired", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // Store client info with an expired clientSecretExpiresAt
        await McpAuth.updateClientInfo(
          "expired-client",
          {
            clientId: "exp-id",
            clientSecret: "exp-secret",
            clientSecretExpiresAt: 1, // epoch second 1, safely in the past
          },
          "https://example.com/mcp",
        )

        const provider = new McpOAuthProvider(
          "expired-client",
          "https://example.com/mcp",
          {},
          { onRedirect: async () => {} },
        )

        // Should return undefined, triggering re-registration
        const info = await provider.clientInformation()
        expect(info).toBeUndefined()
      },
    })
  })

  test("returns client info when clientSecretExpiresAt is in the future", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const futureExpiry = Date.now() / 1000 + 86400 // 24 hours from now

        await McpAuth.updateClientInfo(
          "valid-client",
          {
            clientId: "valid-id",
            clientSecret: "valid-secret",
            clientSecretExpiresAt: futureExpiry,
          },
          "https://example.com/mcp",
        )

        const provider = new McpOAuthProvider(
          "valid-client",
          "https://example.com/mcp",
          {},
          { onRedirect: async () => {} },
        )

        const info = await provider.clientInformation()
        expect(info).toBeDefined()
        expect(info!.client_id).toBe("valid-id")
      },
    })
  })

  test("returns undefined when URL has changed (getForUrl returns undefined)", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await McpAuth.updateClientInfo(
          "url-changed",
          { clientId: "old-id" },
          "https://old-server.com/mcp",
        )

        const provider = new McpOAuthProvider(
          "url-changed",
          "https://new-server.com/mcp", // different URL
          {},
          { onRedirect: async () => {} },
        )

        const info = await provider.clientInformation()
        expect(info).toBeUndefined()
      },
    })
  })
})

describe("McpOAuthProvider.tokens: format mapping", () => {
  test("maps internal token format to OAuthTokens correctly", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const expiresAt = Date.now() / 1000 + 3600

        await McpAuth.updateTokens(
          "token-map",
          {
            accessToken: "access-123",
            refreshToken: "refresh-456",
            expiresAt,
            scope: "read write",
          },
          "https://example.com/mcp",
        )

        const provider = new McpOAuthProvider(
          "token-map",
          "https://example.com/mcp",
          {},
          { onRedirect: async () => {} },
        )

        const tokens = await provider.tokens()
        expect(tokens).toBeDefined()
        expect(tokens!.access_token).toBe("access-123")
        expect(tokens!.token_type).toBe("Bearer")
        expect(tokens!.refresh_token).toBe("refresh-456")
        expect(tokens!.scope).toBe("read write")
        // expires_in should be roughly 3600 (within a few seconds)
        expect(tokens!.expires_in).toBeGreaterThan(3590)
        expect(tokens!.expires_in).toBeLessThanOrEqual(3600)
      },
    })
  })

  test("returns undefined when no tokens stored", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const provider = new McpOAuthProvider(
          "no-tokens",
          "https://example.com/mcp",
          {},
          { onRedirect: async () => {} },
        )

        const tokens = await provider.tokens()
        expect(tokens).toBeUndefined()
      },
    })
  })

  test("returns undefined when URL has changed", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await McpAuth.updateTokens(
          "tokens-old-url",
          { accessToken: "old-tok" },
          "https://old.example.com",
        )

        const provider = new McpOAuthProvider(
          "tokens-old-url",
          "https://new.example.com",
          {},
          { onRedirect: async () => {} },
        )

        const tokens = await provider.tokens()
        expect(tokens).toBeUndefined()
      },
    })
  })
})

describe("McpOAuthProvider.invalidateCredentials: mode correctness", () => {
  test("'all' removes entire auth entry", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await McpAuth.updateTokens("inv-all", { accessToken: "tok" })
        await McpAuth.updateClientInfo("inv-all", { clientId: "cid" })

        const provider = new McpOAuthProvider(
          "inv-all",
          "https://example.com",
          {},
          { onRedirect: async () => {} },
        )

        await provider.invalidateCredentials("all")

        const entry = await McpAuth.get("inv-all")
        expect(entry).toBeUndefined()
      },
    })
  })

  test("'tokens' removes only tokens, preserves clientInfo", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await McpAuth.updateTokens("inv-tokens", { accessToken: "tok" })
        await McpAuth.updateClientInfo("inv-tokens", { clientId: "cid" })

        const provider = new McpOAuthProvider(
          "inv-tokens",
          "https://example.com",
          {},
          { onRedirect: async () => {} },
        )

        await provider.invalidateCredentials("tokens")

        const entry = await McpAuth.get("inv-tokens")
        expect(entry).toBeDefined()
        expect(entry!.tokens).toBeUndefined()
        expect(entry!.clientInfo!.clientId).toBe("cid")
      },
    })
  })

  test("'client' removes only clientInfo, preserves tokens", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await McpAuth.updateTokens("inv-client", { accessToken: "tok" })
        await McpAuth.updateClientInfo("inv-client", { clientId: "cid" })

        const provider = new McpOAuthProvider(
          "inv-client",
          "https://example.com",
          {},
          { onRedirect: async () => {} },
        )

        await provider.invalidateCredentials("client")

        const entry = await McpAuth.get("inv-client")
        expect(entry).toBeDefined()
        expect(entry!.clientInfo).toBeUndefined()
        expect(entry!.tokens!.accessToken).toBe("tok")
      },
    })
  })

  test("invalidateCredentials is no-op when no entry exists", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const provider = new McpOAuthProvider(
          "nonexistent",
          "https://example.com",
          {},
          { onRedirect: async () => {} },
        )

        // Should not throw
        await provider.invalidateCredentials("all")
        await provider.invalidateCredentials("tokens")
        await provider.invalidateCredentials("client")
      },
    })
  })
})
