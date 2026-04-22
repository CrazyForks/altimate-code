import { afterEach, describe, expect, test } from "bun:test"
import { Installation } from "../../src/installation"

const fetch0 = globalThis.fetch

afterEach(() => {
  globalThis.fetch = fetch0
})

describe("installation", () => {
  test("reads release version from GitHub releases", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ tag_name: "v1.2.3" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch

    expect(await Installation.latest("unknown")).toBe("1.2.3")
  })

  // altimate_change start — choco/scoop now fall through to GitHub API
  // We do not publish altimate-code to chocolatey or scoop. Upstream opencode
  // queried those registries for the "opencode" package (WRONG product); the
  // fix falls through to the GitHub releases API so `latest()` returns the
  // correct altimate-code version even when --method=choco|scoop is passed.
  test("scoop falls through to GitHub releases (altimate-code is not on scoop)", async () => {
    const urls: string[] = []
    globalThis.fetch = (async (url: string) => {
      urls.push(url)
      return new Response(JSON.stringify({ tag_name: "v0.6.0" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as unknown as typeof fetch

    expect(await Installation.latest("scoop")).toBe("0.6.0")
    // Must NOT hit the upstream scoop bucket for `opencode.json`
    expect(urls.some((u) => u.includes("raw.githubusercontent.com") && u.includes("opencode.json"))).toBe(false)
    // MUST hit the altimate-code GitHub releases API
    expect(urls.some((u) => u.includes("api.github.com/repos/AltimateAI/altimate-code/releases/latest"))).toBe(true)
  })

  test("choco falls through to GitHub releases (altimate-code is not on chocolatey)", async () => {
    const urls: string[] = []
    globalThis.fetch = (async (url: string) => {
      urls.push(url)
      return new Response(JSON.stringify({ tag_name: "v0.6.0" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as unknown as typeof fetch

    expect(await Installation.latest("choco")).toBe("0.6.0")
    // Must NOT hit the upstream chocolatey feed for `opencode`
    expect(urls.some((u) => u.includes("community.chocolatey.org"))).toBe(false)
    // MUST hit the altimate-code GitHub releases API
    expect(urls.some((u) => u.includes("api.github.com/repos/AltimateAI/altimate-code/releases/latest"))).toBe(true)
  })

  test("upgrade('choco', ...) throws UpgradeFailedError with helpful message", async () => {
    await expect(Installation.upgrade("choco", "0.6.0")).rejects.toBeInstanceOf(Installation.UpgradeFailedError)
    const err = await Installation.upgrade("choco", "0.6.0").catch((e) => e)
    expect(err.data.stderr).toContain("altimate-code is not distributed via choco")
    expect(err.data.stderr).toContain("@altimateai/altimate-code")
    expect(err.data.stderr).toContain("https://altimate.ai/install")
  })

  test("upgrade('scoop', ...) throws UpgradeFailedError with helpful message", async () => {
    const err = await Installation.upgrade("scoop", "0.6.0").catch((e) => e)
    expect(err).toBeInstanceOf(Installation.UpgradeFailedError)
    expect(err.data.stderr).toContain("altimate-code is not distributed via scoop")
    expect(err.data.stderr).toContain("altimate-code")
  })
  // altimate_change end
})
