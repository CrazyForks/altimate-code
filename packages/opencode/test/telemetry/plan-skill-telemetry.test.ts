// @ts-nocheck
import { describe, expect, test } from "bun:test"
import { Telemetry } from "../../src/telemetry"

// ---------------------------------------------------------------------------
// 1. classifySkillTrigger — trigger source classification
// ---------------------------------------------------------------------------
describe("telemetry.classifySkillTrigger", () => {
  test("returns 'llm_selected' when no extra context is provided", () => {
    expect(Telemetry.classifySkillTrigger()).toBe("llm_selected")
    expect(Telemetry.classifySkillTrigger(undefined)).toBe("llm_selected")
  })

  test("returns 'llm_selected' when extra has no trigger field", () => {
    expect(Telemetry.classifySkillTrigger({})).toBe("llm_selected")
    expect(Telemetry.classifySkillTrigger({ foo: "bar" })).toBe("llm_selected")
  })

  test("returns 'user_command' when extra.trigger is 'user_command'", () => {
    expect(Telemetry.classifySkillTrigger({ trigger: "user_command" })).toBe("user_command")
  })

  test("returns 'auto_suggested' when extra.trigger is 'auto_suggested'", () => {
    expect(Telemetry.classifySkillTrigger({ trigger: "auto_suggested" })).toBe("auto_suggested")
  })

  test("returns 'llm_selected' when extra.trigger is 'llm_selected'", () => {
    expect(Telemetry.classifySkillTrigger({ trigger: "llm_selected" })).toBe("llm_selected")
  })

  test("returns 'llm_selected' for unrecognized trigger values", () => {
    expect(Telemetry.classifySkillTrigger({ trigger: "something_else" })).toBe("llm_selected")
    expect(Telemetry.classifySkillTrigger({ trigger: 42 })).toBe("llm_selected")
  })
})

