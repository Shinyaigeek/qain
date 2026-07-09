import type { CdpSession, CssProperty, RuleMatch, StyleSheetHeader } from './cdp.js'

/**
 * Which CSS rule set this value.
 *
 * The projection deliberately drops `padding`, `margin` and `width`, so a diff can
 * say a button grew but not why. Matched rules answer that — but only for the
 * handful of nodes that actually changed, which is why they are captured
 * separately rather than carried in every snapshot.
 */
export interface SourceLocation {
  /** Stylesheet URL, or the document URL for an inline `<style>`. */
  url: string
  /** 1-indexed, absolute in `url` — inline sheets are offset by their position in the HTML. */
  line: number
  column: number
}

export type Origin = 'regular' | 'user-agent' | 'injected' | 'inspector'

export interface Declaration {
  property: string
  value: string
  important: boolean
  origin: Origin
  /** Came from a `style=""` attribute. Beats every rule of the same importance. */
  inline: boolean
  /** null for inline styles. */
  selector: string | null
  /** Set when this longhand came from a shorthand, e.g. `padding: 8px 16px`. */
  shorthand?: string
  source: SourceLocation | null
  /** Position in the cascade array Chromium returned. Later means higher precedence. */
  order: number
}

/** Author declarations only, keyed by qain node key. */
export type RuleIndex = Record<string, Declaration[]>

// ---------------------------------------------------------------------------

/**
 * Chromium returns `matchedCSSRules` sorted by specificity, then source order —
 * so the last entry wins *among declarations of equal importance*. It does not
 * fold in `!important`, and it does not include the `style=""` attribute.
 * Resolving the cascade means layering both back on:
 *
 *   important user-agent  >  important author  >  normal author  >  normal user-agent
 *
 * and, within a tier, an inline style beats any rule, and a later rule beats an
 * earlier one. Reading the array back-to-front and taking the first hit — which is
 * the obvious thing to do — silently picks the wrong rule whenever `!important` is
 * involved.
 */
export function precedence(declaration: Declaration): [number, number, number] {
  const ua = declaration.origin === 'user-agent'
  const tier = declaration.important ? (ua ? 3 : 2) : ua ? -1 : 0
  return [tier, declaration.inline ? 1 : 0, declaration.order]
}

/** The declaration that actually renders, or null when nothing sets the property. */
export function winner(declarations: Declaration[], property: string): Declaration | null {
  let best: Declaration | null = null
  let bestRank: [number, number, number] | null = null

  for (const declaration of declarations) {
    if (declaration.property !== property) continue
    const rank = precedence(declaration)
    if (bestRank === null || compare(rank, bestRank) > 0) {
      best = declaration
      bestRank = rank
    }
  }
  return best
}

function compare(a: [number, number, number], b: [number, number, number]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
}

export function formatSource(source: SourceLocation | null): string {
  if (!source) return '<unknown>'
  const file = source.url.split('/').pop() || source.url
  return `${file}:${source.line}:${source.column}`
}

// ---------------------------------------------------------------------------

export interface CaptureRulesOptions {
  /** Include the user-agent stylesheet. Off by default: it is large and nobody edited it. */
  includeUserAgent?: boolean
}

/**
 * Fetches the matched rules for each node, keyed the same way the snapshot is.
 *
 * Costs one CDP round-trip per node, so it is opt-in. Pseudo-elements are skipped:
 * their rules arrive under the host's `pseudoElements`, not their own node.
 */
