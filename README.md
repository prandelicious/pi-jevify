# pi-jevify

A measurement-first Pi extension and evaluation harness. Baseline profiling is the default. The main model keeps planning, tool arguments, parallel execution and synthesis; the decision provider supplies independent Noul relevance probabilities.

Targets **Pi 0.99.2** (`@earendil-works/pi-coding-agent`) and Node **22.19.0+**. It uses Pi's native `ctx.modelRegistry.classify()` and Codemode VM; no separate Jev HTTP client or BM25 replacement is included.

## Run it

```sh
pnpm install --ignore-scripts
pnpm check
pnpm test
pnpm build
pi -e ./src/index.ts
```

See [Contributing](CONTRIBUTING.md) for local checks and pull request guidance, and [Security](SECURITY.md) for private vulnerability reports.

Pi package metadata also supports `pi install /absolute/path/to/pi-jevify`. Installation is optional; the `-e` command loads the extension for a session. Tests include Pi's actual extension loader, agent loop, built-in codemode and built-in BM25 discovery.

Metrics go to `.traces/pi-jevify.jsonl` in the session working directory. Set `PI_DECISION_TRACE` to choose another file. Telemetry contains metrics, candidate names and probabilities, not raw prompts, credentials, tool arguments or source bodies. `task_success` and quality remain `null` in ordinary sessions until an independent evaluator supplies an outcome.

## Establish the baseline

```sh
pnpm eval --mode baseline --repeat 2 --output .traces/baseline.jsonl
pnpm report --input .traces/baseline.jsonl --output .traces/baseline.md \
  --gate tools --gate-output .traces/tools-gate.json
pnpm report --input .traces/baseline.jsonl --output .traces/skills.md \
  --gate skills --gate-output .traces/skills-gate.json
```

The runner uses your configured Pi model, or `--model provider/id`. It copies authentication/model configuration to a temporary agent directory so evals do not modify your ordinary sessions or workspace. OAuth refresh may still contact its provider. `--agent-dir` selects the source configuration directory. Each case gets a fresh temporary workspace; all temporary files are removed afterward.

The controlled corpus has nine agent tasks and a separate research case. Capability fixtures are local external-tool test doubles, exercised through real Pi codemode and deferred BM25 discovery; they are **not live MCP integration acceptance**. Skills come from the labeled corpus, not your entire personal catalog. Outcome checks inspect answer markers and run independent artifact tests; they do not substitute for broad human quality assessment. Supply a larger corpus with `--corpus path.json` for representative workloads. Command checks must declare `checks.checkerFiles`, including checker helpers, and supply their original contents in `files`; the runner restores those fixtures before verification so agent edits cannot weaken assertions.

Core tasks use Pi's normal four active tools. Capability cases add codemode or tool_search to the initial loadout via `defaultTools`, preserving the hidden/deferred registry. SDK `tools` is an allowlist that would remove those capabilities entirely.

## Experiments

Supported modes:

- `baseline`
- `shadow-tools`, `enforced-tools`
- `shadow-skills`, `enforced-skills`
- `research-baseline`, `research-decision-filter`
- `codemode-baseline`, `codemode-jev`

An experimental runner invocation requires a matching `allowed: true` gate generated from baseline traces. Gates distinguish live evidence from scripted fixtures. Defaults require three baseline runs and either 4 KiB mean tool declarations, one labeled irrelevant call per run, 4 KiB skill metadata, or 8 KiB extracted evidence. These are configurable experimental hypotheses in `hypothesisGate()`, not calibrated quality guarantees. A stopped gate is an expected project outcome.

```sh
pnpm eval --mode shadow-tools --provider jev --repeat 2 \
  --gate .traces/tools-gate.json --output .traces/shadow.jsonl
pnpm eval --mode enforced-tools --provider jev --repeat 2 \
  --gate .traces/tools-gate.json --output .traces/enforced.jsonl
```

