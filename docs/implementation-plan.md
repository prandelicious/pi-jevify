# Measurement-first implementation

The supplied brief is the approved design. This empty workspace will contain one installable Pi package, with baseline behavior as its default. No provider HTTP client, frontier model replacement, or BM25 replacement will be added.

- [x] Establish typed Noul-only decisions, deterministic policy, timeout/fail-open and baseline restoration with tests.
- [x] Measure actual provider declarations and skill sections; record per-request JSONL and run aggregates with cache usage separate and unknown quality/cost represented as null.
- [x] Integrate run-level shadow/enforcement tool and skill experiments. Preserve baseline core tools and explicit requests; expose recovery only in enforced tools mode.
- [x] Implement independent batched evidence filtering with deterministic prefilters and fail-open behavior.
- [x] Add independent capability/skill/source labels, all requested modes, repeated isolated SDK runs, outcome checks, fixture replay, paired reporting and measurement gates.
- [x] Verify type checking, tests, build, package contents, real Pi extension loading and available live baseline/classifier paths. Report environmental limitations and never treat fixture replay as live evidence.

Tests target the safety boundaries: invalid/partial judgments, previous shortlists, hidden MCP exposure, timeouts, run cleanup, provider payload formats, independent labels, unknown outcomes, cache accounting, evidence recall, and mixed/incomplete report inputs. Eval fixtures prove harness reproducibility; live runs prove provider integration. Gates use measured baseline records, require explicit thresholds, and do not enable unrelated experiments.
