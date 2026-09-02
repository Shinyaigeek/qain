# CLI reference

```
qain snap <url> [options]         capture a snapshot
qain diff <before> <after> [opts] compare two snapshots
qain view <snapshot> [opts]       rebuild the page from a snapshot, as HTML
qain shot <before> <after> [opts] render before.png, after.png and diff.png
```

`qain --help` prints the same. Exit codes across all commands:

| code | meaning |
| --- | --- |
| `0` | success — for `diff`, an empty diff |
| `1` | `diff` only: the diff is non-empty |
| `2` | usage error, capture error, or unreadable snapshot |

## `qain snap <url>`

Opens the URL in a fresh headless Chromium, waits for it to settle, and writes
a [snapshot](./snapshot-format.md) as JSON — to stdout by default, so it pipes.

```sh
qain snap http://localhost:3000 --selector '[data-testid=card]' --rules -o card.json
```

| option | default | what |
| --- | --- | --- |
| `-o, --out <file>` | stdout | Where to write the JSON. With `-o`, a one-line summary and any capture warnings go to stderr. |
| `--selector <css>` | whole document | Scope the snapshot to the first element matching this selector, and its descendants. Errors if nothing matches. |
| `--states <list>` | none | Comma-separated pseudo-states to force and capture, each as its own state: `hover`, `focus`, `focus-visible`, `focus-within`, `active`, `target`. |
| `--viewport <WxH>` | `1280x720` | Viewport size, e.g. `390x844`. |
| `--wait <ms>` | `0` | Extra settle time after load. |
| `--wait-for <css>` | — | Wait for this selector to appear before capturing. |
| `--strategy <mode>` | `auto` | Pseudo-state capture strategy: `auto`, `bulk`, or `isolated`. See below. |
| `--rules` | off | Also record matched CSS declarations, so `qain diff` can name the `file:line` behind each change. One CDP round-trip per node, ~3× snapshot size. |
| `--ua-rules` | off | Include the user-agent stylesheet in `--rules`. Large, and nobody edited it. |
| `--replay` | off | Record per-line text rectangles, so `view`, `diff --replay`, and `shot` can rebuild the page without re-running layout. Pass it on **both** snapshots you intend to diff visually. |
| `--browser <path>` | Playwright's managed Chromium | Chromium/Chrome executable to launch. |
| `--headed` | off | Run with a visible window — useful for debugging what the page looked like at capture time. |

### What "settled" means

`snap` captures after, in order: the `load` event, `--wait-for` (if given),
`document.fonts.ready` — webfonts swap in late and would otherwise change every
`font-family` in the snapshot — and finally `--wait` milliseconds. If the page
animates or streams in content, give it an explicit `--wait-for` or `--wait`;
qain does not guess.

### Pseudo-state strategy

Forcing every button into `:hover` at once is a page state that never occurs
in a real browser — safe only if hovering changes nothing outside the hovered
elements. `--strategy auto` (the default) takes one bulk snapshot, verifies
nothing outside the forced subtrees moved or restyled, and silently falls back
to one snapshot per element when it did. `bulk` and `isolated` pin the choice:
`bulk` is fast, `isolated` is always correct.

## `qain diff <before> <after>`

Compares two snapshot files and prints a human-readable report to stdout.
Exit code `1` when the diff is non-empty.

```sh
qain diff before.json after.json --omit-derived
qain diff before.json after.json --json > diff.json
qain diff before.json after.json --replay report.html
```

