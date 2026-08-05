import { computeContrast, crossedThreshold, isLargeText } from './contrast.js'
import { explain } from './explain.js'
import {
  CURRENT_COLOR_PROPERTIES,
  DEFAULT_BOX_TOLERANCE,
  DEFAULT_IGNORED_ATTRIBUTES,
  DEFAULT_IGNORED_PROPERTIES,
  GEOMETRIC_PROPERTIES,
  INHERITED_PROPERTIES,
} from './projection.js'
import {
  type Box,
  type Cause,
  type Change,
  type Diff,
  type DiffSummary,
  FORMAT_VERSION,
  isDerived,
  type QainNode,
  type Snapshot,
  type StateName,
} from './types.js'

export interface DiffOptions {
  ignoreProperties?: readonly string[]
  ignoreAttributes?: readonly string[]
  /** Sub-pixel box movement below this, in CSS pixels, is not a change. */
  boxTolerance?: number
  /** Contrast ratio deltas below this are not reported. */
  contrastTolerance?: number
  /** Drop `derived` box changes entirely. The terse view. */
  omitDerived?: boolean
}

export function diff(before: Snapshot, after: Snapshot, options: DiffOptions = {}): Diff {
  const ignoredProperties = new Set(options.ignoreProperties ?? DEFAULT_IGNORED_PROPERTIES)
  const ignoredAttributes = new Set(options.ignoreAttributes ?? DEFAULT_IGNORED_ATTRIBUTES)
  const tolerance = options.boxTolerance ?? DEFAULT_BOX_TOLERANCE
  const contrastTolerance = options.contrastTolerance ?? 0.05

  const warnings: string[] = []
  if (before.qain !== after.qain) {
    warnings.push(`snapshot format mismatch: ${before.qain} vs ${after.qain}`)
  }
  if (
    before.viewport.width !== after.viewport.width ||
    before.viewport.height !== after.viewport.height
  ) {
    warnings.push(
      `viewport differs (${fmtViewport(before)} vs ${fmtViewport(after)}); box changes are not comparable`,
    )
  }
  const projectionDelta = symmetricDifference(before.projection, after.projection)
  if (projectionDelta.length > 0) {
    warnings.push(
      `projections differ; ${projectionDelta.join(', ')} compared on only one side and were skipped`,
    )
  }
  const sharedProjection = new Set(
    before.projection.filter((p) => after.projection.includes(p) && !ignoredProperties.has(p)),
  )

  const changes: Change[] = []
  const states = [
    ...new Set<StateName>([
      ...before.states.map((s) => s.state),
      ...after.states.map((s) => s.state),
    ]),
  ]

  for (const state of states) {
    const beforeState = before.states.find((s) => s.state === state)
    const afterState = after.states.find((s) => s.state === state)
    if (!beforeState || !afterState) {
      warnings.push(`state '${state}' present in only one snapshot; skipped`)
      continue
    }
    if (
      beforeState.strategy &&
      afterState.strategy &&
      beforeState.strategy !== afterState.strategy
    ) {
      warnings.push(
        `state '${state}' captured with different strategies (${beforeState.strategy} vs ${afterState.strategy}); box changes may be artefacts`,
      )
    }

    diffState(state, beforeState.nodes, afterState.nodes, {
      sharedProjection,
      ignoredAttributes,
      tolerance,
      contrastTolerance,
      out: changes,
    })
  }

  const filtered = options.omitDerived ? changes.filter((c) => !isDerived(c)) : changes

  const carries = (snapshot: Snapshot) => snapshot.states.some((s) => s.rules !== undefined)
  if (filtered.length > 0 && carries(before) !== carries(after)) {
    warnings.push('only one snapshot carries matched rules, so changes cannot be attributed')
  }
  const attributions = explain(filtered, before.states, after.states)

  return {
    qain: FORMAT_VERSION,
    before: { url: before.url, title: before.title },
    after: { url: after.url, title: after.title },
    changes: filtered,
    attributions,
    summary: summarise(filtered),
    warnings: [...warnings, ...before.warnings, ...after.warnings],
  }
}

// ---------------------------------------------------------------------------

interface StateContext {
  sharedProjection: Set<string>
  ignoredAttributes: Set<string>
  tolerance: number
  contrastTolerance: number
  out: Change[]
}

