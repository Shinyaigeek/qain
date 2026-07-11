# qain-diff action

Diffs two qain snapshots on a pull request: posts a **sticky comment** with the
readable, rule-attributed diff, uploads the interactive HTML + replay report, and
**fails the check** when styles changed.

It compares snapshots you capture — it does not build or serve your app, because
only your workflow knows how. You produce a base snapshot and a head snapshot; the
action does the rest.

```yaml
# .github/workflows/style.yml
name: style
on: pull_request

jobs:
  qain:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile

      # Build + serve this PR however you normally do, then snapshot it.
      - run: pnpm build && pnpm preview & npx wait-on http://localhost:4173
      - run: npx qain snap http://localhost:4173 --rules --replay -o head.qain.json

      # `base.qain.json` is committed in the repo and refreshed on main.
      - uses: Shinyaigeek/qain/.github/actions/qain-diff@main
        with:
          before: base.qain.json
          after: head.qain.json
          name: home
```

## Inputs

| input | default | what |
| --- | --- | --- |
| `before` | — | Path to the base snapshot JSON. **Required.** |
| `after` | — | Path to the head snapshot JSON. **Required.** |
| `name` | `qain` | Label, so several diffs can coexist on one PR (own comment each). |
| `github-token` | `${{ github.token }}` | Token used to comment. |
| `comment` | `true` | Post and update a sticky PR comment. |
| `fail-on-diff` | `true` | Fail the step — and the check — on any change. |
| `qain-cmd` | `npx --yes qain` | How to invoke the CLI; point it at a local build if unpublished. |
| `working-directory` | `.` | Directory the snapshot paths are relative to. |

## Outputs

- `changed` — `'true'` when the diff was non-empty.
- `total` — total number of changes.

## Notes

- Capture both snapshots with `--replay` to get the fade-between replay in the
  uploaded report; without it, the report is the diff table alone.
- The comment updates in place on every push (matched by a hidden
  `<!-- qain-report:<name> -->` marker), so a PR keeps one comment per `name`.
- Two-ref flow (no committed baseline): check out the base ref in an earlier job,
  build and `qain snap` it, upload it as an artifact, then download it here as
  `before`.