| option | default | what |
| --- | --- | --- |
| `--omit-derived` | off | Drop changes that are only collateral movement — a node that moved because something above it grew. The terse view. |
| `--ignore-paint-order` | off | Do not report paint-order (stacking) changes. Use it when part of the tree is out of the page's control — a cross-origin `<iframe>` that paints only once its document arrives shifts every node after it, so the same page diffs against itself depending on the network. |
| `--json` | off | Emit the [diff as JSON](./snapshot-format.md#the-diff) instead of text. |
| `--html <file>` | — | Also write a standalone HTML report. |
| `--replay <file>` | — | Also write a before/after visual replay you can fade between. Requires both snapshots to carry `snap --replay` data; errors otherwise. |
| `--serve` | off | Host the view on `localhost` instead of writing a file, and stay up until Ctrl-C. Serves the before/after replay when both snapshots carry `--replay` data, otherwise the HTML report. |
| `--port <n>` | `4179` | Port for `--serve`. Falls back to a free port if this one is taken. |
| `--tolerance <px>` | `0.5` | Sub-pixel box movement below this is not a change. Raise it if a font renders a fraction of a pixel differently across machines. |
| `--no-color` | auto | Plain text. Color is on only when stdout is a TTY. |

The two snapshots do not need to come from the same URL — comparing
`staging` against `production`, or `?theme=light` against `?theme=dark`,
works because elements are matched by [identity key](./snapshot-format.md#keys),
not by URL or DOM position.

## `qain view <snapshot>`

Rebuilds the page from a snapshot as a standalone HTML file — a
reconstruction, not a screenshot. Every element is placed at the rectangle
Chromium gave it; nothing reflows.

```sh
qain view page.json -o page.html
qain view page.json --serve            # open it on localhost
```

| option | default | what |
| --- | --- | --- |
| `-o, --out <file>` | stdout | Where to write the HTML. |
| `--state <name>` | `default` | Which captured state to draw: `default` or one of the captured pseudo-states. |
| `--serve` | off | Host the rebuilt page on `localhost` instead of writing it, and stay up until Ctrl-C. |
| `--port <n>` | `4179` | Port for `--serve`. Falls back to a free port if this one is taken. |

A snapshot captured without `--replay` still renders, but as boxes with no
text placed in them — `view` warns when that is the case.

The replay and `view` pages are interactive: **⌘/Ctrl + scroll** or the
`− 100% +` control zooms the canvas, **drag** pans it, and **clicking a
change** — in the canvas or the causes list — spotlights every box for that
node (Esc clears it).

## `qain shot <before> <after>`

Renders both snapshots in a headless Chromium and writes three PNGs:
`before.png`, `after.png`, and `diff.png` — the base render faded to
near-white with every differing pixel in solid red. For eyes and multimodal
models; the semantic diff is still `qain diff`.

```sh
qain shot before.json after.json -o shots/ --state hover
```

| option | default | what |
| --- | --- | --- |
| `-o, --out-dir <dir>` | `.` | Directory for the three PNGs. Created if missing. |
| `--state <name>` | `default` | Which captured state to render. |
| `--browser <path>` | Playwright's managed Chromium | Chromium/Chrome executable to launch. |

Both snapshots must carry `snap --replay` data.

## `qain impact`

The blast radius of the working tree: which components changed, in which
targets, and which stylesheet caused it. Captures every target in
`qain.impact.json` at HEAD, diffs each against a baseline committed from the
base branch, and folds the results into one report.

```sh
qain impact --update                 # on the base branch: write the baselines
qain impact                          # on the PR: report the blast radius
qain impact --shots shots/ --markdown impact.md
```

| option | default | what |
| --- | --- | --- |
| `--config <file>` | `qain.impact.json` | Target list, grouping attributes, origin patterns. |
| `--update` | off | Rewrite the baselines instead of diffing. Run on the base branch, never on the PR. |
| `--shots <dir>` | off | Render `before/after/diff.png` per changed target, from the snapshots alone. |
| `--markdown <file>` | off | Write the report as a PR comment. |
| `--json` | off | Emit the report as JSON. |
| `--omit-derived` | off | Hide components that only moved. |
| `--no-color` | off | Plain text. |

Exit code is `0` when nothing changed, `1` when something changed **or a target
has no baseline**, and `2` on a broken run. An unbaselined target is unreviewed
rather than clean.

Targets are captured with rules and replay data unconditionally — the first is
what lets the report name the library behind a change, the second is what lets
`--shots` render without re-running the app.

Component names come from an attribute the design system stamps on its own root
elements (`data-component` by default); each changed node is grouped under the
nearest ancestor carrying one. See
[`@qain/impact`](../packages/impact/README.md) for the full configuration, the
CI shape, and what bundled CSS and runtime CSS-in-JS cost you.