For an ordinary Pi session, set `PI_DECISION_MODE` and `PI_DECISION_GATE` to the matching gate file. Modes default to baseline; a missing or stopped gate skips the decision. TypeSafe credentials must be available through Pi's provider configuration. The extension never configures credentials itself.

Tool routing makes **one decision per user run**, over that run's active baseline declarations. It never activates hidden MCP tools as routing candidates. The default policy preserves `read`, `bash`, `edit`, and `write`, as well as explicitly mentioned baseline tools. Programmatic options allow per-experiment thresholds, preserved tools and explicit requests. Independent probabilities are not Choice confidence or Score values.

Enforced routing adds `decision_reroute`. Calling it restores the captured baseline while keeping recovery callable. Missing/invalid answers, errors and timeouts explicitly restore that baseline; the final `agent_settled` boundary and session transitions restore the exact original loadout. Recovery is absent from baseline and shadow declarations. Its schema and subsequent calls are counted in enforced measurements. Tool discovery can broaden the set during the run; the router does not override each internal model step.

Skill filtering changes `systemPromptOptions.skills` only in its own enforced mode. It preserves explicitly invoked skills and keeps `read` available. Known skill paths remain accessible; catalog filtering is a discoverability experiment, not a capability boundary.

The provider-neutral `DecisionProvider` accepts state and Noul questions. `PiClassifierProvider` maps these to Pi's `bool` protocol, which Pi maps to TypeSafe Noul. OpenAI Decisions is intentionally not implemented until a stable supported API is available; requesting an unsupported provider fails explicitly.

## Evidence filtering

```sh
pnpm eval --mode research-baseline --repeat 3 --output .traces/research-baseline.jsonl
pnpm report --input .traces/research-baseline.jsonl --output .traces/research.md \
  --gate research --gate-output .traces/research-gate.json
pnpm eval --mode research-decision-filter --provider jev --repeat 3 \
  --gate .traces/research-gate.json --output .traces/research-filter.jsonl
```

`filterEvidence()` accepts already extracted sources. Exact duplicate URLs/text, thin pages, wrong content types, optional domain/date exclusions are deterministic. One batched call judges relevance, primary-source status, claim support, evidence strength and suspicious content. Deterministic policy retains relevant primary evidence, including contradictions, and strong corroborating evidence. Classifier failure, invalid judgments or an empty shortlist recover to deterministic survivors.

The included research task deliberately uses fictional extracted documentation, weak pages, an outdated authoritative contradiction, and injected instructions. It measures context retention and citation IDs. Search and parallel extraction remain the caller's responsibility. This is an extracted-evidence experiment, not a web retrieval benchmark.

Native Codemode evidence comparison keeps retrieval and filtering inside the Pi VM. The CLI modes are intentionally fixture-only; a live integration needs Pi credentials for both the frontier model and the Jev classifier, plus a Codemode-callable source tool supplied by the host. Use the exported recipe for that host integration. The Codemode baseline applies deterministic thin-source filtering and stores retained evidence; source text remains untrusted evidence and embedded instructions are never followed. The Jev mode calls `models.classify()` inside the VM, keeps relevant primary evidence including archived contradictions, and fails open to the deterministic shortlist when the classifier is unavailable or invalid.

```sh
pnpm eval --mode codemode-baseline --fixture --repeat 1 \
  --output .traces/codemode-baseline.jsonl
pnpm eval --mode codemode-jev --fixture --repeat 1 \
  --output .traces/codemode-jev.jsonl
cat .traces/codemode-baseline.jsonl .traces/codemode-jev.jsonl > .traces/codemode-comparison.jsonl
pnpm report --input .traces/codemode-comparison.jsonl \
  --output .traces/codemode-comparison.md
```

The offline fixture uses Pi's actual SDK, a registered classifier model, native `models.classify()`, and QuickJS Codemode execution. Its labels and answers are fixed harness evidence, not live-quality claims. `codemode_calls`, nested call details, `workflow_classifier_*`, retained evidence sizes, and `total_cost` are recorded separately; nested classifier usage is included once in total cost.

