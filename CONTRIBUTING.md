# Contributing to qain

Thanks for taking the time to contribute. qain is a pnpm monorepo of small,
focused packages, and the bar for a change is: it builds, it type-checks, it
passes lint, and the e2e/examples suites stay green.

## Prerequisites

- **Node 22 or newer** (`engines`). Development pins the version in `.nvmrc`.
- **pnpm** — the repo declares its version in `packageManager`; enable
  [Corepack](https://nodejs.org/api/corepack.html) with `corepack enable` and it
  is provisioned for you.
- A local **Chrome** for the tests (`pnpm browsers` installs it). qain is
  **Chromium only, by design** — see the README for why.

## Setup

```sh
pnpm install
pnpm browsers      # tests use Chrome; the CLI launches bundled chromium
pnpm build
```

## The checks CI runs

Run these before opening a PR — they are exactly what the `CI` workflow gates on:

```sh
pnpm check         # biome lint + format
pnpm build         # tsc across every package
pnpm typecheck     # tsc --noEmit
pnpm test          # e2e + examples (needs a browser)
pnpm demo          # the README's worked example
```

`pnpm check:fix` applies the formatter and safe lint fixes.

## Working in the monorepo

- Packages live under `packages/*`. `@qain/core` is the engine; `cli`,
  `playwright`, `vitest`, and `storybook` are thin integrations on top of it.
- Cross-package deps use `workspace:*`; shared tool versions use the pnpm
  `catalog:` in `pnpm-workspace.yaml`. Don't hard-pin a catalog'd dependency in a
  single package.
- Install scripts are blocked by default. A dependency that genuinely needs one
  must be added to `allowBuilds` in `pnpm-workspace.yaml`, and the reason called
  out in the PR.

## Pull requests

- Keep the PR scoped to one change. A bug fix and a refactor are two PRs.
- Match the surrounding code — the codebase leans terse and explicit; comments
  explain *why*, not *what*.
- Describe the user-visible behaviour change and how you verified it. If it
  touches diff output, paste a before/after.
- New behaviour needs coverage in `e2e/` or `examples/`.

## Reporting bugs and asking for features

Use the issue templates. A repro (ideally a minimal HTML page or a failing
snapshot) is worth more than a description.

## Security

Please **do not** open a public issue for a vulnerability. See
[SECURITY.md](./SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the
project's [MIT License](./LICENSE).
