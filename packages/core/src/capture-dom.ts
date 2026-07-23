/**
 * Capturing a snapshot from a live DOM, with no DevTools Protocol.
 *
 * `capture()` (capture.ts) is the real thing: it drives Chromium over CDP and
 * reads `DOMSnapshot.captureSnapshot`, which hands back used values, paint order
 * and composited backgrounds the browser computed for itself. None of that is
 * reachable from ordinary page script — there is no `getPaintOrder()`, and
 * `getComputedStyle` cannot force `:hover`.
 *
 * This module rebuilds the same {@link Snapshot} from what page script *can* see:
 * `getComputedStyle`, `getBoundingClientRect`, `Range` rectangles, and the CSSOM.
 * The pieces CDP would have given directly are reconstructed:
 *
 *   - **paint order / stacking contexts** — from the CSS properties that form a
 *     stacking context and the z-index of each, as a deterministic proxy (see
 *     {@link computePaintOrder}). Not pixel-exact CSS painting, but stable enough
 *     that a z-index or position change reorders it and nothing else does.
 *   - **composited background** — folded down the ancestor chain with the same
 *     source-over compositing the contrast math uses.
 *   - **forced pseudo-states** — by rewriting `:hover` and friends to a class and
 *     toggling that class, since there is no scriptable equivalent of
 *     `CSS.forcePseudoState`.
 *   - **`file:line` attribution** — by parsing the stylesheet source text the
 *     caller passes in, because the CSSOM does not expose source positions.
 *
 * Everything downstream — {@link diff}, {@link explain}, {@link renderReplayDiff},
 * {@link formatHtml} — is pure and consumes the {@link Snapshot} unchanged. This is
 * what lets qain run entirely in a browser tab: the playground renders two HTML
 * documents into iframes, captures each with this function, and diffs them with
 * exactly the same code the CLI runs over CDP.
 *
 * Chromium is still assumed. The projection, the computed-value serialisations and
 * the stacking rules are all Chromium's; running this in Firefox would compare a
 * page against itself consistently but would not match a CDP snapshot.
 */

import { composite, parseColor, type Rgba } from './contrast.js'
import { assignKeys, displayPath, type IdentityInput } from './identity.js'
import {
  DEFAULT_EXCLUDED_ATTRIBUTES,
  DEFAULT_INTERACTIVE_SELECTOR,
  DEFAULT_PROJECTION,
  NON_RENDERED_TAGS,
} from './projection.js'
import type { Declaration, RuleIndex, SourceLocation } from './rules.js'
import {
  type Box,
  type CapturedState,
  FORMAT_VERSION,
  type PseudoState,
  type QainNode,
  type Snapshot,
  type StateName,
  type TextRun,
} from './types.js'

export interface CaptureDomOptions {
  /** Restrict the snapshot to this element and its subtree. Default: the whole document. */
  root?: Element
  /** Pseudo-states to force and capture, each as its own state. Default: none. */
  states?: readonly PseudoState[]
  /** Computed properties to record. Default: DEFAULT_PROJECTION. */
  projection?: readonly string[]
  /** Which elements are candidates for pseudo-state forcing. */
  interactiveSelector?: string
  excludeAttributes?: readonly string[]
  /** Record matched author rules so a later diff can name the declaration behind each change. */
  rules?: boolean
  /**
   * The stylesheet source, for `file:line` attribution. Pass the full HTML text
   * (inline `<style>` blocks are located within it) or a single stylesheet's CSS.
   * Without it, `rules` still carry their selector but no source location.
   */
  source?: string
  /** The URL to record, and the filename attribution points at. Default: the document URL. */
  url?: string
  /** Also record per-line text rectangles, which `renderReplay` needs to rebuild the page. */
  replay?: boolean
}

const TEXT_NODE = 3

/** The dynamic pseudo-classes qain forces, longest first so the regex never splits `:focus-visible`. */
const FORCEABLE: readonly PseudoState[] = [
  'focus-visible',
  'focus-within',
  'focus',
  'hover',
  'active',
  'target',
]
const FORCE_CLASS = (state: string) => `qain-force-${state}`
const PSEUDO_PATTERN = new RegExp(`:(${FORCEABLE.join('|')})(?![\\w-])`, 'g')

