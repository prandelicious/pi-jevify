import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createRouterExtension } from "../src/index.js";
import type { Trace } from "../src/types.js";

function harness(
  mode: "baseline" | "shadow-tools" | "enforced-tools" | "enforced-skills",
  fail = false,
) {
  const handlers = new Map<string, Function>();
  let active = ["read", "bash", "edit", "write", "browser"];
  const traces: Trace[] = [];
  const tools: Record<string, any> = {};
  const pi = {
    on: (name: string, fn: Function) => {
      handlers.set(name, fn);
    },
    registerTool: (tool: any) => {
      tools[tool.name] = tool;
    },
    getActiveTools: () => [...active],
    setActiveTools: (x: string[]) => {
      active = [...x];
    },
    getAllTools: () => [
      ...["read", "bash", "edit", "write", "browser"].map((name) => ({
        name,
        description: name,
        exposure: "direct",
        parameters: {},
      })),
      ...Object.values(tools),
      {
        name: "hidden_mcp",
        description: "hidden",
        exposure: "codemode",
        parameters: {},
      },
    ],
  };
  createRouterExtension({
    mode,
    source: "fixture",
    gate: {
      experiment: mode.includes("skills") ? "skills" : "tools",
      allowed: true,
      baselineRuns: 3,
      reason: "fixture",
      source: "fixture",
    },
    onTrace: (t) => traces.push(t),
    provider: {
      id: "fixture",
      evaluate: async (_s, q) => {
        if (fail) throw Error("offline");
        return {
          probabilities: Object.fromEntries(Object.keys(q).map((k) => [k, 0])),
          input: 10,
          output: 1,
          cost: null,
          latencyMs: 1,
          model: "fixture",
        };
      },
    },
  })(pi as unknown as ExtensionAPI);
  const ctx = {
    model: { id: "fixture", provider: "fixture" },
    sessionManager: { getSessionId: () => "session" },
    ui: { notify: () => {} },
  } as unknown as ExtensionContext;
  const start = () =>
    handlers.get("before_agent_start")!(
      {
        prompt: "task",
        systemPrompt: "",
        systemPromptOptions: { skills: [], sections: {} },
      },
      ctx,
    );
  return { handlers, tools, traces, ctx, start, active: () => active };
}
test("baseline does not classify or activate recovery tools", async () => {
  const h = harness("baseline");
  await h.start();
  assert.deepEqual(h.active(), ["read", "bash", "edit", "write", "browser"]);
  assert.equal(Object.keys(h.tools).length, 0);
});
test("enforced tools preserve core, expose reroute, and restore exact baseline on end", async () => {
  const h = harness("enforced-tools");
  await h.start();
  assert.deepEqual(h.active(), [
    "read",
    "bash",
    "edit",
    "write",
    "decision_reroute",
  ]);
  await h.handlers.get("agent_settled")!({ messages: [] }, h.ctx);
  assert.deepEqual(h.active(), ["read", "bash", "edit", "write", "browser"]);
});
test("reroute restores captured baseline and stays callable", async () => {
  const h = harness("enforced-tools");
  await h.start();
  await h.tools.decision_reroute.execute(
    "call",
    { reason: "need browser" },
    undefined,
    undefined,
    h.ctx,
  );
  assert.deepEqual(h.active(), [
    "read",
    "bash",
    "edit",
    "write",
    "browser",
    "decision_reroute",
  ]);
});
test("classifier failure after an enforced run explicitly restores baseline", async () => {
  const h = harness("enforced-tools", true);
  await h.start();
  assert.deepEqual(h.active(), [
    "read",
    "bash",
    "edit",
    "write",
    "browser",
    "decision_reroute",
  ]);
});
test("request bytes come from payload and separate usage/cache fields survive aggregation", async () => {
  const h = harness("baseline");
  await h.start();
  const payload = {
    tools: [{ type: "function", name: "read", parameters: {} }],
  };
  h.handlers.get("before_provider_request")!({ payload }, h.ctx);
  h.handlers.get("message_end")!(
    {
      message: {
        role: "assistant",
        model: "fixture",
        provider: "fixture",
        content: [],
        stopReason: "stop",
        usage: {
          input: 100,
          output: 2,
          cacheRead: 50,
          cacheWrite: 20,
          cost: { total: 0.1 },
        },
      },
    },
    h.ctx,
  );
  await h.handlers.get("agent_settled")!({ messages: [] }, h.ctx);
  assert.equal(
    h.traces.find((t) => t.type === "request")!.declared_tool_bytes,
    Buffer.byteLength(JSON.stringify(payload.tools)),
  );
  const run = h.traces.find((t) => t.type === "run")!;
  assert.equal(run.frontier_input, 100);
  assert.equal(run.cache_read, 50);
  assert.equal(run.cache_write, 20);
  assert.equal(run.task_success, null);
});
test("skill selection does not replace the selected tool loadout", async () => {
  const h = harness("enforced-skills");
  await h.start();
  await h.handlers.get("agent_settled")!({}, h.ctx);
  assert.deepEqual(h.traces.find((t) => t.type === "run")!.selected_tools, [
    "read",
    "bash",
    "edit",
    "write",
    "browser",
  ]);
});
test("low-level agent_end keeps routing and measurements active until the user run settles", async () => {
  const h = harness("enforced-tools");
  await h.start();
  await h.handlers.get("agent_end")?.({ messages: [] }, h.ctx);
  assert.ok(h.active().includes("decision_reroute"));
  assert.equal(h.traces.filter((t) => t.type === "run").length, 0);
  h.handlers.get("before_provider_request")!({ payload: { tools: [] } }, h.ctx);
  await h.handlers.get("agent_settled")!({}, h.ctx);
  assert.equal(h.traces.filter((t) => t.type === "run").length, 1);
  assert.equal(h.traces.find((t) => t.type === "run")!.provider_requests, 1);
});
test("enforcement skips decisions when the recovery tool is excluded from registry", async () => {
  const h = harness("enforced-tools");
  delete h.tools.decision_reroute;
  await h.start();
  assert.deepEqual(h.active(), ["read", "bash", "edit", "write", "browser"]);
  await h.handlers.get("agent_settled")!({}, h.ctx);
  assert.equal(
    h.traces.find((t) => t.type === "run")!.experiment_applied,
    false,
  );
});
