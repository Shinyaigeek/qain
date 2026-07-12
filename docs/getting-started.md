# Getting started

qain captures the browser's *used values* — resolved computed styles, layout
boxes, paint order, composited colors — as a JSON snapshot, and diffs two
snapshots semantically. This page takes you from install to your first diff.

## Install

```sh
pnpm add -D @qain/cli    # or npm i -D / yarn add -D / bun add -d
```

This installs the `qain` binary. It needs a Chromium to drive: qain launches
one through `playwright-core`, which looks for its matching Playwright-managed
Chromium. If `snap` fails with a browser-not-found error, either install one —

```sh
npx playwright install chromium
```

— or point `--browser` at any Chrome/Chromium binary already on disk:

```sh
qain snap http://localhost:3000 --browser /usr/bin/google-chrome
```

**Chromium only, by design.** `DOMSnapshot.captureSnapshot` and
`CSS.forcePseudoState` have no Firefox or WebKit equivalent, and qain is built
on both.

## Capture, change, diff

Point `qain snap` at any URL a browser can open — a dev server, a Storybook
story, a deployed page:

```sh
qain snap http://localhost:3000 --rules --replay -o before.json
```

`--rules` records the matched CSS declarations so the diff can name the
`file:line` behind each change. `--replay` records per-line text rectangles so
the page can be rebuilt later. Both are opt-in because they cost snapshot size;
both are worth passing by default.

Now change the code, and capture again:

```sh
qain snap http://localhost:3000 --rules --replay -o after.json
qain diff before.json after.json
```

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

## Reading the diff

Every change is **primary** or **derived**. A primary change is a cause: the
node's own styles, attributes, or text changed, or it resized for reasons of
its own. A derived change is a consequence: the node only moved because
something above it grew, or only recolored because it inherits `currentColor`.
`--omit-derived` shows the causes alone — usually the view you want:

```sh
qain diff before.json after.json --omit-derived
```

The exit code is `1` when the diff is non-empty and `0` when it is clean, so
CI and coding agents can gate on it. `--json` emits the diff as structured
data instead of text.

## Looking at it

A textual diff tells you *what*; sometimes you want to see it:

```sh
qain diff before.json after.json --replay report.html
```

writes a standalone HTML page with both snapshots rebuilt pixel-exactly,
side by side or stacked with an opacity slider, causes outlined in red. And

```sh
qain shot before.json after.json -o shots/
```

renders `before.png`, `after.png`, and `diff.png` — useful when the consumer
of the report is a multimodal model or a PR comment.

## Where to next

- [CLI reference](./cli.md) — every flag, including `--selector` to scope the
  snapshot to one element and `--states hover,focus-visible` to capture forced
  pseudo-states.
- [Recipes](./recipes.md) — Storybook stories, extracting computed styles as
  data, CI gating.
- Prefer assertions over snap-and-diff? The
  [Playwright](../packages/playwright/README.md),
  [Vitest](../packages/vitest/README.md), and
  [Storybook](../packages/storybook/README.md) matchers manage baselines for
  you.
