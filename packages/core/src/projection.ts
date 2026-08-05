/**
 * The projection: which of Chromium's ~420 computed properties qain records.
 *
 * Two rules decide membership.
 *
 * 1. If the property's effect is already visible in the layout box, it is out.
 *    `margin`, `padding`, `width`, `height`, `top`, `inset`, `flex-basis` and
 *    friends all resolve into `bounds`, which qain captures anyway. Recording
 *    them again would report the same change twice — once as the cause and once
 *    as the effect — which is exactly the noise this tool exists to remove.
 *
 * 2. If a human would not notice it changing, it is out. `math-depth`,
 *    `forced-color-adjust`, `-webkit-locale`, `text-rendering`, and most of the
 *    font-synthesis family never reach the pixels in practice.
 *
 * The projection answers "what changed". Answering "why" needs the matched CSS
 * rules (CSS.getMatchedStylesForNode), which is where `padding` reappears as the
 * reason behind a box change — see rules.ts and explain.ts. That is a second query
 * against the one node that moved, not something worth carrying in every snapshot.
 */
export const DEFAULT_PROJECTION: readonly string[] = [
  // typography
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'line-height',
  'letter-spacing',
  'text-align',
  'text-transform',
  'text-decoration-line',
  'text-decoration-color',
  'white-space',
  'word-break',
  'text-overflow',

  // color
  'color',
  'background-color',
  'background-image',
  'opacity',

  // borders & decoration
  'border-top-color',
  'border-right-color',
  'border-bottom-color',
  'border-left-color',
  'border-top-width',
  'border-right-width',
  'border-bottom-width',
  'border-left-width',
  'border-top-style',
  'border-right-style',
  'border-bottom-style',
  'border-left-style',
  'border-top-left-radius',
  'border-top-right-radius',
  'border-bottom-left-radius',
  'border-bottom-right-radius',
  'box-shadow',
  'outline-color',
  'outline-width',
  'outline-style',

  // layout mode — the *cause* of box changes, not the box itself
  'display',
  'position',
  'float',
  'overflow-x',
  'overflow-y',
  'visibility',
  'z-index',
  'flex-direction',
  'flex-wrap',
  'justify-content',
  'align-items',
  'gap',
  'grid-template-columns',
  'grid-template-rows',

  // compositing
  'transform',
  'filter',
  'mix-blend-mode',
  'cursor',
]

/**
 * `transform-origin` belongs here by intuition and nowhere by rule 1: its
 * computed value resolves `50% 50%` against the element's own box, so it reads
 * `640px 143px` and changes whenever the box does. Including it made every
 * ancestor of a resized element look like a cause. `perspective-origin` and
 * `background-position` have the same shape. If you add a property and suddenly
 * every container is `primary`, this is why.
 */
export const BOX_DERIVED_PROPERTIES: readonly string[] = [
  'transform-origin',
  'perspective-origin',
  'background-position',
]

/**
 * Elements the renderer never lays out. A `<style>` element's text content
 * changes on every CSS edit, which would mark it — and by causality every
 * ancestor — as changed, on a node that has no pixels at all.
 */
export const NON_RENDERED_TAGS: ReadonlySet<string> = new Set([
  'HEAD',
  'META',
  'TITLE',
  'LINK',
  'BASE',
  'STYLE',
  'SCRIPT',
  'NOSCRIPT',
  'TEMPLATE',
])

/**
 * Properties that default to `currentColor`. When `color` changes, every one of
 * them reports the same change again. Six restatements of one fact is precisely
 * the noise this tool exists to remove, so the diff demotes them to `derived`
 * whenever their value tracks `color` on both sides.
 */
export const CURRENT_COLOR_PROPERTIES: ReadonlySet<string> = new Set([
  'border-top-color',
  'border-right-color',
  'border-bottom-color',
  'border-left-color',
  'outline-color',
  'text-decoration-color',
  'column-rule-color',
  'caret-color',
  'text-emphasis-color',
])

/**
 * Properties CSS inherits. When one changes on an ancestor, every descendant that
 * did not override it reports the identical change — one edit to `body` restating
 * itself once per node in the subtree. Same noise as `currentColor` above, arriving
 * by a different route, so the diff demotes them on the same terms: only when the
 * value matches an ancestor's change exactly, which an element with its own
 * declaration cannot do.
 *
 * Only the inherited members of `DEFAULT_PROJECTION` are listed. `text-decoration-line`
 * is not one of them — it propagates to in-flow descendants when it paints, but its
 * computed value does not inherit, so a child reports `none` either way.
 */
export const INHERITED_PROPERTIES: ReadonlySet<string> = new Set([
  'color',
  'cursor',
  'font-family',
  'font-size',
  'font-style',
  'font-weight',
  'letter-spacing',
  'line-height',
  'text-align',
  'text-transform',
  'visibility',
  'white-space',
  'word-break',
])

/**
 * Excluded from comparison, not from capture — you still see them in the
 * snapshot. `cursor` wobbles with pointer state; the box-derived properties are
 * here so that a custom projection that includes one of them by mistake still
 * produces a readable diff.
 */
export const DEFAULT_IGNORED_PROPERTIES: readonly string[] = ['cursor', ...BOX_DERIVED_PROPERTIES]

/**
 * Elements that can hold a pseudo-state worth capturing. Forcing :hover on a
 * <div> that has no :hover rule costs a CDP round-trip and yields nothing.
 */
export const DEFAULT_INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  'input',
  'select',
  'textarea',
  'summary',
  'details',
  'label',
  '[tabindex]',
  '[role="button"]',
  '[role="link"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="checkbox"]',
  '[role="switch"]',
].join(',')

/** Volatile or identity-irrelevant attributes, dropped from every snapshot. */
export const DEFAULT_EXCLUDED_ATTRIBUTES: readonly string[] = [
  'style',
  'nonce',
  'integrity',
  'srcset',
  'sizes',
  'loading',
  'decoding',
  'fetchpriority',
]

/**
 * `class` is captured but never compared by default. Tailwind and CSS Modules
 * both produce class strings that churn on every build while the rendered
 * result is identical — comparing them turns every release into a red diff.
 * The computed styles already tell you if the *rendering* changed.
 */
export const DEFAULT_IGNORED_ATTRIBUTES: readonly string[] = ['class']

/**
 * Projected properties that can move or resize a box.
 *
 * `color` cannot. Neither can `background-color`, `box-shadow` or `opacity`. So when
 * a node is recoloured *and* displaced by something else on the page, the displacement
 * is still collateral — the recolouring did not cause it. Without this distinction,
 * every element that changes colour inside a reflow gets promoted to a cause, and the
 * causes stop being the short list they are supposed to be.
 */
export const GEOMETRIC_PROPERTIES: ReadonlySet<string> = new Set([
  'display',
  'position',
  'float',
  'overflow-x',
  'overflow-y',
  'flex-direction',
  'flex-wrap',
  'justify-content',
  'align-items',
  'gap',
  'grid-template-columns',
  'grid-template-rows',
  'transform',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'line-height',
  'letter-spacing',
  'text-align',
  'text-transform',
  'white-space',
  'word-break',
  'border-top-width',
  'border-right-width',
  'border-bottom-width',
  'border-left-width',
])

/** Sub-pixel layout jitter, in CSS pixels, treated as no change. */
export const DEFAULT_BOX_TOLERANCE = 0.5
