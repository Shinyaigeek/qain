# @qain/storybook

Semantic style-regression testing for the
[Storybook test runner](https://github.com/storybookjs/test-runner).

Every story you already have becomes a style-regression test. The runner renders
each story in a real Chromium; qain captures its **used values** — computed styles,
layout boxes, paint order, composited colors — and diffs them against a committed
baseline. Class churn and one-pixel font shifts stay quiet; a real regression names
the declaration behind it.

```ts
// .storybook/test-runner.ts
import type { TestRunnerConfig } from '@storybook/test-runner'
import { matchStyleSnapshot } from '@qain/storybook'

const config: TestRunnerConfig = {
  async postVisit(page, context) {
    await matchStyleSnapshot(page, context)
  },
}
export default config
```

That is the whole integration. `postVisit` hands you a Playwright page, so qain takes
a CDP session the same way `@qain/playwright` does — no extra browser, no viewer.

- **Baselines** land in `qain-snapshots/<story-id>.qain.json`. First run writes and
  passes; later runs diff against it. Set `QAIN_UPDATE_SNAPSHOTS=1` to accept
  changes. Under `CI`, a missing baseline **fails** — so an uncommitted one can't
  slip through.
- **Pseudo-states, rules, scope** — pass any capture/diff option through:
  ```ts
  await matchStyleSnapshot(page, context, { states: ['hover', 'focus-visible'], rules: true })
  ```
- **Chromium only, by design** — `DOMSnapshot.captureSnapshot` and
  `CSS.forcePseudoState` have no Firefox or WebKit equivalent.

## Options

| option | default | what |
| --- | --- | --- |
| `name` | story id | Baseline file name. |
| `snapshotDir` | `qain-snapshots` | Where baselines live. |
| `selector` | `#storybook-root` | Scope the capture. Use `#root` on Storybook 6. |
| `states`, `rules`, `omitDerived`, `boxTolerance`, … | — | Any [`@qain/core`](https://github.com/Shinyaigeek/qain) capture/diff option. |

## License

[MIT](./LICENSE) © Shinyaigeek