function diffState(
  state: StateName,
  before: QainNode[],
  after: QainNode[],
  ctx: StateContext,
): void {
  const beforeByKey = byKey(before)
  const afterByKey = byKey(after)

  /**
   * Keys that changed in a way capable of moving or resizing a box. A colour change
   * is a change, but it is not a reason for anything to move.
   */
  const selfChanged = new Set<string>()
  const boxChanged = new Map<string, { before: Box | null; after: Box | null }>()
  const pending: Change[] = []

  for (const [key, node] of beforeByKey) {
    if (!afterByKey.has(key)) {
      selfChanged.add(key)
      pending.push({ kind: 'removed', state, key, path: node.path, node })
    }
  }
  for (const [key, node] of afterByKey) {
    if (!beforeByKey.has(key)) {
      selfChanged.add(key)
      pending.push({ kind: 'added', state, key, path: node.path, node })
    }
  }

  for (const [key, a] of beforeByKey) {
    const b = afterByKey.get(key)
    if (!b) continue

    for (const property of ctx.sharedProjection) {
      const from = a.styles[property]
      const to = b.styles[property]
      if (from === to) continue

      // `border-*-color` and friends default to `currentColor`. When `color`
      // moves they all move with it, restating one change six times. Demote them
      // — but only when their value actually tracks `color` on both sides, so an
      // independently-authored border colour is still reported as its own change.
      const tracksColor =
        CURRENT_COLOR_PROPERTIES.has(property) && from === a.styles.color && to === b.styles.color
      const cause: Cause = tracksColor ? 'derived' : 'primary'

      if (!tracksColor && GEOMETRIC_PROPERTIES.has(property)) selfChanged.add(key)
      pending.push({
        kind: 'style',
        state,
        key,
        path: b.path,
        property,
        before: from,
        after: to,
        cause,
      })
    }

    for (const attribute of union(Object.keys(a.attrs), Object.keys(b.attrs))) {
      if (ctx.ignoredAttributes.has(attribute)) continue
      const from = a.attrs[attribute]
      const to = b.attrs[attribute]
      if (from !== to) {
        selfChanged.add(key)
        pending.push({ kind: 'attr', state, key, path: b.path, attribute, before: from, after: to })
      }
    }

    if (a.text !== b.text) {
      selfChanged.add(key)
      pending.push({ kind: 'text', state, key, path: b.path, before: a.text, after: b.text })
    }

    if (!boxEqual(a.box, b.box, ctx.tolerance)) {
      boxChanged.set(key, { before: a.box, after: b.box })
    }

    if (a.paintOrder !== b.paintOrder) {
      pending.push({
        kind: 'paint-order',
        state,
        key,
        path: b.path,
        before: a.paintOrder,
        after: b.paintOrder,
      })
    }

    const contrast = contrastChange(state, key, a, b, ctx.contrastTolerance)
    if (contrast) pending.push(contrast)
  }

  const sizeChanged = new Set<string>()
  for (const [key, boxes] of boxChanged) {
    if (
      boxes.before === null ||
      boxes.after === null ||
      Math.abs(boxes.after[2] - boxes.before[2]) > ctx.tolerance ||
      Math.abs(boxes.after[3] - boxes.before[3]) > ctx.tolerance
    ) {
      sizeChanged.add(key)
    }
  }

  demoteInherited(pending, afterByKey)

  const causes = classify(beforeByKey, after, selfChanged, sizeChanged)

  for (const [key, boxes] of boxChanged) {
    pending.push({
      kind: 'box',
      state,
      key,
      path: afterByKey.get(key)!.path,
      before: boxes.before,
      after: boxes.after,
      delta: delta(boxes.before, boxes.after),
      cause: causes.has(key) ? 'primary' : 'derived',
    })
  }

  ctx.out.push(...pending)
}

/**
 * Demotes a style change that is only an ancestor's change, inherited.
 *
 * Walks up to the nearest ancestor whose own diff touched the same property. When
 * that ancestor moved between the same two values, this node did not change of its
 * own accord — it inherited. A node with its own declaration cannot match: either it
 * overrides the ancestor and does not move at all, or it moves between values of its
 * own. The chain collapses to whichever ancestor is the real cause, because each link
 * stops at the first changed ancestor above it rather than at the root.
 */
function demoteInherited(pending: Change[], afterByKey: Map<string, QainNode>): void {
  const changedAt = new Map<string, { before: string | undefined; after: string | undefined }>()
  for (const change of pending) {
    if (change.kind === 'style') {
      changedAt.set(`${change.key}\u0000${change.property}`, {
        before: change.before,
        after: change.after,
      })
    }
  }

  for (const change of pending) {
    if (change.kind !== 'style' || change.cause === 'derived') continue
    if (!INHERITED_PROPERTIES.has(change.property)) continue

    for (
      let cursor = afterByKey.get(change.key)?.parent;
      cursor !== undefined;
      cursor = afterByKey.get(cursor)?.parent
    ) {
      const above = changedAt.get(`${cursor}\u0000${change.property}`)
      if (!above) continue
      if (above.before === change.before && above.after === change.after) {
        change.cause = 'derived'
      }
      break
    }
  }
}

