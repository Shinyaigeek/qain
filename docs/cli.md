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
| `--json` | off | Emit the [diff as JSON](./snapshot-format.md#the-diff) instead of text. |
| `--html <file>` | — | Also write a standalone HTML report. |
| `--replay <file>` | — | Also write a before/after visual replay you can fade between. Requires both snapshots to carry `snap --replay` data; errors otherwise. |
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
```

| option | default | what |
| --- | --- | --- |
| `-o, --out <file>` | stdout | Where to write the HTML. |
| `--state <name>` | `default` | Which captured state to draw: `default` or one of the captured pseudo-states. |

A snapshot captured without `--replay` still renders, but as boxes with no
text placed in them — `view` warns when that is the case.

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
