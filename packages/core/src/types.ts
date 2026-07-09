import type { Attribution } from './explain.js'
import type { RuleIndex } from './rules.js'

/** Bumped whenever the on-disk snapshot shape changes incompatibly. */
export const FORMAT_VERSION = 1

/**
 * Pseudo-classes qain can force via CSS.forcePseudoState. `visited` is omitted:
 * Chromium deliberately lies about :visited styles to prevent history sniffing,
 * so any snapshot of it would be fiction.
 */
export const PSEUDO_STATES = [
  'hover',
  'focus',
  'focus-visible',
  'focus-within',
  'active',
  'target',
] as const
export type PseudoState = (typeof PSEUDO_STATES)[number]

export type StateName = 'default' | PseudoState

/** [x, y, width, height] in document coordinates, CSS pixels. */
export type Box = [number, number, number, number]

/**
 * One rendered line of text, at the rectangle the browser put it in.
 *
 * This is what makes replay possible without recording `padding`. A button's text
 * run sits at the border box plus its border and padding — the offset *is* the
 * padding, already resolved. Recorded only with `capture({ replay: true })`, and
 * never compared: a text run is a consequence of the box, not a fact about it.
 */
export interface TextRun {
  box: Box
  text: string
}

export interface QainNode {
  /**
   * Identity across snapshots. Stable under sibling insertion, unlike a CSS path.
   * See identity.ts for how it is derived.
   */
  key: string
  /** Key of the parent element. Absent on roots. Lets the diff reason about causality. */
  parent?: string
  /** Human-readable location, for report output only. Never compared. */
  path: string
  tag: string
  /** 'before' | 'after' | 'marker' | ... — present only for pseudo-elements. */
  pseudo?: string
  role?: string
  /** Accessible name, from the AX tree. */
  name?: string
  attrs: Record<string, string>
  text?: string
  styles: Record<string, string>
  box: Box | null
  /** Higher = painted later = on top. Reflects stacking order, not DOM order. */
  paintOrder?: number
  stackingContext?: boolean
  /** Composited background color — what the pixels actually are. Text-bearing nodes only. */
  blendedBackground?: string
  textOpacity?: number
  /** Per-line text rectangles, for replay. Present only with `capture({ replay: true })`. */
  textRuns?: TextRun[]
}

export interface CapturedState {
  state: StateName
  /**
   * How the pseudo-state was captured. 'bulk' forces every candidate at once and
   * takes a single snapshot. 'isolated' forces one node at a time — correct when a
   * pseudo-class changes layout, because a growing element displaces its siblings.
   */
  strategy?: 'bulk' | 'isolated'
  nodes: QainNode[]
}

export interface Snapshot {
  qain: typeof FORMAT_VERSION
  url: string
  title: string
  viewport: { width: number; height: number }
  /** The computed-style properties this snapshot recorded. Diffing is scoped to these. */
  projection: string[]
  states: CapturedState[]
  /**
   * Matched author declarations per node, for the default state. Present only when
   * captured with `rules: true`. Lets a diff say which rule caused each change.
   */
  rules?: RuleIndex
  warnings: string[]
}

/**
 * 'primary' — this node is a cause. Its own styles, attributes or text changed,
 *   or its box changed size for reasons of its own. Note that the projection
 *   deliberately omits `padding`, `margin` and `width`, so a button that grows
 *   has no style change to point at — its changed *size* is the evidence.
 * 'derived' — this node is a consequence. It only moved, or it only resized to
 *   fit a child that changed.
 *
 * Nearly all diff noise is derived. Separating the two is the point of qain.
 */
export type Cause = 'primary' | 'derived'

interface ChangeBase {
  state: StateName
  key: string
  path: string
}

export type Change =
  | (ChangeBase & { kind: 'added'; node: QainNode })
  | (ChangeBase & { kind: 'removed'; node: QainNode })
  | (ChangeBase & {
      kind: 'style'
      property: string
      before: string | undefined
      after: string | undefined
      /** 'derived' when the property merely tracks `color` — see CURRENT_COLOR_PROPERTIES. */
      cause: Cause
    })
  | (ChangeBase & {
      kind: 'attr'
      attribute: string
      before: string | undefined
      after: string | undefined
    })
  | (ChangeBase & { kind: 'text'; before: string | undefined; after: string | undefined })
  | (ChangeBase & {
      kind: 'box'
      before: Box | null
      after: Box | null
      delta: { dx: number; dy: number; dw: number; dh: number }
      cause: Cause
    })
  | (ChangeBase & { kind: 'paint-order'; before: number | undefined; after: number | undefined })
  | (ChangeBase & {
      kind: 'contrast'
      before: number | null
      after: number | null
      /** Set when the change crosses a WCAG threshold, e.g. 'AA-normal'. */
      crosses: string | null
      foreground: string
      background: string
    })

export type ChangeKind = Change['kind']

export interface DiffSummary {
  total: number
  primary: number
  derived: number
  byKind: Record<string, number>
}

export interface Diff {
  qain: typeof FORMAT_VERSION
  before: { url: string; title: string }
  after: { url: string; title: string }
  changes: Change[]
  /** Which CSS declaration caused each primary change. Empty unless both snapshots carry rules. */
  attributions: Attribution[]
  summary: DiffSummary
  warnings: string[]
}

export function isDerived(change: Change): boolean {
  return 'cause' in change && change.cause === 'derived'
}
