import {
  type AxNode,
  type CaptureSnapshotResult,
  type CdpSession,
  type DocumentSnapshot,
  type StyleSheetHeader,
  rare,
  rareBool,
  str,
} from './cdp.js'
import { type IdentityInput, assignKeys, displayPath } from './identity.js'
import {
  DEFAULT_EXCLUDED_ATTRIBUTES,
  DEFAULT_INTERACTIVE_SELECTOR,
  DEFAULT_PROJECTION,
  NON_RENDERED_TAGS,
} from './projection.js'
import { type RuleIndex, captureRules } from './rules.js'
import {
  type Box,
  type CapturedState,
  FORMAT_VERSION,
  type PseudoState,
  type QainNode,
  type Snapshot,
  type TextRun,
} from './types.js'

export interface CaptureOptions {
  /** Restrict the snapshot to this element and its descendants. Default: the whole document. */
  selector?: string
  /** Pseudo-states to force and capture, each as its own state. Default: none. */
  states?: readonly PseudoState[]
  /** Computed properties to record. Default: DEFAULT_PROJECTION. */
  projection?: readonly string[]
  /** Which elements are candidates for pseudo-state forcing. */
  interactiveSelector?: string
  excludeAttributes?: readonly string[]
  /**
   * 'auto' takes one bulk capture with every candidate forced, verifies that
   * nothing outside the forced subtrees moved, and falls back to per-node
   * captures when it did. 'bulk' and 'isolated' pin the choice.
   */
  strategy?: 'auto' | 'bulk' | 'isolated'
  /**
   * Also record the matched CSS rules for every node, so a later diff can name the
   * declaration behind each change. Costs one CDP round-trip per node — opt in.
   */
  rules?: boolean
  /** Include the user-agent stylesheet in `rules`. Large, and nobody edited it. */
  includeUserAgentRules?: boolean
  /**
   * Also record each rendered line of text at the rectangle the browser gave it,
   * which is what `qain view` needs to rebuild the page without re-running layout.
   */
  replay?: boolean
}

interface Parsed {
  nodes: QainNode[]
  /** Parallel to `nodes`: index of the parent within `nodes`, or -1. */
  parents: number[]
  /** Parallel to `nodes`: the node's backendNodeId. */
  backendIds: number[]
  /** backendNodeId -> index within `nodes`. */
  byBackendId: Map<number, number>
  title: string
  url: string
}

const ELEMENT_NODE = 1
const TEXT_NODE = 3

// ---------------------------------------------------------------------------

