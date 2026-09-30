## Updated goal-friendly implementation plan

### Goal

Build a small **Pi extension and eval harness** that determines where a cheap semantic decision model actually improves Pi, then applies it only where the measurements justify the added latency and cost.

Do **not** assume tool-schema size is the bottleneck. First instrument normal Pi, establish where waste actually occurs, then independently evaluate:

1. **Tool filtering/routing**
2. **Skill-catalog filtering**
3. **Workflow/evidence filtering**

The main frontier model remains responsible for reasoning, planning, parallel execution, tool arguments, and synthesis. The decision model only makes narrow semantic judgments; deterministic code turns those judgments into actions.

Pi already defaults to only `read`, `bash`, `edit`, and `write`, while MCP servers default to `codemode`, which keeps individual MCP tool schemas out of the model's declarations.

---

# 1. Build the extension around measurement first

Create a standalone Pi extension, but keep Phase 0 primarily observational.

Suggested structure:

```text
pi-decision-router/
├── src/
│   ├── index.ts
│   ├── instrumentation.ts
│   ├── decisions.ts
│   ├── policy.ts
│   ├── tool-routing.ts
│   ├── skill-filtering.ts
│   ├── recovery.ts
│   ├── telemetry.ts
│   └── types.ts
├── test/
│   ├── policy.test.ts
│   ├── recovery.test.ts
│   ├── routing.test.ts
│   └── fixtures/
├── evals/
│   ├── cases/
│   ├── runner.ts
│   ├── labels.ts
│   └── report.ts
├── package.json
└── README.md
```

Do **not** write a separate Jev HTTP client.

Use Pi's existing classifier interface:

```ts
ctx.modelRegistry.classify(...)
```

Pi already ships an example extension that calls Jev this way.

The decision-provider layer should stay thin enough that OpenAI's new Decisions API can later be added as a second provider without changing the rest of the experiment:

```text
DecisionProvider
    ├── Pi/Jev classifier
    └── OpenAI Decisions API
```

Jev should be the first implementation because Pi already integrates it.

---

# 2. Phase 0 — Instrument normal Pi before optimizing anything

This phase should answer:

> **What is actually expensive or wasteful in normal Pi?**

For every model turn, record:

```text
task/run ID
model
active tool names
declared tool names
declared tool definition bytes
declared tool definition estimated tokens
available skill count
skill prompt bytes/tokens
frontier input tokens
frontier output tokens
cacheRead
cacheWrite
tool calls
tool call names
agent/model turns
wall-clock latency
task success
estimated cost
```

Pi's usage structure explicitly includes `cacheRead` and `cacheWrite`; these must appear separately in the report rather than being hidden inside total input.

Also distinguish:

```text
registered tools
active tools
actually declared tools
tools actually called
MCP tools accessible through codemode
```

Those are not equivalent.

### Important measurement

Measure the **actual serialized tool declarations sent to the frontier model**.

Do not infer schema cost from the size of Pi's complete registered tool catalog.

If baseline Pi usually declares only:

```text
read
bash
edit
write
codemode
```

then semantic tool filtering probably has little room to improve prompt cost.

---

# 3. Establish an explicit hypothesis gate

After collecting representative baseline traces, branch the project based on observed waste.

```text
Normal Pi measurements
        │
        ├── Tool declarations materially large?
        │       └── Yes → evaluate tool filtering
        │
        ├── Skill catalog materially large?
        │       └── Yes → evaluate skill filtering
        │
        ├── Too many unnecessary tool calls/turns?
        │       └── Yes → evaluate capability routing
        │
        └── Research/evidence context materially bloated?
                └── Yes → evaluate workflow filtering
```

If a branch has negligible potential savings, **do not build it merely because it was part of the original idea**.

---

# 4. Build the evaluation corpus early

Create the task suite before enabling any optimization.

The corpus should contain:

### No-tool tasks

Examples:

```text
Explain this code.
Review this function conceptually.
Suggest a better architecture.
```

Tests whether routing itself adds unnecessary overhead.

### Core-tool tasks

```text
Read this file.
Modify this function.
Run the tests.
```

### Multi-step coding tasks

```text
inspect → edit → test → diagnose → edit → retest
```

These are particularly important because one routing decision may remain in effect across multiple internal model steps.

### MCP/codemode tasks

Tasks requiring external tools but where Pi's existing `codemode` mechanism should already avoid exposing a large schema catalog.

### Deferred/tool_search tasks

Specifically exercise Pi's BM25-based tool discovery so we can compare against it only where relevant.

### Skill-dependent tasks

Tasks where a specialized skill materially improves execution.

