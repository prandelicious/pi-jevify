import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI, Skill } from "@earendil-works/pi-coding-agent";
import { formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { PiClassifierProvider } from "./decisions.js";
import { inspectDeclarations, inspectSkills } from "./instrumentation.js";
import { routeTools } from "./tool-routing.js";
import { filterSkills } from "./skill-filtering.js";
import { jsonlSink } from "./telemetry.js";
import { JEV_PRICING } from "./pricing.js";
import {
  addCodemodeClassifierUsage,
  codemodeUsage,
  parseCodemodeEvidence,
} from "./codemode-evidence.js";
import {
  MODES,
  type RouterOptions,
  type Trace,
  type Gate,
  type RoutingResult,
} from "./types.js";

function envOptions(): RouterOptions {
  const mode = process.env.PI_DECISION_MODE ?? "baseline";
  if (!MODES.includes(mode as (typeof MODES)[number]))
    throw new Error(`Unknown decision mode: ${mode}`);
  let gate: Gate | undefined;
  if (process.env.PI_DECISION_GATE)
    gate = JSON.parse(
      readFileSync(process.env.PI_DECISION_GATE, "utf8"),
    ) as Gate;
  return {
    mode: mode as (typeof MODES)[number],
    tracePath: process.env.PI_DECISION_TRACE,
    taskId: process.env.PI_DECISION_TASK_ID,
    gate,
  };
}
export function createRouterExtension(options: RouterOptions = {}) {
  return (pi: ExtensionAPI): void => {
    const mode = options.mode ?? "baseline";
    const toolMode = mode === "shadow-tools" || mode === "enforced-tools";
    const skillMode = mode === "shadow-skills" || mode === "enforced-skills";
    const enforce = mode === "enforced-tools";
    let baseline: string[] | null = null;
    let skills: Skill[] = [];
    let runId = "";
    let started = 0;
    let requestStarted = 0;
    let requestId = 0;
    let turnCount = 0;
    let calls: string[] = [];
    let nestedCalls: string[] = [];
    let skillsRead: string[] = [];
    let reroutes = 0;
    let rerouteRestorations = 0;
    let recoveryStarted: number | null = null;
    let recoveryTurn = 0;
    let currentSkills: Skill[] = [];
    let routing: RoutingResult | null = null;
    let requests: Trace[] = [];
    let turns: Trace[] = [];
    let codemodeInput: number | null = 0;
    let codemodeOutput: number | null = 0;
    let codemodeCacheRead: number | null = 0;
    let codemodeCacheWrite: number | null = 0;
    let codemodeCost: number | null = 0;
    let codemodeCalls: string[] = [];
    let codemodeCallDetails: Record<string, unknown>[] = [];
    let codemodeEvidence: Record<string, unknown> | null = null;
    let warned = false;
    let sink: ((trace: Trace) => void) | undefined;
    const source = options.source ?? "live";
    const emit = (
      type: Trace["type"],
      fields: Record<string, unknown>,
    ): Trace => {
      const trace: Trace = {
        schema_version: 1,
        type,
        task_id: options.taskId ?? runId,
        run_id: runId,
        mode,
        provider:
          options.provider?.id ?? (toolMode || skillMode ? "jev" : "none"),
        source,
        ...fields,
      };
      try {
        options.onTrace?.(trace);
        sink?.(trace);
      } catch {
        if (!warned) {
          warned = true;
          console.error("pi-jevify: unable to write telemetry");
        }
      }
      return trace;
    };
    const restore = () => {
      if (baseline) pi.setActiveTools([...baseline]);
      baseline = null;
    };
    if (enforce)
      pi.registerTool({
        name: "decision_reroute",
        label: "Restore capabilities",
        description:
          "Restore the full pre-run tool loadout when a missing capability prevents completing the task. Describe the missing capability.",
        defaultActive: false,
        parameters: Type.Object({ reason: Type.String({ minLength: 1 }) }),
        executionMode: "sequential",
        async execute(_id, { reason }) {
          if (!baseline)
            return {
              content: [{ type: "text", text: "No routed run is active." }],
              details: { restored: false, tools: [] as string[] },
            };
          const restoreStarted = performance.now();
          pi.setActiveTools([...new Set([...baseline, "decision_reroute"])]);
          reroutes++;
          const restored = baseline.every((name) =>
            pi.getActiveTools().includes(name),
          );
          if (restored) rerouteRestorations++;
          if (recoveryStarted === null) {
            recoveryStarted = restoreStarted;
            recoveryTurn = turnCount;
          }
          emit("recovery", {
            event: "reroute",
            restored,
            restore_latency_ms: performance.now() - restoreStarted,
            at_turn: turnCount,
            restored_tools: [...baseline],
          });
          return {
            content: [
              {
                type: "text",
                text: `Baseline capabilities restored. Missing capability: ${reason}`,
              },
            ],
            details: { restored: true, tools: [...baseline] },
          };
        },
      });
    pi.on("before_agent_start", async (event, ctx) => {
      // A prior interrupted run must never become the next run's baseline.
      restore();
      baseline = pi
        .getActiveTools()
        .filter((name) => name !== "decision_reroute");
      runId = randomUUID();
      started = performance.now();
      requestId = 0;
      turnCount = 0;
      calls = [];
      nestedCalls = [];
      skillsRead = [];
      reroutes = 0;
      rerouteRestorations = 0;
      recoveryStarted = null;
      recoveryTurn = 0;
      requests = [];
      turns = [];
      codemodeInput = 0;
      codemodeOutput = 0;
      codemodeCacheRead = 0;
      codemodeCacheWrite = 0;
      codemodeCost = 0;
      codemodeCalls = [];
      codemodeCallDetails = [];
      codemodeEvidence = null;
      routing = null;
      try {
        sink = options.tracePath
          ? jsonlSink(resolve(options.tracePath))
          : options.onTrace
            ? undefined
            : jsonlSink(
                resolve(ctx.cwd ?? process.cwd(), ".traces/pi-jevify.jsonl"),
              );
      } catch {
        sink = undefined;
        console.error("pi-jevify: unable to initialize telemetry");
      }
      skills = [...event.systemPromptOptions.skills];
      currentSkills = [...skills];
      const experiment = toolMode ? "tools" : skillMode ? "skills" : null;
      const gate = options.gate;
      const allowed =
        experiment !== null &&
        gate?.allowed === true &&
        gate.experiment === experiment &&
        gate.baselineRuns > 0 &&
        gate.source === source;
      if ((toolMode || skillMode) && !allowed) {
        ctx.ui.notify(
          "Decision experiment skipped: a matching measured baseline gate is required.",
          "warning",
        );
        return;
      }
      if (
        enforce &&
        !pi.getAllTools().some((tool) => tool.name === "decision_reroute")
      ) {
        ctx.ui.notify(
          "Tool enforcement skipped: decision_reroute is excluded from this session registry.",
          "warning",
        );
        return;
      }
      const provider =
        options.provider ?? new PiClassifierProvider(ctx.modelRegistry);
      if (toolMode) {
        routing = await routeTools({
          baseline,
          candidates: pi.getAllTools(),
          provider,
          task: event.prompt,
          apply: (selected) =>
            pi.setActiveTools([...new Set([...selected, "decision_reroute"])]),
          enforce,
          timeoutMs: options.timeoutMs ?? 5000,
          threshold: options.threshold ?? 0.5,
          thresholds: options.thresholds,
          preserve: [
            ...new Set([
              "read",
              "bash",
              "edit",
              "write",
              ...(options.preserve ?? []),
            ]),
          ],
          explicit: [
            ...(options.explicitTools ?? []),
            ...baseline.filter((name) => event.prompt.includes(name)),
          ],
        });
        if (enforce && !pi.getActiveTools().includes("decision_reroute")) {
          pi.setActiveTools([...baseline]);
          routing = {
            ...routing,
            selected: [...baseline],
            failOpen: true,
            reason: "Recovery tool activation failed; restored baseline",
          };
        }
      } else if (skillMode) {
        const explicit = [
          ...(options.explicitSkills ?? []),
          ...skills
            .filter(
              (s) =>
                event.prompt.includes(`/skill:${s.name}`) ||
                event.prompt.includes(s.filePath),
            )
            .map((s) => s.name),
        ];
        const result = await filterSkills(event.prompt, skills, provider, {
          timeoutMs: options.timeoutMs ?? 5000,
          threshold: options.threshold ?? 0.5,
          explicit,
        });
        routing = result.routing;
        if (mode === "enforced-skills") {
          event.systemPromptOptions.skills = result.skills;
          currentSkills = result.skills;
        }
      }
    });
    pi.on("before_provider_request", (event, ctx) => {
      if (!baseline) return;
      requestStarted = performance.now();
      requestId++;
      const declarations = inspectDeclarations(event.payload);
      const strings: string[] = [];
      const visit = (value: unknown): void => {
        if (typeof value === "string") strings.push(value);
        else if (Array.isArray(value)) value.forEach(visit);
        else if (value && typeof value === "object")
          Object.values(value).forEach(visit);
      };
      visit(event.payload);
      const promptSkills = inspectSkills(strings.join("\n"));
      const payload = event.payload as { model?: unknown } | null;
      requests.push(
        emit("request", {
          request_id: requestId,
          model:
            typeof payload?.model === "string"
              ? payload.model
              : (ctx.model?.id ?? null),
          registered_tools: pi.getAllTools().map((t) => t.name),
          active_tools: pi.getActiveTools(),
          declared_tools: declarations.names,
          mcp_codemode_tools: pi
            .getAllTools()
            .filter(
              (t) =>
                t.exposure === "codemode" &&
                (t.sourceInfo?.source === "mcp" ||
                  t.namespace?.name.startsWith("mcp__")),
            )
            .map((t) => t.name),
          codemode_accessible_tools: pi
            .getAllTools()
            .filter((t) => t.exposure === "codemode")
            .map((t) => t.name),
          deferred_tools: pi
            .getAllTools()
            .filter((t) => t.exposure === "deferred")
            .map((t) => t.name),
          declared_tool_bytes: declarations.bytes,
          declared_tool_estimated_tokens: declarations.estimatedTokens,
          declarations_exact: declarations.exact,
          available_skill_count: currentSkills.filter(
            (s) => !s.disableModelInvocation,
          ).length,
          skill_prompt_bytes: promptSkills.bytes,
          skill_prompt_estimated_tokens: promptSkills.estimatedTokens,
          baseline_skill_count: skills.filter((s) => !s.disableModelInvocation)
            .length,
          baseline_skill_prompt_bytes: inspectSkills(
            formatSkillsForPrompt(skills),
          ).bytes,
          token_estimator: "ceil(UTF-8 bytes / 4); not provider tokenization",
        }),
      );
    });
    pi.on("message_end", (event) => {
      if (!baseline || event.message.role !== "assistant") return;
      const message = event.message;
      turnCount++;
      turns.push(
        emit("turn", {
          request_id: requestId,
          model: message.model,
          frontier_provider: message.provider,
          frontier_input: message.usage?.input ?? null,
          frontier_output: message.usage?.output ?? null,
          cache_read: message.usage?.cacheRead ?? null,
          cache_write: message.usage?.cacheWrite ?? null,
          frontier_cost: message.usage?.cost.total ?? null,
          wall_clock_ms: performance.now() - requestStarted,
          stop_reason: message.stopReason,
          tool_call_names: message.content
            .filter((b) => b.type === "toolCall")
            .map((b) => b.name),
        }),
      );
    });
    pi.on("tool_execution_start", (event, ctx) => {
      if (!baseline) return;
      (event.parentToolCallId ? nestedCalls : calls).push(event.toolName);
      if (event.toolName === "read" && typeof event.args?.path === "string") {
        const file = resolve(ctx?.cwd ?? process.cwd(), event.args.path);
        const skill = skills.find((s) => resolve(s.filePath) === file);
        if (skill) skillsRead.push(skill.name);
      }
    });
    pi.on("tool_execution_end", (event) => {
      if (!baseline || event.toolName !== "codemode" || event.parentToolCallId)
        return;
      const usage = codemodeUsage(event.result);
      codemodeCalls.push(...usage.calls);
      const executionCallDetails: Record<string, unknown>[] = [];
      if (
        event.result &&
        typeof event.result === "object" &&
        "details" in event.result &&
        event.result.details &&
        typeof event.result.details === "object" &&
        "calls" in event.result.details &&
        Array.isArray(event.result.details.calls)
      ) {
        const callsForExecution = event.result.details.calls.filter(
          (call: unknown): call is Record<string, unknown> =>
            typeof call === "object" && call !== null,
        );
        executionCallDetails.push(...callsForExecution);
        codemodeCallDetails.push(
          ...callsForExecution.map((call: Record<string, unknown>) => {
            const safe: Record<string, unknown> = {};
            for (const key of [
              "name",
              "parentToolCallId",
              "durationMs",
              "model",
              "cost",
            ]) {
              const value = call[key];
              if (
                key === "durationMs" || key === "cost"
                  ? typeof value === "number"
                  : typeof value === "string"
              )
                safe[key] = value;
            }
            return safe;
          }),
        );
      }
      // Usage belongs to this Codemode execution. A source-only execution
      // must not reuse an earlier classify call's model arguments or cost.
      const classifierUsage = addCodemodeClassifierUsage(
        {
          input: codemodeInput,
          output: codemodeOutput,
          cacheRead: codemodeCacheRead,
          cacheWrite: codemodeCacheWrite,
          cost: codemodeCost,
        },
        usage,
        executionCallDetails
          .filter(
            (call) =>
              call.name === "models.classify" && typeof call.args === "string",
          )
          .map((call) => String(call.args)),
      );
      codemodeInput = classifierUsage.input;
      codemodeOutput = classifierUsage.output;
      codemodeCacheRead = classifierUsage.cacheRead;
      codemodeCacheWrite = classifierUsage.cacheWrite;
      codemodeCost = classifierUsage.cost;
      const text = Array.isArray(event.result?.content)
        ? event.result.content
            .filter((part: unknown) => {
              return (
                typeof part === "object" &&
                part !== null &&
                "type" in part &&
                part.type === "text" &&
                "text" in part &&
                typeof part.text === "string"
              );
            })
            .map((part: { text: string }) => part.text)
            .join("\n")
        : "";
      const parsed = parseCodemodeEvidence(text);
      if (parsed)
        codemodeEvidence = parsed as unknown as Record<string, unknown>;
    });
    pi.on("agent_settled", () => {
      if (!baseline) return;
      const sum = (key: string): number | null =>
        turns.length && turns.every((t) => typeof t[key] === "number")
          ? turns.reduce((n, t) => n + (t[key] as number), 0)
          : null;
      const average = (key: string): number | null =>
        requests.length && requests.every((t) => typeof t[key] === "number")
          ? requests.reduce((n, t) => n + (t[key] as number), 0) /
            requests.length
          : null;
      const d = routing?.decision;
      const frontierCost = sum("frontier_cost");
      const decisionCost = d?.cost ?? (routing ? null : 0);
      const workflowCost = codemodeCost;
      try {
        emit("run", {
          task_success: null,
          quality_score: null,
          baseline_tools: [...baseline],
          selected_tools: toolMode
            ? (routing?.selected ?? [...baseline])
            : [...baseline],
          selected_skills: skillMode
            ? (routing?.selected ?? skills.map((s) => s.name))
            : skills.map((s) => s.name),
          skills_read: [...new Set(skillsRead)],
          baseline_tool_count: baseline.length,
          selected_tool_count: toolMode
            ? (routing?.selected.length ?? baseline.length)
            : baseline.length,
          declared_tool_bytes: average("declared_tool_bytes"),
          declared_tool_estimated_tokens: average(
            "declared_tool_estimated_tokens",
          ),
          skill_prompt_bytes: average("skill_prompt_bytes"),
          frontier_input: sum("frontier_input"),
          frontier_output: sum("frontier_output"),
          cache_read: sum("cache_read"),
          cache_write: sum("cache_write"),
          frontier_cost: frontierCost,
          decision_probabilities: d?.probabilities ?? null,
          decision_model: d?.model ?? null,
          decision_input: d?.input ?? (routing ? null : 0),
          decision_output: d?.output ?? (routing ? null : 0),
          decision_cost: decisionCost,
          decision_pricing:
            options.provider?.id === "jev" ||
            (!options.provider && (toolMode || skillMode))
              ? JEV_PRICING
              : null,
          decision_latency_ms: d?.latencyMs ?? (routing ? null : 0),
          codemode_input: codemodeInput,
          codemode_output: codemodeOutput,
          codemode_cache_read: codemodeCacheRead,
          codemode_cache_write: codemodeCacheWrite,
          codemode_cost: workflowCost,
          codemode_calls: [...new Set(codemodeCalls)],
          codemode_nested_calls: codemodeCallDetails,
          codemode_evidence: codemodeEvidence,
          total_cost:
            frontierCost !== null &&
            decisionCost !== null &&
            workflowCost !== null
              ? frontierCost + decisionCost + workflowCost
              : null,
          tool_calls: calls.length,
          tool_call_names: [...calls],
          nested_tool_call_names: [...nestedCalls],
          agent_turns: turnCount,
          provider_requests: requestId,
          reroutes,
          reroute_restorations: rerouteRestorations,
          reroute_success: null,
          recovery_turns:
            recoveryStarted === null ? 0 : turnCount - recoveryTurn,
          recovery_wall_clock_ms:
            recoveryStarted === null ? 0 : performance.now() - recoveryStarted,
          observed_used_but_not_selected: toolMode
            ? calls.filter(
                (name) =>
                  !routing?.selected.includes(name) &&
                  name !== "decision_reroute",
              )
            : [],
          fail_open: routing?.failOpen ?? false,
          decision_failure: routing?.reason ?? null,
          experiment_applied: routing !== null,
          gate: options.gate ?? null,
          wall_clock_ms: performance.now() - started,
          execution_completed:
            turns.length > 0 &&
            !["error", "aborted"].includes(turns.at(-1)!.stop_reason as string),
        });
      } finally {
        restore();
      }
    });
    pi.on("session_shutdown", restore);
    pi.on("session_before_switch", restore);
    pi.on("session_tree", restore);
    pi.on("session_before_fork", restore);
  };
}
export default function extension(pi: ExtensionAPI): void {
  createRouterExtension(envOptions())(pi);
}
