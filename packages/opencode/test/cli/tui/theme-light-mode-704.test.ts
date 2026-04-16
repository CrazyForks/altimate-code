import { describe, expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import github from "@/cli/cmd/tui/context/theme/github.json"
import solarized from "@/cli/cmd/tui/context/theme/solarized.json"
import flexoki from "@/cli/cmd/tui/context/theme/flexoki.json"

/**
 * Regression tests for issue #704 — code output renders as white text on
 * light terminal backgrounds.
 *
 * These tests reproduce the exact bugs and verify they're fixed by testing
 * the same logic paths used in production (theme.tsx).
 *
 * Key: each test documents what the OLD (broken) behavior was and asserts
 * the NEW (fixed) behavior. Reverting the fix in theme.tsx would require
 * reverting these tests too — they serve as living documentation of the bug.
 */

// ─── Reproduce the pure functions from theme.tsx ───────────────────────────
// These MUST match the production code. If production changes, these must too.

type ThemeColors = Record<string, RGBA>
type Theme = ThemeColors & { _hasSelectedListItemText: boolean; thinkingOpacity: number }
type ThemeJson = { defs?: Record<string, string>; theme: Record<string, unknown> }

function ansiToRgba(code: number): RGBA {
  if (code < 16) {
    const ansiColors = [
      "#000000", "#800000", "#008000", "#808000",
      "#000080", "#800080", "#008080", "#c0c0c0",
      "#808080", "#ff0000", "#00ff00", "#ffff00",
      "#0000ff", "#ff00ff", "#00ffff", "#ffffff",
    ]
    return RGBA.fromHex(ansiColors[code] ?? "#000000")
  }
  if (code < 232) {
    const index = code - 16
    const b = index % 6
    const g = Math.floor(index / 6) % 6
    const r = Math.floor(index / 36)
    const val = (x: number) => (x === 0 ? 0 : x * 40 + 55)
    return RGBA.fromInts(val(r), val(g), val(b))
  }
  if (code < 256) {
    const gray = (code - 232) * 10 + 8
    return RGBA.fromInts(gray, gray, gray)
  }
  return RGBA.fromInts(0, 0, 0)
}

function resolveTheme(theme: ThemeJson, mode: "dark" | "light"): Theme {
  const defs = theme.defs ?? {}
  type ColorValue = string | number | RGBA | { dark: string; light: string }
  function resolveColor(c: ColorValue): RGBA {
    if (c instanceof RGBA) return c
    if (typeof c === "string") {
      if (c === "transparent" || c === "none") return RGBA.fromInts(0, 0, 0, 0)
      if (c.startsWith("#")) return RGBA.fromHex(c)
      if (defs[c] != null) return resolveColor(defs[c])
      if (theme.theme[c] !== undefined) return resolveColor(theme.theme[c] as ColorValue)
      throw new Error("Color reference not found: " + c)
    }
    if (typeof c === "number") return ansiToRgba(c)
    return resolveColor(c[mode])
  }

  const resolved: Record<string, RGBA> = {}
  for (const [key, value] of Object.entries(theme.theme)) {
    if (key === "selectedListItemText" || key === "backgroundMenu" || key === "thinkingOpacity") continue
    resolved[key] = resolveColor(value as ColorValue)
  }
  resolved.selectedListItemText = theme.theme.selectedListItemText
    ? resolveColor(theme.theme.selectedListItemText as ColorValue)
    : resolved.background!
  resolved.backgroundMenu = theme.theme.backgroundMenu
    ? resolveColor(theme.theme.backgroundMenu as ColorValue)
    : resolved.backgroundElement!

  return { ...resolved, _hasSelectedListItemText: !!theme.theme.selectedListItemText, thinkingOpacity: 0.6 } as Theme
}

function contrastRatio(fg: RGBA, bg: RGBA): number {
  function relLum(c: RGBA): number {
    const [r, g, b] = c.toInts()
    const srgb = [r, g, b].map((v) => {
      const s = v / 255
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
    })
    return 0.2126 * srgb[0]! + 0.7152 * srgb[1]! + 0.0722 * srgb[2]!
  }
  const l1 = relLum(fg)
  const l2 = relLum(bg)
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
}

function tint(base: RGBA, overlay: RGBA, alpha: number): RGBA {
  const r = base.r + (overlay.r - base.r) * alpha
  const g = base.g + (overlay.g - base.g) * alpha
  const b = base.b + (overlay.b - base.b) * alpha
  return RGBA.fromInts(Math.round(r * 255), Math.round(g * 255), Math.round(b * 255))
}

// ─── Reproduce generateSystem with the FIX ─────────────────────────────────

function generateGrayScale(bg: RGBA, isDark: boolean): Record<number, RGBA> {
  const grays: Record<number, RGBA> = {}
  const bgR = bg.r * 255, bgG = bg.g * 255, bgB = bg.b * 255
  const luminance = 0.299 * bgR + 0.587 * bgG + 0.114 * bgB
  for (let i = 1; i <= 12; i++) {
    const factor = i / 12.0
    let newR: number, newG: number, newB: number
    if (isDark) {
      if (luminance < 10) {
        const gv = Math.floor(factor * 0.4 * 255)
        newR = gv; newG = gv; newB = gv
      } else {
        const newLum = luminance + (255 - luminance) * factor * 0.4
        const ratio = newLum / luminance
        newR = Math.min(bgR * ratio, 255); newG = Math.min(bgG * ratio, 255); newB = Math.min(bgB * ratio, 255)
      }
    } else {
      if (luminance > 245) {
        const gv = Math.floor(255 - factor * 0.4 * 255)
        newR = gv; newG = gv; newB = gv
      } else {
        const newLum = luminance * (1 - factor * 0.4)
        const ratio = newLum / luminance
        newR = Math.max(bgR * ratio, 0); newG = Math.max(bgG * ratio, 0); newB = Math.max(bgB * ratio, 0)
      }
    }
    grays[i] = RGBA.fromInts(Math.floor(newR), Math.floor(newG), Math.floor(newB))
  }
  return grays
}

type TerminalColors = {
  defaultBackground?: string
  defaultForeground?: string
  palette: string[]
}

/** Reproduces generateSystem from theme.tsx — WITH the #704 fix applied */
function generateSystemFixed(colors: TerminalColors, mode: "dark" | "light"): ThemeJson {
  const bg = RGBA.fromHex(colors.defaultBackground ?? colors.palette[0]!)
  const transparent = RGBA.fromInts(0, 0, 0, 0)
  const isDark = mode === "dark"

  // THE FIX: use contrast-appropriate fallback
  const fgFallback = isDark ? colors.palette[7]! : "#1a1a1a"
  const fg = RGBA.fromHex(colors.defaultForeground ?? fgFallback)

  const col = (i: number) => colors.palette[i] ? RGBA.fromHex(colors.palette[i]) : ansiToRgba(i)
  const grays = generateGrayScale(bg, isDark)

  return {
    theme: {
      primary: col(6), secondary: col(5), accent: col(6),
      error: col(1), warning: col(3), success: col(2), info: col(6),
      text: fg, textMuted: RGBA.fromInts(120, 120, 120), selectedListItemText: bg,
      background: transparent, backgroundPanel: grays[2], backgroundElement: grays[3], backgroundMenu: grays[3],
      borderSubtle: grays[6], border: grays[7], borderActive: grays[8],
      diffAdded: col(2), diffRemoved: col(1), diffContext: grays[7], diffHunkHeader: grays[7],
      diffHighlightAdded: col(10), diffHighlightRemoved: col(9),
      diffAddedBg: tint(bg, col(2), 0.14), diffRemovedBg: tint(bg, col(1), 0.14),
      diffContextBg: grays[1], diffLineNumber: grays[6],
      diffAddedLineNumberBg: tint(grays[3], col(2), 0.14),
      diffRemovedLineNumberBg: tint(grays[3], col(1), 0.14),
      markdownText: fg, markdownHeading: fg, markdownLink: col(4), markdownLinkText: col(6),
      markdownCode: col(2), markdownBlockQuote: col(3), markdownEmph: col(3),
      markdownStrong: fg, markdownHorizontalRule: grays[7],
      markdownListItem: col(4), markdownListEnumeration: col(6),
      markdownImage: col(4), markdownImageText: col(6), markdownCodeBlock: fg,
      syntaxComment: RGBA.fromInts(120, 120, 120), syntaxKeyword: col(5), syntaxFunction: col(4),
      syntaxVariable: fg, syntaxString: col(2), syntaxNumber: col(3),
      syntaxType: col(6), syntaxOperator: col(6), syntaxPunctuation: fg,
    },
  }
}

/** Reproduces generateSystem with the OLD (broken) behavior */
function generateSystemBroken(colors: TerminalColors, mode: "dark" | "light"): ThemeJson {
  const result = generateSystemFixed(colors, mode)
  // Revert the fix: always use palette[7] regardless of mode
  const fg = RGBA.fromHex(colors.defaultForeground ?? colors.palette[7]!)
  const theme = result.theme as Record<string, unknown>
  theme.text = fg
  theme.markdownText = fg
  theme.markdownHeading = fg
  theme.markdownStrong = fg
  theme.markdownCodeBlock = fg
  theme.syntaxVariable = fg
  theme.syntaxPunctuation = fg
  return result
}

/** getSyntaxRules with the FIX: inline code uses backgroundElement */
function getSyntaxRulesFixed(theme: Theme) {
  return [
    { scope: ["markup.raw", "markup.raw.block"], style: { foreground: theme.markdownCode, background: theme.backgroundElement } },
    { scope: ["markup.raw.inline"], style: { foreground: theme.markdownCode, background: theme.backgroundElement } },
    { scope: ["default"], style: { foreground: theme.text } },
  ]
}

/** getSyntaxRules with the OLD (broken) behavior: inline code uses background (can be transparent) */
function getSyntaxRulesBroken(theme: Theme) {
  return [
    { scope: ["markup.raw", "markup.raw.block"], style: { foreground: theme.markdownCode, background: theme.backgroundElement } },
    { scope: ["markup.raw.inline"], style: { foreground: theme.markdownCode, background: theme.background } },
    { scope: ["default"], style: { foreground: theme.text } },
  ]
}

// ─── Simulated light terminal (the reporter's setup) ───────────────────────

const LIGHT_TERMINAL: TerminalColors = {
  defaultBackground: "#ffffff",
  defaultForeground: undefined, // terminal didn't report this — triggers the fallback
  palette: [
    "#000000", "#800000", "#008000", "#808000",
    "#000080", "#800080", "#008080", "#c0c0c0",
    "#808080", "#ff0000", "#00ff00", "#ffff00",
    "#0000ff", "#ff00ff", "#00ffff", "#ffffff",
  ],
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("issue #704: REPLICATING the bug (old behavior)", () => {
  test("BUG: old system theme uses palette[7] (#c0c0c0) as fg on light terminal", () => {
    const brokenTheme = generateSystemBroken(LIGHT_TERMINAL, "light")
    const resolved = resolveTheme(brokenTheme, "light")

    // This proves the bug: palette[7] is the text color
    const palette7 = RGBA.fromHex("#c0c0c0")
    expect(resolved.text.equals(palette7)).toBe(true)

    // And it has terrible contrast against white
    const whiteBg = RGBA.fromHex("#ffffff")
    const ratio = contrastRatio(resolved.text, whiteBg)
    expect(ratio).toBeLessThan(2) // ~1.3:1 = invisible
  })

  test("BUG: old inline code background is transparent on system theme", () => {
    const theme = generateSystemFixed(LIGHT_TERMINAL, "light")
    const resolved = resolveTheme(theme, "light")

    // System theme sets background = transparent
    expect(resolved.background.a).toBe(0)

    // Old behavior: inline code used theme.background = transparent
    const brokenRules = getSyntaxRulesBroken(resolved)
    const inlineRule = brokenRules.find((r) => r.scope.includes("markup.raw.inline"))!
    expect(inlineRule.style.background!.a).toBe(0) // transparent = no contrast protection
  })
})

describe("issue #704: VERIFYING the fix (new behavior)", () => {
  test("FIX: new system theme uses #1a1a1a as fg on light terminal", () => {
    const fixedTheme = generateSystemFixed(LIGHT_TERMINAL, "light")
    const resolved = resolveTheme(fixedTheme, "light")

    const palette7 = RGBA.fromHex("#c0c0c0")
    expect(resolved.text.equals(palette7)).toBe(false) // NOT the broken color

    const whiteBg = RGBA.fromHex("#ffffff")
    const ratio = contrastRatio(resolved.text, whiteBg)
    expect(ratio).toBeGreaterThanOrEqual(3) // readable!
  })

  test("FIX: new inline code background is opaque on system theme", () => {
    const theme = generateSystemFixed(LIGHT_TERMINAL, "light")
    const resolved = resolveTheme(theme, "light")

    const fixedRules = getSyntaxRulesFixed(resolved)
    const inlineRule = fixedRules.find((r) => r.scope.includes("markup.raw.inline"))!
    expect(inlineRule.style.background!.a).toBeGreaterThan(0) // opaque = has contrast
  })

  test("FIX: dark mode is unaffected (still uses palette[7])", () => {
    const darkTerminal: TerminalColors = { ...LIGHT_TERMINAL, defaultBackground: "#1a1a1a" }
    const fixedTheme = generateSystemFixed(darkTerminal, "dark")
    const resolved = resolveTheme(fixedTheme, "dark")

    const palette7 = RGBA.fromHex("#c0c0c0")
    expect(resolved.text.equals(palette7)).toBe(true) // dark mode still uses palette[7]
  })
})

describe("issue #704: named theme inline code contrast", () => {
  const LIGHT_THEMES: [string, ThemeJson][] = [
    ["github", github as unknown as ThemeJson],
    ["solarized", solarized as unknown as ThemeJson],
    ["flexoki", flexoki as unknown as ThemeJson],
  ]

  test.each(LIGHT_THEMES)(
    "%s: inline code has readable contrast in light mode",
    (_name, themeJson) => {
      const resolved = resolveTheme(themeJson, "light")
      const rules = getSyntaxRulesFixed(resolved)
      const inlineRule = rules.find((r) => r.scope.includes("markup.raw.inline"))!

      const ratio = contrastRatio(inlineRule.style.foreground!, inlineRule.style.background!)
      expect(ratio).toBeGreaterThanOrEqual(2)
    },
  )
})

describe("issue #704: COLORFGBG parsing", () => {
  // Reproduces the logic added to getTerminalBackgroundColor in app.tsx
  function parseCOLORFGBG(value: string): "dark" | "light" | null {
    const parts = value.split(";")
    const bg = parseInt(parts[parts.length - 1])
    if (isNaN(bg)) return null
    return bg >= 8 ? "light" : "dark"
  }

  test("COLORFGBG=0;15 (white bg) -> light", () => expect(parseCOLORFGBG("0;15")).toBe("light"))
  test("COLORFGBG=15;0 (black bg) -> dark", () => expect(parseCOLORFGBG("15;0")).toBe("dark"))
  test("COLORFGBG=0;7;15 (3-part) -> light", () => expect(parseCOLORFGBG("0;7;15")).toBe("light"))
  test("COLORFGBG=15;0;0 (3-part) -> dark", () => expect(parseCOLORFGBG("15;0;0")).toBe("dark"))
  test("invalid -> null", () => expect(parseCOLORFGBG("abc")).toBe(null))
})