For a host supplied source tool, the reusable VM recipe is in [`examples/codemode-evidence-recipe.ts`](examples/codemode-evidence-recipe.ts). It expects a Codemode-callable `research_sources` tool and a classifier registered in Pi's model registry, then stores the retained source IDs with `store("retained_evidence", ...)` and returns exact UTF-8 `evidence_bytes` and `retained_evidence_bytes`. Replace `<full research task>` with the complete user task and `<claim>` with the separate claim before running it. The illustrative `0.5` cutoff is a fixture policy, not a calibrated probability guarantee. If the classifier is missing or returns an invalid answer, keep the deterministic candidates and mark the result `fail_open`.

## Traces and reports

JSONL is the source of truth. Requests record actual serialized provider declarations, separate registered/active/declared/codemode/deferred tools, and skill catalogs found in the actual request. Bytes are exact UTF-8 fragment sizes; token estimates are explicitly `ceil(bytes / 4)`, not provider tokenization. OpenAI, Anthropic, Google and Bedrock declaration envelopes are covered. Opaque/unrecognized declarations remain unavailable rather than using catalog size as a proxy. Traces omit raw prompts, source bodies, and arbitrary tool arguments; Codemode nested calls retain only safe names, linkage, durations, model identifiers, and costs.

Turn records link to requests and retain Pi's input, output, `cacheRead`, `cacheWrite`, latency and cost. Run records aggregate calls, nested calls, turns, decision usage, failure/recovery and quality. Input means Pi's uncached input; cache reads and writes stay separate. Retry requests are recorded even when only one final assistant result exists. Normal-session quality is unavailable rather than inferred from a successful API response.

Frontier costs use Pi's model catalog. Jev costs use a separate input-only adapter: the official price checked on **2026-09-30** is $0.042 per million input tokens, with free output ([TypeSafe pricing](https://docs.typesafe.ai/models)). Output usage is still logged. Unsupported model versions and unreported usage leave cost unavailable. Review the dated pricing snapshot when upgrading; estimated cost is not an invoice.

Combine matched control and experiment traces into a new file, then report:

```sh
cat .traces/baseline.jsonl .traces/enforced.jsonl > .traces/comparison.jsonl
pnpm report --input .traces/comparison.jsonl --output .traces/comparison.md
```

Pairs must match case, repetition, source, workload hash and model. The promising verdict additionally requires at most 5% of runs to need rerouting. Duplicate pairs fail. Reports show input, cache reads/writes, output, classifier overhead, task checks, recall and total cost. They never promote fixtures or shadow selection to enforcement evidence. Unknown costs or insufficient runs produce an inconclusive verdict; success regressions or measured cost regressions stop the experiment. Even a promising result requires broader validation before enabling by default.

## Offline verification

```sh
pnpm eval --mode baseline --fixture --repeat 2 --output .traces/fixture-baseline.jsonl
pnpm eval --mode research-baseline --fixture --repeat 3 --output .traces/fixture-research.jsonl
pnpm eval --mode codemode-baseline --fixture --case research-conflicts --repeat 1 --output .traces/fixture-codemode-baseline.jsonl
pnpm eval --mode codemode-jev --fixture --case research-conflicts --repeat 1 --output .traces/fixture-codemode-jev.jsonl
```

Fixture mode runs a local scripted OpenAI-compatible server and deterministic decision adapter through Pi's real SDK. It validates wiring and reproducibility with no paid requests. Its answers are scripted and cannot establish model quality, latency savings, cost savings, or live MCP compatibility. All four routing/catalog modes and recovery have dedicated SDK tests.

See [implementation brief](docs/implementation-brief.md), [implementation plan](docs/implementation-plan.md), and [validation results](docs/validation-results.md).
