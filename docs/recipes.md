# Recipes

Everything here is the CLI against a URL — no test runner, no config. Each
recipe assumes `@qain/cli` is installed ([getting started](./getting-started.md)).

## Check a change against a running dev server

The core loop. Snapshot before, change the code, snapshot after, diff:

```sh
qain snap http://localhost:3000 --rules --replay -o /tmp/before.json
# ... edit CSS, components, tokens ...
qain snap http://localhost:3000 --rules --replay -o /tmp/after.json
qain diff /tmp/before.json /tmp/after.json --omit-derived
```

If your dev server hot-reloads, the second `snap` sees the new code with no
restart. The diff names what changed, what merely moved, and — with `--rules` —
the `file:line` of the declaration behind each change.

## Scope to one element

`--selector` restricts the snapshot to one subtree, so a component-level
change diffs against component-level data instead of the whole page:

```sh
qain snap http://localhost:3000 --selector '[data-testid=pricing-card]' -o card.json
```

Any selector `querySelector` accepts works; the first match wins, and qain
errors — rather than silently snapshotting nothing — when there is no match.
If the element renders late, add `--wait-for '[data-testid=pricing-card]'`.

## Extract computed styles + DOM as data

A snapshot is not only for diffing — it *is* the computed styles and DOM
of the page, as JSON on stdout by default. Pull out whatever you need:

```sh
# every node: its location, tag, attributes, resolved styles, layout box
qain snap http://localhost:3000 --selector '[data-testid=pay]' \
  | jq '.states[0].nodes[] | {path, tag, attrs, styles, box}'

# one property across the whole page
qain snap http://localhost:3000 \
  | jq '.states[0].nodes[] | {path, color: .styles["color"]}'
```

The values are Chromium's *used values* — `color` is an `rgb()` triple, not
the `var(--text-muted)` you wrote — which is exactly what makes them
comparable across builds. See the [snapshot format](./snapshot-format.md) for
every field.

## Snapshot a Storybook story

Storybook renders every story standalone at `iframe.html?id=<story-id>`, and
that is a URL like any other:

```sh
qain snap 'http://localhost:6006/iframe.html?id=button--primary' \
  --selector '#storybook-root' --rules -o button-primary.json
```

`--selector '#storybook-root'` keeps Storybook's own chrome out of the
snapshot (use `#root` on Storybook 6). To turn *every* story into a
baseline-managed style test instead of snapshotting by hand, use
[`@qain/storybook`](../packages/storybook/README.md) — one `postVisit` hook.

## Capture hover and focus styles

Pixel VRT cannot screenshot `:hover` without synthesizing real pointer input.
qain forces pseudo-classes through CDP and captures each as its own state:

```sh
qain snap http://localhost:3000 --states hover,focus-visible --rules -o before.json
```

The diff then reports hover regressions under a `:hover` heading, attributed
to the `:hover` rule that caused them. Available states: `hover`, `focus`,
`focus-visible`, `focus-within`, `active`, `target`.

## Compare two environments, or two variants of one URL

Nothing requires *before* and *after* to be the same URL — elements are
matched by identity key, not address. Staging against production:

```sh
qain snap https://staging.example.com/pricing -o staging.json
qain snap https://example.com/pricing -o prod.json
qain diff prod.json staging.json --omit-derived
```

or two variants of the same page — themes, feature flags, A/B arms:

```sh
qain snap 'http://localhost:3000/?theme=light' -o light.json
qain snap 'http://localhost:3000/?theme=dark' -o dark.json
qain diff light.json dark.json
```

Keep the viewport identical across the two snaps, or every box moves.

## Gate CI — or a coding agent — on the diff

`qain diff` exits `1` when the diff is non-empty, so the shell is the
assertion:

```sh
qain snap "$APP_URL" --rules -o after.json
qain diff baseline.json after.json --omit-derived || {
  echo "style regression — see above" >&2
  exit 1
}
```

For a coding agent, `--json` gives it structure to reason over, and
`qain shot` renders PNGs a multimodal model can look at:

```sh
qain diff baseline.json after.json --json > diff.json   # exit code still 1
qain shot baseline.json after.json -o shots/            # before/after/diff.png
```

An agent loop is then: snap → edit → snap → diff; repeat until the diff
contains only the changes it intended. The
[`examples/`](../examples/README.md) directory runs this exact workflow
end-to-end, and this repo's own CI posts the diff and screenshots on PRs that
change a committed baseline.

## Capture on a phone-sized viewport

```sh
qain snap http://localhost:3000 --viewport 390x844 -o mobile.json
```

Media queries resolve at capture time, so a `@media (max-width: 480px)` bug
is visible in `mobile.json` and absent from a `1280x720` snapshot. Diff only
snapshots that share a viewport.

## Debug a surprising capture

When the snapshot does not contain what you expected, watch it happen:

```sh
qain snap http://localhost:3000 --headed --wait 3000 -o page.json
```

`--headed` opens a visible window; `--wait` keeps it around long enough to
look at. The usual suspects, in order: content that renders after `load`
(fix with `--wait-for <css>`), a webfont or animation still settling (fix
with `--wait <ms>`), and the element living inside an iframe — the CLI
snapshots the top-level document; iframe piercing is a
[`@qain/core` option](./library.md) (`frameUrl`) used by the Vitest
integration.
