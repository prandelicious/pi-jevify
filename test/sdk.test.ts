import { test } from "node:test";
import assert from "node:assert/strict";
import { runCase } from "../evals/runner.js";
import { loadCorpus } from "../evals/corpus.js";
const corpus = loadCorpus();
test("real Pi SDK keeps hidden external fixture registered without declaring its schema", async () => {
  const traces = await runCase(
    corpus.find((c) => c.id === "codemode-lookup")!,
    { mode: "baseline", fixture: true, repeat: 0 },
  );
  const request = traces.find((t) => t.type === "request")!;
  assert.ok((request.registered_tools as string[]).includes("fixture_release"));
  assert.ok(!(request.declared_tools as string[]).includes("fixture_release"));
  assert.ok(
    (
      traces.find((t) => t.type === "run")!.nested_tool_call_names as string[]
    ).includes("fixture_release"),
  );
});
test("real Pi BM25 discovers and loads a deferred fixture", async () => {
  const traces = await runCase(
    corpus.find((c) => c.id === "deferred-lookup")!,
    { mode: "baseline", fixture: true, repeat: 0 },
  );
  assert.ok(
    (
      traces.findLast((t) => t.type === "request")!.declared_tools as string[]
    ).includes("fixture_release"),
  );
  assert.ok(
    (
      traces.find((t) => t.type === "run")!.tool_call_names as string[]
    ).includes("fixture_release"),
  );
});
for (const mode of [
  "shadow-tools",
  "enforced-tools",
  "shadow-skills",
  "enforced-skills",
] as const) {
  test(`real Pi SDK ${mode} keeps task execution working`, async () => {
    // This gate enables a contract test only; synthetic outcomes cannot authorize live use.
    const gate = {
      experiment: mode.includes("tools") ? "tools" : "skills",
      allowed: true,
      baselineRuns: 18,
      reason: "Measured fixture baseline; contract validation only",
      source: "fixture",
    } as const;
    const c = corpus.find(
      (c) =>
        c.id === (mode.includes("skills") ? "skill-dependent" : "core-read"),
    )!;
    const traces = await runCase(c, { mode, fixture: true, repeat: 0, gate });
    const run = traces.find((t) => t.type === "run")!;
    assert.equal(run.task_success, true);
    assert.equal(run.experiment_applied, true);
    const request = traces.find((t) => t.type === "request")!;
    assert.equal(
      (request.declared_tools as string[]).includes("decision_reroute"),
      mode === "enforced-tools",
    );
    if (mode === "enforced-skills")
      assert.equal(request.available_skill_count, 1);
    if (mode === "shadow-skills")
      assert.equal(request.available_skill_count, 2);
  });
}