/** Rewrite `.btn:hover .x` to `.btn.qain-force-hover .x`, which a class toggle can then match. */
function toMatchSelector(selector: string): string {
  return selector.replace(PSEUDO_PATTERN, (_m, name: string) => `.${FORCE_CLASS(name)}`)
}

// ---------------------------------------------------------------------------

export function captureDom(doc: Document, options: CaptureDomOptions = {}): Snapshot {
  const win = doc.defaultView
  if (!win) throw new Error('qain: captureDom needs a document with a live window')

  const projection = [...(options.projection ?? DEFAULT_PROJECTION)]
  const excluded = new Set(options.excludeAttributes ?? DEFAULT_EXCLUDED_ATTRIBUTES)
  const states = options.states ?? []
  const rootEl = options.root ?? doc.documentElement
  const url = options.url ?? doc.URL
  const warnings: string[] = []

  const parsedRules =
    options.rules && options.source !== undefined
      ? parseStylesheetSource(options.source, url)
      : options.rules
        ? rulesFromCssom(doc, url, warnings)
        : null

  const forcing = states.length > 0 ? installForcing(doc, parsedRules) : null

  const ctx: WalkContext = {
    doc,
    win,
    projection,
    excluded,
    replay: !!options.replay,
    parsedRules,
    scratch: doc.createElement('div'),
  }

  const captured: CapturedState[] = [walk(rootEl, 'default', ctx)]

  if (states.length > 0) {
    const candidates = Array.from(
      rootEl.querySelectorAll(options.interactiveSelector ?? DEFAULT_INTERACTIVE_SELECTOR),
    )
    if (candidates.length === 0) {
      warnings.push(
        `no elements matched the interactive selector, so states [${states.join(', ')}] captured nothing`,
      )
    }
    for (const state of states) {
      const klass = FORCE_CLASS(state)
      for (const el of candidates) el.classList.add(klass)
      const result = walk(rootEl, state, ctx)
      // Keep only the forced subtrees, mirroring CDP capture: an unforced node's
      // resting styles already live in the default state.
      result.nodes = result.nodes.filter((node) =>
        candidates.some((c) => within(c, node, ctx.elByKey)),
      )
      if (result.rules) result.rules = pick(result.rules, result.nodes)
      captured.push(result)
      for (const el of candidates) el.classList.remove(klass)
    }
  }

  forcing?.remove()

  return {
    qain: FORMAT_VERSION,
    url,
    title: doc.title,
    viewport: { width: rootEl.clientWidth || win.innerWidth, height: win.innerHeight },
    projection,
    states: captured,
    warnings,
  }
}

// ---------------------------------------------------------------------------
// The DOM walk
// ---------------------------------------------------------------------------

interface WalkContext {
  doc: Document
  win: Window
  projection: string[]
  excluded: Set<string>
  replay: boolean
  parsedRules: ParsedRule[] | null
  scratch: HTMLElement
  /** Filled per walk: key -> element, so state filtering can test ancestry. */
  elByKey?: Map<string, Element>
}