### Parallelizable tasks

For example:

```text
inspect repo + search docs + compare upstream implementation
```

Any optimization must preserve the main model's ability to run independent work in parallel.

### Research tasks

Include:

- many weak sources
- one or more strong primary sources
- conflicting evidence
- planted low-quality or irrelevant sources

These will eventually evaluate evidence filtering.

---

# 5. Label capabilities independently of baseline behavior

For each eval task, annotate:

```yaml
required:
  - read

required_any:
  - [bash, test_runner]

optional:
  - github_search

irrelevant:
  - image_generation

expected_skills:
  - debugging
```

The labels represent what the task actually requires—not what an unrestricted baseline agent happened to call.

This distinction is critical.

Track baseline behavior separately:

```text
required_by_label
baseline_used
enforced_used
baseline_used_but_not_selected
```

A baseline agent making an unnecessary tool call must **not** redefine that tool as required.

---

# 6. Establish the baseline

Run the complete corpus with normal Pi.

Where practical, use repeated runs because frontier-model behavior is stochastic.

Capture:

```text
task success
quality score
tool calls
unnecessary tool calls
agent turns
declared schema size
skill prompt size
input/output tokens
cacheRead/cacheWrite
latency
cost
```

This becomes the control condition.

---

# 7. Tool-routing experiment — only if Phase 0 justifies it

If actual declaration overhead or tool-choice waste is material, implement tool filtering.

## 7.1 Start from the real Pi baseline loadout

Capture the active/default catalog before making any changes.

Example:

```ts
const baselineTools = pi.getActiveTools();
```

This exact set is used for fail-open restoration.

Do not assume it is always the hard-coded four defaults because extensions/MCP may have modified it.

---

## 7.2 Do not activate hidden MCP tools unnecessarily

Pi's default MCP mode is `codemode`: MCP tools remain callable without their individual schemas being declared to the frontier model.

Therefore:

```text
registered MCP tool
≠
candidate we should setActiveTools()
```

Tool routing should primarily reason over **tools that would otherwise be declared directly**, unless the experiment explicitly targets deferred tool discovery.

Otherwise the optimization could increase schema size.

---

# 8. Use Jev through Pi's classifier

For semantic filtering, construct one shared state:

```text
state:
{
  task,
  candidates: {
    read: {...},
    github_search: {...},
    browser: {...}
  }
}
```

Then create independent Noul questions:

```text
tool_read:
  "Would `candidates.read` directly help complete `task`?"

tool_github_search:
  "Would `candidates.github_search` directly help complete `task`?"

tool_browser:
  "Would `candidates.browser` directly help complete `task`?"
```

Use **Noul** rather than Choice because multiple tools can simultaneously be useful.

The output becomes:

```text
read           0.98
github_search  0.87
browser        0.22
```

Treat these values as semantic signals—not commands.

---

# 9. Keep policy deterministic

Implement policy as a pure function:

```ts
selected = policy({
    baselineTools,
    probabilities,
    requiredCoreTools,
    thresholds,
})
```

Do not let Jev directly call:

```ts
setActiveTools()
```

Policy should explicitly handle:

- always-preserved core tools
- per-tool threshold
- maximum/minimum candidates if needed
- explicitly requested tools
- empty classifier response
- invalid probability
- classifier failure
- confidence-independent Noul semantics

Do not build one abstraction that treats Choice confidence, Noul probability, and Score values as interchangeable numbers.

For Phase 1 routing, use **Noul only**.

---

# 10. Shadow mode first

Run the semantic decision but leave the actual Pi tool set unchanged.

Record:

```text
baseline active set
Jev proposed set
required labeled tools
baseline tools actually used
classifier latency
classifier input/output tokens
```

Key shadow metrics:

```text
required capability recall
selected-set size
false-positive selection
potential declaration reduction
baseline-used-but-not-selected
decision latency
decision cost
```

Do **not** claim shadow mode proves that rejected tools are safe to hide.

Only an enforced run can prove that.

---

# 11. Enforcement must ship with recovery

Before the first enforced eval, implement both **fail-open** and **reroute**.

## Fail-open

Every routing attempt should follow:

```text
capture baseline set
       ↓
classify
       ↓
success?
 ┌─────┴─────┐
 yes          no
 ↓            ↓
selected   setActiveTools(baseline)
```

Never implement fail-open as merely:

```ts
catch {
    return;
}
```

because a previous shortlist may remain active.

Explicitly restore the known baseline set.

---

# 12. Add reroute at the same time as enforcement

A missed capability should not strand the agent.

Provide a recovery tool such as:

