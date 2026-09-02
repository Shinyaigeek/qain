# @qain/impact

**Feed it a PR, get back the blast radius.**

A library bump, a theme edit, a one-line component tweak — the question is always
the same: *what does this actually change, and where?* `@qain/impact` captures your
pages at HEAD, diffs each against a baseline committed from the base branch, and
folds the result into one report grouped two ways — by the **component** the change
landed in, and by the **stylesheet** that caused it.

```
qain impact — 3 of 12 targets changed · 47 changes (18 primary, 29 derived)

by origin
  library:@acme/ds        31 changes · 4 components · 3 targets
  theme:/theme/tokens.css  9 changes · 2 components · 2 targets
  local:/assets/app.css    7 changes · 1 component · 1 target

components
  Button  18 changes (12 primary)
    in checkout, billing, settings
    ← .acme-Button { padding: 8px 16px → 14px 16px }  button.css:14:3  [library:@acme/ds]
    e.g. html > body > main > button[data-testid=pay] > span
```

The origin split is the part no module-graph tool can give you. It is not read from
the PR's file list — it comes from the stylesheet that carried the winning
declaration, as the browser resolved it. A PR that looks like a one-component change
can turn out to be four-fifths design-system churn, and this is where that shows up.

## Install

```sh
pnpm add -D @qain/cli   # the `qain impact` command
pnpm add -D @qain/impact  # the library, if you want to build your own report
```

## Configure

`qain.impact.json`:

```json
{
  "baseUrl": "http://localhost:3000",
  "baselineDir": "qain-baselines",
  "targets": [
    { "name": "checkout", "path": "/checkout" },
    { "name": "billing", "path": "/billing", "states": ["hover"] },
    { "name": "button-story", "url": "http://localhost:6006/iframe.html?id=button--primary", "selector": "#storybook-root" }
  ]
}
```

`targets` is the only required field, and deliberately so — there is no sound guess
for which pages you want captured, and a guess would silently under-report.

Everything else has a default: `componentAttributes`
(`data-component`, `data-qain-component`), `origins.library` (`**/node_modules/**`),
`origins.theme` (`**/theme/**`, `**/tokens*.css`), `viewport`, `states`.

## Run it

```sh
qain impact --update                 # on the base branch: write the baselines
qain impact                          # on the PR: report the blast radius
qain impact --shots shots/           # + before/after/diff PNGs per changed target
qain impact --markdown report.md     # + a PR comment
```

Exit code is `0` when nothing changed, `1` when something did **or a target has no
baseline**, and `2` on a broken run. An unbaselined target is unreviewed rather than
clean, and exiting `0` on one would be the silent miss the whole tool exists to
prevent.

## Where component names come from

A snapshot holds tags, attributes, roles and paths. It has no component identity, so
something has to put the name in the DOM. If your design system ships React
components, that something is the design system itself:

```jsx
export function Button(props) {
  return <button data-component="Button" className={styles.button} {...props} />
}
```

One line per component, in a repository you already own. No babel plugin, no Vite
plugin, no fiber introspection, and nothing that breaks when React changes its
internals. It also makes the report independent of how you write CSS — Tailwind,
CSS Modules and emotion all group identically.

The attribute sits on the component's root element, but the element that actually
changed is usually a descendant — the span inside the button, not the button. The
report walks up from each changed node to the nearest ancestor carrying one of
`componentAttributes`, so descendants land under their owner. Anything with no such
ancestor is grouped under `(ungrouped)`.

**Add the attribute one release before you need the analysis.** The report diffs
HEAD against a stored baseline, so the baseline has to carry the attribute too.

## Two things it cannot do

**Bundled CSS loses its origin.** `origins.library` matches a node_modules path. If
your bundler inlines the design system into `assets/index-<hash>.css`, that path is
gone and the change reports as `local`. Name your own output in `origins` when that
happens.

**Runtime CSS-in-JS loses its source location.** emotion and styled-components
inject stylesheets at runtime, so CDP reports the document URL and an offset into
the injected sheet — never `Button.tsx:14`. Detection and grouping still work
exactly as well; only the *name* of the cause degrades.

## In CI

Capture baselines where the base branch is built, and report on the PR:

```yaml
# on push to main
- run: qain impact --update
# commit qain-baselines/ back, or upload it as an artifact

# on pull_request
- run: qain impact --markdown impact.md --shots shots/
```

Capturing both sides per PR would mean checking out, installing and building the
base ref inside the PR job. That is the slowest and most brittle shape this could
take; a stored baseline avoids it entirely — the same trade `@qain/storybook` makes
with committed baselines.

## Library

Every part of the command is exported, and the aggregation is a pure function you
can drive with your own captures:

```ts
import { buildReport, loadConfig, runImpact, formatImpactMarkdown } from '@qain/impact'

const config = await loadConfig('qain.impact.json')
const report = await runImpact(config)
console.log(formatImpactMarkdown(report))
```

MIT © Shinyaigeek