export async function capture(cdp: CdpSession, options: CaptureOptions = {}): Promise<Snapshot> {
  const projection = [...(options.projection ?? DEFAULT_PROJECTION)]
  const excluded = new Set(options.excludeAttributes ?? DEFAULT_EXCLUDED_ATTRIBUTES)
  const states = options.states ?? []
  const warnings: string[] = []

  // There is no command that returns a stylesheet header, only an event, and it
  // only fires for sheets seen after CSS.enable. Subscribe before enabling.
  const headers = new Map<string, StyleSheetHeader>()
  if (options.rules) {
    if (typeof cdp.on === 'function') {
      cdp.on('CSS.styleSheetAdded', ({ header }: { header: StyleSheetHeader }) =>
        headers.set(header.styleSheetId, header),
      )
    } else {
      warnings.push(
        'this CDP session cannot subscribe to events, so rules carry no source location',
      )
    }
  }

  await cdp.send('DOM.enable')
  await cdp.send('CSS.enable')
  await cdp.send('DOMSnapshot.enable')
  await cdp.send('Accessibility.enable')

  // One DOM.getDocument gives nodeId -> backendNodeId for every node. That bridge
  // is the whole reason for the call: forcePseudoState speaks nodeId, DOMSnapshot
  // speaks backendNodeId, and without the map every candidate would cost a
  // DOM.describeNode round-trip.
  const { root } = await cdp.send('DOM.getDocument', { depth: -1 })
  const nodeIdToBackend = new Map<number, number>()
  collectNodeIds(root, nodeIdToBackend)

  const axByBackendId = await fetchAxTree(cdp)
  const viewport = await fetchViewport(cdp)

  const takeSnapshot = async (): Promise<CaptureSnapshotResult> =>
    cdp.send('DOMSnapshot.captureSnapshot', {
      computedStyles: projection,
      includePaintOrder: true,
      includeDOMRects: false,
      includeBlendedBackgroundColors: true,
      includeTextColorOpacities: true,
    })

  const scopeBackendId = options.selector
    ? await resolveSelector(cdp, root.nodeId, options.selector, nodeIdToBackend)
    : undefined
  if (options.selector && scopeBackendId === undefined) {
    throw new Error(`qain: no element matched selector ${JSON.stringify(options.selector)}`)
  }

  const parseOptions = {
    projection,
    ax: axByBackendId,
    excluded,
    scopeBackendId,
    replay: !!options.replay,
  }
  const defaultParsed = parse(await takeSnapshot(), parseOptions)

  const captured: CapturedState[] = [{ state: 'default', nodes: defaultParsed.nodes }]

  if (states.length > 0) {
    const candidates = await findCandidates(
      cdp,
      root.nodeId,
      options.interactiveSelector ?? DEFAULT_INTERACTIVE_SELECTOR,
      defaultParsed,
      nodeIdToBackend,
    )
    if (candidates.length === 0) {
      warnings.push(
        `no elements matched the interactive selector, so states [${states.join(', ')}] captured nothing`,
      )
    }

    for (const state of states) {
      const result = await captureState(cdp, state, candidates, {
        takeSnapshot,
        parse: (snap) => parse(snap, parseOptions),
        defaultParsed,
        strategy: options.strategy ?? 'auto',
      })
      captured.push(result.state)
      warnings.push(...result.warnings)
    }
  }

  let rules: RuleIndex | undefined
  if (options.rules) {
    rules = await captureRules(
      cdp,
      defaultParsed.nodes.map((node, i) => ({
        key: node.key,
        backendNodeId: defaultParsed.backendIds[i]!,
        ...(node.pseudo ? { pseudo: node.pseudo } : {}),
      })),
      headers,
      { includeUserAgent: options.includeUserAgentRules ?? false },
    )
  }

  return {
    qain: FORMAT_VERSION,
    url: defaultParsed.url,
    title: defaultParsed.title,
    viewport,
    projection,
    states: captured,
    ...(rules ? { rules } : {}),
    warnings,
  }
}

// ---------------------------------------------------------------------------
// Pseudo-state capture
// ---------------------------------------------------------------------------

interface Candidate {
  backendNodeId: number
  nodeId: number
  /** Index into the default snapshot's node list. */
  index: number
}

interface StateContext {
  takeSnapshot: () => Promise<CaptureSnapshotResult>
  parse: (snap: CaptureSnapshotResult) => Parsed
  defaultParsed: Parsed
  strategy: 'auto' | 'bulk' | 'isolated'
}