export async function captureRules(
  cdp: CdpSession,
  nodes: { key: string; backendNodeId: number; pseudo?: string }[],
  headers: Map<string, StyleSheetHeader>,
  options: CaptureRulesOptions = {},
): Promise<RuleIndex> {
  const targets = nodes.filter((node) => !node.pseudo)
  if (targets.length === 0) return {}

  const { nodeIds } = (await cdp.send('DOM.pushNodesByBackendIdsToFrontend', {
    backendNodeIds: targets.map((node) => node.backendNodeId),
  })) as { nodeIds: number[] }

  const index: RuleIndex = {}
  for (let i = 0; i < targets.length; i++) {
    const nodeId = nodeIds[i]
    if (!nodeId) continue
    let matched: {
      inlineStyle?: { cssProperties: CssProperty[] }
      matchedCSSRules?: RuleMatch[]
    }
    try {
      matched = await cdp.send('CSS.getMatchedStylesForNode', { nodeId })
    } catch {
      // Nodes that vanished between the snapshot and now, or that have no style.
      continue
    }

    const declarations = normalize(matched, headers, options.includeUserAgent ?? false)
    if (declarations.length > 0) index[targets[i]!.key] = declarations
  }
  return index
}

function normalize(
  matched: { inlineStyle?: { cssProperties: CssProperty[] }; matchedCSSRules?: RuleMatch[] },
  headers: Map<string, StyleSheetHeader>,
  includeUserAgent: boolean,
): Declaration[] {
  const out: Declaration[] = []

  matched.matchedCSSRules?.forEach((match, order) => {
    const rule = match.rule
    if (!includeUserAgent && rule.origin === 'user-agent') return
    const header = rule.styleSheetId ? headers.get(rule.styleSheetId) : undefined
    for (const property of rule.style?.cssProperties ?? []) {
      out.push(
        ...expand(property, {
          origin: rule.origin,
          inline: false,
          selector: rule.selectorList?.text ?? null,
          order,
          header,
        }),
      )
    }
  })

  for (const property of matched.inlineStyle?.cssProperties ?? []) {
    out.push(
      ...expand(property, {
        origin: 'regular',
        inline: true,
        selector: null,
        order: Number.MAX_SAFE_INTEGER,
        header: undefined,
      }),
    )
  }

  return out
}

interface Context {
  origin: Origin
  inline: boolean
  selector: string | null
  order: number
  header: StyleSheetHeader | undefined
}

/**
 * One `padding: 8px 16px` becomes four longhand declarations, each remembering the
 * shorthand it came from. Without this, explaining a `padding-top` change would
 * find nothing, because nobody ever writes `padding-top`.
 */
function expand(property: CssProperty, context: Context): Declaration[] {
  // A declaration Chromium parsed but did not apply — an override, or invalid.
  if (property.disabled || property.parsedOk === false) return []

  const source = locate(property, context.header)
  const base = {
    // Chromium reports importance twice: as a flag, and inside the value string.
    important: property.important ?? IMPORTANT.test(property.value),
    origin: context.origin,
    inline: context.inline,
    selector: context.selector,
    source,
    order: context.order,
  }

  const longhands = property.longhandProperties ?? []
  if (longhands.length > 0) {
    const shorthand = `${property.name}: ${stripImportant(property.value)}`
    return longhands.map((longhand) => ({
      ...base,
      property: longhand.name,
      value: stripImportant(longhand.value),
      shorthand,
    }))
  }

  return [{ ...base, property: property.name, value: stripImportant(property.value) }]
}

const IMPORTANT = /\s*!\s*important\s*$/i

/**
 * `background-color: rgb(3, 3, 3) !important` arrives with the flag baked into the
 * value as well as set on `important`. Left in, the value would never equal the
 * computed style, and every report would print `!important` twice.
 */
function stripImportant(value: string): string {
  return value.replace(IMPORTANT, '')
}

/**
 * An inline `<style>` reports declaration ranges relative to the sheet, so its
 * position inside the HTML has to be added back. Only the first line of the sheet
 * shares a line with the `<style>` tag, so only that line gets the column offset.
 */
function locate(
  property: CssProperty,
  header: StyleSheetHeader | undefined,
): SourceLocation | null {
  if (!header || !property.range) return null

  const inlineOffset = header.isInline ? (header.startLine ?? 0) : 0
  const line = property.range.startLine + inlineOffset
  const column =
    header.isInline && property.range.startLine === 0
      ? property.range.startColumn + (header.startColumn ?? 0)
      : property.range.startColumn

  return { url: header.sourceURL || '', line: line + 1, column: column + 1 }
}
