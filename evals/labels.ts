import type { Labels } from "../src/types.js";
export function capabilityMetrics(
  labels: Labels,
  selected: string[],
  baselineUsed: string[],
) {
  const set = new Set(selected);
  const total = labels.required.length + labels.required_any.length;
  const hit =
    labels.required.filter((x) => set.has(x)).length +
    labels.required_any.filter((group) => group.some((x) => set.has(x))).length;
  return {
    requiredRecall: total ? hit / total : 1,
    falsePositives: labels.irrelevant.filter((x) => set.has(x)).length,
    baselineUsedButNotSelected: [
      ...new Set(baselineUsed.filter((x) => !set.has(x))),
    ],
    requiredByLabel: labels.required,
    requiredAnyByLabel: labels.required_any,
  };
}
export function validateLabels(labels: Labels): void {
  const all = [
    ...labels.required,
    ...labels.required_any.flat(),
    ...labels.optional,
    ...labels.irrelevant,
  ];
  if (all.some((x) => typeof x !== "string" || !x))
    throw new Error("Invalid capability labels");
  if (labels.required_any.some((x) => !x.length))
    throw new Error("Empty required_any group");
  if (
    labels.irrelevant.some(
      (x) =>
        labels.required.includes(x) || labels.required_any.flat().includes(x),
    )
  )
    throw new Error("Contradictory capability labels");
}