async function captureState(
  cdp: CdpSession,
  state: PseudoState,
  candidates: Candidate[],
  ctx: StateContext,
): Promise<{ state: CapturedState; warnings: string[] }> {
  const warnings: string[] = []
  if (candidates.length === 0) {
    return { state: { state, strategy: 'bulk', nodes: [] }, warnings }
  }

  const force = (nodeIds: number[], classes: string[]) =>
    Promise.all(
      nodeIds.map((nodeId) =>
        cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: classes }),
      ),
    )

  const subtreeOf = (parsed: Parsed, backendNodeId: number): QainNode[] => {
    const rootIndex = parsed.byBackendId.get(backendNodeId)
    if (rootIndex === undefined) return []
    return descendants(parsed, rootIndex).map((i) => parsed.nodes[i]!)
  }

  if (ctx.strategy !== 'isolated') {
    const ids = candidates.map((c) => c.nodeId)
    await force(ids, [state])
    const bulk = ctx.parse(await ctx.takeSnapshot())
    await force(ids, [])

    const forcedIndexes = new Set<number>()
    for (const candidate of candidates) {
      const i = bulk.byBackendId.get(candidate.backendNodeId)
      if (i !== undefined) for (const d of descendants(bulk, i)) forcedIndexes.add(d)
    }

    const contamination = detectContamination(ctx.defaultParsed, bulk, forcedIndexes, candidates)

    if (ctx.strategy === 'bulk' || contamination === null) {
      const nodes = candidates.flatMap((c) => subtreeOf(bulk, c.backendNodeId))
      if (ctx.strategy === 'bulk' && contamination !== null) {
        warnings.push(`:${state} bulk capture is contaminated — ${contamination}`)
      }
      return { state: { state, strategy: 'bulk', nodes }, warnings }
    }

    warnings.push(
      `:${state} perturbs the page beyond the elements being forced (${contamination}), ` +
        `so qain fell back to isolated capture: ${candidates.length} extra snapshots`,
    )
  }

  // Isolated: force one node at a time so nothing can displace anything else.
  const nodes: QainNode[] = []
  for (const candidate of candidates) {
    await force([candidate.nodeId], [state])
    const parsed = ctx.parse(await ctx.takeSnapshot())
    await force([candidate.nodeId], [])
    nodes.push(...subtreeOf(parsed, candidate.backendNodeId))
  }
  return { state: { state, strategy: 'isolated', nodes }, warnings }
}

/**
 * Returns a description of why a bulk capture cannot be trusted, or null if it can.
 *
 * Forcing :hover on every button at once is a page state that never occurs in a
 * browser. It is safe only when hovering changes nothing outside the hovered
 * elements themselves. Two ways it can go wrong:
 *
 *   - `.btn:hover { padding: 24px }` grows a button, displacing every element
 *     after it. Their boxes in the bulk capture are fiction.
 *   - `.btn:hover ~ .panel { color: red }` restyles a node that is not forced.
 *
 * Both show up as a change outside the forced subtrees. A forced element whose
 * own box changed is also suspect once there is more than one of them, because
 * it may have displaced a sibling that is itself forced.
 */
function detectContamination(
  base: Parsed,
  bulk: Parsed,
  forcedIndexes: Set<number>,
  candidates: Candidate[],
): string | null {
  for (let i = 0; i < bulk.nodes.length; i++) {
    if (forcedIndexes.has(i)) continue
    const after = bulk.nodes[i]!
    const beforeIndex = base.byBackendId.get(bulk.backendIds[i]!)
    if (beforeIndex === undefined) continue
    const before = base.nodes[beforeIndex]!

    if (!boxesEqual(before.box, after.box)) {
      return `${after.path} changed box while it was not being forced`
    }
    for (const [property, value] of Object.entries(after.styles)) {
      if (before.styles[property] !== value) {
        return `${after.path} restyled ${property} while it was not being forced (sibling combinator?)`
      }
    }
  }

  if (candidates.length > 1) {
    for (const candidate of candidates) {
      const afterIndex = bulk.byBackendId.get(candidate.backendNodeId)
      if (afterIndex === undefined) continue
      const before = base.nodes[candidate.index]!
      const after = bulk.nodes[afterIndex]!
      if (!boxesEqual(before.box, after.box)) {
        return `${after.path} changes size or position when forced, which displaces the other ${candidates.length - 1} forced elements`
      }
    }
  }

  return null
}

function boxesEqual(a: Box | null, b: Box | null): boolean {
  if (a === null || b === null) return a === b
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3]
}