```text
decision_reroute
```

or equivalent.

Its purpose:

```text
current set cannot complete task
        ↓
agent describes missing capability
        ↓
restore/broaden search space
        ↓
new classification or baseline fallback
```

Measure:

```text
reroute count
reroute success
additional turns
additional latency
```

A high reroute rate indicates an overly aggressive policy.

---

# 13. Respect Pi's actual routing lifetime

Treat the first experiment as:

> **One capability decision for one user run.**

Do not quietly assume the extension can cheaply reroute before every internal model step.

Pi's `before_agent_start` is a run-level hook; later model requests inside that run have separate lifecycle behavior.

So our first hypothesis is:

```text
Can one pre-run semantic capability decision improve the entire run?
```

If that fails specifically on long multi-stage tasks, *then* evaluate finer-grained rerouting as a separate experiment.

---

# 14. Skill-catalog filtering is a separate experiment

Pi skills are rendered into the system prompt using:

```text
<available_skills>
...
</available_skills>
```

rather than exposed through an active-tool API.

Therefore don't call it "skill activation."

Call it:

> **skill catalog filtering**

The experiment becomes:

```text
all skill metadata
        ↓
Jev Noul relevance judgments
        ↓
filter systemPromptOptions.skills
        ↓
frontier model sees only likely-relevant skill entries
```

Keep `read` available.

A filtered skill is therefore **not inaccessible** if its path is otherwise known; we're testing prompt efficiency and discoverability, not enforcing a capability boundary.

Metrics:

```text
skill prompt tokens before/after
required-skill recall
skills actually read
task success
cache effects
frontier input tokens
```

---

# 15. Research/evidence filtering should be its own experiment

This may ultimately be more valuable than tool routing.

Pipeline:

```text
search
   ↓
10–30 candidate sources
   ↓
cheap deterministic filters
   ├ duplicate
   ├ empty/thin
   ├ obvious wrong content type
   └ basic domain/date checks
   ↓
parallel extraction
   ↓
ONE batched classifier call
   ├ relevant?
   ├ primary source?
   ├ actually supports target claim?
   ├ strong enough evidence?
   └ suspicious/low-quality?
   ↓
deterministic retention policy
   ↓
frontier model sees surviving evidence
   ↓
synthesis
```

This is where Jev may provide larger absolute savings because it can remove entire page bodies or chunks rather than small tool definitions.

Evaluate:

```text
task/research quality
citation correctness
source recall
strong-source recall
weak-source rejection
frontier context tokens
frontier input tokens
Jev tokens
latency
total cost
```

Keep this experiment independent from tool routing so gains remain attributable.

---

# 16. Treat Pi's BM25 tool search as a baseline, not a target

Do not replace `Bm25Ranker` initially.

Pi currently uses BM25 for its `tool_search` implementation over deferred tool metadata.

Only if baseline data shows that `tool_search` is materially involved in the workloads we care about should we compare:

```text
A. Pi BM25 only

B. BM25 shortlist
       ↓
   Jev reranking

C. Jev over complete deferred catalog
```

Measure:

```text
required-tool recall
number loaded
extra agent turn(s)
tool_search calls
frontier tokens
classifier tokens
latency
task success
```

If BM25 already works well enough, leave it alone.

---

# 17. Add OpenAI Decisions as a provider comparison, not an architectural dependency

Keep the semantic-decision interface provider-neutral.

Conceptually:

```ts
interface DecisionProvider {
    evaluate(state, questions): Promise<DecisionResults>
}
```

Initial implementation:

```text
PiClassifierProvider
    → ctx.modelRegistry.classify(Jev)
```

Later:

```text
OpenAIDecisionsProvider
```

The rest of the extension should not care which provider produced:

```text
candidate → probability/decision
```

When OpenAI's new Decisions API has stable public documentation and access, run the exact same eval cases against both.

This changes the research question from:

> Is Jev useful?

to:

> Does a cheap semantic decision layer improve Pi, and which provider has the best quality/cost/latency tradeoff?

---

# 18. Cache behavior is a first-class outcome

Dynamic tool/skill lists may change the leading request content and reduce prompt-cache reuse.

Therefore every comparison must show:

```text
uncached input
cacheRead
cacheWrite
output
classifier input
classifier output
```

A result such as:

```text
20% fewer declared tokens
but
40% less cache reuse
```

may be a net regression.

Do not report "input tokens reduced" without cache information.

---

# 19. Cost accounting must use provider-specific pricing

For Jev, log both:

```text
input tokens
output tokens
```

but calculate cost from the current Jev pricing rules rather than assuming conventional LLM input/output billing.

