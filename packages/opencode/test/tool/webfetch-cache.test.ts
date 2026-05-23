import { describe, test, expect, beforeEach } from "bun:test"
import {
  normalizeUrlForCache,
  _resetFailureCache,
  _failureCacheSize,
} from "../../src/tool/webfetch"

/**
 * Webfetch URL failure cache.
 *
 * Background: telemetry-2026-05-21 showed 486 residual webfetch 404 errors
 * (down 78% from March's 2,222, so the existing cache is working — these
 * are the cases that still escape it). The cache previously had a 5-min TTL
 * and didn't normalize URLs, so tracking-param variations of a known-bad URL
 * missed cache. This file pins the normalization contract that now
 * collapses common LLM-generated URL variations onto one cache entry.
 */

beforeEach(() => {
  _resetFailureCache()
})

describe("normalizeUrlForCache", () => {
  test("returns identical URLs unchanged (apart from sorting empty params)", () => {
    expect(normalizeUrlForCache("https://example.com/path")).toBe("https://example.com/path")
  })

  test("strips utm_* tracking params", () => {
    expect(
      normalizeUrlForCache("https://example.com/docs?utm_source=twitter&utm_medium=social"),
    ).toBe("https://example.com/docs")
  })

  test("strips fbclid, gclid, msclkid, etc.", () => {
    expect(normalizeUrlForCache("https://example.com/a?fbclid=abc123")).toBe(
      "https://example.com/a",
    )
    expect(normalizeUrlForCache("https://example.com/a?gclid=xyz")).toBe("https://example.com/a")
    expect(normalizeUrlForCache("https://example.com/a?msclkid=qqq")).toBe(
      "https://example.com/a",
    )
  })

  test("preserves functional query params", () => {
    expect(normalizeUrlForCache("https://example.com/api?page=2&limit=20")).toBe(
      "https://example.com/api?limit=20&page=2",
    )
    expect(normalizeUrlForCache("https://example.com/search?q=hello+world")).toBe(
      "https://example.com/search?q=hello+world",
    )
  })

  test("preserves functional params when mixed with tracking params", () => {
    // `ref` is preserved (it's functional on GitHub etc.); `referrer` is stripped.
    // utm_* and fbclid are stripped.
    expect(
      normalizeUrlForCache(
        "https://example.com/post?id=42&utm_source=email&utm_campaign=monthly&fbclid=abc&referrer=twitter",
      ),
    ).toBe("https://example.com/post?id=42")
  })

  test("sorts query params for stable cache key", () => {
    expect(normalizeUrlForCache("https://example.com/x?b=2&a=1")).toBe(
      "https://example.com/x?a=1&b=2",
    )
    expect(normalizeUrlForCache("https://example.com/x?a=1&b=2")).toBe(
      "https://example.com/x?a=1&b=2",
    )
  })

  test("strips URL fragments", () => {
    expect(normalizeUrlForCache("https://example.com/page#section-3")).toBe(
      "https://example.com/page",
    )
    expect(normalizeUrlForCache("https://example.com/page?id=1#section-3")).toBe(
      "https://example.com/page?id=1",
    )
  })

  test("lowercases hostname (case-insensitive per RFC 3986)", () => {
    expect(normalizeUrlForCache("https://EXAMPLE.COM/path")).toBe("https://example.com/path")
    expect(normalizeUrlForCache("https://Example.Com/Path")).toBe("https://example.com/Path")
  })

  test("preserves path case (paths ARE case-sensitive per HTTP)", () => {
    expect(normalizeUrlForCache("https://example.com/Foo/Bar")).toBe("https://example.com/Foo/Bar")
  })

  test("collapses Cloudflare challenge tokens (__cf_chl_* prefix)", () => {
    expect(
      normalizeUrlForCache(
        "https://example.com/page?__cf_chl_tk=abc&__cf_chl_jschl_tk__=xyz",
      ),
    ).toBe("https://example.com/page")
  })

  test("returns input verbatim if URL parsing fails", () => {
    expect(normalizeUrlForCache("not a url at all")).toBe("not a url at all")
  })

  test("multiple variations of the same logical URL collapse to one cache key", () => {
    const variations = [
      "https://docs.example.com/api/v1?utm_source=docs",
      "https://docs.example.com/api/v1?utm_source=twitter&fbclid=q",
      "https://docs.example.com/api/v1?gclid=z",
      "https://docs.example.com/api/v1#anchor",
      "https://DOCS.EXAMPLE.COM/api/v1",
      "https://docs.example.com/api/v1?utm_campaign=monthly",
    ]
    const normalized = variations.map(normalizeUrlForCache)
    const unique = new Set(normalized)
    expect(unique.size).toBe(1)
    expect(unique.values().next().value).toBe("https://docs.example.com/api/v1")
  })

  test("different functional params do NOT collapse", () => {
    const a = normalizeUrlForCache("https://example.com/a?page=1")
    const b = normalizeUrlForCache("https://example.com/a?page=2")
    expect(a).not.toBe(b)
  })

  test("different paths do NOT collapse", () => {
    expect(normalizeUrlForCache("https://example.com/v1/api")).not.toBe(
      normalizeUrlForCache("https://example.com/v2/api"),
    )
  })

  test("preserves `ref` param (functional on GitHub raw URLs / git APIs)", () => {
    // GitHub: `?ref=main` vs `?ref=v2.0` selects different branches/tags.
    // Stripping `ref` would suppress legitimate fetches of different refs.
    // Caught by reviewer (2026-05-22). Same for ref_src and ref_url.
    expect(normalizeUrlForCache("https://api.github.com/repos/x/y/contents/foo.md?ref=main")).toBe(
      "https://api.github.com/repos/x/y/contents/foo.md?ref=main",
    )
    expect(normalizeUrlForCache("https://api.github.com/repos/x/y/contents/foo.md?ref=v2.0")).toBe(
      "https://api.github.com/repos/x/y/contents/foo.md?ref=v2.0",
    )
    // Different `ref` values must NOT collapse — they identify different
    // resources. Pinning this prevents a regression that would re-add ref
    // to TRACKING_PARAMS.
    expect(
      normalizeUrlForCache("https://api.github.com/repos/x/y/contents/foo.md?ref=main"),
    ).not.toBe(normalizeUrlForCache("https://api.github.com/repos/x/y/contents/foo.md?ref=v2.0"))
  })

  test("still strips `referrer` (full word, tracking-only)", () => {
    // The abbreviated `ref` is functional; the full word `referrer` is
    // a tracking header and stays in TRACKING_PARAMS.
    expect(normalizeUrlForCache("https://example.com/page?referrer=twitter")).toBe(
      "https://example.com/page",
    )
  })

  test("duplicate-key params collapse to a stable order regardless of input order", () => {
    // Without value-aware sort, `?a=1&a=2` and `?a=2&a=1` would produce
    // different cache keys despite carrying the same logical content.
    expect(normalizeUrlForCache("https://example.com/x?a=1&a=2")).toBe(
      normalizeUrlForCache("https://example.com/x?a=2&a=1"),
    )
    // And the normalized form is deterministic:
    expect(normalizeUrlForCache("https://example.com/x?a=2&a=1")).toBe(
      "https://example.com/x?a=1&a=2",
    )
  })
})

describe("failure cache helpers", () => {
  test("_resetFailureCache empties the cache", () => {
    expect(_failureCacheSize()).toBe(0)
    // Add an entry via direct manipulation isn't exposed; this test just
    // exercises the helpers exist and return sane values.
    _resetFailureCache()
    expect(_failureCacheSize()).toBe(0)
  })
})