function descendants(parsed: Parsed, root: number): number[] {
  const out = [root]
  for (let i = root + 1; i < parsed.nodes.length; i++) {
    let cursor = parsed.parents[i] ?? -1
    while (cursor >= 0 && cursor > root) cursor = parsed.parents[cursor] ?? -1
    if (cursor === root) out.push(i)
  }
  return out
}

// ---------------------------------------------------------------------------
// CDP helpers
// ---------------------------------------------------------------------------

/** nodeId -> backendNodeId, over the whole document. */
function collectNodeIds(node: any, out: Map<number, number>): void {
  if (typeof node.backendNodeId === 'number' && typeof node.nodeId === 'number') {
    out.set(node.nodeId, node.backendNodeId)
  }
  for (const child of node.children ?? []) collectNodeIds(child, out)
  if (node.contentDocument) collectNodeIds(node.contentDocument, out)
}

async function fetchAxTree(
  cdp: CdpSession,
): Promise<Map<number, { role?: string; name?: string }>> {
  const map = new Map<number, { role?: string; name?: string }>()
  try {
    const { nodes } = (await cdp.send('Accessibility.getFullAXTree')) as { nodes: AxNode[] }
    for (const node of nodes) {
      if (node.backendDOMNodeId === undefined) continue
      const role = node.role?.value
      const name = node.name?.value
      if (role || name) map.set(node.backendDOMNodeId, { role, name })
    }
  } catch {
    // The AX tree is an optimisation for identity, not a requirement. Without it
    // qain falls back to tag ordinals, which still work.
  }
  return map
}

async function fetchViewport(cdp: CdpSession): Promise<{ width: number; height: number }> {
  try {
    const metrics = await cdp.send('Page.getLayoutMetrics')
    const viewport = metrics.cssLayoutViewport ?? metrics.layoutViewport
    return { width: viewport.clientWidth, height: viewport.clientHeight }
  } catch {
    return { width: 0, height: 0 }
  }
}

async function resolveSelector(
  cdp: CdpSession,
  rootNodeId: number,
  selector: string,
  nodeIdToBackend: Map<number, number>,
): Promise<number | undefined> {
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: rootNodeId, selector })
  if (!nodeId) return undefined
  return nodeIdToBackend.get(nodeId)
}

async function findCandidates(
  cdp: CdpSession,
  rootNodeId: number,
  selector: string,
  parsed: Parsed,
  nodeIdToBackend: Map<number, number>,
): Promise<Candidate[]> {
  const { nodeIds } = (await cdp.send('DOM.querySelectorAll', {
    nodeId: rootNodeId,
    selector,
  })) as { nodeIds: number[] }

  const candidates: Candidate[] = []
  for (const nodeId of nodeIds) {
    const backendNodeId = nodeIdToBackend.get(nodeId)
    if (backendNodeId === undefined) continue
    const index = parsed.byBackendId.get(backendNodeId)
    // Elements outside the snapshot scope, or with no layout box, cannot be compared.
    if (index === undefined) continue
    candidates.push({ nodeId, backendNodeId, index })
  }
  return candidates
}

// ---------------------------------------------------------------------------
// Snapshot parsing
// ---------------------------------------------------------------------------

interface ParseOptions {
  projection: string[]
  ax: Map<number, { role?: string; name?: string }>
  excluded: Set<string>
  scopeBackendId: number | undefined
  replay: boolean
}

