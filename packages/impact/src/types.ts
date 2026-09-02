import type { PseudoState } from '@qain/core'

/** Bumped with the on-disk report shape. Tracks @qain/core's snapshot version. */
export const REPORT_VERSION = 2

/**
 * Where a change came from, decided by the stylesheet that carried the winning
 * declaration — not by reading the PR's file list.
 *
 * This is the whole point of doing impact analysis inside qain rather than over a
 * module graph. A PR that edits one component can still turn out to be 80% library
 * churn, and only the browser knows that.
 */
export type OriginKind = 'library' | 'theme' | 'local' | 'unknown'

export interface OriginRef {
  kind: OriginKind
  /**
   * `@acme/ds` for a library — the package name, recovered from the node_modules
   * path. The stylesheet path for a theme or local file. `unknown` when the
   * declaration has no source location, which is what runtime-injected CSS-in-JS
   * looks like from CDP.
   */
  name: string
}

/** One named cause: the declaration that moved, and the file it lives in. */
export interface CauseRef {
  origin: OriginRef
  property: string
  selector: string | null
  before: string | undefined
  after: string | undefined
  /** `button.css:14:3`, or `<unknown>`. */
  source: string
}

export interface ComponentImpact {
  /**
   * The grouping attribute's value on the nearest ancestor — a design-system
   * component name, not an application file. `UNGROUPED` when nothing above the
   * changed node carried the attribute.
   */
  component: string
  /** Target names this component changed in. */
  targets: string[]
  changes: number
  primary: number
  derived: number
  /** Deduped origins across every cause attributed to this component. */
  origins: OriginRef[]
  /** Deduped causes, most frequent first. */
  causes: CauseRef[]
  /** A few node paths, so a human can find one instance. */
  examples: string[]
}

export type TargetStatus = 'changed' | 'unchanged' | 'missing-baseline' | 'error'

export interface TargetImpact {
  name: string
  url: string
  status: TargetStatus
  changes: number
  primary: number
  derived: number
  /** Components that changed here, most changes first. */
  components: string[]
  /** Set when status is 'error'. */
  error?: string
}

export interface OriginImpact {
  origin: OriginRef
  changes: number
  components: string[]
  targets: string[]
}

export interface ImpactSummary {
  targets: number
  targetsChanged: number
  missingBaselines: number
  errors: number
  components: number
  changes: number
  primary: number
  derived: number
}

export interface ImpactReport {
  qain: typeof REPORT_VERSION
  generatedAt: string
  summary: ImpactSummary
  /** Grouped by where the cause lives. The headline of the report. */
  byOrigin: OriginImpact[]
  components: ComponentImpact[]
  targets: TargetImpact[]
  warnings: string[]
}

// ---------------------------------------------------------------------------

export interface TargetConfig {
  /** Stable id. Names the baseline file, so changing it orphans the baseline. */
  name: string
  /** Resolved against `baseUrl`. Ignored when `url` is set. */
  path?: string
  /** Absolute URL. Wins over `path`. */
  url?: string
  /** Scope the capture to one subtree, e.g. a Storybook canvas root. */
  selector?: string
  /** Overrides the top-level `states`. */
  states?: PseudoState[]
  /** Wait for this selector before capturing. */
  waitFor?: string
  /** Settle time in ms after load. */
  wait?: number
  viewport?: { width: number; height: number }
}

export interface OriginPatterns {
  /**
   * Globs matched against the stylesheet URL. `**` crosses path separators, `*`
   * does not. Defaults catch a node_modules path; a bundler that inlines the
   * design system into `assets/index-<hash>.css` erases that path, so teams that
   * bundle need to name their own output here.
   */
  library: string[]
  theme: string[]
}

export interface ImpactConfig {
  /** Prefixed to every target's `path`. */
  baseUrl?: string
  /** Where `*.qain.json` baselines live. Committed, like @qain/storybook's. */
  baselineDir: string
  targets: TargetConfig[]
  /**
   * Attributes carrying a component name, tried in order on each ancestor. The
   * design system stamps one of these on its own root elements — one line per
   * component, in a repository the team already owns.
   */
  componentAttributes: string[]
  origins: OriginPatterns
  viewport: { width: number; height: number }
  /**
   * Extra pseudo-states to force and capture. The resting state is always
   * captured, so this list adds to it rather than replacing it.
   */
  states: PseudoState[]
  /** Drop collateral movement from the report. Counts still include it. */
  omitDerived: boolean
  /** Chromium executable, when not using the bundled one. */
  browser?: string
}

/** The label used when no ancestor carried a component attribute. */
export const UNGROUPED = '(ungrouped)'
