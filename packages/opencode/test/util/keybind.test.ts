import { describe, test, expect } from "bun:test"
import { Keybind } from "../../src/util/keybind"

describe("Keybind.parse", () => {
  test("returns empty array for 'none'", () => {
    expect(Keybind.parse("none")).toEqual([])
  })

  test("parses simple key", () => {
    const [info] = Keybind.parse("a")
    expect(info.name).toBe("a")
    expect(info.ctrl).toBe(false)
    expect(info.meta).toBe(false)
    expect(info.shift).toBe(false)
    expect(info.leader).toBe(false)
  })

  test("parses ctrl+key combo", () => {
    const [info] = Keybind.parse("ctrl+s")
    expect(info.ctrl).toBe(true)
    expect(info.name).toBe("s")
  })

  test("parses multi-modifier combo ctrl+shift+a", () => {
    const [info] = Keybind.parse("ctrl+shift+a")
    expect(info.ctrl).toBe(true)
    expect(info.shift).toBe(true)
    expect(info.name).toBe("a")
  })

  test("recognizes 'alt', 'meta', and 'option' as meta modifier", () => {
    for (const alias of ["alt", "meta", "option"]) {
      const [info] = Keybind.parse(`${alias}+x`)
      expect(info.meta).toBe(true)
      expect(info.name).toBe("x")
    }
  })

  test("parses super modifier", () => {
    const [info] = Keybind.parse("super+s")
    expect(info.super).toBe(true)
    expect(info.name).toBe("s")
  })

  test("parses <leader> prefix", () => {
    const [info] = Keybind.parse("<leader>a")
    expect(info.leader).toBe(true)
    expect(info.name).toBe("a")
  })

  test("normalizes 'esc' to 'escape'", () => {
    const [info] = Keybind.parse("esc")
    expect(info.name).toBe("escape")
  })

  test("parses comma-separated multi-binding", () => {
    const bindings = Keybind.parse("ctrl+a,ctrl+b")
    expect(bindings).toHaveLength(2)
    expect(bindings[0].name).toBe("a")
    expect(bindings[0].ctrl).toBe(true)
    expect(bindings[1].name).toBe("b")
    expect(bindings[1].ctrl).toBe(true)
  })
})

describe("Keybind.toString", () => {
  test("returns empty string for undefined", () => {
    expect(Keybind.toString(undefined)).toBe("")
  })

  test("formats ctrl+key", () => {
    const result = Keybind.toString({
      ctrl: true, meta: false, shift: false, super: false, leader: false, name: "s",
    })
    expect(result).toBe("ctrl+s")
  })

  test("formats meta as 'alt'", () => {
    const result = Keybind.toString({
      ctrl: false, meta: true, shift: false, super: false, leader: false, name: "x",
    })
    expect(result).toBe("alt+x")
  })

  test("formats super modifier", () => {
    const result = Keybind.toString({
      ctrl: false, meta: false, shift: false, super: true, leader: false, name: "s",
    })
    expect(result).toBe("super+s")
  })

  test("formats leader prefix with key", () => {
    const result = Keybind.toString({
      ctrl: false, meta: false, shift: false, super: false, leader: true, name: "a",
    })
    expect(result).toBe("<leader> a")
  })

  test("formats leader-only (no key)", () => {
    const result = Keybind.toString({
      ctrl: false, meta: false, shift: false, super: false, leader: true, name: "",
    })
    expect(result).toBe("<leader>")
  })

  test("maps 'delete' to 'del'", () => {
    const result = Keybind.toString({
      ctrl: false, meta: false, shift: false, super: false, leader: false, name: "delete",
    })
    expect(result).toBe("del")
  })
})

describe("Keybind.match", () => {
  test("returns false for undefined first argument", () => {
    const b: Keybind.Info = { ctrl: true, meta: false, shift: false, super: false, leader: false, name: "s" }
    expect(Keybind.match(undefined, b)).toBe(false)
  })

  test("matches identical bindings", () => {
    const a: Keybind.Info = { ctrl: true, meta: false, shift: false, super: false, leader: false, name: "s" }
    const b: Keybind.Info = { ctrl: true, meta: false, shift: false, super: false, leader: false, name: "s" }
    expect(Keybind.match(a, b)).toBe(true)
  })

  test("treats missing super as false (normalization)", () => {
    // Simulate an Info object where super is undefined (e.g. from older code)
    const a = { ctrl: false, meta: false, shift: false, leader: false, name: "a" } as Keybind.Info
    const b: Keybind.Info = { ctrl: false, meta: false, shift: false, super: false, leader: false, name: "a" }
    expect(Keybind.match(a, b)).toBe(true)
  })

  test("does not match different keys", () => {
    const a: Keybind.Info = { ctrl: true, meta: false, shift: false, super: false, leader: false, name: "s" }
    const b: Keybind.Info = { ctrl: true, meta: false, shift: false, super: false, leader: false, name: "x" }
    expect(Keybind.match(a, b)).toBe(false)
  })
})

describe("Keybind.parse → Keybind.toString roundtrip", () => {
  test("roundtrips ctrl+shift+a", () => {
    const [parsed] = Keybind.parse("ctrl+shift+a")
    expect(Keybind.toString(parsed)).toBe("ctrl+shift+a")
  })

  test("meta aliases normalize to 'alt' on roundtrip", () => {
    // parse("meta+x") sets meta:true, toString emits "alt" — lossy but correct
    const [parsed] = Keybind.parse("meta+x")
    expect(Keybind.toString(parsed)).toBe("alt+x")

    const [parsed2] = Keybind.parse("option+x")
    expect(Keybind.toString(parsed2)).toBe("alt+x")
  })
})
