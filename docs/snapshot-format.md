# Snapshot & diff format

Both files the CLI reads and writes are plain JSON, designed to be consumed by
things other than qain — `jq`, a script, a coding agent. This page documents
the shape. The TypeScript types in
[`@qain/core`](../packages/core/src/types.ts) are the source of truth.

The top-level `qain` field is the format version (currently `2`), bumped
whenever the shape changes incompatibly. `qain diff` refuses files without it.

## The snapshot

What `qain snap` writes and `capture()` returns:

```jsonc
{
  "qain": 2,
  "url": "http://localhost:3000/",
  "title": "Billing",
  "viewport": { "width": 1280, "height": 720 },
  "projection": ["font-family", "font-size", /* … */],
  "states": [
    { "state": "default", "nodes": [/* QainNode[] */] },
    { "state": "hover", "strategy": "bulk", "nodes": [/* … */], "rules": {/* … */} }
  ],
  "warnings": []
}
```

- **`projection`** — the computed-style properties this snapshot recorded.
  Diffing is scoped to these; two snapshots with different projections still
  diff over the intersection, with a warning naming the properties that were
  only recorded on one side.
- **`states`** — one entry per captured state: always `default`, plus one per
  `--states` pseudo-state. A pseudo-state entry carries `strategy` (`bulk` or
  `isolated` — how it was forced) and, with `--rules`, its own `rules` index:
  the cascade under `:hover` is a different cascade.
- **`warnings`** — non-fatal capture problems, e.g. a pseudo-state that
  matched no interactive element.

### Nodes

Each state holds a flat list of nodes — every rendered element in the captured
scope, in document order:

```jsonc
{
  "key": "main>div>pay",              // identity across snapshots — see below
  "parent": "main>div",               // key of the parent element
  "path": "html > body > main > div > button[data-testid=pay]",
  "tag": "button",
  "role": "button",                   // from the accessibility tree
  "name": "Pay now",                  // accessible name
  "attrs": { "data-testid": "pay", "class": "btn btn-primary" },
  "text": "Pay now",
  "styles": { "color": "rgb(255, 255, 255)", "background-color": "rgb(29, 78, 216)", /* … */ },
  "box": [420, 312, 160, 40],         // [x, y, width, height], document coords, CSS px
  "paintOrder": 7,                    // higher = painted later = on top
  "blendedBackground": "rgb(29, 78, 216)",  // composited — what the pixels are
  "textRuns": [{ "box": [438, 322, 124, 20], "text": "Pay now" }]  // --replay only
}
```

Field notes:

- **`styles`** holds Chromium's *used values* for the projected properties —
  `rgb()` triples and `px` lengths, never `var()` references or `em`s. That
  resolution is what makes two builds comparable.
- **`box`** is `null` for nodes that generate no box. `padding`, `margin`,
  `width`, and `height` are deliberately **not** in `styles`: their effect is
  already in `box`, and recording both would report every change twice.
- **`attrs`** — volatile attributes (`style`, `nonce`, `srcset`, …) are
  dropped at capture. `class` **is captured but never compared** by default:
  Tailwind and CSS Modules rewrite class strings on every build while the
  rendering is identical.
- **`pseudo`** — present only for pseudo-elements (`"before"`, `"after"`,
  `"marker"`, …).
- **`blendedBackground`** — the composited background under text-bearing
  nodes; what WCAG contrast is computed against.
- **`textRuns`** — per-line text rectangles, recorded only with `--replay`.
  This is what lets `qain view` rebuild the page without re-running layout.
  Never compared: a text run is a consequence of the box, not a fact about it.

### Keys

`key` is the element's identity across snapshots, derived in priority order
from `data-testid`, then `id`, then accessible role + name, then a sibling
ordinal. It is stable under sibling insertion — adding a `<div>` at the top of
a list reports one addition, not a rewritten subtree — and it is why two
snapshots from *different URLs* (staging vs production) can be diffed at all.
`path` is for human-readable report output only, and is never compared.

## The diff

What `qain diff --json` emits and `diff()` returns:

```jsonc
{
  "qain": 2,
  "before": { "url": "…", "title": "…" },
  "after":  { "url": "…", "title": "…" },
  "changes": [/* Change[] */],
  "attributions": [/* Attribution[] — only when both snapshots carry rules */],
  "summary": { "total": 8, "primary": 2, "derived": 6, "byKind": { "style": 4, "box": 3, "contrast": 1 } },
  "warnings": []
}
```

### Changes

Every change carries `state` (which captured state it lives in), `key`, and
`path`, plus kind-specific fields:

| `kind` | fields | meaning |
| --- | --- | --- |
| `added` / `removed` | `node` | An element appeared or disappeared. |
| `style` | `property`, `before`, `after`, `cause` | A projected computed property changed. |
| `attr` | `attribute`, `before`, `after` | An attribute changed. |
| `text` | `before`, `after` | Text content changed. |
| `box` | `before`, `after`, `delta: {dx, dy, dw, dh}`, `cause` | The layout box moved or resized. |
| `paint-order` | `before`, `after` | Stacking changed — the node paints above or below different things now. |
| `contrast` | `before`, `after`, `crosses`, `foreground`, `background` | WCAG contrast ratio changed; `crosses` names the threshold (`"AA-normal"`, …) when one was crossed, else `null`. |

`cause` — on `style` and `box` changes — is `"primary"` or `"derived"`.
Primary: the node is a cause; its own styles changed, or it resized for
reasons of its own. Derived: a consequence; it only moved, or only resized to
fit a child, or the property merely tracks `color` via `currentColor`.
Filtering on `cause == "primary"` (or passing `--omit-derived`) is how you get
the terse view; nearly all diff noise is derived.

### Attributions

When both snapshots were captured with `--rules`, each primary change is
traced to the author declaration behind it:

```jsonc
{
  "state": "default",
  "key": "main>div>pay",
  "path": "html > body > main > div > button[data-testid=pay]",
  "unattributed": false,
  "causes": [{
    "property": "padding-top",
    "before": { "property": "padding", "value": "8px 16px",  "selector": ".btn",
                "source": { "url": "…/theme.css", "line": 3, "column": 2 }, /* … */ },
    "after":  { "property": "padding", "value": "20px 16px", "selector": ".btn",
                "source": { "url": "…/theme.css", "line": 3, "column": 2 }, /* … */ }
  }]
}
```

Each side of a cause is the declaration that **won the cascade** — importance,
origin, and inline style resolved the way Chromium resolves them, with
shorthands expanded and collapsed so one `padding` edit reads as one cause.
`source.line`/`column` are 1-based. `unattributed: true` means the node
changed but no declaration on it did — a longer label widened the button, a
rule stopped matching, or the cause is in a stylesheet qain did not capture;
qain says so rather than blaming an innocent rule. Attributions are keyed by
`(state, key)`: a `:hover` regression is explained by the cascade that was
active while `:hover` was forced, never by the resting one.
