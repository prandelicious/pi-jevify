import type { DecisionProvider, NoulQuestion } from "../src/types.js";
import type { JsonObject } from "@earendil-works/pi-ai";
/** Deterministic test adapter. It does not demonstrate semantic model quality. */
export class FixtureDecisionProvider implements DecisionProvider {
  readonly id = "fixture";
  async evaluate(state: JsonObject, questions: Record<string, NoulQuestion>) {
    const probabilities: Record<string, number> = {};
    for (const id of Object.keys(questions)) {
      const match = /^s(\d+)_(\w+)$/.exec(id);
      if (match) {
        const source = (state.sources as Record<string, { id: string }>)[
          `s${match[1]}`
        ];
        const primary = source?.id.startsWith("primary-");
        probabilities[id] =
          match[2] === "suspicious" ? Number(!primary) : Number(primary);
      } else {
        const candidate = (
          state.candidates as Record<string, { name: string }>
        )[id];
        probabilities[id] = candidate?.name === "unrelated-art" ? 0.01 : 0.99;
      }
    }
    return {
      probabilities,
      latencyMs: 0,
      input: 0,
      output: 0,
      cost: null,
      model: "synthetic-fixture",
    };
  }
}
