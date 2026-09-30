import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { EvalCase } from "./corpus.js";
import type { Model } from "@earendil-works/pi-ai";
interface Step {
  name: string;
  arguments: Record<string, unknown>;
}
/** Local scripted OpenAI-compatible server exercises real Pi SDK hooks and tool execution. */
export async function fixtureFrontier(c: EvalCase, skillPath?: string) {
  const steps: Step[][] = [];
  if (c.id === "core-read")
    steps.push([{ name: "read", arguments: { path: "message.txt" } }]);
  if (c.id === "core-edit" || c.id === "multi-stage")
    steps.push(
      [{ name: "read", arguments: { path: "math.mjs" } }],
      [{ name: "bash", arguments: { command: "node --test math.test.mjs" } }],
      [
        {
          name: "write",
          arguments: {
            path: "math.mjs",
            content:
              "export const double = x => x * 2; export const sum = (a,b) => a+b;\n",
          },
        },
      ],
      [{ name: "bash", arguments: { command: "node --test math.test.mjs" } }],
    );
  if (c.id === "parallel-inspection")
    steps.push([
      { name: "read", arguments: { path: "alpha.txt" } },
      { name: "read", arguments: { path: "beta.txt" } },
    ]);
  if (c.id === "skill-dependent")
    steps.push([{ name: "read", arguments: { path: skillPath! } }]);
  if (c.capabilityFixture === "codemode")
    steps.push([
      {
        name: "codemode",
        arguments: {
          code: "const result = await tools.fixture_release({}); console.log(result);",
        },
      },
    ]);
  if (c.capabilityFixture === "deferred")
    steps.push(
      [
        {
          name: "tool_search",
          arguments: { query: "fixture_release release marker", limit: 1 },
        },
      ],
      [{ name: "fixture_release", arguments: {} }],
    );
  let request = 0;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body) as {
      tools?: { function?: { name: string } }[];
    };
    const step = steps[request++];
    const names = new Set(payload.tools?.map((t) => t.function?.name));
    const missing = step?.find((s) => !names.has(s.name));
    const calls =
      missing && names.has("decision_reroute")
        ? [
            {
              name: "decision_reroute",
              arguments: { reason: `Missing ${missing.name}` },
            },
          ]
        : step;
    if (missing && names.has("decision_reroute")) request--;
    const content =
      c.checks.answerIncludes?.join(" ") ?? "Fixed the bug; tests pass.";
    const message = calls
      ? {
          role: "assistant",
          content: null,
          tool_calls: calls.map((s, i) => ({
            id: `call_${request}_${i}`,
            type: "function",
            function: { name: s.name, arguments: JSON.stringify(s.arguments) },
          })),
        }
      : { role: "assistant", content };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(
      `data: ${JSON.stringify({ id: `fixture_${request}`, object: "chat.completion.chunk", created: 0, model: "scripted-fixture", choices: [{ index: 0, delta: message, finish_reason: null }] })}\n\n`,
    );
    res.write(
      `data: ${JSON.stringify({ id: `fixture_${request}`, object: "chat.completion.chunk", created: 0, model: "scripted-fixture", choices: [{ index: 0, delta: {}, finish_reason: calls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 20 } } })}\n\n`,
    );
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const model: Model<"openai-completions"> = {
    id: "scripted-fixture",
    name: "Scripted test frontier",
    provider: "fixture",
    api: "openai-completions",
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32000,
    maxTokens: 2000,
  };
  return {
    model,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