// ---------------------------------------------------------------------------
// 2. New event types — plan_revision and feature_suggestion are valid
// ---------------------------------------------------------------------------
describe("telemetry.new-event-types", () => {
  test("plan_revision event type is valid and structurally correct", () => {
    const event: Telemetry.Event = {
      type: "plan_revision",
      timestamp: Date.now(),
      session_id: "test-session",
      revision_number: 3,
      action: "refine",
    }
    expect(event.type).toBe("plan_revision")
    expect(event.revision_number).toBe(3)
    expect(event.action).toBe("refine")
  })

  test("plan_revision supports all action values", () => {
    const actions: Array<"refine" | "approve" | "reject"> = ["refine", "approve", "reject"]
    for (const action of actions) {
      const event: Telemetry.Event = {
        type: "plan_revision",
        timestamp: Date.now(),
        session_id: "test-session",
        revision_number: 1,
        action,
      }
      expect(event.action).toBe(action)
    }
  })

  test("feature_suggestion event type is valid and structurally correct", () => {
    const event: Telemetry.Event = {
      type: "feature_suggestion",
      timestamp: Date.now(),
      session_id: "test-session",
      suggestion_type: "post_warehouse_connect",
      suggestions_shown: ["run_query", "schema_inspect"],
      warehouse_type: "snowflake",
    }
    expect(event.type).toBe("feature_suggestion")
    expect(event.suggestions_shown).toEqual(["run_query", "schema_inspect"])
  })

  test("feature_suggestion supports all suggestion_type values", () => {
    const types: Array<"post_warehouse_connect" | "dbt_detected" | "schema_not_indexed" | "progressive_disclosure"> = [
      "post_warehouse_connect",
      "dbt_detected",
      "schema_not_indexed",
      "progressive_disclosure",
    ]
    for (const suggestion_type of types) {
      const event: Telemetry.Event = {
        type: "feature_suggestion",
        timestamp: Date.now(),
        session_id: "test-session",
        suggestion_type,
        suggestions_shown: ["test"],
      }
      expect(event.suggestion_type).toBe(suggestion_type)
    }
  })

  test("feature_suggestion warehouse_type is optional", () => {
    const event: Telemetry.Event = {
      type: "feature_suggestion",
      timestamp: Date.now(),
      session_id: "test-session",
      suggestion_type: "dbt_detected",
      suggestions_shown: ["dbt_build", "dbt_run"],
    }
    expect(event.type).toBe("feature_suggestion")
    expect("warehouse_type" in event).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 3. skill_used event includes trigger field
// ---------------------------------------------------------------------------
describe("telemetry.skill-used-trigger", () => {
  test("skill_used event accepts trigger field", () => {
    const event: Telemetry.Event = {
      type: "skill_used",
      timestamp: Date.now(),
      session_id: "test-session",
      message_id: "msg-1",
      skill_name: "test-skill",
      skill_source: "builtin",
      duration_ms: 150,
      trigger: "llm_selected",
    }
    expect(event.trigger).toBe("llm_selected")
  })

  test("skill_used trigger supports all trigger values", () => {
    const triggers: Array<"user_command" | "llm_selected" | "auto_suggested" | "unknown"> = [
      "user_command",
      "llm_selected",
      "auto_suggested",
      "unknown",
    ]
    for (const trigger of triggers) {
      const event: Telemetry.Event = {
        type: "skill_used",
        timestamp: Date.now(),
        session_id: "s",
        message_id: "m",
        skill_name: "test",
        skill_source: "project",
        duration_ms: 10,
        trigger,
      }
      expect(event.trigger).toBe(trigger)
    }
  })
})

// ---------------------------------------------------------------------------
// 4. Regression — existing telemetry categorization still works
// ---------------------------------------------------------------------------
describe("telemetry.categorization-regression", () => {
  test("categorizeToolName still works for all categories", () => {
    expect(Telemetry.categorizeToolName("sql_execute", "standard")).toBe("sql")
    expect(Telemetry.categorizeToolName("dbt_build", "standard")).toBe("dbt")
    expect(Telemetry.categorizeToolName("read", "standard")).toBe("file")
    expect(Telemetry.categorizeToolName("anything", "mcp")).toBe("mcp")
    expect(Telemetry.categorizeToolName("warehouse_list", "standard")).toBe("warehouse")
    expect(Telemetry.categorizeToolName("lineage_trace", "standard")).toBe("lineage")
    expect(Telemetry.categorizeToolName("schema_inspector", "standard")).toBe("schema")
    expect(Telemetry.categorizeToolName("cost_analysis", "standard")).toBe("finops")
    expect(Telemetry.categorizeToolName("unknown_tool", "standard")).toBe("standard")
  })

  test("classifyError still works for known error patterns", () => {
    expect(Telemetry.classifyError("SyntaxError: unexpected token")).toBe("parse_error")
    expect(Telemetry.classifyError("ECONNREFUSED 127.0.0.1:5432")).toBe("connection")
    expect(Telemetry.classifyError("request timed out after 30s")).toBe("timeout")
    expect(Telemetry.classifyError("permission denied for table")).toBe("permission")
    expect(Telemetry.classifyError("invalid params: missing field")).toBe("validation")
    expect(Telemetry.classifyError("something completely unknown happened")).toBe("unknown")
  })

  test("bucketCount still works", () => {
    expect(Telemetry.bucketCount(0)).toBe("0")
    expect(Telemetry.bucketCount(5)).toBe("1-10")
    expect(Telemetry.bucketCount(25)).toBe("10-50")
    expect(Telemetry.bucketCount(100)).toBe("50-200")
    expect(Telemetry.bucketCount(500)).toBe("200+")
  })
})

// ---------------------------------------------------------------------------
// 5. agent_outcome event structure validation
// ---------------------------------------------------------------------------
describe("telemetry.agent-outcome", () => {
  test("agent_outcome event accepts all outcome values", () => {
    const outcomes: Array<"completed" | "abandoned" | "aborted" | "error"> = [
      "completed",
      "abandoned",
      "aborted",
      "error",
    ]
    for (const outcome of outcomes) {
      const event: Telemetry.Event = {
        type: "agent_outcome",
        timestamp: Date.now(),
        session_id: "test-session",
        agent: "plan",
        tool_calls: 5,
        generations: 3,
        duration_ms: 12000,
        cost: 0.05,
        compactions: 0,
        outcome,
      }
      expect(event.outcome).toBe(outcome)
      expect(event.agent).toBe("plan")
      expect(event.tool_calls).toBe(5)
      expect(event.generations).toBe(3)
      expect(event.duration_ms).toBe(12000)
      expect(event.cost).toBe(0.05)
    }
  })
})
