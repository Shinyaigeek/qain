# qain examples

A small billing page, and a commit that breaks it in four different ways at once.

```sh
pnpm build            # from the repo root
pnpm --filter qain-examples demo    # the CLI workflow
pnpm --filter qain-examples test    # the Playwright matcher
pnpm --filter qain-examples serve   # http://localhost:5600/
```

`?variant=regressed` swaps in the broken stylesheet and rehashes the utility
classes. Nothing else about the page moves — same markup, same URL path, same
viewport — which is the situation a style-regression tool exists for.

## The regression

`app/styles/theme.css` → `app/styles/theme.regressed.css`, four independent edits:

| edit | what qain should say |
| --- | --- |
| `.btn` padding `8px 16px` → `14px 16px` | two buttons **resized**; everything below them **moved** |
| `.muted` colour `#6b7280` → `#c7cbd4` | three nodes **recoloured**, contrast `4.83 → 1.63`, below WCAG AA |
| `.badge` `z-index: 2` → `0` | **paint order** changed — the badge now renders under the heading |
| `.btn-primary:hover` background = the resting background | the `:hover` state stopped differing |
| every `css-a1b2c3` → `css-9f8e7d` | **nothing** |

The last row is the point. A CSS-Modules or Tailwind build rewrites class strings
on every commit; a naive DOM snapshot test goes red on all of them.

## What the demo prints

```
default state
  html > body > header > span[data-testid=plan-badge]
    z-index: 2 → 0
    paint order: 4 → 3 (stacking changed)
    ← .badge { z-index: 2 → 0 }  theme.regressed.css:21:3
  html > body > main > section[data-testid=usage-card] > p[data-testid=usage-note]
    color: rgb(107, 114, 128) → rgb(199, 203, 212)
    contrast 4.83 → 1.63  ✗ falls below WCAG AA-normal
    ← .muted { color: rgb(107, 114, 128) → rgb(199, 203, 212) }  theme.regressed.css:30:3
  html > body > main > div > button[data-testid=pay]
    resized 0px × +12px
    ← .btn { padding: 8px 16px → 14px 16px }  theme.regressed.css:4:3

:hover
  html > body > main > div > button[data-testid=pay]
    background-color: rgb(29, 78, 216) → rgb(37, 99, 235)
    contrast 6.7 → 5.17
```

Fourteen causes. Without `--omit-derived` the same diff has **thirty-nine**
changes: the fourteen above, plus eighteen `currentColor` properties dragged along
by `.muted`, plus seven boxes the buttons pushed down the page. qain knows which
is which, so the other twenty-five go behind a fold.

Note the footnote. Its colour changed *and* it was displaced by the buttons
growing — but colour cannot move a box, so only the colour is reported as a
cause. That distinction lives in `GEOMETRIC_PROPERTIES`.

## Look at it

Step 8 of the demo writes `examples/replay.html`: both pages rebuilt from their
snapshots, side by side, with an opacity slider. Switch to overlay, drag the fader,
and watch the footnote slide 12px as the buttons grow. Causes are outlined in red,
collateral in grey.

## Is this a test?

Yes. `scripts/demo.mjs` shells out to the real `qain` binary rather than importing
the library, so it covers the CLI's argument parsing and its exit codes — 0 for a
clean diff, 1 for a dirty one, which is how CI and coding agents gate on it. It
asserts that all six regressed elements are found and that the rehashed class is
not, then fails loudly if the example ever stops demonstrating what it claims to.

`tests/billing.spec.ts` does the same through `toMatchStyleSnapshot`, including
the HTML report and the replay it attaches to the Playwright run on failure.
