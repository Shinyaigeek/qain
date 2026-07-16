import type { Box, Change, Diff, QainNode, Snapshot, StateName } from './types.js'

/**
 * Replay: rebuilding the page from the snapshot, so a human can look at it.
 *
 * The trick is that qain never re-runs layout. Every element is placed at the
 * exact rectangle Chromium gave it, and every *line* of text at the rectangle
 * Chromium gave that line. Nothing cascades, nothing reflows, nothing depends on
 * the viewport. The page cannot come out subtly different from what was recorded,
 * because none of the machinery that could make it differ is involved.
 *
 * This is also why the projection can omit `padding` and still replay it. A
 * button's text run sits eighteen pixels inside its border box; that offset *is*
 * the padding, already resolved. The same goes for margins, alignment, flex
 * distribution, and line breaking in wrapped paragraphs.
 *
 * The one thing flattening the tree costs is the effects that a parent has on its
 * whole subtree: an ancestor's `opacity` fades everything beneath it, an ancestor's
 * `overflow:hidden` clips it. Siblings inherit neither. Both are rebuilt from the
 * recorded `parent` chain — opacity as the product down the chain, clipping as the
 * intersection of every clipping ancestor's box — see effectiveOpacity and clipRegion.
 *
 * What it does not reproduce:
 *
 *   - **Rotations and skews.** `bounds` is post-transform but axis-aligned, so a
 *     rotated element replays as its bounding box. `transform` is recorded, but
 *     re-applying it would move the box twice.
 *   - **Anything qain did not project.** `background-size`/`-position`/`-repeat`,
 *     `text-shadow`, backdrop filters, clip paths — a positioned gradient replays
 *     at its default size, a text shadow not at all.
 *   - **A parent `filter`** (blur, drop-shadow). Like opacity it acts on the whole
 *     subtree, but unlike opacity there is no per-element value to fold down.
 *   - **Rounded clipping corners.** A clipping ancestor is applied as a rectangular
 *     inset, so a child clipped by a `border-radius`d parent keeps square corners.
 *   - **Group opacity as true compositing.** Ancestor opacity is folded into each
 *     element separately, which is exact until a *faded ancestor with its own
 *     background* sits behind a *faded child* — then the background tints through,
 *     where real group opacity would flatten the subtree first. Uniform fades and
 *     transparent-backed children (the common cases) are unaffected.
 *   - **Text shaping the run boxes cannot capture.** Ligatures across a line break,
 *     bidi reordering within a run.
 *
 * It is a faithful reconstruction of the geometry and the colour, not a screenshot.
 */

export interface ReplayOptions {
  /** Which captured state to draw. Defaults to 'default'. */
  state?: StateName
  /** Outline these nodes, distinguishing causes from collateral. */
  changes?: Change[]
  title?: string
  /**
   * Emit only the reconstruction itself — no header bar, padding or shadow.
   * This is what `qain shot` screenshots: two bare renders of the same page
   * must differ only where the page does.
   */
  bare?: boolean
}

/**
 * Element properties worth replaying. Typography is applied to the text runs.
 *
 * `opacity` is deliberately absent: replay flattens the tree into siblings, so an
 * element's own opacity is not enough — an ancestor's opacity must fade it too. It
 * is applied separately, as the product down the whole chain (see boxHtml).
 */
const BOX_STYLES: readonly string[] = [
  'background-color',
  'background-image',
  'visibility',
  'mix-blend-mode',
  'filter',
  'border-top-width',
  'border-right-width',
  'border-bottom-width',
  'border-left-width',
  'border-top-style',
  'border-right-style',
  'border-bottom-style',
  'border-left-style',
  'border-top-color',
  'border-right-color',
  'border-bottom-color',
  'border-left-color',
  'border-top-left-radius',
  'border-top-right-radius',
  'border-bottom-left-radius',
  'border-bottom-right-radius',
  'box-shadow',
  'outline-color',
  'outline-width',
  'outline-style',
]

const RUN_STYLES: readonly string[] = [
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'letter-spacing',
  'color',
  'text-decoration-line',
  'text-decoration-color',
]

