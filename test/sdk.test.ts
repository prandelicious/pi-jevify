import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { main, runCase } from "../evals/runner.js";
import { loadCorpus, researchSources } from "../evals/corpus.js";
const corpus = loadCorpus();
test("native Codemode CLI rejects non-fixture runs before model setup", async () => {
  await assert.rejects(
    main(["--mode", "codemode-jev", "--repeat", "1"]),
    /require --fixture/,
  );
});
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
for (const mode of ["codemode-baseline", "codemode-jev"] as const) {
  test(`real Pi SDK ${mode} filters evidence in native Codemode`, async () => {
    const c = corpus.find((c) => c.id === "research-conflicts")!;
    const traces = await runCase(c, { mode, fixture: true, repeat: 0 });
    const run = traces.find((t) => t.type === "run")!;
    assert.equal(run.task_success, true);
    assert.equal(run.experiment_applied, mode === "codemode-jev");
    const summary = run.codemode_evidence as {
      retained_sources: string[];
      fail_open: boolean;
    };
    assert.ok(summary.retained_sources.includes("primary-current"));
    assert.ok(summary.retained_sources.includes("primary-old"));
    assert.equal(summary.fail_open, false);
    assert.ok(
      (run.codemode_calls as string[]).includes("fixture_research_sources"),
    );
    if (mode === "codemode-jev") {
      assert.ok((run.codemode_calls as string[]).includes("models.classify"));
      assert.equal(run.workflow_classifier_input, 100);
      assert.equal(run.total_cost, run.workflow_classifier_cost);
      assert.equal(run.codemode_classifier_task_matches_prompt, true);
      assert.equal(run.codemode_classifier_claim_present, true);
      assert.equal(
        run.codemode_classifier_source_count,
        researchSources(c.id).filter(
          (source) => source.text.trim().length >= 32,
        ).length,
      );
      assert.equal(
        run.codemode_classifier_source_text_hash,
        createHash("sha256")
          .update(
            researchSources(c.id)
              .filter((source) => source.text.trim().length >= 32)
              .map((source) => source.text)
              .join("\u0000"),
          )
          .digest("hex"),
      );
      const serialized = JSON.stringify(traces);
      assert.doesNotMatch(serialized, /IGNORE ALL PRIOR INSTRUCTIONS/);
      assert.doesNotMatch(serialized, /fixture service timeout is 30 seconds/);
      const nestedCalls = run.codemode_nested_calls as Record<
        string,
        unknown
      >[];
      assert.ok(nestedCalls.length > 0);
      assert.ok(nestedCalls.every((call) => !Object.hasOwn(call, "args")));
    }
  });
}
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
