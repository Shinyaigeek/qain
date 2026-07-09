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
    ← .note { color: rgb(90, 90, 90) → rgb(190, 190, 190) }  theme.css:12:3

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
qain snap http://localhost:3000 --rules -o before.json
# ... change the code ...
qain snap http://localhost:3000 --rules -o after.json
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

## Why it names the rule

`--rules` records the matched CSS declarations alongside the snapshot, so the diff
can point at the line that caused each change:

```
button[data-testid=submit]
  resized 0px × +24px
  ← .btn { padding: 8px 16px → 20px 16px }  buttons.css:3:3
```

`padding` is not in the projection — by design, since the box already reports its
effect. Attribution buys the information back from the author's declaration rather
than its resolved consequence, and only for the nodes that changed.

Two things this required getting right, both of which are easy to get wrong:

**Chromium's `matchedCSSRules` is sorted by specificity, not by the cascade.**
`!important` is not folded into that order, and `style=""` is not in the array at
all. Reading the array backwards and taking the first hit — the obvious
implementation — picks the wrong rule whenever `!important` is involved. qain
resolves importance, origin, and inline explicitly, and the e2e suite asserts the
declaration it picks equals the value Chromium computed.

**Nobody writes `padding-top`.** Declarations are expanded through
`longhandProperties` so a `padding-top` change finds `padding: 8px 16px`, then
collapsed back so one edit reads as one cause rather than four.

When a primary change has no declaration behind it — a longer label widened the
button — qain says `no CSS declaration on this node changed` instead of blaming a
rule that happens to mention `width`. Derived changes are never attributed at all;
their cause is another node.

Cost: one CDP round-trip per node, and roughly 3× the snapshot size. Hence opt-in.

## Contrast

Because Chromium reports the *composited* background (`blendedBackgroundColors`),
qain computes WCAG contrast against what the eye actually receives — a half-opaque
white panel over blue reads `rgb(128, 128, 255)`, not `rgba(255,255,255,0.5)`.
A ratio that crosses a WCAG threshold is reported by name.

## What it does not do

- **Replay.** Snapshots are data, not a reconstructed page. The Playwright HTML
  report is the viewer.
- **Attribute pseudo-states.** `rules` are captured for the default state only.
- **Attribute across nodes.** A rule that stopped matching because a class changed
  shows up as a declaration appearing or disappearing, not as "you removed
  `.primary`".
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
