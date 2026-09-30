# Validation results

Validated on 2026-09-30 against Pi 0.99.1. The package remains in baseline mode by default.

## Implementation checks

- 41 automated tests passed, including Pi’s own TypeScript extension loader and actual SDK tool execution.
- Type checking and compiled build passed. Package contents and the compiled runner were checked locally.
- All four tool/catalog shadow and enforcement modes passed real SDK contract tests with scripted providers.
- Timeout, invalid/missing probabilities, exact restoration, rerouting, user-run settlement, preserved skill/tool names, immutable checkers and aggregate recovery-rate gates are covered.
- Original checker files and helper files are restored before artifact validation. A test proves that removing assertions cannot produce a successful result.

## Live controlled baseline

The final agent baseline passed 18/18 runs: nine tasks repeated twice, using the configured `openai-codex/gpt-5.6-luna` model. These are isolated controlled tasks with thinking off; personal extensions/catalogs are excluded. The installed extension can separately profile ordinary Pi sessions with their actual loadouts.

Codemode and deferred cases exercised Pi’s built-in mechanisms against a local external-capability fixture. They do not establish real MCP-server compatibility. The first harness version mistakenly used an SDK allowlist that removed the hidden capability; the final baseline uses `defaultTools` and verifies actual nested calls and discovery.

Measured gates:

- **tools**: stop — Stop: declaration context and labeled call waste are negligible.
- **skills**: stop — Stop: skill catalog is small or unmeasured.

Tool and skill filtering implementations are available, but their live experiments were stopped because this corpus did not demonstrate material waste. They were not enabled by default.

## Live Jev evidence comparison

Three repeated runs of one fictional extracted-source task used real frontier and Jev APIs. The task includes current documentation, historical contradictory primary documentation, weak sources and injected instructions. The temporary TypeSafe credential was supplied only to the evaluation process, then unset; it was not saved in Pi configuration or project files.

Both the final baseline and final filtered runs passed 3/3 task checks, with full labeled strong-source recall and valid primary-source citation IDs. These checks assess this controlled fixture, not general research quality.

| Metric (mean)           |   Baseline | Jev filter |    Change |
| ----------------------- | ---------: | ---------: | --------: |
| frontier_input          |  3,680.667 |      1,469 |    -60.1% |
| cache_read              |          0 |          0 |    +0.000 |
| cache_write             |          0 |          0 |    +0.000 |
| frontier_output         |     75.333 |         59 |    -21.7% |
| decision_input          |          0 |      7,944 | +7944.000 |
| decision_output         |          0 |      1,280 | +1280.000 |
| decision_latency_ms     |          0 |    382.717 |  +382.717 |
| wall_clock_ms           |   3,294.17 |   3,251.12 |     -1.3% |
| total_cost              | $0.0008265 | $0.0006982 |    -15.5% |
| retained_evidence_bytes |     12,870 |        311 |    -97.6% |
| strong_source_recall    |          1 |          1 |     +0.0% |
| citation_correctness    |          1 |          1 |     +0.0% |

Jev pricing uses the dated input-only adapter; output tokens are recorded but free under the verified TypeSafe price. All total costs include classifier overhead. Cache reads and writes were zero in these runs, so this experiment does not establish behavior under substantial cache reuse.

The first live filtering attempt dropped the archived primary source and failed the quality gate. The final version supplies the full research task to the classifier and distinguishes original authorship from recency and suspiciousness; thresholds stayed at 0.5. This change was tuned on the same fixture, so a separate held-out corpus is still needed.

**Verdict: inconclusive for general rollout.** The final narrow experiment reduced estimated cost by 15.5% and frontier input by 60.1%, but three repetitions of one case are insufficient for promotion. The report requires at least ten matched enforced runs and a low aggregate recovery rate before it can call an experiment promising. Normal profiling remains the default.

## Evidence files

Raw traces remain in the local `.traces` directory and are excluded from version control and package releases. They contain run metrics and may include model identifiers, so reproduce the results with the commands in the README before comparing changes.
