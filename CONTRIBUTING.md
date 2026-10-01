# Contributing

Thanks for helping improve pi-jevify. Keep changes focused and explain the behavior or measurement they change.

## Set up

Use Node.js 22.19.0 or newer and pnpm 12.6.0. Install dependencies and run the checks before opening a pull request:

```sh
pnpm install --frozen-lockfile
pnpm format:check
pnpm check
pnpm test
pnpm build
```

Run the offline evaluation when changing the runner, corpus, or reporting logic:

```sh
pnpm eval --mode baseline --fixture --repeat 2 --output .traces/fixture-baseline.jsonl
```

Fixture results verify integration and reproducibility. They do not measure model quality, live latency, or production savings.

## Pull requests

- Describe the user-visible behavior or measurement change and its limits.
- Add or update tests for changed behavior.
- Update the README when setup, options, or interpretation changes.
- Keep credentials, private prompts, and local `.traces` out of commits.
- Do not claim an optimization is beneficial based only on fixture or shadow results.

The CI workflow runs formatting, type checks, tests, builds, and a package-content check for pull requests and pushes to `main`.
