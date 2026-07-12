<!-- Keep the PR scoped to one change. A bug fix and a refactor are two PRs. -->

## What & why

<!-- The user-visible change and the reason for it. Link any issue: Closes #NNN -->

## How verified

<!-- Commands run, and for diff-output changes a before/after paste. -->

## Checklist

- [ ] `pnpm check` passes (lint + format)
- [ ] `pnpm build` and `pnpm typecheck` pass
- [ ] `pnpm test` passes (or N/A — explain)
- [ ] Behaviour changes are covered in `e2e/` or `examples/`
- [ ] Touched only one concern; docs/CHANGELOG updated if user-visible
