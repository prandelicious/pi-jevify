import type { Candidate, DecisionProvider, RoutingResult } from "./types.js";
import { selectCandidates } from "./policy.js";
import { withDeadline } from "./recovery.js";
import { DecisionFailure } from "./decisions.js";
export async function routeTools(options: {
  baseline: string[];
  candidates: Candidate[];
  provider: DecisionProvider;
  apply: (selected: string[]) => void;
  enforce: boolean;
  timeoutMs: number;
  task?: string;
  preserve?: string[];
  explicit?: string[];
  threshold?: number;
  thresholds?: Record<string, number>;
  signal?: AbortSignal;
}): Promise<RoutingResult> {
  const { baseline, provider } = options;
  let decision: RoutingResult["decision"] = null;
  const started = performance.now();
  try {
    if (!baseline.length)
      return { selected: [], failOpen: false, reason: null, decision: null };
    const candidates = baseline.map((name) => {
      const candidate = options.candidates.find((c) => c.name === name);
      if (!candidate) throw new Error(`Missing baseline metadata: ${name}`);
      return candidate;
    });
    const state = {
      task: options.task ?? "",
      candidates: Object.fromEntries(
        candidates.map((c, i) => [
          `c${i}`,
          { name: c.name, description: c.description },
        ]),
      ),
    };
    const questions = Object.fromEntries(
      candidates.map((_c, i) => [
        `c${i}`,
        {
          instructions: `Would \`candidates.c${i}\` directly help complete \`task\` across the entire run, including later inspection, editing, testing, and recovery?`,
        },
      ]),
    );
    decision = await withDeadline(
      (signal) => provider.evaluate(state, questions, signal),
      options.timeoutMs,
      options.signal,
    );
    const probabilities = Object.fromEntries(
      candidates.map((c, i) => [c.name, decision!.probabilities[`c${i}`]!]),
    );
    const policy = selectCandidates({
      baseline,
      probabilities,
      preserve: options.preserve,
      explicit: options.explicit,
      threshold: options.threshold ?? 0.5,
      thresholds: options.thresholds,
    });
    if (options.enforce) options.apply(policy.selected);
    return { ...policy, decision };
  } catch (error) {
    decision =
      error instanceof DecisionFailure
        ? error.decision
        : (decision ?? {
            probabilities: {},
            latencyMs: performance.now() - started,
            input: null,
            output: null,
            cost: null,
            model: "unavailable",
          });
    if (options.enforce) options.apply([...baseline]);
    return {
      selected: [...baseline],
      failOpen: true,
      reason: error instanceof Error ? error.message : "Decision failed",
      decision,
    };
  }
}
