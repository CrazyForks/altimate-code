import { describe, test, expect } from "bun:test"
import { Command } from "../../src/command/index"

describe("Command.hints: template placeholder extraction", () => {
  test("extracts single numbered placeholder", () => {
    expect(Command.hints("Run $1")).toEqual(["$1"])
  })

  test("extracts and sorts multiple numbered placeholders", () => {
    expect(Command.hints("Run $2 then $1 then $3")).toEqual(["$1", "$2", "$3"])
  })

  test("deduplicates repeated placeholders", () => {
    expect(Command.hints("$1 and $1 and $2")).toEqual(["$1", "$2"])
  })

  test("extracts $ARGUMENTS when present", () => {
    expect(Command.hints("Run with $ARGUMENTS")).toEqual(["$ARGUMENTS"])
  })

  test("numbered placeholders come before $ARGUMENTS", () => {
    expect(Command.hints("$2 $ARGUMENTS $1")).toEqual(["$1", "$2", "$ARGUMENTS"])
  })

  test("returns empty array when no placeholders", () => {
    expect(Command.hints("Just a plain template")).toEqual([])
  })

  test("handles empty string", () => {
    expect(Command.hints("")).toEqual([])
  })

  test("does not match partial patterns like $ARGS or $foo", () => {
    expect(Command.hints("$ARGS $foo $bar")).toEqual([])
  })

  test("handles double-digit placeholders (lexicographic sort quirk)", () => {
    // The sort is lexicographic, so $10 sorts before $2.
    // This documents actual behavior — not necessarily desired.
    expect(Command.hints("$10 $2 $1")).toEqual(["$1", "$10", "$2"])
  })
})
