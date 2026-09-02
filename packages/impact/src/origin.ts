import type { OriginKind, OriginPatterns, OriginRef } from './types.js'

/**
 * Glob → RegExp. `**` crosses `/`, `*` does not. Written by hand because the whole
 * matcher is a dozen lines, and a dependency here would be the only one in the
 * package that is neither qain nor Playwright.
 */
export function globToRegExp(glob: string): RegExp {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]!
    if (char === '*') {
      if (glob[i + 1] === '*') {
        out += '.*'
        i++
        // `**/` should also match zero segments, so `**/x.css` matches a bare `x.css`.
        if (glob[i + 1] === '/') i++
      } else {
        out += '[^/]*'
      }
      continue
    }
    if (char === '?') {
      out += '[^/]'
      continue
    }
    out += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${out}$`)
}

/**
 * The package a stylesheet belongs to, from a node_modules path.
 *
 * Takes the *last* `node_modules` segment, so pnpm's
 * `node_modules/.pnpm/@acme+ds@1.2.3/node_modules/@acme/ds/dist/x.css` resolves to
 * `@acme/ds` rather than `.pnpm`. Returns null for the tool directories a bundler
 * leaves in the path, such as Vite's `node_modules/.vite/deps`.
 */
export function packageNameFrom(url: string): string | null {
  const segments = url.split('/')
  const at = segments.lastIndexOf('node_modules')
  if (at === -1) return null

  const first = segments[at + 1]
  if (!first || first.startsWith('.')) return null
  if (!first.startsWith('@')) return first

  const second = segments[at + 2]
  return second ? `${first}/${second}` : first
}

/** Drop the origin from an absolute URL, so reports stay readable. */
export function shorten(url: string): string {
  try {
    return new URL(url).pathname || url
  } catch {
    return url
  }
}

/**
 * Which bucket a stylesheet falls into. Patterns match against the full URL, so a
 * team can name their bundle output when the bundler has erased the node_modules
 * path — `assets/index-*.css` inlines the design system and loses every trace of
 * where those rules came from.
 */
export function classifyOrigin(url: string | null, patterns: OriginPatterns): OriginRef {
  if (!url) return { kind: 'unknown', name: 'unknown' }

  if (patterns.library.some((glob) => globToRegExp(glob).test(url))) {
    return { kind: 'library', name: packageNameFrom(url) ?? shorten(url) }
  }
  if (patterns.theme.some((glob) => globToRegExp(glob).test(url))) {
    return { kind: 'theme', name: shorten(url) }
  }
  return { kind: 'local', name: shorten(url) }
}

/** Stable identity for grouping. */
export function originId(origin: OriginRef): string {
  return `${origin.kind} ${origin.name}`
}

const ORDER: Record<OriginKind, number> = { library: 0, theme: 1, local: 2, unknown: 3 }

/** Libraries first: a design-system change is the one a reviewer cannot see locally. */
export function compareOrigin(a: OriginRef, b: OriginRef): number {
  return ORDER[a.kind] - ORDER[b.kind] || a.name.localeCompare(b.name)
}
