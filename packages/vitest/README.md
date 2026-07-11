# @qain/vitest

Semantic style-regression testing for [Vitest browser mode](https://vitest.dev/guide/browser/).

Component VRT without booting Storybook: mount a component in `@vitest/browser`,
and assert its **used values** — computed styles, layout boxes, paint order,
composited colors — against a committed baseline. Class churn and one-pixel font
shifts are ignored by construction; a real regression names the declaration behind
it.

```ts
import { render } from 'vitest-browser-react'
import { test } from 'vitest'
import { expect } from '@qain/vitest'
import { Button } from './Button'

test('primary button', async () => {
  render(<Button variant="primary">Pay</Button>)
  await expect(document.body).toMatchStyleSnapshot({ states: ['hover', 'focus-visible'] })
})
```

- **First run** writes the baseline to `__qain__/<test>.qain.json` beside the test
  and passes; later runs diff against it. `-u` accepts changes, `--ci` never writes.
- **No config.** Baselines persist through Vitest's built-in browser file commands.
  qain drives CDP via the session Vitest already exposes (`cdp()`), and targets the
  test's iframe automatically.
- **Chromium only, by design** — `DOMSnapshot.captureSnapshot` and
  `CSS.forcePseudoState` have no Firefox or WebKit equivalent.

## Requires

Vitest 4+ browser mode on the Playwright provider with a Chromium instance:

```ts
// vitest.config.ts
import { playwright } from '@vitest/browser-playwright'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    browser: {
      enabled: true,
      provider: playwright(),
      instances: [{ browser: 'chromium' }],
    },
  },
})
```

`toMatchStyleSnapshot` takes the same capture and diff options as the CLI and the
Playwright matcher — `states`, `rules`, `selector`, `omitDerived`, `boxTolerance`.
See [`qain`](https://github.com/Shinyaigeek/qain) for what the diff reports and why
it stays quiet.

## License

[MIT](./LICENSE) © Shinyaigeek
