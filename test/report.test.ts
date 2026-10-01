import { test } from "node:test";
import assert from "node:assert/strict";
import { hypothesisGate, compareRuns, METRICS } from "../evals/report.js";
import type { Trace } from "../src/types.js";
const row = (
  id: string,
  mode: "baseline" | "enforced-tools",
  fields: Record<string, unknown> = {},
): Trace => ({
  schema_version: 1,
  type: "run",
  task_id: id,
  run_id: id + mode,
  mode,
  provider: mode === "baseline" ? "none" : "jev",
  source: "live",
  repeat: 0,
  task_success: true,
  quality_score: 1,
  declared_tool_bytes: 1000,
  skill_prompt_bytes: 100,
  unnecessary_tool_calls: 0,
  frontier_input: 100,
  frontier_output: 10,
  cache_read: 50,
  cache_write: 0,
  total_cost: 1,
  wall_clock_ms: 100,
  reroutes: 0,
  required_capability_recall: 1,
  ...fields,
});
test("small measured declarations stop the tool experiment", () => {
  assert.equal(
    hypothesisGate(
      [row("a", "baseline"), row("b", "baseline"), row("c", "baseline")],
      "tools",
    ).allowed,
    false,
  );
});
test("missing declaration measurements never justify a gate", () => {
  assert.equal(
    hypothesisGate(
      [
        row("a", "baseline", { declared_tool_bytes: null }),
        row("b", "baseline"),
        row("c", "baseline"),
      ],
      "tools",
    ).allowed,
    false,
  );
});
test("fixture measurements cannot authorize a live experiment", () => {
  assert.equal(
    hypothesisGate(
      [
        row("a", "baseline", { source: "fixture" }),
        row("b", "baseline", { source: "fixture" }),
        row("c", "baseline", { source: "fixture" }),
      ],
      "tools",
    ).source,
    "fixture",
  );
});
test("report requires matching pairs, known costs, and successful enforced outcomes", () => {
  const rows = [
    row("a", "baseline"),
    row("a", "enforced-tools", { total_cost: null }),
  ];
  assert.equal(compareRuns(rows, "enforced-tools").verdict, "inconclusive");
  assert.equal(
    compareRuns(
      [
        row("a", "baseline"),
        row("a", "enforced-tools", { task_success: false }),
      ],
      "enforced-tools",
    ).verdict,
    "stop",
  );
  assert.equal(
    compareRuns(
      [row("a", "baseline"), row("b", "enforced-tools")],
      "enforced-tools",
    ).pairs,
    0,
  );
});
test("shadow comparisons never prove enforcement", () => {
  const shadow = {
    ...row("a", "enforced-tools"),
    mode: "shadow-tools",
  } as Trace;
  assert.equal(
    compareRuns([row("a", "baseline"), shadow], "shadow-tools").verdict,
    "shadow-only",
  );
});
test("a reroute on every run is not a low recovery rate", () => {
  const rows = Array.from({ length: 10 }, (_, i) => [
    row(`task-${i}`, "baseline"),
    row(`task-${i}`, "enforced-tools", {
      experiment_applied: true,
      total_cost: 0.5,
      reroutes: 1,
    }),
  ]).flat();
  assert.notEqual(compareRuns(rows, "enforced-tools").verdict, "promising");
});
test("native evidence byte metrics are included in reports", () => {
  assert.ok(METRICS.includes("evidence_bytes"));
  assert.ok(METRICS.includes("retained_evidence_bytes"));
});