/** The page itself, not an element in it. Its box covers everything and would occlude. */
const CHROME_TAGS = new Set(['html', 'body'])

// ---------------------------------------------------------------------------

export function renderReplay(snapshot: Snapshot, options: ReplayOptions = {}): string {
  const state = options.state ?? 'default'
  const stage = buildStage(snapshot, state, options.changes ?? [])
  const title = options.title ?? (snapshot.title || snapshot.url)

  if (options.bare) {
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>${esc(title)}</title>
${snapshot.url ? `<base href="${esc(snapshot.url)}">` : ''}
<style>
  * { box-sizing: border-box; }
  body { margin:0; background:#fff; }
  .stage { position:relative; overflow:hidden; }
  .stage .n, .stage .t { pointer-events:none; }
</style></head>
<body>${stage.html}</body></html>`
  }

  const states = snapshot.states.map((s) => s.state)
  const counts = countChanges(options.changes ?? [])

  return page(
    title,
    snapshot.url,
    `${bar([
      brand('qain view'),
      meta(snapshot.url),
      states.length > 1 ? stateSelect(states, state) : '',
      counts.total > 0 ? highlightToggle(counts) : '',
      zoomControl(),
    ])}
    <div class="scroll"><div class="stages">${stage.html}</div></div>
    ${counts.total > 0 ? changeList(options.changes ?? []) : ''}`,
    script(false),
  )
}

/**
 * Two reconstructions of the same page, side by side or stacked. The stacked mode
 * is the one that earns its keep: a four-pixel shift is invisible in two images
 * next to each other and obvious when you fade one into the other.
 */
export function renderReplayDiff(
  before: Snapshot,
  after: Snapshot,
  diff: Diff,
  options: { state?: StateName } = {},
): string {
  const state = options.state ?? 'default'
  const beforeStage = buildStage(before, state, [])
  const afterStage = buildStage(after, state, diff.changes)
  const counts = countChanges(diff.changes)

  const width = Math.max(beforeStage.width, afterStage.width)
  const height = Math.max(beforeStage.height, afterStage.height)
  const states = after.states.map((s) => s.state)

  return page(
    `qain — ${after.title || after.url}`,
    after.url,
    `${bar([
      brand('qain replay'),
      meta(`${counts.primary} primary · ${counts.derived} derived`),
      `<label>view
        <select id="mode">
          <option value="side">side by side</option>
          <option value="overlay">overlay</option>
        </select>
      </label>`,
      `<label class="fade" hidden>fade
        <input id="opacity" type="range" min="0" max="100" value="50">
      </label>`,
      states.length > 1 ? stateSelect(states, state) : '',
      highlightToggle(counts),
      zoomControl(),
    ])}
    <div class="scroll">
      <div class="stages" id="stages" style="--w:${width}px;--h:${height}px">
        <figure><figcaption>before</figcaption>${beforeStage.html}</figure>
        <figure><figcaption>after</figcaption>${afterStage.html}</figure>
      </div>
    </div>
    ${changeList(diff.changes)}`,
    script(true),
  )
}

// ---------------------------------------------------------------------------

interface Stage {
  html: string
  width: number
  height: number
}

function buildStage(snapshot: Snapshot, state: StateName, changes: Change[]): Stage {
  const nodes = nodesForState(snapshot, state)
  const byKey = new Map(nodes.map((n) => [n.key, n]))
  const causeByKey = new Map<string, 'primary' | 'derived'>()
  for (const change of changes) {
    if (change.state !== state) continue
    const cause = 'cause' in change ? change.cause : 'primary'
    // A node with any primary change is a cause, whatever else it also has.
    if (cause === 'primary' || !causeByKey.has(change.key)) causeByKey.set(change.key, cause)
  }

  let width = 0
  let height = 0
  const parts: string[] = []
  let background = '#fff'

  for (const node of nodes) {
    if (CHROME_TAGS.has(node.tag)) {
      const bg = node.styles['background-color']
      if (node.tag === 'body' && bg && bg !== 'rgba(0, 0, 0, 0)') background = bg
      if (node.box) {
        width = Math.max(width, node.box[0] + node.box[2])
        height = Math.max(height, node.box[1] + node.box[3])
      }
      continue
    }
    // Clipping ancestors and ancestor opacity both come from the tree the flat
    // stage threw away. Rebuild them from the recorded parent chain.
    const clip = clipRegion(node, byKey)
    if (!node.box || node.box[2] <= 0 || node.box[3] <= 0) {
      // No layout box: display:none, or an element the renderer skipped. Still
      // draw its text runs if it somehow has them.
      parts.push(...runsHtml(node, causeByKey.get(node.key), clip))
      continue
    }

    width = Math.max(width, node.box[0] + node.box[2])
    height = Math.max(height, node.box[1] + node.box[3])

    parts.push(boxHtml(node, causeByKey.get(node.key), effectiveOpacity(node, byKey), clip))
    parts.push(...runsHtml(node, causeByKey.get(node.key), clip))
  }

  return {
    html: `<div class="stage" style="width:${width}px;height:${height}px;background:${esc(background)}">${parts.join('')}</div>`,
    width,
    height,
  }
}

/**
 * A pseudo-state capture holds only the forced elements and their subtrees. Drawing
 * it alone would render three buttons on an empty page, so the default state is the
 * canvas and the pseudo-state overrides the nodes it covers.
 */
function nodesForState(snapshot: Snapshot, state: StateName): QainNode[] {
  const base = snapshot.states.find((s) => s.state === 'default')?.nodes ?? []
  if (state === 'default') return base

  const overrides = new Map(
    (snapshot.states.find((s) => s.state === state)?.nodes ?? []).map((n) => [n.key, n]),
  )
  return base.map((node) => overrides.get(node.key) ?? node)
}

function boxHtml(
  node: QainNode,
  cause: 'primary' | 'derived' | undefined,
  opacity: number,
  clip: ClipRegion | null,
): string {
  const declarations: string[] = [
    'position:absolute',
    'box-sizing:border-box',
    ...rect(node.box!),
    `z-index:${(node.paintOrder ?? 0) * 2}`,
  ]
  for (const property of BOX_STYLES) {
    const value = node.styles[property]
    if (value && value !== 'none' && value !== 'normal') {
      declarations.push(`${property}:${value}`)
    }
  }
  // Own opacity times every ancestor's — the flat stage has no tree to inherit it.
  if (opacity < 1) declarations.push(`opacity:${round(opacity)}`)
  const inset = clipInset(node.box!, clip)
  if (inset) declarations.push(`clip-path:${inset}`)

  const attributes = [
    `class="n${cause ? ` c-${cause}` : ''}"`,
    `data-qain-key="${esc(node.key)}"`,
    `style="${esc(declarations.join(';'))}"`,
  ]

  if (node.tag === 'img' && node.attrs.src) {
    return `<img ${attributes.join(' ')} src="${esc(node.attrs.src)}" alt="${esc(node.attrs.alt ?? '')}">`
  }
  return `<div ${attributes.join(' ')}></div>`
}

function runsHtml(
  node: QainNode,
  cause: 'primary' | 'derived' | undefined,
  clip: ClipRegion | null,
): string[] {
  if (!node.textRuns) return []

  const shared: string[] = []
  for (const property of RUN_STYLES) {
    const value = node.styles[property]
    if (value && value !== 'none') shared.push(`${property}:${value}`)
  }
  // textOpacity is already the accumulated opacity of the text's paint — it folds
  // in every ancestor, so unlike the box it must not be multiplied again here.
  if (node.textOpacity !== undefined) shared.push(`opacity:${node.textOpacity}`)

  return node.textRuns.map((run) => {
    const declarations = [
      'position:absolute',
      ...rect(run.box),
      // The run box is exactly one line: its height is the line box.
      `line-height:${run.box[3]}px`,
      'white-space:pre',
      // The recorded text is post-`text-transform`; applying it again would shout.
      'text-transform:none',
      `z-index:${(node.paintOrder ?? 0) * 2 + 1}`,
      ...shared,
    ]
    const inset = clipInset(run.box, clip)
    if (inset) declarations.push(`clip-path:${inset}`)
    return `<span class="t${cause ? ` c-${cause}` : ''}" data-qain-key="${esc(node.key)}" style="${esc(declarations.join(';'))}">${esc(run.text)}</span>`
  })
}

function rect(box: Box): string[] {
  return [`left:${box[0]}px`, `top:${box[1]}px`, `width:${box[2]}px`, `height:${box[3]}px`]
}

/**
 * The stage is flat: every box is a sibling, so a parent's opacity and a parent's
 * `overflow:hidden` — both of which act on a subtree — are gone. These two helpers
 * put them back by walking the recorded `parent` chain.
 */

/** The product of this node's opacity and all its ancestors'. */
function effectiveOpacity(node: QainNode, byKey: Map<string, QainNode>): number {
  let opacity = 1
  for (let cur: QainNode | undefined = node; cur; cur = ancestor(cur, byKey)) {
    const value = cur.styles.opacity
    if (value) {
      const parsed = Number.parseFloat(value)
      if (!Number.isNaN(parsed)) opacity *= parsed
    }
  }
  return opacity
}

/** A clip rectangle in stage coordinates, or null when nothing above clips. */
type ClipRegion = { minX: number; minY: number; maxX: number; maxY: number }

// overflow other than `visible` clips the descendant flow. `scroll`/`auto` clip too;
// the recorded boxes already sit at the scrolled position, so clipping to the
// container's box reproduces exactly what was on screen when the snapshot was taken.
const CLIPPING_OVERFLOW = new Set(['hidden', 'clip', 'scroll', 'auto'])

function clipRegion(node: QainNode, byKey: Map<string, QainNode>): ClipRegion | null {
  let region: ClipRegion | null = null
  // Start from the parent: an element's own overflow clips its children, not itself.
  for (let cur = ancestor(node, byKey); cur; cur = ancestor(cur, byKey)) {
    if (!cur.box) continue
    const [x, y, w, h] = cur.box
    if (CLIPPING_OVERFLOW.has(cur.styles['overflow-x'] ?? '')) {
      region ??= {
        minX: Number.NEGATIVE_INFINITY,
        minY: Number.NEGATIVE_INFINITY,
        maxX: Number.POSITIVE_INFINITY,
        maxY: Number.POSITIVE_INFINITY,
      }
      region.minX = Math.max(region.minX, x)
      region.maxX = Math.min(region.maxX, x + w)
    }
    if (CLIPPING_OVERFLOW.has(cur.styles['overflow-y'] ?? '')) {
      region ??= {
        minX: Number.NEGATIVE_INFINITY,
        minY: Number.NEGATIVE_INFINITY,
        maxX: Number.POSITIVE_INFINITY,
        maxY: Number.POSITIVE_INFINITY,
      }
      region.minY = Math.max(region.minY, y)
      region.maxY = Math.min(region.maxY, y + h)
    }
  }
  return region
}

/**
 * `clip-path: inset()` for an element at `box`, so the clip region shows through
 * and everything outside it is cut. Insets are relative to the element's own border
 * box; an axis the region does not constrain stays at its infinite bound and clamps
 * to a zero inset. Returns undefined when there is nothing to clip.
 */
function clipInset(box: Box, clip: ClipRegion | null): string | undefined {
  if (!clip) return undefined
  const [x, y, w, h] = box
  const top = Math.max(0, clip.minY - y)
  const left = Math.max(0, clip.minX - x)
  const right = Math.max(0, x + w - clip.maxX)
  const bottom = Math.max(0, y + h - clip.maxY)
  if (top === 0 && left === 0 && right === 0 && bottom === 0) return undefined
  return `inset(${round(top)}px ${round(right)}px ${round(bottom)}px ${round(left)}px)`
}

function ancestor(node: QainNode, byKey: Map<string, QainNode>): QainNode | undefined {
  return node.parent ? byKey.get(node.parent) : undefined
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

// ---------------------------------------------------------------------------

function countChanges(changes: Change[]) {
  let primary = 0
  let derived = 0
  for (const change of changes) {
    if ('cause' in change && change.cause === 'derived') derived++
    else primary++
  }
  return { primary, derived, total: primary + derived }
}

function changeList(changes: Change[]): string {
  const primary = changes.filter((c) => !('cause' in c) || c.cause === 'primary')
  if (primary.length === 0) return ''

  const items = primary
    .map(
      (change) =>
        `<li data-jump="${esc(change.key)}"><code>${esc(change.path)}</code><span>${esc(summarise(change))}</span></li>`,
    )
    .join('')
  return `<aside><h2>Causes <small>${primary.length}</small></h2><ol>${items}</ol></aside>`
}

function summarise(change: Change): string {
  switch (change.kind) {
    case 'style':
      return `${change.property}: ${change.before ?? '—'} → ${change.after ?? '—'}`
    case 'box': {
      const { dx, dy, dw, dh } = change.delta
      const parts: string[] = []
      if (dx || dy) parts.push(`moved ${dx}, ${dy}`)
      if (dw || dh) parts.push(`resized ${dw} × ${dh}`)
      return parts.join('; ') || 'box changed'
    }
    case 'contrast':
      return `contrast ${change.before} → ${change.after}${change.crosses ? ` · below WCAG ${change.crosses}` : ''}`
    case 'paint-order':
      return `paint order ${change.before} → ${change.after}`
    case 'added':
      return `added <${change.node.tag}>`
    case 'removed':
      return `removed <${change.node.tag}>`
    case 'attr':
      return `[${change.attribute}] ${change.before ?? '—'} → ${change.after ?? '—'}`
    case 'text':
      return 'text changed'
  }
}

const brand = (text: string) => `<strong>${esc(text)}</strong>`
const meta = (text: string) => `<span class="meta">${esc(text)}</span>`
const bar = (children: string[]) => `<header>${children.filter(Boolean).join('')}</header>`

const stateSelect = (states: StateName[], current: StateName) =>
  `<label>state <select id="state">${states
    .map((s) => `<option${s === current ? ' selected' : ''}>${esc(s)}</option>`)
    .join('')}</select></label>`

const highlightToggle = (counts: { primary: number; derived: number }) =>
  `<label class="toggle"><input id="highlight" type="checkbox" checked> highlight
     <i class="swatch p"></i>${counts.primary}
     <i class="swatch d"></i>${counts.derived}
   </label>`

const zoomControl = () =>
  `<div class="zoom" role="group" aria-label="zoom">
     <button type="button" data-zoom="out" title="zoom out (⌘/Ctrl + scroll)">−</button>
     <output id="zoomLevel">100%</output>
     <button type="button" data-zoom="in" title="zoom in (⌘/Ctrl + scroll)">+</button>
     <button type="button" data-zoom="reset" title="reset zoom">reset</button>
   </div>`

function page(title: string, base: string, body: string, tail: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>${esc(title)}</title>
${base ? `<base href="${esc(base)}">` : ''}
<style>
  :root { color-scheme: light dark; --bg:#f6f7f9; --fg:#111; --dim:#666; --line:#e2e2e2;
          --panel:#fff; --primary:#e11d48; --derived:#94a3b8; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#0d0d0f; --fg:#eee; --dim:#999; --line:#2a2a2a; --panel:#17171a; }
  }
  * { box-sizing: border-box; }
  body { margin:0; display:grid; grid-template-rows:auto 1fr; height:100vh;
         background:var(--bg); color:var(--fg);
         font:13px/1.5 ui-sans-serif, system-ui, sans-serif; }
  header { display:flex; gap:1rem; align-items:center; flex-wrap:wrap;
           padding:.6rem 1rem; border-bottom:1px solid var(--line); background:var(--panel); }
  header .meta { color:var(--dim); font:11px/1.4 ui-monospace, monospace;
                 max-width:38ch; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  header label { display:flex; gap:.4rem; align-items:center; color:var(--dim); }
  .toggle .swatch { display:inline-block; width:.7em; height:.7em; border-radius:2px; margin:0 .2em 0 .5em; }
  .swatch.p { background:var(--primary); } .swatch.d { background:var(--derived); }
  .zoom { display:flex; align-items:center; gap:.15rem; }
  .zoom button { font:12px ui-monospace, monospace; line-height:1; padding:.25rem .5rem;
                 border:1px solid var(--line); border-radius:4px; background:var(--panel);
                 color:var(--fg); cursor:pointer; }
  .zoom button:hover { border-color:var(--primary); }
  .zoom output { min-width:3.8ch; text-align:center; color:var(--dim);
                 font:11px ui-monospace, monospace; }
  /* Drag the canvas to pan; the boxes stay click-through so the drag lands here. */
  .scroll { overflow:auto; padding:1.5rem; cursor:grab; }
  .scroll.panning { cursor:grabbing; user-select:none; }
  .stages { display:flex; gap:1.5rem; align-items:flex-start; }
  .stages.overlay { display:grid; }
  .stages.overlay figure { grid-area:1/1; }
  .stages.overlay figcaption { display:none; }
  figure { margin:0; }
  figcaption { color:var(--dim); margin-bottom:.4rem; font:11px ui-monospace, monospace; }
  .stage { position:relative; overflow:hidden; flex:none;
           box-shadow:0 1px 3px rgba(0,0,0,.15); }
  .stage .n, .stage .t { pointer-events:none; }
  /* Outlines sit outside the box so they never shift what they mark. */
  .hl .c-primary { outline:2px solid var(--primary); outline-offset:1px; }
  .hl .c-derived { outline:1px dashed var(--derived); }
  /* Only the marked boxes take the pointer, so clicks select them and empty
     space still drags. Must come after the pointer-events:none rule above. */
  .hl .c-primary, .hl .c-derived { pointer-events:auto; cursor:pointer; }
  /* A clicked change is spotlit: a double ring, lifted above everything. */
  .stage .selected { outline:3px solid var(--primary) !important; outline-offset:2px !important;
    box-shadow:0 0 0 3px var(--bg), 0 0 0 6px var(--primary), 0 6px 22px rgba(0,0,0,.45) !important;
    z-index:2147483647 !important; }
  .flash { animation: flash .9s ease-out 2; }
  @keyframes flash { 0%,100% { outline-color:var(--primary) } 50% { outline-color:transparent } }
  aside { position:fixed; right:1rem; bottom:1rem; width:min(30rem, 42vw); max-height:40vh;
          overflow:auto; background:var(--panel); border:1px solid var(--line);
          border-radius:8px; padding:.75rem 1rem; box-shadow:0 4px 20px rgba(0,0,0,.18); }
  aside h2 { font-size:.8rem; margin:0 0 .5rem; text-transform:uppercase; letter-spacing:.06em; color:var(--dim); }
  aside h2 small { color:var(--fg); }
  aside ol { margin:0; padding-left:1.2rem; }
  aside li { cursor:pointer; padding:.15rem .35rem; margin:0 -.35rem; border-radius:4px; }
  aside li:hover code { text-decoration:underline; }
  aside li.active { background:color-mix(in srgb, var(--primary) 15%, transparent); }
  aside li.active code, aside li.active span { color:var(--fg); }
  aside code { font:11px ui-monospace, monospace; color:var(--dim); display:block;
               overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  aside span { font-size:12px; }
</style></head>
<body>${body}
<script>${tail}</script>
</body></html>`
}

function script(hasModes: boolean): string {
  return `
const scroll = document.querySelector('.scroll');
const stages = document.querySelector('.stages');
const highlight = document.getElementById('highlight');
const apply = () => document.querySelectorAll('.stage').forEach(s => s.classList.toggle('hl', !highlight || highlight.checked));
highlight?.addEventListener('change', apply); apply();

// Selection: click a change — in the canvas or the causes list — to spotlight it.
// A second argument keeps the two directions from scrolling each other around.
function select(key, fromList) {
  document.querySelectorAll('.stage .selected').forEach(n => n.classList.remove('selected'));
  document.querySelectorAll('aside li.active').forEach(li => li.classList.remove('active'));
  if (!key) return;
  const targets = [...document.querySelectorAll('[data-qain-key]')].filter(n => n.dataset.qainKey === key);
  targets.forEach(t => t.classList.add('selected'));
  const li = [...document.querySelectorAll('aside li')].find(li => li.dataset.jump === key);
  if (li) { li.classList.add('active'); if (fromList !== true) li.scrollIntoView({ block: 'nearest' }); }
  const last = targets[targets.length - 1];
  if (!last) return;
  last.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
  targets.forEach(t => { t.classList.remove('flash'); void t.offsetWidth; t.classList.add('flash'); });
}
document.querySelectorAll('aside li').forEach(li => li.addEventListener('click', () => select(li.dataset.jump, true)));
window.addEventListener('keydown', e => { if (e.key === 'Escape') select(null); });

// Zoom: the +/- buttons and ⌘/Ctrl + wheel, keeping the point under the cursor fixed.
let zoom = 1;
const zoomLabel = document.getElementById('zoomLevel');
function setZoom(next, cx, cy) {
  next = Math.min(5, Math.max(0.1, next));
  const rect = scroll.getBoundingClientRect();
  const px = cx == null ? rect.width / 2 : cx, py = cy == null ? rect.height / 2 : cy;
  const ax = (scroll.scrollLeft + px) / zoom, ay = (scroll.scrollTop + py) / zoom;
  zoom = next;
  stages.style.zoom = zoom;
  scroll.scrollLeft = ax * zoom - px;
  scroll.scrollTop = ay * zoom - py;
  if (zoomLabel) zoomLabel.textContent = Math.round(zoom * 100) + '%';
}
document.querySelectorAll('[data-zoom]').forEach(b => b.addEventListener('click', () => {
  const a = b.dataset.zoom;
  setZoom(a === 'reset' ? 1 : zoom * (a === 'in' ? 1.25 : 0.8));
}));
scroll.addEventListener('wheel', e => {
  if (!(e.ctrlKey || e.metaKey)) return;
  e.preventDefault();
  const rect = scroll.getBoundingClientRect();
  setZoom(zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e.clientX - rect.left, e.clientY - rect.top);
}, { passive: false });

// Pan: drag the canvas. A press that never moves is a click — select the box
// under it, or clear the selection when it lands on empty space.
let pan = null;
scroll.addEventListener('mousedown', e => {
  if (e.button !== 0) return;
  pan = { x: e.clientX, y: e.clientY, sl: scroll.scrollLeft, st: scroll.scrollTop, moved: false, target: e.target };
});
window.addEventListener('mousemove', e => {
  if (!pan) return;
  const dx = e.clientX - pan.x, dy = e.clientY - pan.y;
  if (!pan.moved && Math.hypot(dx, dy) < 4) return;
  pan.moved = true;
  scroll.classList.add('panning');
  scroll.scrollLeft = pan.sl - dx;
  scroll.scrollTop = pan.st - dy;
});
window.addEventListener('mouseup', () => {
  if (!pan) return;
  const { moved, target } = pan;
  pan = null;
  scroll.classList.remove('panning');
  if (moved) return;
  const el = target instanceof Element ? target.closest('[data-qain-key]') : null;
  select(el ? el.dataset.qainKey : null);
});
${
  hasModes
    ? `
const mode = document.getElementById('mode');
const fade = document.querySelector('.fade');
const opacity = document.getElementById('opacity');
const sync = () => {
  const overlay = mode.value === 'overlay';
  stages.classList.toggle('overlay', overlay);
  fade.hidden = !overlay;
  const after = stages.querySelectorAll('figure')[1];
  after.style.opacity = overlay ? opacity.value / 100 : 1;
};
mode.addEventListener('change', sync);
opacity.addEventListener('input', sync);
sync();`
    : ''
}`
}

function esc(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&quot;'
      default:
        return '&#39;'
    }
  })
}
