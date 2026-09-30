import type { ClassifierContext } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  DecisionProvider,
  DecisionResult,
  NoulQuestion,
} from "./types.js";
import { isProbability } from "./policy.js";
import { jevCost } from "./pricing.js";

export class DecisionFailure extends Error {
  constructor(
    message: string,
    readonly decision: DecisionResult,
  ) {
    super(message);
  }
}

/** Pi maps its bool question/answer to TypeSafe Noul on the wire. */
export class PiClassifierProvider implements DecisionProvider {
  readonly id = "jev";
  constructor(
    private registry: ExtensionContext["modelRegistry"],
    private modelId = "jev-latest",
  ) {}
  async evaluate(
    state: ClassifierContext["state"],
    questions: Record<string, NoulQuestion>,
    signal?: AbortSignal,
  ): Promise<DecisionResult> {
    const model = this.registry.findOfType(
      "classifier",
      "typesafe",
      this.modelId,
    );
    if (!model)
      throw new Error("Jev classifier is unavailable in Pi model registry");
    const started = performance.now();
    const result = await this.registry.classify(
      model,
      {
        state,
        questions: Object.fromEntries(
          Object.entries(questions).map(([id, q]) => [
            id,
            {
              type: "bool" as const,
              instructions: q.instructions,
              criteria: q.criteria ?? {
                true: "The proposition is true.",
                false: "The proposition is false.",
              },
            },
          ]),
        ),
      },
      { signal },
    );
    const measured: DecisionResult = {
      probabilities: {},
      latencyMs: performance.now() - started,
      input: result.usage?.input ?? null,
      output: result.usage?.output ?? null,
      cost: jevCost(result.model, result.usage?.input ?? null),
      model: result.model,
    };
    if (result.stopReason !== "stop")
      throw new DecisionFailure(
        `Jev classification ${result.stopReason}`,
        measured,
      );
    const probabilities: Record<string, number> = {};
    for (const id of Object.keys(questions)) {
      const answer = result.answers[id];
      if (answer?.type !== "bool" || !isProbability(answer.probability))
        throw new DecisionFailure(`Invalid Noul answer for ${id}`, measured);
      probabilities[id] = answer.probability;
    }
    return { ...measured, probabilities };
  }
}