function parse(snapshot: CaptureSnapshotResult, options: ParseOptions): Parsed {
  const { projection, ax, excluded: excludedAttributes, scopeBackendId } = options
  const strings = snapshot.strings
  const document = snapshot.documents[0]
  if (!document) throw new Error('qain: DOMSnapshot returned no documents')

  const { nodes, layout } = document
  const runsByLayout = options.replay ? indexTextRuns(document, strings) : undefined
  const layoutByNode = new Map<number, number>()
  for (let li = 0; li < layout.nodeIndex.length; li++) {
    layoutByNode.set(layout.nodeIndex[li]!, li)
  }

  const scopeIndex = scopeBackendId === undefined ? -1 : nodes.backendNodeId.indexOf(scopeBackendId)
  const inScope = (ni: number): boolean => {
    if (scopeIndex < 0) return true
    let cursor: number | undefined = ni
    while (cursor !== undefined && cursor >= 0) {
      if (cursor === scopeIndex) return true
      cursor = nodes.parentIndex[cursor]
    }
    return false
  }

  const attributesOf = (ni: number): Record<string, string> => {
    const out: Record<string, string> = {}
    const flat = nodes.attributes[ni] ?? []
    for (let k = 0; k + 1 < flat.length; k += 2) {
      const name = strings[flat[k]!]
      const value = strings[flat[k + 1]!] ?? ''
      if (name && !excludedAttributes.has(name)) out[name] = value
    }
    return out
  }

  /**
   * A text node's runs belong to the element that contains it. Pseudo-elements own
   * their own layout object, and therefore their own runs.
   */
  const textRunsFor = (ni: number, ownLayout: number | undefined): TextRun[] | undefined => {
    if (!runsByLayout) return undefined
    const runs: TextRun[] = []
    if (ownLayout !== undefined) runs.push(...(runsByLayout.get(ownLayout) ?? []))
    for (let i = 0; i < nodes.parentIndex.length; i++) {
      if (nodes.parentIndex[i] !== ni || nodes.nodeType[i] !== TEXT_NODE) continue
      const li = layoutByNode.get(i)
      if (li !== undefined) runs.push(...(runsByLayout.get(li) ?? []))
    }
    return runs.length > 0 ? runs : undefined
  }

  const directText = (ni: number): string | undefined => {
    const parts: string[] = []
    for (let i = 0; i < nodes.parentIndex.length; i++) {
      if (nodes.parentIndex[i] !== ni || nodes.nodeType[i] !== TEXT_NODE) continue
      const value = strings[nodes.nodeValue[i]!]
      if (value) parts.push(value)
    }
    const text = parts.join('').replace(/\s+/g, ' ').trim()
    return text.length > 0 ? text : undefined
  }

  // Document order is guaranteed by DOMSnapshot, so a parent is always seen first,
  // which lets a single forward pass drop whole non-rendered subtrees.
  const kept: number[] = []
  const indexOfNode = new Map<number, number>()
  const dropped = new Set<number>()
  for (let ni = 0; ni < nodes.nodeType.length; ni++) {
    const parent = nodes.parentIndex[ni] ?? -1
    const tag = strings[nodes.nodeName[ni]!] ?? ''
    if (parent >= 0 && dropped.has(parent)) {
      dropped.add(ni)
      continue
    }
    if (NON_RENDERED_TAGS.has(tag.toUpperCase())) {
      dropped.add(ni)
      continue
    }
    if (nodes.nodeType[ni] !== ELEMENT_NODE) continue
    if (!inScope(ni)) continue
    indexOfNode.set(ni, kept.length)
    kept.push(ni)
  }

  const identities: IdentityInput[] = []
  const parents: number[] = []
  for (const ni of kept) {
    const pseudoIndex = rare(nodes.pseudoType, ni)
    const backendNodeId = nodes.backendNodeId[ni]!
    const axNode = ax.get(backendNodeId)
    identities.push({
      tag: strings[nodes.nodeName[ni]!] ?? '?',
      pseudo: str(strings, pseudoIndex),
      attrs: attributesOf(ni),
      role: axNode?.role,
      name: axNode?.name,
    })
    let parent = nodes.parentIndex[ni] ?? -1
    while (parent >= 0 && !indexOfNode.has(parent)) parent = nodes.parentIndex[parent] ?? -1
    parents.push(parent >= 0 ? indexOfNode.get(parent)! : -1)
  }

  const { keys, ordinals } = assignKeys(identities, parents)

  const out: QainNode[] = []
  const backendIds: number[] = []
  const byBackendId = new Map<number, number>()

  for (let i = 0; i < kept.length; i++) {
    const ni = kept[i]!
    const identity = identities[i]!
    const li = layoutByNode.get(ni)

    const styles: Record<string, string> = {}
    if (li !== undefined) {
      const row = layout.styles[li] ?? []
      for (let p = 0; p < projection.length; p++) {
        const value = str(strings, row[p])
        if (value !== undefined) styles[projection[p]!] = value
      }
    }

    const rawBounds = li !== undefined ? layout.bounds[li] : undefined
    const box: Box | null =
      rawBounds && rawBounds.length === 4
        ? [round(rawBounds[0]!), round(rawBounds[1]!), round(rawBounds[2]!), round(rawBounds[3]!)]
        : null

    const blended =
      li !== undefined ? str(strings, layout.blendedBackgroundColors?.[li]) : undefined
    const pseudoText =
      identity.pseudo && li !== undefined ? str(strings, layout.text[li]) : undefined

    const parentIndex = parents[i]!
    const node: QainNode = {
      key: keys[i]!,
      path: displayPath(identities, parents, ordinals, i),
      tag: identity.tag.toLowerCase(),
      attrs: identity.attrs,
      styles,
      box,
    }
    if (parentIndex >= 0) node.parent = keys[parentIndex]!
    if (identity.pseudo) node.pseudo = identity.pseudo
    if (identity.role) node.role = identity.role
    if (identity.name) node.name = identity.name

    const text = pseudoText ?? directText(ni)
    if (text) node.text = text
    const runs = textRunsFor(ni, li)
    if (runs) node.textRuns = runs
    if (li !== undefined) {
      const paintOrder = layout.paintOrders?.[li]
      if (paintOrder !== undefined) node.paintOrder = paintOrder
      if (rareBool(layout.stackingContexts, li)) node.stackingContext = true
      const opacity = layout.textColorOpacities?.[li]
      if (opacity !== undefined && opacity !== 1) node.textOpacity = opacity
    }
    if (blended) node.blendedBackground = blended

    const backendNodeId = nodes.backendNodeId[ni]!
    byBackendId.set(backendNodeId, out.length)
    backendIds.push(backendNodeId)
    out.push(node)
  }

  return {
    nodes: out,
    parents,
    backendIds,
    byBackendId,
    title: strings[document.title] ?? '',
    url: strings[document.documentURL] ?? '',
  }
}