/**
 * Decides which nodes are causes.
 *
 * A node is a cause when its own content changed, or when its box changed size
 * and nothing below it did. The second clause is what catches `padding: 8px ->
 * 20px`: padding is not in the projection, so the only evidence a button grew of
 * its own accord is that it grew while its children sat still. The same clause
 * exonerates the container above it, which grew only to fit the button.
 *
 * The two rules are mutually recursive — whether a node is a cause depends on
 * whether its descendants are — so this walks the tree bottom-up. Document order
 * puts children after parents, so iterating `after` in reverse visits every
 * descendant before its ancestor.
 *
 * Removed nodes have no place in the new tree, so their former ancestors are
 * seeded from the old one first.
 */
function classify(
  beforeByKey: Map<string, QainNode>,
  after: QainNode[],
  selfChanged: Set<string>,
  sizeChanged: Set<string>,
): Set<string> {
  const hasCausalDescendant = new Set<string>()
  const afterKeys = new Set(after.map((n) => n.key))

  for (const key of selfChanged) {
    if (afterKeys.has(key) || !beforeByKey.has(key)) continue
    let cursor = beforeByKey.get(key)?.parent
    while (cursor !== undefined && !hasCausalDescendant.has(cursor)) {
      hasCausalDescendant.add(cursor)
      cursor = beforeByKey.get(cursor)?.parent
    }
  }

  const causes = new Set<string>()
  for (let i = after.length - 1; i >= 0; i--) {
    const node = after[i]!
    const isCause =
      selfChanged.has(node.key) || (sizeChanged.has(node.key) && !hasCausalDescendant.has(node.key))
    if (isCause) causes.add(node.key)
    if ((isCause || hasCausalDescendant.has(node.key)) && node.parent !== undefined) {
      hasCausalDescendant.add(node.parent)
    }
  }
  return causes
}

function contrastChange(
  state: StateName,
  key: string,
  a: QainNode,
  b: QainNode,
  tolerance: number,
): Change | null {
  const from = computeContrast({
    color: a.styles.color,
    blendedBackground: a.blendedBackground,
    fontSize: a.styles['font-size'],
    fontWeight: a.styles['font-weight'],
    textOpacity: a.textOpacity,
  })
  const to = computeContrast({
    color: b.styles.color,
    blendedBackground: b.blendedBackground,
    fontSize: b.styles['font-size'],
    fontWeight: b.styles['font-weight'],
    textOpacity: b.textOpacity,
  })

  if (from === null || to === null) return null
  if (Math.abs(from - to) < tolerance) return null

  const large = isLargeText(b.styles['font-size'], b.styles['font-weight'])
  return {
    kind: 'contrast',
    state,
    key,
    path: b.path,
    before: round2(from),
    after: round2(to),
    crosses: crossedThreshold(from, to, large),
    foreground: b.styles.color ?? '',
    background: b.blendedBackground ?? '',
  }
}

// ---------------------------------------------------------------------------

/**
 * Keys are unique per snapshot by construction, but a malformed document (two
 * elements with the same `id`) can break that. First writer wins, matching
 * `document.getElementById`.
 */
function byKey(nodes: QainNode[]): Map<string, QainNode> {
  const map = new Map<string, QainNode>()
  for (const node of nodes) if (!map.has(node.key)) map.set(node.key, node)
  return map
}

function boxEqual(a: Box | null, b: Box | null, tolerance: number): boolean {
  if (a === null || b === null) return a === b
  return a.every((value, i) => Math.abs(value - b[i]!) <= tolerance)
}

function delta(a: Box | null, b: Box | null) {
  if (a === null || b === null) return { dx: 0, dy: 0, dw: 0, dh: 0 }
  return {
    dx: round2(b[0] - a[0]),
    dy: round2(b[1] - a[1]),
    dw: round2(b[2] - a[2]),
    dh: round2(b[3] - a[3]),
  }
}

function summarise(changes: Change[]): DiffSummary {
  const byKind: Record<string, number> = {}
  let derived = 0
  for (const change of changes) {
    byKind[change.kind] = (byKind[change.kind] ?? 0) + 1
    if (isDerived(change)) derived++
  }
  return { total: changes.length, primary: changes.length - derived, derived, byKind }
}

function union(a: readonly string[], b: readonly string[]): string[] {
  return [...new Set([...a, ...b])]
}

function symmetricDifference(a: readonly string[], b: readonly string[]): string[] {
  const setB = new Set(b)
  const setA = new Set(a)
  return [...a.filter((x) => !setB.has(x)), ...b.filter((x) => !setA.has(x))]
}

function fmtViewport(snapshot: Snapshot): string {
  return `${snapshot.viewport.width}x${snapshot.viewport.height}`
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}
