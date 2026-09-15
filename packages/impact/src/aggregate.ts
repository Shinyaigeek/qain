import {
  type Attribution,
  type Diff,
  formatSource,
  isDerived,
  type QainNode,
  type Snapshot,
  type StateName,
} from '@qain/core'
import { classifyOrigin, compareOrigin, originId } from './origin.js'
import {
  type CauseRef,
  type ComponentImpact,
  type ImpactConfig,
  type ImpactReport,
  type OriginImpact,
  type OriginRef,
  REPORT_VERSION,
  type TargetImpact,
  type TargetStatus,
  UNGROUPED,
} from './types.js'

/** One captured target, or the reason it produced no diff. */
export interface TargetResult {
  name: string
  url: string
  status: TargetStatus
  error?: string
  before?: Snapshot
  after?: Snapshot
  diff?: Diff
}

/** Attribution and change are both addressed by (state, key). */
function slot(state: StateName, key: string): string {
  return `${state}\u0000${key}`
}

/**
 * Index a snapshot's nodes by state and key, so a change can be walked back up the
 * tree. `QainNode.parent` holds a key, not a reference, which is what makes the
 * walk possible from the serialized form at all.
 */
function indexNodes(snapshot: Snapshot | undefined): Map<string, QainNode> {
  const index = new Map<string, QainNode>()
  if (!snapshot) return index
  for (const state of snapshot.states) {
    for (const node of state.nodes) index.set(slot(state.state, node.key), node)
  }
  return index
}

/**
 * The component a changed node belongs to: the nearest ancestor carrying one of the
 * configured attributes, the node itself included.
 *
 * The walk is the whole reason this is not a one-liner. A design system stamps its
 * name on the component's root element, but the element that actually changed is
 * usually a descendant — the span inside the button, not the button.
 */
export function componentOf(
  node: QainNode | undefined,
  state: StateName,
  nodes: Map<string, QainNode>,
  attributes: readonly string[],
): string {
  let current = node
  // The tree is shallow and the map is by key, so a depth cap only guards against a
  // corrupt snapshot whose parent chain contains a cycle.
  for (let depth = 0; current && depth < 256; depth++) {
    for (const attribute of attributes) {
      const value = current.attrs[attribute]
      if (value) return value
    }
    current = current.parent ? nodes.get(slot(state, current.parent)) : undefined
  }
  return UNGROUPED
}

interface Bucket {
  component: string
  targets: Set<string>
  changes: number
  primary: number
  derived: number
  origins: Map<string, OriginRef>
  causes: Map<string, { cause: CauseRef; count: number }>
  examples: string[]
}

function bucket(map: Map<string, Bucket>, component: string): Bucket {
  let found = map.get(component)
  if (!found) {
    found = {
      component,
      targets: new Set(),
      changes: 0,
      primary: 0,
      derived: 0,
      origins: new Map(),
      causes: new Map(),
      examples: [],
    }
    map.set(component, found)
  }
  return found
}

/** The declarations behind one change, as origins and readable causes. */
function causesOf(attribution: Attribution | undefined, config: ImpactConfig): CauseRef[] {
  if (!attribution || attribution.causes.length === 0) return []

  const out: CauseRef[] = []
  for (const change of attribution.causes) {
    // Prefer the declaration that renders now; a rule that stopped matching leaves
    // only the `before` side to name.
    const winner = change.after ?? change.before
    const source = winner?.source ?? null
    out.push({
      origin: classifyOrigin(source?.url ?? null, config.origins),
      property: change.property,
      selector: winner?.selector ?? null,
      before: change.before?.value,
      after: change.after?.value,
      source: formatSource(source),
    })
  }
  return out
}

function causeId(cause: CauseRef): string {
  return `${cause.source}\u0000${cause.selector}\u0000${cause.property}\u0000${cause.before}\u0000${cause.after}`
}

/**
 * Turns per-target diffs into one blast-radius report.
 *
 * Pure, and deliberately so: every browser-facing part of this package is a thin
 * shell around it, and the interesting behaviour — walking to the owning component,
 * naming the library a change came from — is testable without launching anything.
 */