/**
 * Groups `textBoxes` by the layout object they belong to, slicing each run's text
 * out of that object's full string. One entry per rendered line, so wrapped text
 * replays with the same line breaks the browser chose.
 */
function indexTextRuns(document: DocumentSnapshot, strings: string[]): Map<number, TextRun[]> {
  const byLayout = new Map<number, TextRun[]>()
  const boxes = document.textBoxes
  if (!boxes) return byLayout

  for (let i = 0; i < boxes.layoutIndex.length; i++) {
    const li = boxes.layoutIndex[i]!
    const bounds = boxes.bounds[i]
    if (!bounds || bounds.length !== 4) continue
    // A zero-area run is collapsed whitespace between tags. It renders nothing.
    if (bounds[2] === 0 || bounds[3] === 0) continue

    const full = str(strings, document.layout.text[li])
    if (full === undefined) continue
    const text = full.substr(boxes.start[i]!, boxes.length[i]!)
    if (text.length === 0) continue

    const list = byLayout.get(li) ?? []
    list.push({
      box: [round(bounds[0]!), round(bounds[1]!), round(bounds[2]!), round(bounds[3]!)],
      text,
    })
    byLayout.set(li, list)
  }
  return byLayout
}

/** Chromium reports sub-pixel bounds; three decimals is well past what anyone can see. */
function round(value: number): number {
  return Math.round(value * 1000) / 1000
}
