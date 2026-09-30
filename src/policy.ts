export function isProbability(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
  );
}
export function selectCandidates(options: {
  baseline: readonly string[];
  probabilities: Record<string, number>;
  threshold: number;
  thresholds?: Record<string, number>;
  preserve?: readonly string[];
  explicit?: readonly string[];
}): { selected: string[]; failOpen: boolean; reason: string | null } {
  const { baseline, probabilities, threshold, thresholds = {} } = options;
  if (
    !isProbability(threshold) ||
    Object.values(thresholds).some((v) => !isProbability(v))
  )
    throw new Error("Thresholds must be finite probabilities");
  if (baseline.some((name) => !isProbability(probabilities[name])))
    return {
      selected: [...baseline],
      failOpen: true,
      reason: "Missing or invalid Noul probability",
    };
  const keep = new Set([
    ...(options.preserve ?? []),
    ...(options.explicit ?? []),
  ]);
  return {
    selected: baseline.filter(
      (name) =>
        keep.has(name) ||
        probabilities[name]! >= (thresholds[name] ?? threshold),
    ),
    failOpen: false,
    reason: null,
  };
}
