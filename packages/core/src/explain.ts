import { type Declaration, type RuleIndex, winner } from './rules.js'
import type { Change } from './types.js'

/**
 * Attribution: turning "this button grew 24px" into "`.btn` in base.html:5 changed
 * `padding` from `8px 16px` to `20px 16px`".
 *
 * The projection cannot do this on its own, and that is by design. `padding` is
 * excluded from every snapshot because its effect is already in the layout box, so
 * recording it would report each change twice. Attribution buys the information
 * back — but only for the few nodes that changed, and only from the matched rules,
 * where the *author's* declaration lives rather than its resolved consequence.
 */

export interface DeclarationChange {
  property: string
  /** The declaration that won the cascade before, and after. Either may be absent. */
  before: Declaration | null
  after: Declaration | null
}

export interface Attribution {
  key: string
  path: string
  causes: DeclarationChange[]
  /**
   * The node changed, but no author declaration on it did. Something else moved it,
   * a rule stopped matching, or the cause is in a stylesheet qain did not capture.
   */
  unattributed: boolean
}

/**
 * Longhands that feed the layout box. A `box` change reports no property, because
 * none of these are in the projection — so attribution has to try them all.
 */
const BOX_MODEL_PROPERTIES: readonly string[] = [
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'width',
  'height',
  'min-width',
  'max-width',
  'min-height',
  'max-height',
  'border-top-width',
  'border-right-width',
  'border-bottom-width',
  'border-left-width',
  'box-sizing',
  'row-gap',
  'column-gap',
  'flex-grow',
  'flex-shrink',
  'flex-basis',
  'flex-direction',
  'flex-wrap',
  'align-items',
  'justify-content',
  'top',
  'right',
  'bottom',
  'left',
  'position',
  'display',
  'font-size',
  'line-height',
  'letter-spacing',
  'white-space',
  'aspect-ratio',
  'grid-template-columns',
  'grid-template-rows',
]

const CONTRAST_PROPERTIES: readonly string[] = ['color', 'background-color', 'opacity']
const STACKING_PROPERTIES: readonly string[] = ['z-index', 'position', 'transform', 'opacity']

/** Which declarations could plausibly have caused this change. */
function suspects(change: Change): readonly string[] {
  switch (change.kind) {
    case 'style':
      return [change.property]
    case 'box':
      return BOX_MODEL_PROPERTIES
    case 'contrast':
      return CONTRAST_PROPERTIES
    case 'paint-order':
      return STACKING_PROPERTIES
    default:
      // added, removed, attr, text — the DOM changed, not the stylesheet.
      return []
  }
}

export interface ExplainOptions {
  /** Attribute derived changes too. Off by default: their cause is another node. */
  includeDerived?: boolean
}

/**
 * Explains a set of changes against the rules captured alongside each snapshot.
 *
 * Pure: takes the two `RuleIndex` values from `snapshot.rules` and reports which
 * winning declaration moved. Returns nothing when either snapshot was captured
 * without `rules: true`.
 */
export function explain(
  changes: Change[],
  beforeRules: RuleIndex | undefined,
  afterRules: RuleIndex | undefined,
  options: ExplainOptions = {},
): Attribution[] {
  if (!beforeRules || !afterRules) return []

  const byKey = new Map<string, { path: string; properties: Set<string> }>()
  for (const change of changes) {
    if (!options.includeDerived && 'cause' in change && change.cause === 'derived') continue
    const properties = suspects(change)
    if (properties.length === 0) continue

    const entry = byKey.get(change.key) ?? { path: change.path, properties: new Set<string>() }
    for (const property of properties) entry.properties.add(property)
    byKey.set(change.key, entry)
  }

  const attributions: Attribution[] = []
  for (const [key, { path, properties }] of byKey) {
    const before = beforeRules[key] ?? []
    const after = afterRules[key] ?? []

    const causes: DeclarationChange[] = []
    for (const property of properties) {
      const from = winner(before, property)
      const to = winner(after, property)
      if (!from && !to) continue
      if (from && to && same(from, to)) continue
      causes.push({ property, before: from, after: to })
    }

    attributions.push({ key, path, causes: dedupe(causes), unattributed: causes.length === 0 })
  }
  return attributions
}

/**
 * Two winners are the same fact when they render the same and come from the same
 * place. A rule that moved down a stylesheet without changing its value is noise.
 */
function same(a: Declaration, b: Declaration): boolean {
  return (
    a.value === b.value &&
    a.important === b.important &&
    a.selector === b.selector &&
    a.inline === b.inline
  )
}

/**
 * `padding: 8px 16px -> 20px 16px` wins four longhands, two of which are unchanged
 * and two of which restate one edit. Collapse anything that came from the same
 * shorthand at the same source location into a single cause.
 */
function dedupe(causes: DeclarationChange[]): DeclarationChange[] {
  const seen = new Set<string>()
  const out: DeclarationChange[] = []

  for (const cause of causes) {
    const shorthand = cause.after?.shorthand ?? cause.before?.shorthand
    if (!shorthand) {
      out.push(cause)
      continue
    }
    const origin = `${shorthand}|${sourceKey(cause.before)}|${sourceKey(cause.after)}`
    if (seen.has(origin)) continue
    seen.add(origin)
    // Report the shorthand the author actually wrote, not the longhand we derived.
    out.push({
      property: cause.after?.shorthand ? shorthandName(cause.after) : shorthandName(cause.before!),
      before: cause.before,
      after: cause.after,
    })
  }
  return out
}

function shorthandName(declaration: Declaration): string {
  return declaration.shorthand?.split(':')[0]?.trim() ?? declaration.property
}

function sourceKey(declaration: Declaration | null): string {
  if (!declaration) return '-'
  const source = declaration.source
  return source
    ? `${source.url}:${source.line}:${source.column}`
    : (declaration.selector ?? 'inline')
}

/** How the cause reads in a report: `.btn { padding: 8px 16px → 20px 16px }`. */
export function describeCause(cause: DeclarationChange): string {
  const { before, after } = cause
  const site = after ?? before!
  const scope = site.inline ? 'style=""' : (site.selector ?? '?')

  const from = before ? valueOf(before) : '<unset>'
  const to = after ? valueOf(after) : '<unset>'
  const bang = after?.important ? ' !important' : ''

  return `${scope} { ${cause.property}: ${from} → ${to}${bang} }`
}

function valueOf(declaration: Declaration): string {
  const shorthand = declaration.shorthand
  return shorthand
    ? (shorthand.split(':').slice(1).join(':').trim() ?? declaration.value)
    : declaration.value
}
