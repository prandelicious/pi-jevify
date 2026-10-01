import test from "node:test";
import assert from "node:assert/strict";
import { createContext, Script } from "node:vm";
import {
  addCodemodeClassifierUsage,
  codemodeEvidenceScript,
  parseCodemodeEvidence,
  codemodeUsage,
  codemodeClassifierCost,
  utf8ByteLength,
} from "../src/codemode-evidence.js";
import { codemodeEvidenceRecipe } from "../examples/codemode-evidence-recipe.js";

test("native codemode recipe classifies in the VM and retains archived primary evidence", () => {
  const script = codemodeEvidenceScript("jev", {
    task: "Find the current timeout and preserve contradictory original evidence.",
    claim: "The timeout is 30 seconds.",
  });
  assert.match(script, /tools\.fixture_research_sources/);
  assert.match(script, /models\.classify/);
  assert.match(script, /judged\.stopReason !== "stop"/);
  assert.match(script, /codePointAt/);
  assert.match(script, /source_policy/);
  assert.match(script, /Find the current timeout/);
  assert.match(script, /The timeout is 30 seconds/);
  assert.doesNotMatch(script, /!\/ignore all prior instructions\/i/);
  assert.match(script, /store\("retained_evidence"/);
  const parsed = parseCodemodeEvidence(
    '{"retained_sources":["primary-current","primary-old"],"evidence_bytes":100,"retained_evidence_bytes":80}',
  );
  assert.deepEqual(parsed?.retained_sources, [
    "primary-current",
    "primary-old",
  ]);
});

test("native baseline recipe stores fetched evidence without classifier access", () => {
  const script = codemodeEvidenceScript("baseline");
  assert.match(script, /tools\.fixture_research_sources/);
  assert.doesNotMatch(script, /models\.classify/);
  assert.match(script, /store\("retained_evidence"/);
});

test("nested codemode classifier usage is counted exactly once", () => {
  const result = codemodeUsage({
    usage: {
      input: 11,
      output: 3,
      cacheRead: 2,
      cacheWrite: 0,
      totalTokens: 16,
      cost: {
        input: 0.11,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0.11,
      },
    },
    details: {
      calls: [
        { name: "fixture_research_sources", status: "ok", durationMs: 2 },
        { name: "models.classify", status: "ok", cost: 0.11, durationMs: 4 },
      ],
    },
  });
  assert.deepEqual(result, {
    input: 11,
    output: 3,
    cacheRead: 2,
    cacheWrite: 0,
    cost: 0.11,
    calls: ["fixture_research_sources", "models.classify"],
  });
});

test("classifier accounting scopes model pricing to each execution and preserves unknown fields", () => {
  const first = addCodemodeClassifierUsage(
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    {
      input: 100,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      calls: ["models.classify"],
    },
    ["typesafe/jev-latest"],
  );
  const sourceOnly = addCodemodeClassifierUsage(
    first,
    {
      input: null,
      output: null,
      cacheRead: null,
      cacheWrite: null,
      cost: null,
      calls: ["fixture_research_sources"],
    },
    [],
  );
  assert.deepEqual(sourceOnly, first);
  const partial = addCodemodeClassifierUsage(
    sourceOnly,
    {
      input: 10,
      output: null,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      calls: ["models.classify"],
    },
    ["typesafe/jev-latest"],
  );
  assert.equal(partial.input, 110);
  assert.equal(partial.output, null);
  assert.ok(Math.abs(partial.cost! - (0.0000042 + 0.00000042)) < 1e-15);
});

test("native classifier validation rejects failure results and empty or out-of-range judgments", () => {
  const script = codemodeEvidenceScript("jev");
  assert.match(script, /judged\.errorMessage/);
  assert.match(script, /empty classifier shortlist/);
  assert.match(script, /<= 1/);
});

test("native evidence sizes use UTF-8 bytes and unknown zero pricing is unavailable", () => {
  assert.equal(utf8ByteLength("é🙂"), 6);
  assert.equal(codemodeClassifierCost(0, 100, ["typesafe/unknown"]), null);
  assert.ok(
    Math.abs(
      codemodeClassifierCost(0, 100, ["typesafe/jev-latest"])! - 0.0000042,
    ) < 1e-15,
  );
});

test("documented host recipe executes and returns the profiler report schema", async () => {
  assert.match(codemodeEvidenceRecipe, /evidence_bytes/);
  assert.match(codemodeEvidenceRecipe, /retained_evidence_bytes/);
  assert.match(codemodeEvidenceRecipe, /codePointAt/);
  assert.match(codemodeEvidenceRecipe, /source_policy/);
  const sources = [
    {
      id: "unicode-primary",
      url: "https://fixture.invalid/unicode",
      text: "Official primary evidence café 🙂 with enough detail to retain.",
    },
  ];
  const source = sources[0]!;
  const stores = new Map<string, unknown>();
  const context = createContext({
    tools: { research_sources: async () => ({ sources }) },
    models: {
      getAvailableOfType: async () => ["fixture-classifier"],
      classify: async (
        _model: unknown,
        state: { questions: Record<string, unknown> },
      ) => ({
        stopReason: "stop",
        answers: Object.fromEntries(
          Object.keys(state.questions).map((id) => [
            id,
            {
              type: "bool",
              probability: id.endsWith("suspicious") ? 0.01 : 0.99,
            },
          ]),
        ),
      }),
    },
    store: (key: string, value: unknown) => stores.set(key, value),
  });
  const result = await new Script(
    `(async () => {${codemodeEvidenceRecipe}})()`,
  ).runInContext(context);
  assert.deepEqual(result.retained_sources, ["unicode-primary"]);
  assert.equal(result.evidence_bytes, utf8ByteLength(source.text));
  assert.equal(result.retained_evidence_bytes, utf8ByteLength(source.text));
  assert.equal(stores.get("retained_evidence_summary"), result);
  const parsed = parseCodemodeEvidence(JSON.stringify(result));
  assert.deepEqual(parsed?.retained_sources, ["unicode-primary"]);
});

test("missing native classifier usage remains unavailable", () => {
  const usage = codemodeUsage({
    details: { calls: [{ name: "models.classify", status: "ok" }] },
  });
  assert.equal(usage.input, null);
  assert.equal(usage.output, null);
  assert.equal(usage.cacheRead, null);
  assert.equal(usage.cacheWrite, null);
  assert.equal(usage.cost, null);
  assert.equal(
    codemodeClassifierCost(null, null, ["typesafe/jev-latest"]),
    null,
  );
});
