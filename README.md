# qain

Style-regression testing that reports **what changed and what merely moved**.

Pixel VRT tells you two images differ. It cannot tell you why, it cannot tell an
LLM why, and it goes red when a font renders one pixel to the left. qain captures
the browser's *used values* — resolved computed styles, layout boxes, paint order,
composited colors — and diffs them semantically:

```
default state
  html > body > div > p[data-testid=note]
    color: rgb(90, 90, 90) → rgb(190, 190, 190)
    contrast 6.9 → 1.86  ✗ falls below WCAG AA-normal

6 derived changes (a consequence of the above)
  ... border-top-color, outline-color, text-decoration-color (follows color)

8 changes: 2 primary, 6 derived
```

**Chromium only, by design.** `DOMSnapshot.captureSnapshot` and
`CSS.forcePseudoState` have no Firefox or WebKit equivalent, and qain is built on
both.

## Install

```sh
pnpm add -D qain              # CLI
pnpm add -D @qain/playwright  # Playwright matcher
pnpm add -D @qain/core        # library
```

## CLI — for humans and coding agents

```sh
qain snap http://localhost:3000 -o before.json
# ... change the code ...
qain snap http://localhost:3000 -o after.json
qain diff before.json after.json --omit-derived
```

Exit code is 1 when the diff is non-empty, so an agent can gate on it. `--json`
emits the diff as structured data; `--html report.html` writes a standalone page.

## Playwright

```ts
import { expect, test } from '@qain/playwright'

test('home page styles', async ({ page }) => {
  await page.goto('/')
  await expect(page).toMatchStyleSnapshot({ states: ['hover', 'focus-visible'] })
})
```

Baselines live beside the test and honour `--update-snapshots` exactly as
`toHaveScreenshot` does. On failure the matcher attaches an HTML diff to the
Playwright report, so nobody has to install a viewer.

## Why it is quiet

A naive DOM+CSS snapshot test is unusable: Chromium reports ~420 computed
properties per element, and changing one CSS variable turns the whole page red.
qain suppresses noise structurally, not with ignore-lists:

**The projection excludes anything the layout box already says.** `padding`,
`margin`, `width` and `height` all resolve into `bounds`, which qain captures
anyway. Recording both would report every change twice — once as the cause, once
as the effect.

**Elements are keyed, not positioned.** `data-testid`, then `id`, then
accessible role + name, then a sibling ordinal. Inserting a `<div>` at the top of
a list reports one addition, not a rewritten subtree.

**`class` is captured but never compared.** Tailwind and CSS Modules rewrite
class strings on every build while the rendering is identical.

**Every change is `primary` or `derived`.** A node that only moved was pushed by
something else. A container that grew only did so to fit a child. Six
`currentColor` properties following one `color` change are one change, not seven.
`--omit-derived` shows you the causes alone.

## Pseudo-states

qain forces `:hover`, `:focus-visible` and friends through CDP and snapshots the
result — something pixel VRT cannot do without synthesising real pointer input.

Forcing every button into `:hover` at once is a page state that never occurs in a
browser. It is safe only if hovering changes nothing outside the hovered elements.
So `strategy: 'auto'` (the default) takes one bulk snapshot, checks whether
anything outside the forced subtrees moved or restyled, and silently falls back to
one snapshot per element when it did. A `:hover` that changes `padding` displaces
its siblings; a `.btn:hover ~ .panel` rule restyles a node that is not hovered.
Both are caught. Neither is guessed at.

## Contrast

Because Chromium reports the *composited* background (`blendedBackgroundColors`),
qain computes WCAG contrast against what the eye actually receives — a half-opaque
white panel over blue reads `rgb(128, 128, 255)`, not `rgba(255,255,255,0.5)`.
A ratio that crosses a WCAG threshold is reported by name.

## What it does not do

- **Replay.** Snapshots are data, not a reconstructed page. The Playwright HTML
  report is the viewer.
- **Explain.** The diff says `background-color` changed; it does not yet say which
  CSS rule changed it. That needs `CSS.getMatchedStylesForNode` against the one
  node that moved — a second query, not something worth carrying in every
  snapshot.
- **Cross-browser.** See above.

## Layout

| package | what |
| --- | --- |
| `@qain/core` | capture, projection, diff, reports. No Playwright dependency. |
| `qain` | the CLI. |
| `@qain/playwright` | fixture, `toMatchStyleSnapshot`, report attachment. |

`@qain/core` asks only for `{ send(method, params) }`, so it works with
Playwright, Puppeteer, or a raw CDP socket.

## Development

```sh
pnpm install
pnpm build
pnpm test          # e2e, needs Chrome
```

Descended from [computed-styles-regression-test](https://github.com/Shinyaigeek/computed-styles-regression-test),
which proved the idea and is superseded by this.
