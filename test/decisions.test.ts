import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PiClassifierProvider } from "../src/decisions.js";
import { jevCost } from "../src/pricing.js";
import { filterEvidence } from "../src/evidence-filtering.js";
const usage = {
  input: 1000,
  output: 10,
  cacheRead: 0,
  cacheWrite: 0,
  cost: { total: 99 },
};
test("Jev adapter uses registry bool/Noul without consuming Choice confidence", async () => {
  let asked: any;
  const registry = {
    findOfType: () => ({ id: "jev-latest" }),
    classify: async (_m: any, c: any) => {
      asked = c;
      return {
        stopReason: "stop",
        answers: { a: { type: "bool", probability: 0.8 } },
        usage,
        model: "jev-latest",
      };
    },
  } as unknown as ExtensionContext["modelRegistry"];
  const r = await new PiClassifierProvider(registry).evaluate(
    { task: "read" },
    { a: { instructions: "Useful?" } },
  );
  assert.equal(asked.questions.a.type, "bool");
  assert.equal(r.probabilities.a, 0.8);
  assert.equal(r.cost, 0.000042);
});
test("Jev cost uses only input and leaves unknown model pricing unavailable", () => {
  assert.equal(jevCost("jev-1.13.0", 1000), 0.000042);
  assert.equal(jevCost("unknown", 1000), null);
});
test("invalid classifier answers carry billed usage for failure accounting", async () => {
  const registry = {
    findOfType: () => ({ id: "jev-latest" }),
    classify: async () => ({
      stopReason: "error",
      answers: {},
      usage,
      model: "jev-latest",
    }),
  } as unknown as ExtensionContext["modelRegistry"];
  await assert.rejects(
    new PiClassifierProvider(registry).evaluate(
      {},
      { a: { instructions: "Useful?" } },
    ),
    (error: any) =>
      error.decision?.input === 1000 && error.decision?.cost === 0.000042,
  );
});
test("relevant authoritative contradictions are retained even without support", async () => {
  const sources = [
    {
      id: "contradiction",
      url: "https://docs.example/v1",
      text: "Official earlier documentation contradicts the target claim.",
    },
  ];
  const r = await filterEvidence("claim", sources, {
    id: "fixture",
    evaluate: async () => ({
      probabilities: {
        s0_relevant: 1,
        s0_primary: 1,
        s0_supports: 0,
        s0_strong: 1,
        s0_suspicious: 0,
      },
      input: 0,
      output: 0,
      cost: null,
      latencyMs: 0,
      model: "fixture",
    }),
  });
  assert.deepEqual(r.retained, sources);
  assert.equal(r.failOpen, false);
});
test("evidence state includes the task so explicitly required historical sources remain relevant", async () => {
  let state: any;
  await filterEvidence(
    "current timeout is 30 seconds",
    [
      {
        id: "old",
        url: "https://example.com/old",
        text: "Archived official documentation says 10 seconds for version 1.",
      },
    ],
    {
      id: "fixture",
      evaluate: async (s) => {
        state = s;
        return {
          probabilities: {
            s0_relevant: 1,
            s0_primary: 1,
            s0_supports: 0,
            s0_strong: 1,
            s0_suspicious: 0,
          },
          input: 0,
          output: 0,
          cost: null,
          latencyMs: 0,
          model: "fixture",
        };
      },
    },
    { task: "Identify older conflicting documentation." },
  );
  assert.equal(state.task, "Identify older conflicting documentation.");
});