export function buildReport(results: TargetResult[], config: ImpactConfig): ImpactReport {
  const components = new Map<string, Bucket>()
  const origins = new Map<string, OriginImpact>()
  const targets: TargetImpact[] = []
  const warnings: string[] = []

  let changes = 0
  let primary = 0
  let derived = 0

  for (const result of results) {
    if (!result.diff || result.status !== 'changed') {
      targets.push({
        name: result.name,
        url: result.url,
        status: result.status,
        changes: 0,
        primary: 0,
        derived: 0,
        components: [],
        ...(result.error ? { error: result.error } : {}),
      })
      continue
    }

    const nodes = indexNodes(result.after)
    const fallback = indexNodes(result.before)
    const attributions = new Map<string, Attribution>()
    for (const attribution of result.diff.attributions) {
      attributions.set(slot(attribution.state, attribution.key), attribution)
    }
    if (result.diff.attributions.length === 0 && result.diff.changes.length > 0) {
      warnings.push(
        `${result.name}: no rule attribution, so every change is reported as origin "unknown". Capture with rules enabled on both sides.`,
      )
    }

    const local = new Map<string, number>()
    let targetPrimary = 0
    let targetDerived = 0

    for (const change of result.diff.changes) {
      const at = slot(change.state, change.key)
      const node = nodes.get(at) ?? fallback.get(at)
      const owner = componentOf(
        node,
        change.state,
        nodes.has(at) ? nodes : fallback,
        config.componentAttributes,
      )

      const entry = bucket(components, owner)
      entry.targets.add(result.name)
      entry.changes++
      changes++
      if (isDerived(change)) {
        entry.derived++
        targetDerived++
        derived++
      } else {
        entry.primary++
        targetPrimary++
        primary++
      }
      if (entry.examples.length < 3 && !entry.examples.includes(change.path)) {
        entry.examples.push(change.path)
      }
      local.set(owner, (local.get(owner) ?? 0) + 1)

      const refs = causesOf(attributions.get(at), config)
      const seen = new Set<string>()
      for (const cause of refs) {
        entry.origins.set(originId(cause.origin), cause.origin)
        const id = causeId(cause)
        const existing = entry.causes.get(id)
        if (existing) existing.count++
        else entry.causes.set(id, { cause, count: 1 })
        seen.add(originId(cause.origin))
      }
      if (refs.length === 0) {
        const unknown: OriginRef = { kind: 'unknown', name: 'unknown' }
        entry.origins.set(originId(unknown), unknown)
        seen.add(originId(unknown))
      }

      // A change counts once per distinct origin, never once per declaration.
      for (const id of seen) {
        const origin = entry.origins.get(id)!
        let impact = origins.get(id)
        if (!impact) {
          impact = { origin, changes: 0, components: [], targets: [] }
          origins.set(id, impact)
        }
        impact.changes++
        if (!impact.components.includes(owner)) impact.components.push(owner)
        if (!impact.targets.includes(result.name)) impact.targets.push(result.name)
      }
    }

    targets.push({
      name: result.name,
      url: result.url,
      status: 'changed',
      changes: result.diff.changes.length,
      primary: targetPrimary,
      derived: targetDerived,
      components: [...local.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([name]) => name),
    })
  }

  const listed = [...components.values()]
    // `omitDerived` drops components that only moved. It never drops a component
    // whose own styles changed, so the filter cannot hide a real regression.
    .filter((entry) => !config.omitDerived || entry.primary > 0)
    .map(toComponentImpact)
    .sort(
      (a, b) =>
        b.primary - a.primary || b.changes - a.changes || a.component.localeCompare(b.component),
    )

  return {
    qain: REPORT_VERSION,
    generatedAt: new Date().toISOString(),
    summary: {
      targets: targets.length,
      targetsChanged: targets.filter((t) => t.status === 'changed').length,
      missingBaselines: targets.filter((t) => t.status === 'missing-baseline').length,
      errors: targets.filter((t) => t.status === 'error').length,
      components: listed.length,
      changes,
      primary,
      derived,
    },
    byOrigin: [...origins.values()].sort((a, b) => compareOrigin(a.origin, b.origin)),
    components: listed,
    targets,
    warnings,
  }
}

function toComponentImpact(entry: Bucket): ComponentImpact {
  return {
    component: entry.component,
    targets: [...entry.targets].sort(),
    changes: entry.changes,
    primary: entry.primary,
    derived: entry.derived,
    origins: [...entry.origins.values()].sort(compareOrigin),
    causes: [...entry.causes.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, 5)
      .map(({ cause }) => cause),
    examples: entry.examples,
  }
}
