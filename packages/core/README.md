# @qain/core

The capture, projection, diff, and report engine behind [qain](https://github.com/Shinyaigeek/qain) —
style-regression testing that reports **what changed and what merely moved**.

This package has no Playwright dependency. It asks only for a CDP session shaped
like `{ send(method, params) }`, so it works with Playwright, Puppeteer, or a raw
CDP socket.

```sh
pnpm add -D @qain/core
```

```ts
import { capture, diff } from '@qain/core'

const before = await capture(session)
// ... change the code, reload ...
const after = await capture(session)

for (const change of diff(before, after).changes) console.log(change)
```

**Chromium only, by design.** `DOMSnapshot.captureSnapshot` and
`CSS.forcePseudoState` have no Firefox or WebKit equivalent, and qain is built on
both.

See the [main README](https://github.com/Shinyaigeek/qain#readme) for the full
story: the CLI, the Playwright matcher, rule attribution, and replay.

MIT © Shinyaigeek
