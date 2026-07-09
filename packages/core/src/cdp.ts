/**
 * qain talks to Chromium over the DevTools Protocol and nothing else.
 *
 * The interface is structural on purpose: Playwright's CDPSession, Puppeteer's
 * CDPSession, and a raw WebSocket client all satisfy it. Nothing in @qain/core
 * imports Playwright.
 *
 * Chromium only, by design. DOMSnapshot.captureSnapshot and CSS.forcePseudoState
 * have no equivalent in Firefox or WebKit, and they are the two calls qain is
 * built on.
 */
export interface CdpSession {
  send(method: string, params?: Record<string, unknown>): Promise<any>
  /**
   * Optional. Only `capture({ rules: true })` needs it, to collect
   * `CSS.styleSheetAdded` and learn each stylesheet's URL — there is no command
   * that returns a stylesheet header. Without it, rules still carry their
   * selector, but no `file:line`.
   */
  on?(event: string, handler: (params: any) => void): void
}

// ---------------------------------------------------------------------------
// The slices of the protocol qain reads. Hand-written rather than pulled from
// devtools-protocol so core stays dependency-free.
// ---------------------------------------------------------------------------

/** Sparse map from array index to value, used for fields most nodes lack. */
export interface RareStringData {
  index: number[]
  value: number[]
}
export interface RareBooleanData {
  index: number[]
}
export interface RareIntegerData {
  index: number[]
  value: number[]
}

export interface NodeTreeSnapshot {
  parentIndex: number[]
  nodeType: number[]
  nodeName: number[]
  nodeValue: number[]
  backendNodeId: number[]
  /** Flat [nameIdx, valueIdx, ...] per node. */
  attributes: number[][]
  textValue?: RareStringData
  inputValue?: RareStringData
  pseudoType?: RareStringData
  isClickable?: RareBooleanData
  contentDocumentIndex?: RareIntegerData
}

export interface LayoutTreeSnapshot {
  /** Index into NodeTreeSnapshot arrays. */
  nodeIndex: number[]
  /** Per layout object, one string-table index per requested computed style, in request order. */
  styles: number[][]
  bounds: number[][]
  text: number[]
  stackingContexts: RareBooleanData
  paintOrders?: number[]
  offsetRects?: number[][]
  scrollRects?: number[][]
  clientRects?: number[][]
  /** String-table indexes; -1 where absent. Populated for text-bearing nodes. */
  blendedBackgroundColors?: number[]
  textColorOpacities?: number[]
}

export interface TextBoxSnapshot {
  /** Index into LayoutTreeSnapshot arrays — the text node this run belongs to. */
  layoutIndex: number[]
  bounds: number[][]
  /** Offset and length into that layout object's text. One entry per rendered line. */
  start: number[]
  length: number[]
}

export interface DocumentSnapshot {
  documentURL: number
  title: number
  baseURL: number
  contentLanguage: number
  encodingName: number
  nodes: NodeTreeSnapshot
  layout: LayoutTreeSnapshot
  textBoxes: TextBoxSnapshot
  scrollOffsetX: number
  scrollOffsetY: number
  contentWidth?: number
  contentHeight?: number
}

export interface CaptureSnapshotResult {
  documents: DocumentSnapshot[]
  strings: string[]
}

export interface AxNode {
  nodeId: string
  ignored: boolean
  role?: { value?: string }
  name?: { value?: string }
  backendDOMNodeId?: number
}

// --- CSS domain, for rule attribution --------------------------------------

export interface SourceRange {
  startLine: number
  startColumn: number
  endLine: number
  endColumn: number
}

export interface CssProperty {
  name: string
  value: string
  important?: boolean
  /** Chromium synthesised this from a shorthand rather than the author writing it. */
  implicit?: boolean
  text?: string
  parsedOk?: boolean
  /** Lost the cascade within its own rule, or is commented out. */
  disabled?: boolean
  range?: SourceRange
  /** Present on shorthands: the longhands this expands to. */
  longhandProperties?: { name: string; value: string }[]
}

export interface RuleMatch {
  rule: {
    styleSheetId?: string
    origin: 'regular' | 'user-agent' | 'injected' | 'inspector'
    selectorList?: { text?: string }
    style?: { cssProperties?: CssProperty[] }
  }
  matchingSelectors: number[]
}

export interface StyleSheetHeader {
  styleSheetId: string
  sourceURL?: string
  isInline?: boolean
  /** Where the `<style>` element starts in the host document. */
  startLine?: number
  startColumn?: number
}

/** Resolve a sparse entry, or undefined if this index has none. */
export function rare(
  data: RareStringData | RareIntegerData | undefined,
  i: number,
): number | undefined {
  if (!data) return undefined
  const at = data.index.indexOf(i)
  return at === -1 ? undefined : data.value[at]
}

export function rareBool(data: RareBooleanData | undefined, i: number): boolean {
  return data ? data.index.includes(i) : false
}

/** Resolve a string-table index, treating -1 and undefined as absent. */
export function str(strings: string[], i: number | undefined): string | undefined {
  if (i === undefined || i < 0) return undefined
  return strings[i]
}
