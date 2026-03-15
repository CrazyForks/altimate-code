import { describe, expect, test } from "bun:test"
import { shortType, detectFK, formatRowCount } from "../../../src/cli/cmd/tui/util/schema-preview-utils"

// ---------------------------------------------------------------------------
// shortType
// ---------------------------------------------------------------------------

describe("SchemaPreview.shortType", () => {
  test("maps common SQL types", () => {
    expect(shortType("VARCHAR")).toBe("VARCHAR")
    expect(shortType("CHARACTER VARYING")).toBe("VARCHAR")
    expect(shortType("TEXT")).toBe("TEXT")
    expect(shortType("INTEGER")).toBe("INT")
    expect(shortType("INT")).toBe("INT")
    expect(shortType("BIGINT")).toBe("BIGINT")
    expect(shortType("SMALLINT")).toBe("SMALLINT")
    expect(shortType("BOOLEAN")).toBe("BOOL")
    expect(shortType("BOOL")).toBe("BOOL")
  })

  test("maps float and decimal types", () => {
    expect(shortType("FLOAT")).toBe("FLOAT")
    expect(shortType("FLOAT4")).toBe("FLOAT")
    expect(shortType("FLOAT8")).toBe("DOUBLE")
    expect(shortType("DOUBLE")).toBe("DOUBLE")
    expect(shortType("DOUBLE PRECISION")).toBe("DOUBLE")
    expect(shortType("DECIMAL")).toBe("DECIMAL")
    expect(shortType("NUMERIC")).toBe("DECIMAL")
    expect(shortType("NUMBER")).toBe("NUMBER")
  })

  test("maps date/time types", () => {
    expect(shortType("DATE")).toBe("DATE")
    expect(shortType("TIMESTAMP")).toBe("TIMESTAMP")
    expect(shortType("TIMESTAMP WITHOUT TIME ZONE")).toBe("TIMESTAMP")
    expect(shortType("TIMESTAMP WITH TIME ZONE")).toBe("TIMESTAMPTZ")
    expect(shortType("TIMESTAMPTZ")).toBe("TIMESTAMPTZ")
  })

  test("maps Snowflake-specific types", () => {
    expect(shortType("TIMESTAMP_NTZ")).toBe("TIMESTAMP")
    expect(shortType("TIMESTAMP_LTZ")).toBe("TIMESTAMPTZ")
    expect(shortType("TIMESTAMP_TZ")).toBe("TIMESTAMPTZ")
    expect(shortType("VARIANT")).toBe("VARIANT")
    expect(shortType("OBJECT")).toBe("OBJECT")
    expect(shortType("ARRAY")).toBe("ARRAY")
  })

  test("maps JSON types", () => {
    expect(shortType("JSON")).toBe("JSON")
    expect(shortType("JSONB")).toBe("JSONB")
  })

  test("maps binary types", () => {
    expect(shortType("BINARY")).toBe("BINARY")
    expect(shortType("VARBINARY")).toBe("BINARY")
    expect(shortType("BYTEA")).toBe("BINARY")
  })

  test("maps UUID", () => {
    expect(shortType("UUID")).toBe("UUID")
  })

  test("handles parameterized types", () => {
    expect(shortType("VARCHAR(255)")).toBe("VARCHAR")
    expect(shortType("DECIMAL(10,2)")).toBe("DECIMAL")
    expect(shortType("NUMERIC(18, 4)")).toBe("DECIMAL")
  })

  test("is case-insensitive", () => {
    expect(shortType("varchar")).toBe("VARCHAR")
    expect(shortType("Timestamp")).toBe("TIMESTAMP")
    expect(shortType("boolean")).toBe("BOOL")
    expect(shortType("int4")).toBe("INT")
    expect(shortType("int8")).toBe("BIGINT")
    expect(shortType("int2")).toBe("SMALLINT")
  })

  test("returns original for unknown types", () => {
    expect(shortType("CUSTOM_TYPE")).toBe("CUSTOM_TYPE")
    expect(shortType("GEOGRAPHY")).toBe("GEOGRAPHY")
    expect(shortType("SUPER")).toBe("SUPER")
  })
})

// ---------------------------------------------------------------------------
// detectFK
// ---------------------------------------------------------------------------

describe("SchemaPreview.detectFK", () => {
  test("detects _id suffix as FK", () => {
    expect(detectFK("customer_id")).toBe(true)
    expect(detectFK("order_id")).toBe(true)
    expect(detectFK("user_id")).toBe(true)
  })

  test("detects _fk suffix as FK", () => {
    expect(detectFK("customer_fk")).toBe(true)
    expect(detectFK("order_fk")).toBe(true)
  })

  test("detects _key suffix as FK", () => {
    expect(detectFK("customer_key")).toBe(true)
    expect(detectFK("surrogate_key")).toBe(true)
  })

  test("does not detect 'id' alone as FK", () => {
    expect(detectFK("id")).toBe(false)
    expect(detectFK("ID")).toBe(false)
  })

  test("does not detect 'pk' alone as FK", () => {
    expect(detectFK("pk")).toBe(false)
    expect(detectFK("PK")).toBe(false)
  })

  test("does not detect regular columns as FK", () => {
    expect(detectFK("name")).toBe(false)
    expect(detectFK("email")).toBe(false)
    expect(detectFK("created_at")).toBe(false)
    expect(detectFK("amount")).toBe(false)
  })

  test("is case-insensitive", () => {
    expect(detectFK("Customer_ID")).toBe(true)
    expect(detectFK("ORDER_FK")).toBe(true)
    expect(detectFK("user_KEY")).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// formatRowCount
// ---------------------------------------------------------------------------

describe("SchemaPreview.formatRowCount", () => {
  test("formats small numbers with locale separators", () => {
    expect(formatRowCount(0)).toBe("0")
    expect(formatRowCount(42)).toBe("42")
    expect(formatRowCount(999)).toBe("999")
  })

  test("formats thousands with K suffix", () => {
    expect(formatRowCount(1000)).toBe("1.0K")
    expect(formatRowCount(1500)).toBe("1.5K")
    expect(formatRowCount(50000)).toBe("50.0K")
    expect(formatRowCount(999999)).toBe("1000.0K")
  })

  test("formats millions with M suffix", () => {
    expect(formatRowCount(1000000)).toBe("1.0M")
    expect(formatRowCount(1500000)).toBe("1.5M")
    expect(formatRowCount(50000000)).toBe("50.0M")
    expect(formatRowCount(999999999)).toBe("1000.0M")
  })

  test("formats billions with B suffix", () => {
    expect(formatRowCount(1000000000)).toBe("1.0B")
    expect(formatRowCount(2500000000)).toBe("2.5B")
  })
})
