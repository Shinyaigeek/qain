export { capture, type CaptureOptions } from './capture.js'
export type { CdpSession } from './cdp.js'
export {
  composite,
  computeContrast,
  contrastRatio,
  crossedThreshold,
  isLargeText,
  parseColor,
  relativeLuminance,
  THRESHOLDS,
  type Rgba,
} from './contrast.js'
export { diff, type DiffOptions } from './diff.js'
export {
  type Attribution,
  type DeclarationChange,
  describeCause,
  explain,
  type ExplainOptions,
} from './explain.js'
export { absoluteKey, assignKeys, relativeKey } from './identity.js'
export {
  BOX_DERIVED_PROPERTIES,
  CURRENT_COLOR_PROPERTIES,
  DEFAULT_BOX_TOLERANCE,
  DEFAULT_EXCLUDED_ATTRIBUTES,
  DEFAULT_IGNORED_ATTRIBUTES,
  DEFAULT_IGNORED_PROPERTIES,
  DEFAULT_INTERACTIVE_SELECTOR,
  DEFAULT_PROJECTION,
  GEOMETRIC_PROPERTIES,
  NON_RENDERED_TAGS,
} from './projection.js'
export { formatHtml, formatText } from './report.js'
export { renderReplay, renderReplayDiff, type ReplayOptions } from './replay.js'
export {
  captureRules,
  type CaptureRulesOptions,
  type Declaration,
  formatSource,
  type Origin,
  precedence,
  type RuleIndex,
  type SourceLocation,
  winner,
} from './rules.js'
export {
  type Box,
  type CapturedState,
  type Cause,
  type Change,
  type ChangeKind,
  type Diff,
  type DiffSummary,
  FORMAT_VERSION,
  isDerived,
  PSEUDO_STATES,
  type PseudoState,
  type QainNode,
  type Snapshot,
  type StateName,
  type TextRun,
} from './types.js'