function walk(rootEl: Element, state: StateName, ctx: WalkContext): CapturedState {
  const { win } = ctx
  const scrollX = win.scrollX
  const scrollY = win.scrollY

  // Document order, dropping non-rendered subtrees. A parent is always seen before
  // its children, so a single forward pass can skip whole `display:none` trees.
  const elements: Element[] = []
  const parentOf: number[] = []
  const index = new Map<Element, number>()

  const visit = (el: Element, parentIndex: number): void => {
    const tag = el.tagName.toUpperCase()
    if (NON_RENDERED_TAGS.has(tag)) return
    const cs = win.getComputedStyle(el)
    if (cs.display === 'none') return

    const myIndex = elements.length
    elements.push(el)
    parentOf.push(parentIndex)
    index.set(el, myIndex)

    for (const child of Array.from(el.children)) visit(child, myIndex)
    // Pseudo-elements own their own layout and can differ; record ::before/::after.
    // (Kept after real children so a stable ordinal falls out of assignKeys.)
  }
  visit(rootEl, -1)

  const identities: IdentityInput[] = elements.map((el) => identityOf(el, ctx.win))
  const { keys, ordinals } = assignKeys(identities, parentOf)

  const paint = computePaintOrder(rootEl, win)
  const nodes: QainNode[] = []
  const elByKey = new Map<string, Element>()

  for (let i = 0; i < elements.length; i++) {
    const el = elements[i]!
    const cs = win.getComputedStyle(el)
    const rect = el.getBoundingClientRect()
    const box: Box | null =
      rect.width === 0 && rect.height === 0 && cs.position !== 'fixed'
        ? [round(rect.x + scrollX), round(rect.y + scrollY), round(rect.width), round(rect.height)]
        : [round(rect.x + scrollX), round(rect.y + scrollY), round(rect.width), round(rect.height)]

    const styles: Record<string, string> = {}
    for (const property of ctx.projection) styles[property] = cs.getPropertyValue(property).trim()

    const node: QainNode = {
      key: keys[i]!,
      path: displayPath(identities, parentOf, ordinals, i),
      tag: el.tagName.toLowerCase(),
      attrs: attributesOf(el, ctx.excluded),
      styles,
      box,
    }
    const parentIndex = parentOf[i]!
    if (parentIndex >= 0) node.parent = keys[parentIndex]!
    const identity = identities[i]!
    if (identity.role) node.role = identity.role
    if (identity.name) node.name = identity.name

    const paintInfo = paint.get(el)
    if (paintInfo) {
      node.paintOrder = paintInfo.order
      if (paintInfo.stackingContext) node.stackingContext = true
    }

    const text = directText(el)
    if (text) node.text = text

    const opacity = effectiveOpacity(el, rootEl, win)
    if (opacity !== 1) node.textOpacity = round(opacity)

    if (text) {
      const blended = blendedBackground(el, rootEl, win)
      if (blended) node.blendedBackground = blended
    }

    if (ctx.replay) {
      const runs = textRuns(el, ctx.doc, scrollX, scrollY)
      if (runs.length > 0) node.textRuns = runs
    }

    elByKey.set(node.key, el)
    nodes.push(node)
  }

  ctx.elByKey = elByKey

  const captured: CapturedState = { state, nodes }
  if (state !== 'default') captured.strategy = 'bulk'
  if (ctx.parsedRules) {
    captured.rules = buildRuleIndex(ctx.parsedRules, elements, keys, ctx.scratch)
  }
  return captured
}

/** True when `node` is `ancestor` or sits inside it — used to keep only forced subtrees. */
function within(ancestor: Element, node: QainNode, elByKey?: Map<string, Element>): boolean {
  const el = elByKey?.get(node.key)
  return el ? ancestor === el || ancestor.contains(el) : false
}

function pick(rules: RuleIndex, nodes: QainNode[]): RuleIndex {
  const keep: RuleIndex = {}
  const wanted = new Set(nodes.map((n) => n.key))
  for (const [key, declarations] of Object.entries(rules)) {
    if (wanted.has(key)) keep[key] = declarations
  }
  return keep
}

// ---------------------------------------------------------------------------
// Node facts
// ---------------------------------------------------------------------------

function attributesOf(el: Element, excluded: Set<string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const attr of Array.from(el.attributes)) {
    if (!excluded.has(attr.name)) out[attr.name] = attr.value
  }
  return out
}

/** The element's own text, direct children only, whitespace collapsed. */
function directText(el: Element): string | undefined {
  const parts: string[] = []
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === TEXT_NODE) parts.push(child.nodeValue ?? '')
  }
  const text = parts.join('').replace(/\s+/g, ' ').trim()
  return text.length > 0 ? text : undefined
}

/**
 * A light accessibility approximation. The real capture reads Chromium's AX tree;
 * here the role comes from an explicit `role` or a small tag map, and the name from
 * `aria-label` or the element's own text. It only sharpens identity keys — a wrong
 * guess just falls back to the tag ordinal, which is what happens without it anyway.
 */
function identityOf(el: Element, _win: Window): IdentityInput {
  const attrs: Record<string, string> = {}
  for (const attr of Array.from(el.attributes)) attrs[attr.name] = attr.value

  const role = attrs.role || implicitRole(el)
  const name =
    attrs['aria-label'] ||
    (role && NAMED_FROM_TEXT.has(role) ? directText(el) : undefined) ||
    attrs.alt ||
    undefined

  const identity: IdentityInput = { tag: el.tagName.toLowerCase(), attrs }
  if (role) identity.role = role
  if (name) identity.name = name
  return identity
}

const NAMED_FROM_TEXT = new Set(['button', 'link', 'heading', 'tab', 'menuitem'])

