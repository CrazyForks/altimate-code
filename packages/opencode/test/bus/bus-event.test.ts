// altimate_change start — tests for BusEvent registry and payloads
import { describe, test, expect } from "bun:test"
import z from "zod"
import { BusEvent } from "../../src/bus/bus-event"

// Use unique type strings prefixed with __test_ to avoid colliding with
// production events already registered in the global BusEvent registry.

describe("BusEvent.define", () => {
  test("returns an object with type string and zod schema", () => {
    const schema = z.object({ count: z.number() })
    const def = BusEvent.define("__test_define_shape", schema)

    expect(def.type).toBe("__test_define_shape")
    expect(def.properties).toBe(schema)
  })
})

describe("BusEvent.payloads", () => {
  test("includes a registered event in the discriminated union", () => {
    const testSchema = z.object({ value: z.string() })
    BusEvent.define("__test_payloads_registered", testSchema)
    const union = BusEvent.payloads()
    const result = union.safeParse({
      type: "__test_payloads_registered",
      properties: { value: "hello" },
    })
    expect(result.success).toBe(true)
  })

  test("rejects event with unregistered type", () => {
    const union = BusEvent.payloads()
    const result = union.safeParse({
      type: "__test_payloads_NONEXISTENT_999",
      properties: {},
    })
    expect(result.success).toBe(false)
  })

  test("rejects event with wrong properties shape", () => {
    BusEvent.define("__test_payloads_registered", z.object({ value: z.string() }))
    const union = BusEvent.payloads()
    const result = union.safeParse({
      type: "__test_payloads_registered",
      properties: { value: 42 }, // should be string, not number
    })
    expect(result.success).toBe(false)
  })
})

describe("BusEvent.define duplicate handling", () => {
  test("first define() wins (idempotent registration)", () => {
    // altimate_change start — bridge cycle 4 made BusEvent.define idempotent so SyncEvent.define
    // (cycle 3 bridge) and SyncEvent.init can both safely register the same type without
    // schema shadowing surprises. First registration wins to keep schema stable.
    BusEvent.define("__test_duplicate_overwrite", z.object({ a: z.string() }))
    // Second call with different schema is a no-op
    BusEvent.define("__test_duplicate_overwrite", z.object({ b: z.number() }))

    const union = BusEvent.payloads()

    // First schema still wins
    const valid = union.safeParse({
      type: "__test_duplicate_overwrite",
      properties: { a: "hello" },
    })
    expect(valid.success).toBe(true)

    // Second schema does NOT replace the first
    const invalid = union.safeParse({
      type: "__test_duplicate_overwrite",
      properties: { b: 42 },
    })
    expect(invalid.success).toBe(false)
    // altimate_change end
  })
})
// altimate_change end
