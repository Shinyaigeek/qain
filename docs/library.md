# Using @qain/core as a library

Everything the CLI and the test-runner matchers do is a thin layer over
`@qain/core`: capture a [snapshot](./snapshot-format.md), diff two of them,
format the result. The package has **no Playwright dependency** — it asks only
for an object shaped like:

```ts
interface CdpSession {
  send(method: string, params?: object): Promise<unknown>
}
```

so it works with Playwright, Puppeteer, or a raw CDP websocket.

```sh
pnpm add -D @qain/core
```

## Getting a CDP session

```ts
// Playwright
const session = await page.context().newCDPSession(page)

// Puppeteer
const session = await page.createCDPSession()
```

Both satisfy the contract structurally; TypeScript may want a cast
(`as unknown as CdpSession`) since their `send` signatures are typed against
their own protocol maps.

## Capture and diff

```ts
import { type CdpSession, capture, diff, formatText } from '@qain/core'

const before = await capture(session, { rules: true })
// ... change the code, reload the page ...
const after = await capture(session, { rules: true })

const result = diff(before, after)
if (result.changes.length > 0) {
  console.log(formatText(result, { color: true }))
}
```

Snapshots are plain JSON — persist them with `JSON.stringify` and diff them in
a later process, which is all the CLI's `-o` does.

### `capture(cdp, options)`

| option | default | what |
| --- | --- | --- |
| `selector` | whole document | Restrict the snapshot to the first matching element and its descendants. Throws when nothing matches. |
| `states` | `[]` | Pseudo-states to force and capture, each as its own state: `'hover'`, `'focus'`, `'focus-visible'`, `'focus-within'`, `'active'`, `'target'` (`PSEUDO_STATES`). |
| `strategy` | `'auto'` | How pseudo-states are forced: `'auto'` bulk-forces and verifies nothing outside the forced subtrees moved, falling back to per-node capture; `'bulk'` and `'isolated'` pin the choice. |
| `rules` | `false` | Record matched CSS declarations per node, so `diff` can attribute each change to a `file:line`. One CDP round-trip per node. |
| `includeUserAgentRules` | `false` | Include the UA stylesheet in `rules`. |
| `replay` | `false` | Record per-line text rectangles (`textRuns`) so `renderReplay` can rebuild the page without re-running layout. |
| `projection` | `DEFAULT_PROJECTION` | Which computed properties to record. Diffing is scoped to the recorded set. |
| `interactiveSelector` | `DEFAULT_INTERACTIVE_SELECTOR` | Which elements are candidates for pseudo-state forcing (buttons, links, inputs, `[tabindex]`, …). |
| `excludeAttributes` | `DEFAULT_EXCLUDED_ATTRIBUTES` | Attributes dropped at capture (`style`, `nonce`, `srcset`, …). |
| `frameUrl` | top-level document | Snapshot the frame whose document URL equals this, piercing into it for node queries and pseudo-state forcing too. This is how `@qain/vitest` targets the iframe Vitest runs each test in. Throws when no frame matches. |

`capture` does **not** navigate, wait for `load`, or wait for
`document.fonts.ready` — the page is snapshotted as it stands. The caller owns
settling; see what [the CLI does](./cli.md#what-settled-means) before it
captures.

### `diff(before, after, options)`

Pure — no browser involved. Returns a [`Diff`](./snapshot-format.md#the-diff);
attributions are computed automatically when both snapshots carry rules.

| option | default | what |
| --- | --- | --- |
| `omitDerived` | `false` | Drop `derived` box changes entirely — the terse view. |
| `boxTolerance` | `DEFAULT_BOX_TOLERANCE` (0.5px) | Sub-pixel box movement below this is not a change. |
| `contrastTolerance` | — | Contrast-ratio deltas below this are not reported. |
| `ignoreProperties` | `DEFAULT_IGNORED_PROPERTIES` | Computed properties excluded from comparison. |
| `ignoreAttributes` | `DEFAULT_IGNORED_ATTRIBUTES` (`['class']`) | Attributes excluded from comparison. Pass `[]` to compare `class` strings too. |

## Rendering results

```ts
import { formatHtml, formatText, renderReplay, renderReplayDiff } from '@qain/core'

formatText(result, { color: true })   // the CLI's terminal report
formatHtml(result)                    // standalone HTML report (`qain diff --html`)
renderReplay(snapshot, { state: 'default' })         // rebuild one snapshot (`qain view`)
renderReplayDiff(before, after, result)              // fade-between page (`qain diff --replay`)
```

The replay renderers need snapshots captured with `replay: true`; without
text runs the reconstruction is boxes with no text placed in them.

## Lower-level pieces

The building blocks are exported for tools that want them: `explain` (change →
declaration attribution, which `diff` calls for you), `captureRules`,
`assignKeys` / `absoluteKey` / `relativeKey` (the
[identity scheme](./snapshot-format.md#keys)), the contrast math
(`contrastRatio`, `composite`, `crossedThreshold`, …), and the default
projection and ignore lists from
[`projection.ts`](../packages/core/src/projection.ts). The
[core README](../packages/core/README.md) and the source are the reference.
