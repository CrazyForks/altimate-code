import { describe, test, expect, afterEach } from "bun:test"
import { McpOAuthCallback } from "../../src/mcp/oauth-callback"

/**
 * Tests for the MCP OAuth callback server (oauth-callback.ts).
 *
 * The escapeHtml function is not exported, so we test it indirectly through
 * the HTTP handler's HTML responses. This verifies the full callback flow
 * including CSRF state validation — the primary user-facing security surface.
 */

const CALLBACK_PORT = 19876
const CALLBACK_PATH = "/mcp/oauth/callback"
const BASE_URL = `http://127.0.0.1:${CALLBACK_PORT}${CALLBACK_PATH}`

afterEach(async () => {
  await McpOAuthCallback.stop()
})

describe("McpOAuthCallback: CSRF state validation", () => {
  test("missing state parameter returns 400 with CSRF warning", async () => {
    await McpOAuthCallback.ensureRunning()

    const res = await fetch(`${BASE_URL}?code=abc123`)
    expect(res.status).toBe(400)

    const html = await res.text()
    expect(html).toContain("Missing required state parameter")
    expect(html).toContain("Authorization Failed")
  })

  test("invalid/expired state parameter returns 400", async () => {
    await McpOAuthCallback.ensureRunning()

    const res = await fetch(`${BASE_URL}?code=abc123&state=nonexistent-state`)
    expect(res.status).toBe(400)

    const html = await res.text()
    expect(html).toContain("Invalid or expired state parameter")
  })

  test("missing code returns 400", async () => {
    await McpOAuthCallback.ensureRunning()

    // Register a pending auth so state is valid
    const pending = McpOAuthCallback.waitForCallback("valid-state-no-code")

    const res = await fetch(`${BASE_URL}?state=valid-state-no-code`)
    expect(res.status).toBe(400)

    const html = await res.text()
    expect(html).toContain("No authorization code provided")

    // Clean up pending auth — cancel it so the test doesn't hang
    McpOAuthCallback.cancelPending("valid-state-no-code")
    await pending.catch(() => {})
  })
})

describe("McpOAuthCallback: successful authorization", () => {
  test("valid code + state resolves pending auth and returns success HTML", async () => {
    await McpOAuthCallback.ensureRunning()

    const authPromise = McpOAuthCallback.waitForCallback("test-state-123")

    const res = await fetch(`${BASE_URL}?code=my-auth-code&state=test-state-123`)
    expect(res.status).toBe(200)

    const html = await res.text()
    expect(html).toContain("Authorization Successful")
    expect(html).toContain("You can close this window")

    // The pending auth should have resolved with the code
    const code = await authPromise
    expect(code).toBe("my-auth-code")
  })
})

describe("McpOAuthCallback: error parameter handling", () => {
  test("error parameter rejects pending auth and returns error HTML", async () => {
    await McpOAuthCallback.ensureRunning()

    const authPromise = McpOAuthCallback.waitForCallback("error-state")
    // Attach catch handler immediately to prevent unhandled rejection
    let rejectedError: Error | undefined
    const catchPromise = authPromise.catch((e) => {
      rejectedError = e
    })

    const res = await fetch(`${BASE_URL}?error=access_denied&error_description=User+denied+access&state=error-state`)

    const html = await res.text()
    expect(html).toContain("Authorization Failed")
    expect(html).toContain("User denied access")

    await catchPromise
    expect(rejectedError).toBeDefined()
    expect(rejectedError!.message).toBe("User denied access")
  })

  test("error without description uses error code", async () => {
    await McpOAuthCallback.ensureRunning()

    const authPromise = McpOAuthCallback.waitForCallback("error-state-2")
    let rejectedError: Error | undefined
    const catchPromise = authPromise.catch((e) => {
      rejectedError = e
    })

    const res = await fetch(`${BASE_URL}?error=server_error&state=error-state-2`)

    const html = await res.text()
    expect(html).toContain("server_error")

    await catchPromise
    expect(rejectedError).toBeDefined()
    expect(rejectedError!.message).toBe("server_error")
  })
})

describe("McpOAuthCallback: XSS prevention via escapeHtml", () => {
  test("HTML special characters in error_description are escaped", async () => {
    await McpOAuthCallback.ensureRunning()

    // The attacker controls error_description from the OAuth server
    const xssPayload = '<script>alert("xss")</script>&"test"'
    const encodedPayload = encodeURIComponent(xssPayload)

    // Need a pending auth so state validation passes
    const authPromise = McpOAuthCallback.waitForCallback("xss-state")
    // Attach catch handler immediately to prevent unhandled rejection
    const catchPromise = authPromise.catch(() => {})

    const res = await fetch(`${BASE_URL}?error=bad&error_description=${encodedPayload}&state=xss-state`)
    const html = await res.text()

    // The raw script tag must NOT appear in the HTML
    expect(html).not.toContain("<script>")
    expect(html).not.toContain('alert("xss")')

    // The escaped versions should be present
    expect(html).toContain("&lt;script&gt;")
    expect(html).toContain("&amp;")
    expect(html).toContain("&quot;")

    await catchPromise
  })
})

describe("McpOAuthCallback: non-callback paths", () => {
  test("non-callback path returns 404", async () => {
    await McpOAuthCallback.ensureRunning()

    const res = await fetch(`http://127.0.0.1:${CALLBACK_PORT}/some/other/path`)
    expect(res.status).toBe(404)
  })
})

describe("McpOAuthCallback: lifecycle", () => {
  test("isRunning reflects server state", async () => {
    expect(McpOAuthCallback.isRunning()).toBe(false)

    await McpOAuthCallback.ensureRunning()
    expect(McpOAuthCallback.isRunning()).toBe(true)

    await McpOAuthCallback.stop()
    expect(McpOAuthCallback.isRunning()).toBe(false)
  })

  test("stop() rejects all pending auths", async () => {
    await McpOAuthCallback.ensureRunning()

    const promise1 = McpOAuthCallback.waitForCallback("pending-1")
    const promise2 = McpOAuthCallback.waitForCallback("pending-2")

    await McpOAuthCallback.stop()

    await expect(promise1).rejects.toThrow("OAuth callback server stopped")
    await expect(promise2).rejects.toThrow("OAuth callback server stopped")
  })

  test("cancelPending rejects a specific pending auth", async () => {
    await McpOAuthCallback.ensureRunning()

    const promise = McpOAuthCallback.waitForCallback("cancel-me")

    McpOAuthCallback.cancelPending("cancel-me")

    await expect(promise).rejects.toThrow("Authorization cancelled")
  })

  test("cancelPending is no-op for nonexistent state", () => {
    // Should not throw
    McpOAuthCallback.cancelPending("does-not-exist")
  })
})
