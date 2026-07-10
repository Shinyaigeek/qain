# @qain/playwright

Playwright fixture and `toMatchStyleSnapshot` matcher for
[qain](https://github.com/Shinyaigeek/qain) — style-regression testing that
reports **what changed and what merely moved**.

```sh
pnpm add -D @qain/playwright
```

```ts
import { expect, test } from '@qain/playwright'

test('home page styles', async ({ page }) => {
  await page.goto('/')
  await expect(page).toMatchStyleSnapshot({ states: ['hover', 'focus-visible'] })
})
```

Baselines live beside the test and honour `--update-snapshots` exactly as
`toHaveScreenshot` does. On failure the matcher attaches an HTML diff to the
Playwright report, naming every change and the CSS rule that caused it.

**Chromium only, by design.** `DOMSnapshot.captureSnapshot` and
`CSS.forcePseudoState` have no Firefox or WebKit equivalent, and qain is built on
both.

See the [main README](https://github.com/Shinyaigeek/qain#readme) for the full
story.

MIT © Shinyaigeek