Likewise, when OpenAI Decisions becomes available, its cost calculation should have its own provider adapter.

Do not hard-code a universal:

```text
input × X + output × Y
```

formula into the eval harness.

---

# 20. Evaluation modes

The runner should support at minimum:

```text
baseline
shadow-tools
enforced-tools
shadow-skills
enforced-skills
research-baseline
research-decision-filter
```

Later:

```text
jev
openai-decisions
```

as provider variants.

Example:

```text
pnpm eval --mode baseline
pnpm eval --mode shadow-tools --provider jev
pnpm eval --mode enforced-tools --provider jev
pnpm eval --mode research-decision-filter --provider jev
```

---

# 21. Produce structured traces

Use JSONL rather than terminal output as the source of truth.

Example:

```json
{
  "task_id": "coding-014",
  "mode": "enforced-tools",
  "provider": "jev",
  "task_success": true,

  "baseline_tool_count": 5,
  "selected_tool_count": 4,
  "declared_tool_bytes": 2810,

  "frontier_input": 18430,
  "frontier_output": 1611,
  "cache_read": 12800,
  "cache_write": 4200,

  "decision_input": 710,
  "decision_output": 14,
  "decision_latency_ms": 241,

  "tool_calls": 5,
  "agent_turns": 4,
  "reroutes": 0,

  "required_capability_recall": 1.0,
  "baseline_used_but_not_selected": ["grep"]
}
```

---

# 22. Comparison report

For every experiment, generate a table like:

| Metric | Baseline | Jev | Delta |
|---|---:|---:|---:|
| Task success | 94% | 94% | 0 |
| Frontier input | 18.4k | 16.1k | -12.5% |
| Cache read | 12.8k | 8.3k | -35.2% |
| Cache write | 4.2k | 6.9k | +64.3% |
| Tool calls | 6.1 | 5.0 | -18% |
| Turns | 4.5 | 4.1 | -9% |
| Decision latency | — | 240 ms | +240 ms |
| Total cost | $X | $Y | ... |
| Required recall | — | 99.1% | — |

This is why cache accounting matters: a seemingly positive token result may reveal a cost regression.

---

# 23. Success criteria

The project succeeds only if an optimization produces a **net improvement**, not merely a prettier routing trace.

### Non-negotiable

Task success must not materially regress.

### Tool routing

Require:

```text
very high labeled required-capability recall
low reroute rate
measurable reduction in calls/turns/context/cost
classifier overhead smaller than savings
```

### Skill filtering

Require:

```text
high required-skill recall
meaningful prompt reduction
no task-success regression
no harmful cache regression
```

### Research filtering

Require:

```text
strong-source recall maintained
weak evidence reduced
frontier context materially reduced
citation/research quality maintained or improved
```

---

# 24. Stop conditions

The project should explicitly allow an experiment to fail.

Examples:

### Stop tool-routing work if

```text
baseline declared tool context is already negligible
```

or:

```text
classifier latency/cost > tool savings
```

or:

```text
dynamic loadouts damage cache efficiency
```

### Stop skill filtering if

```text
skill prompt is too small to matter
```

### Continue research filtering if

```text
it removes large amounts of junk evidence while preserving quality
```

even if tool routing itself turns out to have no value.

---

# 25. Phase 1 deliverables

At the end of the first implementation cycle we should have:

1. **An installable Pi extension** with instrumentation, Jev classification through Pi's model registry, deterministic policy, shadow/enforcement modes, fail-open recovery, and rerouting.
2. **A baseline profiler** that measures actual declared-tool bytes/tokens, skills, frontier usage, cache reads/writes, calls, turns, latency, and cost.
3. **A labeled eval corpus** with required/optional/irrelevant capabilities independent of baseline agent behavior.
4. **A reproducible eval harness** for baseline, shadow, and enforcement modes.
5. **A skill-catalog filtering experiment**, kept separate from tool filtering.
6. **A research/evidence filtering experiment**, also evaluated independently.
7. **A provider-neutral decision abstraction** so OpenAI Decisions can be compared with Jev once its API is usable.
8. **A report that can tell us to stop** if Pi already solves the supposed bottleneck efficiently.

The governing principle should be:

```text
Measure the bottleneck.
Use cheap semantic decisions only where the bottleneck is real.
Keep decisions narrow.
Keep policy deterministic.
Preserve frontier-model agency.
Count cache effects and recovery costs.
Let enforced task success decide whether the optimization works.
```

That is the implementation I would use now; it is substantially safer and more informative than starting with a Jev-powered replacement for Pi's existing tool discovery.
