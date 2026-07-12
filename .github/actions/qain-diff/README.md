# qain-diff action

Watches the qain snapshot baselines committed in your repo. When a pull
request changes one, the action diffs it against the merge-base version and
posts **one sticky comment** with the semantic, rule-attributed style diff per
baseline — updated in place on every push, and **deleted again when the diff
disappears** (e.g. the baseline change is reverted).

You never tell it which files: it looks at what the PR actually changed and
matches it against a glob.

```yaml
# .github/workflows/qain.yml
name: qain
on:
  pull_request:

permissions:
  contents: read
  pull-requests: write

jobs:
  diff:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - uses: Shinyaigeek/qain/.github/actions/qain-diff@v0.0.2
        with:
          pattern: |
            **/__qain__/*.qain.json
            **/qain-snapshots/*.qain.json
```

Those two globs cover the default baseline locations of `@qain/vitest` and
`@qain/storybook`; `@qain/playwright` baselines live in
`*.spec.ts-snapshots/`. Point `pattern` wherever yours are.

**Do not add `on.pull_request.paths` filtering for the baseline files.** The
cleanup half — deleting the comment once a baseline change is reverted — needs
a run on the push where the file is *no longer* part of the PR's diff. The
action exits in seconds when nothing matches.

## What lands on the PR

- One comment per `name`, holding a section per changed baseline: change
  counts (primary / derived / contrast regressions) and the readable diff with
  the CSS rule behind each change.
- New baselines and deleted baselines are listed as such; baseline files that
  changed with no semantic difference (formatting churn) get a footnote.
- An interactive HTML report per changed baseline, uploaded as the
  `qain-report-<name>` artifact and linked from the comment.
- When a later push leaves no matching changes, the comment is deleted.

## Inputs

| input | default | what |
| --- | --- | --- |
| `pattern` | `**/*.qain.json` | Glob(s) for the baseline files to watch, one per line. `**`, `*`, `?`. |
| `name` | `qain` | Label, so several instances can coexist on one PR (own comment each). |
| `github-token` | `${{ github.token }}` | Needs `pull-requests: write` to manage the comment. |
| `fail-on-diff` | `false` | Also fail the check while a baseline carries a semantic change. Off by default: a committed baseline update is usually intentional — the comment explains it rather than blocks it. |
| `qain-cmd` | `npx --yes @qain/cli` | How to invoke the CLI (needs Node 22+); pin a version or point at a local build. |

## Outputs

- `changed` — `'true'` when at least one changed baseline carries a semantic diff.
- `total` — semantic changes summed across baselines.
- `files` — JSON array: `{path, status, total, primary, derived, contrast}`.

## Notes

- Works on `pull_request` events; on anything else it logs and does nothing.
- Fork PRs: the default `GITHUB_TOKEN` on fork PRs is read-only, so the
  comment cannot be posted (the standard limitation of comment actions).
- The comment is found again via a hidden `<!-- qain-report:<name> -->`
  marker; don't remove it when editing the comment by hand.
