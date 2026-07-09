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
 * What it does not reproduce:
 *
 *   - **Rotations and skews.** `bounds` is post-transform but axis-aligned, so a
 *     rotated element replays as its bounding box. `transform` is recorded, but
 *     re-applying it would move the box twice.
 *   - **Anything qain did not project.** Gradients, backdrop filters, clip paths.
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
}

/** Element properties worth replaying. Typography is applied to the text runs. */
const BOX_STYLES: readonly string[] = [
  'background-color',
  'background-image',
  'opacity',
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
    if (!node.box || node.box[2] <= 0 || node.box[3] <= 0) {
      // No layout box: display:none, or an element the renderer skipped. Still
      // draw its text runs if it somehow has them.
      parts.push(...runsHtml(node, causeByKey.get(node.key)))
      continue
    }

    width = Math.max(width, node.box[0] + node.box[2])
    height = Math.max(height, node.box[1] + node.box[3])

    parts.push(boxHtml(node, causeByKey.get(node.key)))
    parts.push(...runsHtml(node, causeByKey.get(node.key)))
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

function boxHtml(node: QainNode, cause: 'primary' | 'derived' | undefined): string {
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

function runsHtml(node: QainNode, cause: 'primary' | 'derived' | undefined): string[] {
  if (!node.textRuns) return []

  const shared: string[] = []
  for (const property of RUN_STYLES) {
    const value = node.styles[property]
    if (value && value !== 'none') shared.push(`${property}:${value}`)
  }
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
    return `<span class="t${cause ? ` c-${cause}` : ''}" data-qain-key="${esc(node.key)}" style="${esc(declarations.join(';'))}">${esc(run.text)}</span>`
  })
}

function rect(box: Box): string[] {
  return [`left:${box[0]}px`, `top:${box[1]}px`, `width:${box[2]}px`, `height:${box[3]}px`]
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
      return `text changed`
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
  .scroll { overflow:auto; padding:1.5rem; }
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
  .flash { animation: flash .9s ease-out 2; }
  @keyframes flash { 0%,100% { outline-color:var(--primary) } 50% { outline-color:transparent } }
  aside { position:fixed; right:1rem; bottom:1rem; width:min(30rem, 42vw); max-height:40vh;
          overflow:auto; background:var(--panel); border:1px solid var(--line);
          border-radius:8px; padding:.75rem 1rem; box-shadow:0 4px 20px rgba(0,0,0,.18); }
  aside h2 { font-size:.8rem; margin:0 0 .5rem; text-transform:uppercase; letter-spacing:.06em; color:var(--dim); }
  aside h2 small { color:var(--fg); }
  aside ol { margin:0; padding-left:1.2rem; }
  aside li { cursor:pointer; padding:.15rem 0; }
  aside li:hover code { text-decoration:underline; }
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
const stages = document.querySelector('.stages');
const highlight = document.getElementById('highlight');
const apply = () => document.querySelectorAll('.stage').forEach(s => s.classList.toggle('hl', !highlight || highlight.checked));
highlight?.addEventListener('change', apply); apply();

document.querySelectorAll('aside li').forEach(li => li.addEventListener('click', () => {
  const key = li.dataset.jump;
  const targets = [...document.querySelectorAll('[data-qain-key]')].filter(n => n.dataset.qainKey === key);
  const last = targets[targets.length - 1];
  if (!last) return;
  last.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
  targets.forEach(t => { t.classList.remove('flash'); void t.offsetWidth; t.classList.add('flash'); });
}));
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