function implicitRole(el: Element): string | undefined {
  const tag = el.tagName.toLowerCase()
  switch (tag) {
    case 'button':
      return 'button'
    case 'a':
      return el.hasAttribute('href') ? 'link' : undefined
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      return 'heading'
    case 'nav':
      return 'navigation'
    case 'main':
      return 'main'
    case 'header':
      return 'banner'
    case 'footer':
      return 'contentinfo'
    case 'input': {
      const type = (el.getAttribute('type') || 'text').toLowerCase()
      if (type === 'checkbox') return 'checkbox'
      if (type === 'radio') return 'radio'
      if (type === 'button' || type === 'submit') return 'button'
      return 'textbox'
    }
    case 'select':
      return 'combobox'
    case 'textarea':
      return 'textbox'
    case 'img':
      return 'img'
    default:
      return undefined
  }
}

/** Product of `opacity` from the node up to (and including) the capture root. */
function effectiveOpacity(el: Element, root: Element, win: Window): number {
  let opacity = 1
  let cursor: Element | null = el
  while (cursor) {
    const value = Number.parseFloat(win.getComputedStyle(cursor).opacity)
    if (Number.isFinite(value)) opacity *= value
    if (cursor === root) break
    cursor = cursor.parentElement
  }
  return opacity
}

/**
 * The colour behind the text, composited down the ancestor chain — the same value
 * CDP returns as `blendedBackgroundColors`. Backgrounds paint far-to-near, so the
 * fold starts at the root (bottom) and lays each nearer ancestor over it. Only flat
 * `background-color` is considered; gradients and images are treated as transparent,
 * which is the same simplification the replay makes.
 */
function blendedBackground(el: Element, root: Element, win: Window): string | undefined {
  const chain: Element[] = []
  let cursor: Element | null = el
  while (cursor) {
    chain.push(cursor)
    if (cursor === root) break
    cursor = cursor.parentElement
  }

  let base: Rgba = { r: 255, g: 255, b: 255, a: 1 }
  let sawColor = false
  for (let i = chain.length - 1; i >= 0; i--) {
    const bg = parseColor(win.getComputedStyle(chain[i]!).backgroundColor)
    if (!bg || bg.a === 0) continue
    sawColor = true
    base = composite(bg, base)
  }
  if (!sawColor) return undefined
  return `rgb(${Math.round(base.r)}, ${Math.round(base.g)}, ${Math.round(base.b)})`
}

/**
 * Per-line text rectangles, in document coordinates. Each direct text node is
 * scanned character by character; runs break where the line box's top changes, so
 * wrapped text replays with the browser's own line breaks. Collapsed whitespace,
 * which renders nothing, is dropped.
 */
function textRuns(el: Element, doc: Document, scrollX: number, scrollY: number): TextRun[] {
  const runs: TextRun[] = []
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType !== TEXT_NODE) continue
    const value = child.nodeValue ?? ''
    if (value.trim().length === 0) continue

    const range = doc.createRange()
    let run: { top: number; left: number; right: number; bottom: number; text: string } | null =
      null

    const flush = () => {
      if (run && run.text.trim().length > 0) {
        runs.push({
          box: [
            round(run.left + scrollX),
            round(run.top + scrollY),
            round(run.right - run.left),
            round(run.bottom - run.top),
          ],
          text: run.text,
        })
      }
      run = null
    }

    for (let i = 0; i < value.length; i++) {
      range.setStart(child, i)
      range.setEnd(child, i + 1)
      const rect = range.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) {
        // A collapsed space between words: keep it in the current run's text if the
        // run is open, so words stay separated, but it starts no run of its own.
        if (run) run.text += value[i]
        continue
      }
      if (!run || Math.abs(rect.top - run.top) > 0.5) {
        flush()
        run = {
          top: rect.top,
          left: rect.left,
          right: rect.right,
          bottom: rect.bottom,
          text: value[i]!,
        }
      } else {
        run.right = Math.max(run.right, rect.right)
        run.bottom = Math.max(run.bottom, rect.bottom)
        run.top = Math.min(run.top, rect.top)
        run.text += value[i]
      }
    }
    flush()
    range.detach()
  }
  return runs
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}

// ---------------------------------------------------------------------------
// Paint order & stacking contexts
// ---------------------------------------------------------------------------

interface PaintInfo {
  order: number
  stackingContext: boolean
}

