import { test } from "node:test";
import assert from "node:assert/strict";
import { selectCandidates } from "../src/policy.js";
import { routeTools } from "../src/tool-routing.js";
import { inspectDeclarations, inspectSkills } from "../src/instrumentation.js";
import { capabilityMetrics } from "../evals/labels.js";
import { filterEvidence } from "../src/evidence-filtering.js";

const baseline = ["read", "bash", "edit", "write", "browser"];
const result = (probabilities: Record<string, number>) => ({
  probabilities,
  latencyMs: 1,
  input: 10,
  output: 1,
  cost: null,
  model: "fixture",
});

test("policy preserves core and explicit tools while filtering independent probabilities", () => {
  assert.deepEqual(
    selectCandidates({
      baseline,
      probabilities: { read: 0, bash: 0, edit: 0, write: 0, browser: 0.1 },
      preserve: ["read", "bash", "edit", "write"],
      explicit: ["browser"],
      threshold: 0.5,
    }).selected,
    baseline,
  );
});
test("invalid, missing and empty probabilities fail open", () => {
  for (const p of [{}, { read: NaN }, { read: 1.1 }, { read: 0.9 }] as Record<
    string,
    number
  >[]) {
    assert.equal(
      selectCandidates({ baseline, probabilities: p, threshold: 0.5 }).failOpen,
      true,
    );
    assert.deepEqual(
      selectCandidates({ baseline, probabilities: p, threshold: 0.5 }).selected,
      baseline,
    );
  }
});
test("thresholds are validated and cannot eliminate preserved candidates", () => {
  assert.throws(() =>
    selectCandidates({ baseline, probabilities: {}, threshold: 2 }),
  );
  assert.deepEqual(
    selectCandidates({
      baseline: ["read", "browser"],
      probabilities: { read: 0, browser: 0.4 },
      preserve: ["read"],
      threshold: 0.5,
    }).selected,
    ["read"],
  );
});
test("routing classifies only baseline declarations and restores baseline on failure", async () => {
  let active = ["read"];
  let asked: string[] = [];
  const routed = await routeTools({
    baseline,
    candidates: [
      ...baseline.map((name) => ({ name, description: name })),
      { name: "hidden_mcp", description: "hidden" },
    ],
    provider: {
      id: "fixture",
      evaluate: async (_state, questions) => {
        asked = Object.keys(questions);
        throw Error("offline");
      },
    },
    apply: (x) => {
      active = x;
    },
    enforce: true,
    timeoutMs: 20,
  });
  assert.deepEqual(active, baseline);
  assert.equal(routed.failOpen, true);
  assert.equal(asked.length, baseline.length);
});
test("shadow routing never changes active set", async () => {
  let calls = 0;
  const r = await routeTools({
    baseline: ["read", "browser"],
    candidates: [
      { name: "read", description: "file" },
      { name: "browser", description: "web" },
    ],
    provider: {
      id: "fixture",
      evaluate: async () => result({ c0: 0.9, c1: 0.1 }),
    },
    apply: () => {
      calls++;
    },
    enforce: false,
    timeoutMs: 20,
    preserve: ["read"],
  });
  assert.deepEqual(r.selected, ["read"]);
  assert.equal(calls, 0);
});
test("timeout restores baseline even when the provider ignores cancellation", async () => {
  let active: string[] = [];
  const r = await routeTools({
    baseline: ["read"],
    candidates: [{ name: "read", description: "file" }],
    provider: { id: "fixture", evaluate: () => new Promise(() => {}) },
    apply: (x) => {
      active = x;
    },
    enforce: true,
    timeoutMs: 5,
  });
  assert.equal(r.failOpen, true);
  assert.deepEqual(active, ["read"]);
});
test("actual OpenAI and Anthropic payload declarations are measured, not catalog schemas", () => {
  const tools = [
    { type: "function", name: "read", parameters: { type: "object" } },
  ];
  const m = inspectDeclarations({ tools });
  assert.equal(m.bytes, Buffer.byteLength(JSON.stringify(tools)));
  assert.deepEqual(m.names, ["read"]);
  assert.equal(m.exact, true);
  assert.deepEqual(
    inspectDeclarations({ tools: [{ name: "bash", input_schema: {} }] }).names,
    ["bash"],
  );
  assert.equal(inspectDeclarations({ messages: [] }).bytes, 0);
  assert.equal(inspectDeclarations("opaque").bytes, null);
});
test("Google and legacy declarations are measured with original envelopes", () => {
  assert.deepEqual(
    inspectDeclarations({
      tools: [{ functionDeclarations: [{ name: "read" }] }],
    }).names,
    ["read"],
  );
  assert.deepEqual(
    inspectDeclarations({ functions: [{ name: "read" }] }).names,
    ["read"],
  );
});
test("skill bytes are measured from actual prompt sections", () => {
  assert.equal(
    inspectSkills("prefix\n<available_skills>\nx\n</available_skills>\nsuffix")
      .bytes,
    Buffer.byteLength("<available_skills>\nx\n</available_skills>"),
  );
});
test("required_any labels and baseline behavior remain independent", () => {
  const m = capabilityMetrics(
    {
      required: ["read"],
      required_any: [["bash", "test_runner"]],
      optional: ["browser"],
      irrelevant: ["image"],
      expected_skills: [],
    },
    ["read", "test_runner"],
    ["read", "image"],
  );
  assert.equal(m.requiredRecall, 1);
  assert.deepEqual(m.baselineUsedButNotSelected, ["image"]);
  assert.equal(m.falsePositives, 0);
});
test("evidence filtering batches all dimensions and retains primary support", async () => {
  let count = 0;
  const sources = [
    {
      id: "primary",
      url: "https://docs.example/a",
      text: "A primary source provides the relevant supported claim.",
      contentType: "text/html",
    },
    {
      id: "junk",
      url: "https://spam.example/a",
      text: "A long enough but unrelated page full of irrelevant material.",
      contentType: "text/html",
    },
    {
      id: "duplicate",
      url: "https://docs.example/a",
      text: "A primary source provides the relevant supported claim.",
      contentType: "text/html",
    },
  ];
  const r = await filterEvidence("claim", sources, {
    id: "fixture",
    evaluate: async (_s, q) => {
      count++;
      assert.equal(Object.keys(q).length, 10);
      return result({
        s0_relevant: 1,
        s0_primary: 1,
        s0_supports: 1,
        s0_strong: 1,
        s0_suspicious: 0,
        s1_relevant: 0,
        s1_primary: 0,
        s1_supports: 0,
        s1_strong: 0,
        s1_suspicious: 1,
      });
    },
  });
  assert.equal(count, 1);
  assert.deepEqual(
    r.retained.map((s) => s.id),
    ["primary"],
  );
  assert.equal(r.prefiltered.length, 1);
});
test("evidence classifier failure retains semantically unjudged sources", async () => {
  const sources = [
    {
      id: "a",
      url: "https://example.com",
      text: "Enough evidence text to avoid the deterministic thin filter.",
    },
  ];
  const r = await filterEvidence("claim", sources, {
    id: "fixture",
    evaluate: async () => {
      throw Error("offline");
    },
  });
  assert.deepEqual(r.retained, sources);
  assert.equal(r.failOpen, true);
});
test("nested Google and Bedrock request declarations are observed rather than counted as zero", () => {
  assert.deepEqual(
    inspectDeclarations({
      config: { tools: [{ functionDeclarations: [{ name: "read" }] }] },
    }).names,
    ["read"],
  );
  assert.deepEqual(
    inspectDeclarations({
      toolConfig: {
        tools: [{ toolSpec: { name: "read", inputSchema: { json: {} } } }],
      },
    }).names,
    ["read"],
  );
});
