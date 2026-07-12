# Committed demo baseline

`home.qain.json` is a committed qain snapshot of the example app's default
state, watched by the `qain baselines` workflow. Change it in a PR and the
[qain-diff action](../../.github/actions/qain-diff) posts a sticky comment
explaining the semantic style diff; revert it and the comment disappears.

Regenerate after changing the example app:

```sh
pnpm serve &
node packages/cli/dist/index.js snap http://localhost:5600/ --rules \
  -o examples/baselines/home.qain.json
```
