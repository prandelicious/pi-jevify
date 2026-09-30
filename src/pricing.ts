/** Provider-specific pricing snapshot, verified against official docs on 2026-09-30.
 * https://docs.typesafe.ai/models — Jev 1.13: $0.042/M input, output free.
 * Review this snapshot when upgrading models; unsupported versions remain unpriced.
 */
export const JEV_PRICING = {
  asOf: "2026-09-30",
  source: "https://docs.typesafe.ai/models",
  inputPerMillion: 0.042,
  outputBilling: "free",
} as const;
export function jevCost(model: string, input: number | null): number | null {
  if (
    !["jev-latest", "jev-preview", "jev-1.13.0"].includes(model) ||
    input === null ||
    !Number.isFinite(input) ||
    input < 0
  )
    return null;
  return (input * JEV_PRICING.inputPerMillion) / 1_000_000;
}