/**
 * A deterministic stand-in for CDP's paint order. Real CSS painting (CSS 2.1
 * Appendix E) is not scriptable, but its observable consequence — that changing a
 * z-index, position or opacity moves an element in front of or behind a sibling —
 * is what a diff needs to see. Children are visited in "stacking layer" order,
 * assigning an increasing counter, so:
 *
 *   - a stacking context with `z-index: 2` lands after one with `z-index: 0`;
 *   - dropping that to `0` moves it earlier, and its counter changes;
 *   - identical structure yields identical counters on both sides, so nothing that
 *     did not restack produces a paint-order diff.
 *
 * It is not the browser's real paint index, and it does not model floats or the
 * block-vs-inline split. It models the one thing the diff reports on: restacking.
 */
function computePaintOrder(root: Element, win: Window): Map<Element, PaintInfo> {
  const out = new Map<Element, PaintInfo>()
  let counter = 0

  const layerOf = (el: Element, isRoot: boolean): { layer: number; sc: boolean } => {
    const cs = win.getComputedStyle(el)
    const sc = isStackingContext(el, cs, isRoot, win)
    if (!sc) {
      // In-flow content sits below positioned content; positioned-but-not-a-context
      // paints in the z-auto band with z:0 contexts.
      return { layer: cs.position === 'static' ? 0 : 3, sc: false }
    }
    const z = zIndexOf(cs)
    // Bands: negative contexts < in-flow < (z-auto / z:0) < positive contexts.
    if (z < 0) return { layer: -1, sc: true }
    if (z === 0) return { layer: 3, sc: true }
    return { layer: 4, sc: true }
  }

  const paint = (el: Element, isRoot: boolean): void => {
    const info = layerOf(el, isRoot)
    out.set(el, { order: counter++, stackingContext: info.sc })

    const children = Array.from(el.children).filter((c) => {
      const cs = win.getComputedStyle(c)
      return !NON_RENDERED_TAGS.has(c.tagName.toUpperCase()) && cs.display !== 'none'
    })
    const decorated = children.map((child, i) => ({
      child,
      ...layerOf(child, false),
      z: zIndexOf(win.getComputedStyle(child)),
      order: i,
    }))
    decorated.sort((a, b) => a.layer - b.layer || a.z - b.z || a.order - b.order)
    for (const { child } of decorated) paint(child, false)
  }

  paint(root, true)
  return out
}

function zIndexOf(cs: CSSStyleDeclaration): number {
  const z = Number.parseInt(cs.zIndex, 10)
  return Number.isNaN(z) ? 0 : z
}

function isStackingContext(
  el: Element,
  cs: CSSStyleDeclaration,
  isRoot: boolean,
  win: Window,
): boolean {
  if (isRoot) return true
  if (cs.position === 'fixed' || cs.position === 'sticky') return true

  const zAuto = cs.zIndex === 'auto'
  if (cs.position !== 'static' && !zAuto) return true
  if (!zAuto) {
    const parent = el.parentElement
    if (parent && /flex|grid/.test(win.getComputedStyle(parent).display)) return true
  }

  if (Number.parseFloat(cs.opacity) < 1) return true
  if (cs.transform && cs.transform !== 'none') return true
  if (cs.filter && cs.filter !== 'none') return true
  if (cs.perspective && cs.perspective !== 'none') return true
  if (cs.clipPath && cs.clipPath !== 'none') return true
  if (cs.mixBlendMode && cs.mixBlendMode !== 'normal') return true
  if (cs.isolation === 'isolate') return true
  const willChange = cs.willChange || ''
  if (/transform|opacity|filter|perspective/.test(willChange)) return true
  const contain = cs.contain || ''
  if (/paint|layout|strict|content/.test(contain)) return true
  return false
}

// ---------------------------------------------------------------------------
// Rules & attribution
// ---------------------------------------------------------------------------

interface ParsedDecl {
  property: string
  value: string
  important: boolean
  source: SourceLocation | null
}

interface ParsedRule {
  /** The author's selector list, as written. */
  selector: string
  /** Rewritten so a forced pseudo-state matches via its class. */
  matchSelector: string
  decls: ParsedDecl[]
  /** Enclosing `@media`/`@supports` conditions; all must currently match. */
  conditions: string[]
}

/**
 * Match every parsed rule against every element, resolving longhands, and key the
 * result the way the snapshot is keyed. Selector matching is delegated to the live
 * DOM (`el.matches`), forced pseudo-states included, so nothing here re-implements
 * the cascade — only the source-position bookkeeping the CSSOM lacks.
 */
