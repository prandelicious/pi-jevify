import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Gate, Mode, Trace } from "../src/types.js";

export function readTraces(path: string): Trace[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((x) => x.trim())
    .map((line, index) => {
      const row = JSON.parse(line) as Trace;
      if (
        row.schema_version !== 1 ||
        !["request", "turn", "run", "research", "recovery"].includes(
          row.type,
        ) ||
        !row.run_id ||
        !row.task_id ||
        !["live", "fixture"].includes(row.source)
      )
        throw new Error(`Invalid trace at line ${index + 1}`);
      return row;
    });
}
function mean(rows: Trace[], key: string): number | null {
  return rows.length &&
    rows.every((r) => typeof r[key] === "number" && Number.isFinite(r[key]))
    ? rows.reduce((s, r) => s + (r[key] as number), 0) / rows.length
    : null;
}
export function hypothesisGate(
  traces: Trace[],
  experiment: Gate["experiment"],
  options: {
    minRuns?: number;
    toolBytes?: number;
    skillBytes?: number;
    unnecessaryCalls?: number;
    evidenceBytes?: number;
  } = {},
): Gate {
  const mode = experiment === "research" ? "research-baseline" : "baseline";
  const rows = traces.filter((t) => t.type === "run" && t.mode === mode);
  if (new Set(rows.map((r) => r.source)).size > 1)
    throw new Error("Do not mix fixture and live baseline evidence");
  const source = rows[0]?.source ?? "live";
  const minimum = options.minRuns ?? 3;
  if (rows.length < minimum)
    return {
      experiment,
      allowed: false,
      baselineRuns: rows.length,
      reason: `Need at least ${minimum} baseline runs`,
      source,
    };
  const tool = mean(rows, "declared_tool_bytes");
  const skills = mean(rows, "skill_prompt_bytes");
  const waste = mean(rows, "unnecessary_tool_calls");
  const evidence = mean(rows, "evidence_bytes");
  let allowed = false;
  let reason = "";
  if (experiment === "tools") {
    allowed =
      tool !== null &&
      (tool >= (options.toolBytes ?? 4096) ||
        (waste !== null && waste >= (options.unnecessaryCalls ?? 1)));
    reason =
      tool === null
        ? "Actual declarations unavailable"
        : allowed
          ? "Measured declaration size or labeled unnecessary calls justify a tools experiment"
          : "Stop: declaration context and labeled call waste are negligible";
  } else if (experiment === "skills") {
    allowed = skills !== null && skills >= (options.skillBytes ?? 4096);
    reason = allowed
      ? "Measured skill prompt justifies a catalog experiment"
      : "Stop: skill catalog is small or unmeasured";
  } else {
    allowed = evidence !== null && evidence >= (options.evidenceBytes ?? 8192);
    reason = allowed
      ? "Measured evidence context justifies independent filtering"
      : "Stop: evidence context is small or unmeasured";
  }
  return { experiment, allowed, baselineRuns: rows.length, reason, source };
}
export const METRICS = [
  "task_success",
  "quality_score",
  "declared_tool_bytes",
  "skill_prompt_bytes",
  "frontier_input",
  "cache_read",
  "cache_write",
  "frontier_output",
  "tool_calls",
  "unnecessary_tool_calls",
  "agent_turns",
  "decision_input",
  "decision_output",
  "decision_latency_ms",
  "workflow_classifier_input",
  "workflow_classifier_output",
  "workflow_classifier_cost",
  "evidence_bytes",
  "retained_evidence_bytes",
  "wall_clock_ms",
  "total_cost",
  "required_capability_recall",
  "required_skill_recall",
  "strong_source_recall",
  "weak_source_rejection",
  "citation_correctness",
  "reroutes",
] as const;
export function compareRuns(
  traces: Trace[],
  mode: Mode,
  options: { maxRerouteRate?: number } = {},
) {
  const rows = traces.filter((r) => r.type === "run");
  const baselineMode =
    mode === "codemode-jev"
      ? "codemode-baseline"
      : mode.startsWith("research-")
        ? "research-baseline"
        : "baseline";
  const key = (r: Trace) =>
    JSON.stringify([
      r.task_id,
      r.repeat ?? 0,
      r.source,
      r.workload_id ?? null,
      r.model ?? null,
    ]);
  const baseline = new Map<string, Trace>();
  for (const row of rows.filter((r) => r.mode === baselineMode)) {
    const k = key(row);
    if (baseline.has(k))
      throw new Error(
        "Duplicate baseline pair; use separate trace files for repetitions",
      );
    baseline.set(k, row);
  }
  const experiments = rows.filter((r) => r.mode === mode);
  const pairs: { baseline: Trace; experiment: Trace }[] = [];
  const seen = new Set<string>();
  for (const row of experiments) {
    const k = key(row);
    if (seen.has(k)) throw new Error("Duplicate experimental pair");
    seen.add(k);
    const control = baseline.get(k);
    if (control) pairs.push({ baseline: control, experiment: row });
  }
  const a = pairs.map((p) => p.baseline),
    b = pairs.map((p) => p.experiment);
  const selectionDiagnostics = pairs.map(
    ({ baseline: control, experiment: trial }) => ({
      task_id: trial.task_id,
      repeat: trial.repeat ?? 0,
      required_by_label: trial.required_by_label ?? null,
      baseline_used: control.tool_call_names ?? [],
      enforced_used: mode.startsWith("enforced-")
        ? trial.tool_call_names
        : null,
      baseline_used_but_not_selected: (
        (control.tool_call_names as string[]) ?? []
      ).filter(
        (name) => !((trial.selected_tools as string[]) ?? []).includes(name),
      ),
    }),
  );
  const rerouteRate =
    b.length && b.every((r) => typeof r.reroutes === "number")
      ? b.filter((r) => (r.reroutes as number) > 0).length / b.length
      : null;
  const metrics = Object.fromEntries(
    METRICS.map((metric) => {
      const normalize = (xs: Trace[]) =>
        xs.map((r) => ({
          ...r,
          [metric]:
            typeof r[metric] === "boolean" ? Number(r[metric]) : r[metric],
        }));
      const before = mean(normalize(a), metric),
        after = mean(normalize(b), metric);
      return [
        metric,
        {
          baseline: before,
          experiment: after,
          delta: before === null || after === null ? null : after - before,
          percent:
            before === null || after === null || before === 0
              ? null
              : ((after - before) / before) * 100,
        },
      ];
    }),
  );
  let verdict:
    | "inconclusive"
    | "stop"
    | "shadow-only"
    | "fixture-only"
    | "promising" = "inconclusive";
  let reason =
    "Matched enforced outcomes, known costs, sufficient runs and quality checks are required.";
  if (mode.startsWith("shadow-")) {
    verdict = "shadow-only";
    reason =
      "Shadow selection does not establish safety of hiding capabilities.";
  } else if (
    pairs.some(
      (p) =>
        p.baseline.task_success === true && p.experiment.task_success === false,
    )
  ) {
    verdict = "stop";
    reason = "Task success regressed on a matched task.";
  } else if (pairs.length && b.every((r) => r.source === "fixture")) {
    verdict = "fixture-only";
    reason =
      "Synthetic fixture replay validates the harness, not optimization value.";
  } else if (
    pairs.length &&
    metrics.total_cost!.baseline !== null &&
    metrics.total_cost!.experiment !== null &&
    metrics.total_cost!.experiment! >= metrics.total_cost!.baseline!
  ) {
    verdict = "stop";
    reason = "Classifier overhead and cache effects do not yield cost savings.";
  } else if (
    pairs.length >= 10 &&
    rerouteRate !== null &&
    rerouteRate <= (options.maxRerouteRate ?? 0.05) &&
    experiments.length === pairs.length &&
    a.every((r) => r.task_success !== null) &&
    b.every((r) => r.task_success === true && r.experiment_applied === true) &&
    metrics.total_cost!.experiment !== null &&
    metrics.total_cost!.baseline !== null &&
    metrics.total_cost!.experiment! < metrics.total_cost!.baseline! &&
    metrics.quality_score!.experiment !== null &&
    metrics.quality_score!.baseline !== null &&
    metrics.quality_score!.experiment! >= metrics.quality_score!.baseline! &&
    b.every(
      (r) =>
        typeof r.reroutes === "number" &&
        r.reroutes <= 1 &&
        (mode === "enforced-tools"
          ? r.required_capability_recall === 1
          : mode === "enforced-skills"
            ? r.required_skill_recall === 1
            : r.strong_source_recall === 1 && r.citation_correctness === 1),
    )
  ) {
    verdict = "promising";
    reason =
      "Matched enforced outcomes show net savings; validate on larger representative workloads before enabling by default.";
  }
  return {
    mode,
    selectionDiagnostics,
    rerouteRate,
    pairs: pairs.length,
    unmatched: experiments.length - pairs.length,
    verdict,
    reason,
    metrics,
  };
}
export function markdownReport(traces: Trace[]): string {
  const modes = [
    ...new Set(traces.filter((t) => t.type === "run").map((t) => t.mode)),
  ];
  const lines = [
    "# Pi decision experiments",
    "",
    `Evidence: ${[...new Set(traces.map((t) => t.source))].join(", ")}. Token estimates use UTF-8 bytes / 4; billed usage comes from Pi. Unknown metrics stay unavailable.`,
    "",
  ];
  for (const experiment of ["tools", "skills", "research"] as const) {
    const gate = hypothesisGate(traces, experiment);
    lines.push(
      `- ${experiment}: ${gate.allowed ? "evaluate" : "stop / collect evidence"} — ${gate.reason} (${gate.baselineRuns} baseline runs)`,
    );
  }
  for (const mode of modes.filter(
    (m) => !["baseline", "research-baseline", "codemode-baseline"].includes(m),
  )) {
    const report = compareRuns(traces, mode);
    lines.push(
      "",
      `## ${mode}: ${report.verdict}`,
      "",
      `${report.reason} Matched pairs: ${report.pairs}; unmatched: ${report.unmatched}.`,
      "",
    );
    const nested = traces
      .filter((trace) => trace.type === "run" && trace.mode === mode)
      .flatMap((trace) =>
        Array.isArray(trace.codemode_nested_calls)
          ? trace.codemode_nested_calls
          : [],
      );
    if (nested.length) {
      lines.push(
        `Codemode nested calls: ${nested
          .map((call) => {
            const item = call as Record<string, unknown>;
            const duration =
              typeof item.durationMs === "number"
                ? ` ${item.durationMs.toFixed(1)}ms`
                : "";
            const cost =
              typeof item.cost === "number" ? ` $${item.cost.toFixed(8)}` : "";
            return `${String(item.name ?? "unknown")}${duration}${cost}`;
          })
          .join(", ")}`,
        "",
      );
    }
    lines.push(
      "| Metric | Baseline | Experiment | Delta |",
      "|---|---:|---:|---:|",
    );
    for (const metric of METRICS) {
      const m = report.metrics[metric]!;
      const fmt = (n: number | null) =>
        n === null ? "unavailable" : Number(n.toFixed(6)).toString();
      lines.push(
        `| ${metric} | ${fmt(m.baseline)} | ${fmt(m.experiment)} | ${m.percent === null ? fmt(m.delta) : `${m.percent.toFixed(1)}%`} |`,
      );
    }
  }
  return lines.join("\n") + "\n";
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const args = process.argv.slice(2);
    const get = (flag: string) => {
      const i = args.indexOf(flag);
      return i < 0 ? undefined : args[i + 1];
    };
    const input = get("--input");
    if (!input)
      throw new Error(
        "Usage: pnpm report --input traces.jsonl [--output report.md] [--gate tools|skills|research --gate-output gate.json]",
      );
    const traces = readTraces(input);
    const report = markdownReport(traces);
    const output = get("--output");
    if (output) writeFileSync(output, report);
    else process.stdout.write(report);
    const experiment = get("--gate");
    if (experiment) {
      if (!["tools", "skills", "research"].includes(experiment))
        throw new Error("Invalid gate experiment");
      const gate = hypothesisGate(traces, experiment as Gate["experiment"]);
      writeFileSync(
        get("--gate-output") ?? "gate.json",
        JSON.stringify(gate, null, 2) + "\n",
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
