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

export interface DocumentSnapshot {
  documentURL: number
  title: number
  baseURL: number
  contentLanguage: number
  encodingName: number
  nodes: NodeTreeSnapshot
  layout: LayoutTreeSnapshot
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
