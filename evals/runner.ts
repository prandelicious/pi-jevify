import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkArtifacts } from "./checker.js";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  createCodemodeExtension,
  createToolSearchExtension,
  type Skill,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createRouterExtension } from "../src/index.js";
import { PiClassifierProvider } from "../src/decisions.js";
import { filterEvidence } from "../src/evidence-filtering.js";
import { jsonlSink } from "../src/telemetry.js";
import { MODES, type Gate, type Mode, type Trace } from "../src/types.js";
import { loadCorpus, researchSources, type EvalCase } from "./corpus.js";
import { capabilityMetrics } from "./labels.js";
import { FixtureDecisionProvider } from "./fixture-provider.js";
import { fixtureFrontier } from "./fixture-frontier.js";

function safeFile(root: string, path: string): string {
  const target = resolve(root, path);
  if (!target.startsWith(root + "/"))
    throw new Error("Eval paths must stay within their isolated workspace");
  return target;
}
export async function runCase(
  c: EvalCase,
  options: {
    mode: Mode;
    fixture: boolean;
    repeat: number;
    gate?: Gate;
    model?: string;
    timeoutMs?: number;
    agentDir?: string;
  },
): Promise<Trace[]> {
  const root = mkdtempSync(join(tmpdir(), "pi-jevify-"));
  const cwd = join(root, "work");
  const agentDir = join(root, "agent");
  mkdirSync(cwd);
  mkdirSync(agentDir);
  let frontier: Awaited<ReturnType<typeof fixtureFrontier>> | undefined;
  let session:
    | Awaited<ReturnType<typeof createAgentSession>>["session"]
    | undefined;
  const traces: Trace[] = [];
  try {
    for (const [file, content] of Object.entries(c.files ?? {})) {
      const path = safeFile(cwd, file);
      mkdirSync(resolve(path, ".."), { recursive: true });
      writeFileSync(path, content);
    }
    const skills: Skill[] = (c.skills ?? []).map((s) => {
      const baseDir = safeFile(cwd, `skills/${s.name}`);
      mkdirSync(baseDir, { recursive: true });
      const filePath = join(baseDir, "SKILL.md");
      writeFileSync(filePath, s.text);
      return {
        name: s.name,
        description: s.description,
        filePath,
        baseDir,
        disableModelInvocation: false,
        sourceInfo: {
          path: filePath,
          source: "fixture",
          scope: "temporary",
          origin: "top-level",
        },
      };
    });
    const userDir = options.agentDir ?? join(homedir(), ".pi", "agent");
    if (!options.fixture)
      for (const file of ["auth.json", "models.json"])
        if (existsSync(join(userDir, file)))
          copyFileSync(join(userDir, file), join(agentDir, file));
    const runtime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
    });
    let model;
    if (options.fixture) {
      frontier = await fixtureFrontier(c, skills[0]?.filePath);
      model = frontier.model;
      runtime.registerProvider("fixture", {
        api: "openai-completions",
        baseUrl: model.baseUrl,
        apiKey: "local-test-key",
        models: [model],
      });
    } else {
      const settings = existsSync(join(userDir, "settings.json"))
        ? (JSON.parse(readFileSync(join(userDir, "settings.json"), "utf8")) as {
            defaultProvider?: string;
            defaultModel?: string;
          })
        : {};
      const selected =
        options.model ??
        (settings.defaultProvider && settings.defaultModel
          ? `${settings.defaultProvider}/${settings.defaultModel}`
          : undefined);
      if (selected) {
        const slash = selected.indexOf("/");
        model = runtime.getModel(
          selected.slice(0, slash),
          selected.slice(slash + 1),
        );
      } else model = (await runtime.getAvailable())[0];
      if (!model)
        throw new Error(
          "No frontier model is available. Configure Pi or pass --model provider/id.",
        );
    }
    const decisionProvider = options.fixture
      ? new FixtureDecisionProvider()
      : new PiClassifierProvider(new ModelRegistry(runtime));
    const factories: ExtensionFactory[] = [
      createRouterExtension({
        mode: options.mode,
        taskId: c.id,
        source: options.fixture ? "fixture" : "live",
        gate: options.gate,
        provider:
          options.mode === "baseline" || options.mode.startsWith("research-")
            ? undefined
            : decisionProvider,
        onTrace: (t) => traces.push(t),
      }),
    ];
    let tools = ["read", "bash", "edit", "write"];
    if (c.capabilityFixture) {
      factories.unshift((pi) =>
        pi.registerTool({
          name: "fixture_release",
          label: "Fixture release",
          description:
            "Retrieve the internal release marker for the controlled eval fixture.",
          parameters: Type.Object({}),
          exposure:
            c.capabilityFixture === "codemode" ? "codemode" : "deferred",
          namespace: {
            name: "fixture",
            description:
              "Local external-capability test double, not a live MCP server",
          },
          async execute() {
            return {
              content: [{ type: "text", text: "RELEASE_FIXTURE_42" }],
              details: { marker: "RELEASE_FIXTURE_42" },
            };
          },
        }),
      );
      factories.unshift(
        createCodemodeExtension({ models: false }),
        createToolSearchExtension(),
      );
      tools.push(
        c.capabilityFixture === "codemode" ? "codemode" : "tool_search",
      );
    }
    const settings = SettingsManager.inMemory({
      defaultTools: tools,
      compaction: { enabled: false },
      retry: { enabled: false },
    });
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager: settings,
      noExtensions: true,
      noSkills: true,
      noContextFiles: true,
      noPromptTemplates: true,
      noThemes: true,
      extensionFactories: factories,
      skillsOverride: () => ({ skills, diagnostics: [] }),
    });
    await loader.reload();
    let prompt = c.prompt;
    let evidenceFields: Record<string, unknown> = {};
    if (c.researchFixture) {
      const sources = researchSources();
      let retained = sources;
      let decision = null;
      let failOpen = false;
      let decisionFailure: string | null = null;
      const filterStarted = performance.now();
      if (options.mode === "research-decision-filter") {
        const filtered = await filterEvidence(
          "The current fixture service timeout is 30 seconds.",
          sources,
          decisionProvider,
          { task: c.prompt },
        );
        retained = filtered.retained;
        decision = filtered.decision;
        failOpen = filtered.failOpen;
        decisionFailure = filtered.reason;
      }
      prompt +=
        "\n\nProvided extracted sources:\n" +
        retained.map((s) => JSON.stringify(s)).join("\n");
      const ids = new Set(retained.map((s) => s.id));
      const labels = c.sourceLabels!;
      evidenceFields = {
        evidence_bytes: Buffer.byteLength(
          sources.map((s) => s.text).join("\n"),
        ),
        retained_evidence_bytes: Buffer.byteLength(
          retained.map((s) => s.text).join("\n"),
        ),
        retained_sources: [...ids],
        strong_source_recall:
          labels.strong.filter((id) => ids.has(id)).length /
          labels.strong.length,
        weak_source_rejection:
          labels.weak.filter((id) => !ids.has(id)).length / labels.weak.length,
        decision_input: decision ? decision.input : 0,
        decision_output: decision ? decision.output : 0,
        decision_latency_ms: decision?.latencyMs ?? 0,
        decision_cost:
          decision?.cost ?? (options.mode === "research-baseline" ? 0 : null),
        decision_probabilities: decision?.probabilities ?? null,
        decision_failure: decisionFailure,
        workflow_filter_latency_ms:
          options.mode === "research-decision-filter"
            ? performance.now() - filterStarted
            : 0,
        provider:
          options.mode === "research-decision-filter"
            ? decisionProvider.id
            : "none",
        fail_open: failOpen,
        experiment_applied: options.mode === "research-decision-filter",
      };
    }
    const created = await createAgentSession({
      cwd,
      agentDir,
      model,
      thinkingLevel: "off",
      modelRuntime: runtime,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager: settings,
    });
    session = created.session;
    if (created.extensionsResult.errors.length)
      throw new Error(
        `Extension loading failed: ${created.extensionsResult.errors.map((e) => e.error).join("; ")}`,
      );
    await session.bindExtensions({
      mode: "print",
      onError: (error) => {
        throw new Error(`Extension error: ${error.error}`);
      },
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    let executionError: string | null = null;
    try {
      timer = setTimeout(() => {
        timedOut = true;
        void session?.abort();
      }, options.timeoutMs ?? 120000);
      await session.prompt(prompt, { expandPromptTemplates: false });
    } catch (error) {
      executionError =
        error instanceof Error ? error.message : "Execution failed";
    } finally {
      if (timer) clearTimeout(timer);
    }
    const answer = session.messages
      .filter((m) => m.role === "assistant")
      .flatMap((m) =>
        m.role === "assistant"
          ? m.content.flatMap((b) => (b.type === "text" ? [b.text] : []))
          : [],
      )
      .join("\n");
    const checks = (c.checks.answerIncludes ?? []).map((text) =>
      answer.toLowerCase().includes(text.toLowerCase()),
    );
    if (c.checks.command) checks.push(checkArtifacts(c, cwd));
    const run = traces.findLast((t) => t.type === "run");
    if (!run)
      throw new Error(
        `No run trace emitted: ${executionError ?? "extension lifecycle was not bound"}`,
      );
    const called = [
      ...(run.tool_call_names as string[]),
      ...(run.nested_tool_call_names as string[]),
    ];
    const metrics = capabilityMetrics(
      c.labels,
      run.selected_tools as string[],
      called,
    );
    const skillSelected = run.selected_skills as string[];
    Object.assign(run, {
      ...evidenceFields,
      task_success:
        !timedOut &&
        !executionError &&
        run.execution_completed === true &&
        checks.length > 0 &&
        checks.every(Boolean),
      quality_score: checks.length
        ? checks.filter(Boolean).length / checks.length
        : null,
      required_capability_recall: metrics.requiredRecall,
      required_skill_recall: c.labels.expected_skills.length
        ? c.labels.expected_skills.filter((s) => skillSelected.includes(s))
            .length / c.labels.expected_skills.length
        : 1,
      unnecessary_tool_calls: called.filter((name) =>
        c.labels.irrelevant.includes(name),
      ).length,
      required_by_label: c.labels.required,
      required_any_by_label: c.labels.required_any,
      baseline_used: options.mode === "baseline" ? called : null,
      enforced_used: options.mode === "enforced-tools" ? called : null,
      baseline_used_but_not_selected: options.mode.startsWith("shadow-")
        ? metrics.baselineUsedButNotSelected
        : null,
      capability_fixture: c.capabilityFixture ?? null,
      execution_error: executionError,
      timed_out: timedOut,
      checker:
        "answer markers and/or independent artifact tests; not a general human quality assessment",
    });
    run.reroute_success =
      (run.reroutes as number) > 0
        ? run.task_success === true && run.reroute_restorations === run.reroutes
        : null;
    if (c.researchFixture) {
      run.wall_clock_ms =
        (run.wall_clock_ms as number) +
        (run.workflow_filter_latency_ms as number);
      const cited = [...answer.matchAll(/\[([a-z]+-[a-z0-9]+)\]/g)].map(
        (m) => m[1]!,
      );
      run.citation_ids = cited;
      run.citation_correctness = cited.length
        ? cited.filter((id) => c.sourceLabels!.validCitations.includes(id))
            .length / cited.length
        : 0;
      run.task_success =
        run.task_success === true && run.citation_correctness === 1;
      const cost = run.decision_cost;
      run.total_cost =
        typeof run.frontier_cost === "number" && typeof cost === "number"
          ? run.frontier_cost + cost
          : null;
    }
    const workloadId = createHash("sha256")
      .update(
        JSON.stringify({
          case: c,
          model: `${model.provider}/${model.id}`,
          fixture: options.fixture,
        }),
      )
      .digest("hex");
    for (const t of traces)
      Object.assign(t, {
        repeat: options.repeat,
        workload_id: workloadId,
        category: c.category,
        model: `${model.provider}/${model.id}`,
      });
    return traces;
  } finally {
    session?.dispose();
    await frontier?.close();
    rmSync(root, { recursive: true, force: true });
  }
}
export async function main(args: string[]) {
  const value = (flag: string) => {
    const i = args.indexOf(flag);
    return i < 0 ? undefined : args[i + 1];
  };
  const mode = (value("--mode") ?? "baseline") as Mode;
  if (!MODES.includes(mode)) throw new Error("Invalid eval mode");
  const fixture = args.includes("--fixture");
  const provider = value("--provider") ?? "jev";
  if (provider !== "jev")
    throw new Error(
      "Only Jev is implemented; OpenAI Decisions remains a future provider.",
    );
  const repeats = Number(value("--repeat") ?? 2);
  if (!Number.isInteger(repeats) || repeats < 1)
    throw new Error("--repeat must be a positive integer");
  const gatePath = value("--gate");
  const gate: Gate | undefined = gatePath
    ? JSON.parse(readFileSync(gatePath, "utf8"))
    : undefined;
  const experiment = mode.includes("tools")
    ? "tools"
    : mode.includes("skills")
      ? "skills"
      : mode === "research-decision-filter"
        ? "research"
        : null;
  if (
    experiment &&
    (!gate?.allowed ||
      gate.experiment !== experiment ||
      gate.baselineRuns < 1 ||
      gate.source !== (fixture ? "fixture" : "live"))
  )
    throw new Error(
      "A matching allowed baseline gate is required. Generate it from baseline JSONL with pnpm report.",
    );
  const cases = loadCorpus(value("--corpus")).filter(
    (c) =>
      (mode.startsWith("research-")
        ? c.category === "research"
        : c.category !== "research") &&
      (!value("--case") || c.id === value("--case")),
  );
  if (!cases.length) throw new Error("No matching eval cases");
  const output = resolve(
    value("--output") ??
      `.traces/${fixture ? "fixture" : "live"}-${mode}.jsonl`,
  );
  if (existsSync(output))
    throw new Error(
      "Output exists; choose a new path to prevent duplicate comparison pairs.",
    );
  const sink = jsonlSink(output);
  for (let repeat = 0; repeat < repeats; repeat++)
    for (const c of cases) {
      const traces = await runCase(c, {
        mode,
        fixture,
        repeat,
        gate,
        model: value("--model"),
        agentDir: value("--agent-dir"),
      });
      traces.forEach(sink);
      const run = traces.find((t) => t.type === "run")!;
      console.log(
        `${c.id} #${repeat + 1}: ${run.task_success ? "pass" : "fail"} (${Math.round(run.wall_clock_ms as number)} ms; ${fixture ? "scripted fixture" : "live model"})`,
      );
    }
  console.log(`Traces: ${output}`);
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
