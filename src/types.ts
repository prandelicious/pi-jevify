import type { JsonObject } from "@earendil-works/pi-ai";

export const MODES = [
  "baseline",
  "shadow-tools",
  "enforced-tools",
  "shadow-skills",
  "enforced-skills",
  "research-baseline",
  "research-decision-filter",
  "codemode-baseline",
  "codemode-jev",
] as const;
export type Mode = (typeof MODES)[number];
export interface NoulQuestion {
  instructions: string;
  criteria?: { true: string; false: string };
}
export interface DecisionResult {
  probabilities: Record<string, number>;
  latencyMs: number;
  input: number | null;
  output: number | null;
  cost: number | null;
  model: string;
}
export interface DecisionProvider {
  readonly id: string;
  evaluate(
    state: JsonObject,
    questions: Record<string, NoulQuestion>,
    signal?: AbortSignal,
  ): Promise<DecisionResult>;
}
export interface Candidate {
  name: string;
  description: string;
}
export interface Labels {
  required: string[];
  required_any: string[][];
  optional: string[];
  irrelevant: string[];
  expected_skills: string[];
}
export interface Source {
  id: string;
  url: string;
  text: string;
  contentType?: string;
  publishedAt?: string;
}
export interface RoutingResult {
  selected: string[];
  failOpen: boolean;
  reason: string | null;
  decision: DecisionResult | null;
}
export interface Gate {
  experiment: "tools" | "skills" | "research";
  allowed: boolean;
  baselineRuns: number;
  reason: string;
  source: "live" | "fixture";
}
export interface Trace {
  schema_version: 1;
  type: "request" | "turn" | "run" | "research" | "recovery";
  task_id: string;
  run_id: string;
  mode: Mode;
  provider: string;
  source: "live" | "fixture";
  [key: string]: unknown;
}
export interface RouterOptions {
  mode?: Mode;
  taskId?: string;
  tracePath?: string;
  source?: "live" | "fixture";
  timeoutMs?: number;
  threshold?: number;
  thresholds?: Record<string, number>;
  preserve?: string[];
  explicitTools?: string[];
  explicitSkills?: string[];
  provider?: DecisionProvider;
  gate?: Gate;
  onTrace?: (trace: Trace) => void;
}