function buildRuleIndex(
  rules: ParsedRule[],
  elements: Element[],
  keys: string[],
  scratch: HTMLElement,
): RuleIndex {
  const win = scratch.ownerDocument.defaultView
  const index: RuleIndex = {}

  for (let e = 0; e < elements.length; e++) {
    const el = elements[e]!
    const key = keys[e]!
    const declarations: Declaration[] = []

    let order = 0
    for (const rule of rules) {
      if (rule.conditions.length > 0 && win) {
        if (!rule.conditions.every((c) => safeMatchMedia(win, c))) continue
      }
      if (!safeMatches(el, rule.matchSelector)) continue
      for (const decl of rule.decls) {
        declarations.push(...expand(scratch, decl, rule.selector, false, order))
      }
      order++
    }

    const inline = el.getAttribute('style')
    if (inline) {
      for (const decl of parseDeclarations(inline, 0, 0, null)) {
        declarations.push(...expand(scratch, decl, null, true, Number.MAX_SAFE_INTEGER))
      }
    }

    if (declarations.length > 0) index[key] = declarations
  }
  return index
}

function safeMatches(el: Element, selector: string): boolean {
  try {
    return el.matches(selector)
  } catch {
    return false
  }
}

function safeMatchMedia(win: Window, condition: string): boolean {
  try {
    return win.matchMedia(condition).matches
  } catch {
    return true
  }
}

/**
 * Expand one authored declaration into the longhands qain compares, leaning on the
 * browser's own shorthand expansion via a scratch element — the same expansion CDP
 * performs, so `padding: 8px 16px` becomes the four `padding-*` longhands here too.
 */
function expand(
  scratch: HTMLElement,
  decl: ParsedDecl,
  selector: string | null,
  inline: boolean,
  order: number,
): Declaration[] {
  scratch.style.cssText = ''
  try {
    scratch.style.setProperty(decl.property, decl.value, decl.important ? 'important' : '')
  } catch {
    // An invalid declaration the browser refuses: keep it verbatim, unexpanded.
  }

  const names = Array.from(scratch.style)
  const base = {
    origin: 'regular' as const,
    inline,
    selector,
    source: decl.source,
    order,
  }

  const isShorthand = names.length > 1 || (names.length === 1 && names[0] !== decl.property)
  if (names.length === 0 || !isShorthand) {
    return [{ ...base, property: decl.property, value: decl.value, important: decl.important }]
  }

  const shorthand = `${decl.property}: ${decl.value}`
  return names.map((name) => ({
    ...base,
    property: name,
    value: scratch.style.getPropertyValue(name),
    important: decl.important || scratch.style.getPropertyPriority(name) === 'important',
    shorthand,
  }))
}

/**
 * A small CSS parser, just enough for a self-contained page: comments, strings,
 * nested at-rules (`@media`/`@supports` recursed into, `@keyframes`/`@font-face`
 * skipped), and declarations with line/column. Positions are 1-indexed and absolute
 * in the source the caller passed, which for an inline `<style>` is the HTML file —
 * so attribution reads `page.html:21:3`, the way the CLI's does over CDP.
 */
function parseStylesheetSource(source: string, url: string): ParsedRule[] {
  const rules: ParsedRule[] = []
  // Inline <style> blocks: parse each at its true offset in the HTML. A bare
  // stylesheet (no <style>) is parsed whole from the top.
  const styleTag = /<style\b[^>]*>/gi
  let matched = false
  let m: RegExpExecArray | null
  // biome-ignore lint/suspicious/noAssignInExpressions: standard exec loop
  while ((m = styleTag.exec(source)) !== null) {
    matched = true
    const start = m.index + m[0].length
    const end = source.toLowerCase().indexOf('</style>', start)
    const css = source.slice(start, end === -1 ? undefined : end)
    const { line, column } = offsetToPosition(source, start)
    parseBlock(css, line, column, [], url, rules)
  }
  if (!matched) {
    parseBlock(source, 1, 1, [], url, rules)
  }
  return rules
}

