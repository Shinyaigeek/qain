export { buildReport, componentOf, type TargetResult } from './aggregate.js'
export { captureTarget, withBrowser } from './capture.js'
export {
  baselineName,
  ConfigError,
  DEFAULT_CONFIG,
  DEFAULT_CONFIG_FILE,
  loadConfig,
  targetUrl,
} from './config.js'
export {
  classifyOrigin,
  compareOrigin,
  globToRegExp,
  originId,
  packageNameFrom,
  shorten,
} from './origin.js'
export { type FormatOptions, formatImpactMarkdown, formatImpactText } from './report.js'
export { baselinePath, type RunOptions, runImpact, updateBaselines } from './run.js'
export { composeDiff, hasTextRuns, renderShots, type Shots } from './shots.js'
export {
  type CauseRef,
  type ComponentImpact,
  type ImpactConfig,
  type ImpactReport,
  type ImpactSummary,
  type OriginImpact,
  type OriginKind,
  type OriginPatterns,
  type OriginRef,
  REPORT_VERSION,
  type TargetConfig,
  type TargetImpact,
  type TargetStatus,
  UNGROUPED,
} from './types.js'
