export { type CaptureOptions, capture } from './capture.js'
export { type CaptureDomOptions, captureDom } from './capture-dom.js'
export type { CdpSession } from './cdp.js'
export {
  composite,
  computeContrast,
  contrastRatio,
  crossedThreshold,
  isLargeText,
  parseColor,
  type Rgba,
  relativeLuminance,
  THRESHOLDS,
} from './contrast.js'
export { type DiffOptions, diff } from './diff.js'
export {
  type Attribution,
  type DeclarationChange,
  describeCause,
  type ExplainOptions,
  explain,
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
export { type ReplayOptions, renderReplay, renderReplayDiff } from './replay.js'
export { formatHtml, formatText } from './report.js'
export {
  type CaptureRulesOptions,
  captureRules,
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