/** Parse a run of CSS, appending style rules. `line`/`col` locate `css[0]` in the source. */
function parseBlock(
  css: string,
  startLine: number,
  startCol: number,
  conditions: string[],
  url: string,
  out: ParsedRule[],
): void {
  let i = 0
  const n = css.length
  const posAt = (offset: number) => advance(startLine, startCol, css, 0, offset)

  while (i < n) {
    // Skip whitespace and comments to the start of a prelude.
    let depthGuard = 0
    let prelude = ''
    while (i < n) {
      const c = css[i]!
      if (c === '/' && css[i + 1] === '*') {
        const close = css.indexOf('*/', i + 2)
        i = close === -1 ? n : close + 2
        continue
      }
      if (c === '{' || c === '}' || c === ';') break
      prelude += c
      i++
      if (++depthGuard > 1_000_000) break
    }
    const terminator = css[i]

    if (terminator === ';' || terminator === undefined || terminator === '}') {
      // An at-rule with no block (`@import …;`) or trailing junk: ignore it.
      i++
      continue
    }

    // terminator === '{' — a block. Find its matching close, tracking nesting.
    const blockStart = i + 1
    const blockEnd = matchingBrace(css, i)
    const inner = css.slice(blockStart, blockEnd)
    const trimmed = prelude.trim()

    if (trimmed.startsWith('@')) {
      const keyword = trimmed.slice(1).split(/[\s(]/, 1)[0]?.toLowerCase()
      if (keyword === 'media' || keyword === 'supports') {
        const condition = trimmed.slice(keyword.length + 1).trim()
        const pos = posAt(blockStart)
        parseBlock(inner, pos.line, pos.column, [...conditions, condition], url, out)
      }
      // @keyframes, @font-face, @page, … have no element selectors to attribute.
    } else if (trimmed.length > 0) {
      const pos = posAt(blockStart)
      const decls = parseDeclarations(inner, pos.line, pos.column, url)
      out.push({
        selector: trimmed.replace(/\s+/g, ' '),
        matchSelector: toMatchSelector(trimmed),
        decls,
        conditions,
      })
    }

    i = blockEnd + 1
  }
}

/** Split a declaration block into property/value pairs, each with its source position. */
function parseDeclarations(
  block: string,
  startLine: number,
  startCol: number,
  url: string | null,
): ParsedDecl[] {
  const decls: ParsedDecl[] = []
  let i = 0
  const n = block.length

  while (i < n) {
    const declStart = i
    let depth = 0
    let text = ''
    while (i < n) {
      const c = block[i]!
      if (c === '/' && block[i + 1] === '*') {
        const close = block.indexOf('*/', i + 2)
        i = close === -1 ? n : close + 2
        continue
      }
      if (c === '(') depth++
      else if (c === ')') depth = Math.max(0, depth - 1)
      else if (c === ';' && depth === 0) break
      else if (c === '{' || c === '}') break
      text += c
      i++
    }
    i++ // consume the ';'

    const colon = text.indexOf(':')
    if (colon === -1) continue
    const property = text.slice(0, colon).trim().toLowerCase()
    let value = text.slice(colon + 1).trim()
    if (!property || !value) continue

    const important = /!\s*important\s*$/i.test(value)
    if (important) value = value.replace(/!\s*important\s*$/i, '').trim()

    const leading = text.length - text.trimStart().length
    const pos = advance(startLine, startCol, block, 0, declStart + leading)
    decls.push({
      property,
      value,
      important,
      source: url === null ? null : { url, line: pos.line, column: pos.column },
    })
  }
  return decls
}

/** Index of the `}` that closes the `{` at `open`, honouring nested braces, strings and comments. */
function matchingBrace(css: string, open: number): number {
  let depth = 0
  for (let i = open; i < css.length; i++) {
    const c = css[i]!
    if (c === '/' && css[i + 1] === '*') {
      const close = css.indexOf('*/', i + 2)
      i = close === -1 ? css.length : close + 1
      continue
    }
    if (c === '"' || c === "'") {
      i = skipString(css, i)
      continue
    }
    if (c === '{') depth++
    else if (c === '}' && --depth === 0) return i
  }
  return css.length
}

function skipString(css: string, quote: number): number {
  const q = css[quote]
  for (let i = quote + 1; i < css.length; i++) {
    if (css[i] === '\\') {
      i++
      continue
    }
    if (css[i] === q) return i
  }
  return css.length
}

/** Line/column (1-indexed) of `offset` within `text`, treating `\n` as the break. */
function offsetToPosition(text: string, offset: number): { line: number; column: number } {
  return advance(1, 1, text, 0, offset)
}

/** Walk `text` from `from` to `to`, updating a 1-indexed line/column cursor. */
function advance(
  line: number,
  column: number,
  text: string,
  from: number,
  to: number,
): { line: number; column: number } {
  let l = line
  let c = column
  for (let i = from; i < to && i < text.length; i++) {
    if (text[i] === '\n') {
      l++
      c = 1
    } else {
      c++
    }
  }
  return { line: l, column: c }
}

/**
 * Fallback for `rules: true` with no source text: read the CSSOM directly. Carries
 * selector, value and importance, but every source location is null — the CSSOM
 * does not expose line numbers.
 */
function rulesFromCssom(doc: Document, _url: string, warnings: string[]): ParsedRule[] {
  const rules: ParsedRule[] = []
  // Duck-typed rather than `instanceof`: `doc` may belong to a different realm (an
  // iframe), where the CSSOM constructors are not the ones in this module's scope.
  const collect = (list: CSSRuleList, conditions: string[]): void => {
    for (const rule of Array.from(list)) {
      const r = rule as CSSStyleRule & CSSMediaRule
      if (typeof r.selectorText === 'string') {
        const decls: ParsedDecl[] = []
        for (const property of Array.from(r.style)) {
          decls.push({
            property,
            value: r.style.getPropertyValue(property),
            important: r.style.getPropertyPriority(property) === 'important',
            source: null,
          })
        }
        rules.push({
          selector: r.selectorText,
          matchSelector: toMatchSelector(r.selectorText),
          decls,
          conditions,
        })
      } else if (r.cssRules && typeof r.conditionText === 'string') {
        collect(r.cssRules, [...conditions, r.conditionText])
      }
    }
  }
  for (const sheet of Array.from(doc.styleSheets)) {
    try {
      collect(sheet.cssRules, [])
    } catch {
      warnings.push('a stylesheet was cross-origin, so its rules carry no attribution')
    }
  }
  return rules
}

// ---------------------------------------------------------------------------
// Pseudo-state forcing
// ---------------------------------------------------------------------------

interface Forcing {
  remove(): void
}

/**
 * There is no scriptable `CSS.forcePseudoState`, so qain forges one: every rule
 * whose selector uses a forceable pseudo-class is re-emitted with that pseudo
 * rewritten to a `.qain-force-*` class, appended after the author's styles so it
 * wins ties. Adding the class to an element then forces exactly that state, with
 * the real cascade — combinators, specificity and all — doing the rest.
 *
 * Built from the parsed source when it is available (so nothing here depends on
 * the CSSOM belonging to this realm); otherwise from a duck-typed read of the live
 * stylesheets, which tolerates `doc` being an iframe from another realm.
 */
function installForcing(doc: Document, parsed: ParsedRule[] | null): Forcing {
  const pieces: string[] = []
  const emit = (matchSelector: string, body: string, conditions: string[]) => {
    const rule = `${matchSelector}{${body}}`
    pieces.push(conditions.length > 0 ? `@media ${conditions.join(' and ')}{${rule}}` : rule)
  }

  if (parsed) {
    for (const rule of parsed) {
      if (rule.matchSelector === rule.selector) continue // no forceable pseudo
      const body = rule.decls
        .map((d) => `${d.property}:${d.value}${d.important ? ' !important' : ''}`)
        .join(';')
      emit(rule.matchSelector, body, rule.conditions)
    }
  } else {
    const collect = (list: CSSRuleList, conditions: string[]): void => {
      for (const rule of Array.from(list)) {
        const r = rule as CSSStyleRule & CSSMediaRule
        if (typeof r.selectorText === 'string') {
          const match = toMatchSelector(r.selectorText)
          if (match !== r.selectorText) emit(match, r.style.cssText, conditions)
        } else if (r.cssRules && typeof r.conditionText === 'string') {
          collect(r.cssRules, [...conditions, r.conditionText])
        }
      }
    }
    for (const sheet of Array.from(doc.styleSheets)) {
      try {
        collect(sheet.cssRules, [])
      } catch {
        // Cross-origin sheet: its pseudo-states cannot be forced. The default state
        // is still captured correctly.
      }
    }
  }

  const style = doc.createElement('style')
  style.setAttribute('data-qain-forcing', '')
  style.textContent = pieces.join('\n')
  doc.head.appendChild(style)
  return { remove: () => style.remove() }
}
