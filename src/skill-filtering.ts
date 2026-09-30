import type { Skill } from "@earendil-works/pi-coding-agent";
import type { DecisionProvider, RoutingResult } from "./types.js";
import { routeTools } from "./tool-routing.js";
/** Catalog discoverability experiment; paths remain readable. */
export async function filterSkills(
  task: string,
  skills: Skill[],
  provider: DecisionProvider,
  options: { timeoutMs: number; threshold: number; explicit: string[] },
): Promise<{ skills: Skill[]; routing: RoutingResult }> {
  const visible = skills.filter((s) => !s.disableModelInvocation);
  const routing = await routeTools({
    baseline: visible.map((s) => s.name),
    candidates: visible,
    task,
    provider,
    apply: () => {},
    enforce: false,
    ...options,
  });
  return {
    skills: skills.filter(
      (s) => s.disableModelInvocation || routing.selected.includes(s.name),
    ),
    routing,
  };
}
