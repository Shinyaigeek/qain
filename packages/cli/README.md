# qain

The CLI for [qain](https://github.com/Shinyaigeek/qain) — style-regression
testing that reports **what changed and what merely moved**.

```sh
pnpm add -D qain
```

```sh
qain snap http://localhost:3000 --rules --replay -o before.json
# ... change the code ...
qain snap http://localhost:3000 --rules --replay -o after.json
qain diff before.json after.json --omit-derived
qain diff before.json after.json --replay report.html   # and look at it
```

Exit code is 1 when the diff is non-empty, so an agent can gate on it. `--json`
emits the diff as structured data; `--html report.html` writes a standalone page.

```
default state
  html > body > div > p[data-testid=note]
    color: rgb(90, 90, 90) → rgb(190, 190, 190)
    contrast 6.9 → 1.86  ✗ falls below WCAG AA-normal
    ← .note { color: rgb(90, 90, 90) → rgb(190, 190, 190) }  theme.css:12:3

8 changes: 2 primary, 6 derived
```

**Chromium only, by design.** `DOMSnapshot.captureSnapshot` and
`CSS.forcePseudoState` have no Firefox or WebKit equivalent, and qain is built on
both.

See the [main README](https://github.com/Shinyaigeek/qain#readme) for the full
story.

MIT © Shinyaigeek
