/**
 * Element identity across snapshots.
 *
 * A CSS path (`div > div:nth-child(3) > button`) breaks the moment anyone inserts
 * a sibling: every following element shifts, and a one-line change reports as a
 * rewritten subtree. Positional matching has the same failure. So qain keys nodes
 * by the most stable thing each one offers, in this order:
 *
 *   1. `data-testid` — put there precisely to be stable. Document-unique, so the
 *      key is absolute and survives being moved anywhere in the tree.
 *   2. `id` — also document-unique, also absolute.
 *   3. role + accessible name — from the AX tree. Stable across refactors that
 *      change tags and classes but not what the thing *is*. Scoped to the parent
 *      key, because two "Submit" buttons can coexist.
 *   4. tag + ordinal among like siblings — the fallback. Positional, and brittle
 *      in the same way everything positional is brittle, but only within one
 *      parent rather than across the whole document.
 */

export interface IdentityInput {
  tag: string
  pseudo?: string
  attrs: Record<string, string>
  role?: string
  name?: string
}

const TESTID_ATTRS = ['data-testid', 'data-test-id', 'data-test', 'data-qa']

/** Roles too generic to identify anything. Fall through to the tag ordinal. */
const WEAK_ROLES = new Set(['generic', 'none', 'presentation', 'GenericContainer', 'InlineTextBox'])

function testId(attrs: Record<string, string>): string | undefined {
  for (const attr of TESTID_ATTRS) {
    const value = attrs[attr]
    if (value) return value
  }
  return undefined
}

/**
 * A key that identifies the node on its own, independent of where it sits.
 * Only `data-testid` and `id` qualify — both are document-unique by contract.
 */
export function absoluteKey(node: IdentityInput): string | undefined {
  if (node.pseudo) return undefined
  const tid = testId(node.attrs)
  if (tid) return `@${tid}`
  if (node.attrs.id) return `#${node.attrs.id}`
  return undefined
}

/**
 * A key that identifies the node among its siblings. `ordinal` disambiguates
 * nodes that produce the same token, and is assigned by the caller, which is the
 * only place that can see the sibling set.
 */
export function relativeKey(node: IdentityInput, ordinal: number): string {
  if (node.pseudo) return `::${node.pseudo}`

  const role = node.role
  const name = node.name?.trim()
  const token =
    role && !WEAK_ROLES.has(role) && name
      ? `${role}[${JSON.stringify(name)}]`
      : role && !WEAK_ROLES.has(role)
        ? `${role}`
        : node.tag.toLowerCase()

  return ordinal === 0 ? token : `${token}(${ordinal})`
}

export interface KeyedTree {
  keys: string[]
  /** Position among siblings that produced the same relative token. 0 for the first. */
  ordinals: number[]
}

/**
 * Assigns keys to a tree, given each node's parent. `parents[i]` is the index of
 * node `i`'s parent, or -1 for a root. Nodes must be in document order, so a
 * parent is always keyed before its children.
 */
export function assignKeys(nodes: IdentityInput[], parents: number[]): KeyedTree {
  const keys: string[] = new Array(nodes.length)
  const ordinals: number[] = new Array(nodes.length).fill(0)
  /** Per parent, how many children have already produced each relative token. */
  const seen = new Map<number, Map<string, number>>()

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!
    const absolute = absoluteKey(node)
    if (absolute) {
      keys[i] = absolute
      continue
    }

    const parent = parents[i] ?? -1
    const parentKey = parent >= 0 ? keys[parent] : undefined

    let counts = seen.get(parent)
    if (!counts) {
      counts = new Map()
      seen.set(parent, counts)
    }
    const base = relativeKey(node, 0)
    const ordinal = counts.get(base) ?? 0
    counts.set(base, ordinal + 1)
    ordinals[i] = ordinal

    const token = relativeKey(node, ordinal)
    keys[i] = parentKey ? `${parentKey}/${token}` : token
  }

  return { keys, ordinals }
}

/**
 * Human-readable trail for reports. Never used for matching.
 *
 * It carries the same sibling ordinal the key does. Without it, `.stack` and
 * `.panel` both render as `html > body > div` and a reader cannot tell which row
 * of the report refers to which element.
 */
export function displayPath(
  nodes: IdentityInput[],
  parents: number[],
  ordinals: number[],
  i: number,
): string {
  const parts: string[] = []
  let cursor: number | undefined = i
  while (cursor !== undefined && cursor >= 0) {
    const node = nodes[cursor]!
    const tid = testId(node.attrs)
    let part: string
    if (node.pseudo) {
      part = `::${node.pseudo}`
    } else {
      part = node.tag.toLowerCase()
      if (tid) part += `[data-testid=${tid}]`
      else if (node.attrs.id) part += `#${node.attrs.id}`
      else if ((ordinals[cursor] ?? 0) > 0) part += `(${ordinals[cursor]})`
    }
    parts.unshift(part)
    const next: number | undefined = parents[cursor]
    cursor = next !== undefined && next >= 0 ? next : undefined
  }
  return parts.join(' > ')
}
