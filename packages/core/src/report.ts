import { type Attribution, describeCause } from './explain.js'
import { formatSource } from './rules.js'
import { type Change, changeId, type Diff, isDerived } from './types.js'

/**
 * Renders a diff for a terminal. Primary changes first — the whole reason qain
 * separates them is so that a reader can stop after the first section.
 */
export function formatText(diff: Diff, options: { color?: boolean } = {}): string {
  const c = options.color ?? true
  const dim = (s: string) => (c ? `\x1b[2m${s}\x1b[0m` : s)
  const bold = (s: string) => (c ? `\x1b[1m${s}\x1b[0m` : s)
  const red = (s: string) => (c ? `\x1b[31m${s}\x1b[0m` : s)
  const green = (s: string) => (c ? `\x1b[32m${s}\x1b[0m` : s)
  const yellow = (s: string) => (c ? `\x1b[33m${s}\x1b[0m` : s)

  const lines: string[] = []

  if (diff.changes.length === 0) {
    lines.push(green('No changes.'))
    for (const warning of diff.warnings) lines.push(yellow(`warning: ${warning}`))
    return lines.join('\n')
  }

  const primary = diff.changes.filter((x) => !isDerived(x))
  const derived = diff.changes.filter(isDerived)
  const byKeyAttribution = indexAttributions(diff.attributions)

  const byState = new Map<string, Change[]>()
  for (const change of primary) {
    const list = byState.get(change.state) ?? []
    list.push(change)
    byState.set(change.state, list)
  }

  for (const [state, changes] of byState) {
    lines.push(bold(state === 'default' ? 'default state' : `:${state}`))
    const byPath = new Map<string, Change[]>()
    for (const change of changes) {
      const list = byPath.get(change.path) ?? []
      list.push(change)
      byPath.set(change.path, list)
    }
    for (const [path, group] of byPath) {
      lines.push(`  ${path}`)
      for (const change of group) lines.push(`    ${describe(change, { red, green, dim, yellow })}`)
      for (const line of causeLines(byKeyAttribution, group)) lines.push(dim(`    ${line}`))
    }
    lines.push('')
  }

  if (derived.length > 0) {
    lines.push(
      dim(
        `${derived.length} derived change${derived.length === 1 ? '' : 's'} (a consequence of the above)`,
      ),
    )
    for (const change of derived.slice(0, 10)) {
      lines.push(dim(`  ${change.path}  ${describe(change, { red, green, dim, yellow })}`))
    }
    if (derived.length > 10) lines.push(dim(`  ... and ${derived.length - 10} more`))
    lines.push('')
  }

  for (const warning of diff.warnings) lines.push(yellow(`warning: ${warning}`))

  const { summary } = diff
  lines.push(
    `${summary.total} change${summary.total === 1 ? '' : 's'}: ` +
      `${summary.primary} primary, ${summary.derived} derived`,
  )
  return lines.join('\n')
}

function indexAttributions(attributions: Attribution[]): Map<string, Attribution> {
  return new Map(attributions.map((a) => [changeId(a.state, a.key), a]))
}

/**
 * The `← ` lines under a change: which declaration moved, and where it lives.
 * Emitted once per node, not once per change, since one `padding` edit shows up as
 * both a resize and a shift.
 */
function causeLines(index: Map<string, Attribution>, group: Change[]): string[] {
  const first = group[0]
  const attribution = first ? index.get(changeId(first.state, first.key)) : undefined
  if (!attribution) return []

  // Silence here would read as "no cause", when it means "the cause is not CSS" \u2014
  // a longer label, an injected element, a rule that stopped matching.
  if (attribution.unattributed) return ['\u2190 no CSS declaration on this node changed']

  return attribution.causes.map((cause) => {
    const site = cause.after ?? cause.before
    const where = site?.inline ? 'style attribute' : formatSource(site?.source ?? null)
    return `\u2190 ${describeCause(cause)}  ${where}`
  })
}

type Paint = Record<'red' | 'green' | 'dim' | 'yellow', (s: string) => string>

function describe(change: Change, paint: Paint): string {
  switch (change.kind) {
    case 'added':
      return paint.green(`+ added  <${change.node.tag}>`)
    case 'removed':
      return paint.red(`- removed  <${change.node.tag}>`)
    case 'style': {
      const body = `${change.property}: ${paint.red(change.before ?? '<unset>')} → ${paint.green(change.after ?? '<unset>')}`
      return change.cause === 'derived' ? paint.dim(`${body}  (follows color)`) : body
    }
    case 'attr':
      return `[${change.attribute}]: ${paint.red(change.before ?? '<unset>')} → ${paint.green(change.after ?? '<unset>')}`
    case 'text':
      return `text: ${paint.red(JSON.stringify(change.before ?? ''))} → ${paint.green(JSON.stringify(change.after ?? ''))}`
    case 'box': {
      const { dx, dy, dw, dh } = change.delta
      const parts: string[] = []
      if (dx || dy) parts.push(`moved ${signed(dx)}, ${signed(dy)}`)
      if (dw || dh) parts.push(`resized ${signed(dw)} × ${signed(dh)}`)
      const body = parts.join('; ') || 'box changed'
      return change.cause === 'derived' ? paint.dim(body) : body
    }
    case 'paint-order':
      return paint.yellow(`paint order: ${change.before} → ${change.after} (stacking changed)`)
    case 'contrast': {
      const arrow = `contrast ${change.before} → ${change.after}`
      return change.crosses ? paint.red(`${arrow}  ✗ falls below WCAG ${change.crosses}`) : arrow
    }
  }
}

function signed(value: number): string {
  return value > 0 ? `+${value}px` : `${value}px`
}

// ---------------------------------------------------------------------------

/**
 * A standalone HTML report, inlined so it can be attached to a Playwright run
 * or opened straight off disk with no server.
 */
export function formatHtml(diff: Diff): string {
  const primary = diff.changes.filter((x) => !isDerived(x))
  const derived = diff.changes.filter(isDerived)

  const index = indexAttributions(diff.attributions)
  const rows = (changes: Change[], withCauses: boolean) => {
    // One padding edit surfaces as both a resize and a shift. Name its cause once.
    const explained = new Set<string>()
    return changes
      .map((change) => {
        const id = changeId(change.state, change.key)
        const shown = withCauses && !explained.has(id)
        if (shown) explained.add(id)
        const attribution = shown ? index.get(id) : undefined
        const causes = !attribution
          ? ''
          : attribution.unattributed
            ? '<div class="cause">\u2190 no CSS declaration on this node changed</div>'
            : `<div class="cause">${attribution.causes
                .map((cause) => {
                  const site = cause.after ?? cause.before
                  const where = site?.inline
                    ? 'style attribute'
                    : formatSource(site?.source ?? null)
                  return `\u2190 <code>${esc(describeCause(cause))}</code> <span class="where">${esc(where)}</span>`
                })
                .join('<br>')}</div>`
        return `<tr class="k-${change.kind}">
      <td class="state">${esc(change.state)}</td>
      <td class="path"><code>${esc(change.path)}</code></td>
      <td class="kind">${esc(change.kind)}</td>
      <td class="detail">${htmlDetail(change)}${causes}</td>
    </tr>`
      })
      .join('\n')
  }

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>qain diff — ${esc(diff.after.title || diff.after.url)}</title>
<style>
  :root { color-scheme: light dark; --bg:#fff; --fg:#111; --dim:#666; --line:#e5e5e5;
          --add:#0a7c3e; --del:#c0392b; --warn:#b7791f; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#111; --fg:#eee; --dim:#999; --line:#2a2a2a; --add:#4ade80; --del:#f87171; --warn:#fbbf24; }
  }
  body { margin:0; padding:2rem; background:var(--bg); color:var(--fg);
         font:14px/1.6 ui-sans-serif, system-ui, sans-serif; }
  h1 { font-size:1.25rem; margin:0 0 .25rem; }
  .meta { color:var(--dim); margin-bottom:1.5rem; }
  .counts { display:flex; gap:1.5rem; margin-bottom:2rem; }
  .counts div { border:1px solid var(--line); border-radius:6px; padding:.75rem 1.25rem; }
  .counts b { display:block; font-size:1.5rem; }
  h2 { font-size:1rem; margin:2rem 0 .5rem; }
  h2 small { color:var(--dim); font-weight:400; }
  .scroll { overflow-x:auto; }
  table { border-collapse:collapse; width:100%; min-width:640px; }
  td, th { text-align:left; padding:.4rem .6rem; border-bottom:1px solid var(--line); vertical-align:top; }
  code { font:12px/1.5 ui-monospace, monospace; }
  .state { color:var(--dim); white-space:nowrap; }
  .kind { color:var(--dim); white-space:nowrap; }
  .before { color:var(--del); }
  .after { color:var(--add); }
  .swatch { display:inline-block; width:.8em; height:.8em; border:1px solid var(--line);
            vertical-align:-1px; margin-right:.25em; border-radius:2px; }
  .fail { color:var(--del); font-weight:600; }
  .warn { color:var(--warn); }
  .empty { color:var(--dim); }
  details summary { cursor:pointer; color:var(--dim); }
  .cause { margin-top:.3rem; color:var(--dim); font-size:12px; }
  .where { opacity:.75; }
</style></head><body>
<h1>qain diff</h1>
<div class="meta"><code>${esc(diff.before.url)}</code> → <code>${esc(diff.after.url)}</code></div>

<div class="counts">
  <div><b>${diff.summary.total}</b> changes</div>
  <div><b>${diff.summary.primary}</b> primary</div>
  <div><b class="empty">${diff.summary.derived}</b> derived</div>
</div>

${diff.warnings.length ? `<div class="warn">${diff.warnings.map((w) => `⚠ ${esc(w)}`).join('<br>')}</div>` : ''}

<h2>Primary <small>— the node itself changed</small></h2>
${primary.length ? `<div class="scroll"><table>${rows(primary, true)}</table></div>` : '<p class="empty">None.</p>'}

<h2>Derived <small>— a consequence of a change above</small></h2>
${
  derived.length
    ? `<details><summary>${derived.length} change${derived.length === 1 ? '' : 's'}</summary>
       <div class="scroll"><table>${rows(derived, false)}</table></div></details>`
    : '<p class="empty">None.</p>'
}
</body></html>`
}

function htmlDetail(change: Change): string {
  switch (change.kind) {
    case 'added':
      return `<span class="after">&lt;${esc(change.node.tag)}&gt;</span>`
    case 'removed':
      return `<span class="before">&lt;${esc(change.node.tag)}&gt;</span>`
    case 'style':
      return `<code>${esc(change.property)}</code>: ${swatch(change.before)}<span class="before">${esc(change.before ?? '—')}</span> → ${swatch(change.after)}<span class="after">${esc(change.after ?? '—')}</span>`
    case 'attr':
      return `<code>[${esc(change.attribute)}]</code>: <span class="before">${esc(change.before ?? '—')}</span> → <span class="after">${esc(change.after ?? '—')}</span>`
    case 'text':
      return `<span class="before">${esc(change.before ?? '')}</span> → <span class="after">${esc(change.after ?? '')}</span>`
    case 'box': {
      const { dx, dy, dw, dh } = change.delta
      const parts: string[] = []
      if (dx || dy) parts.push(`moved ${signed(dx)}, ${signed(dy)}`)
      if (dw || dh) parts.push(`resized ${signed(dw)} × ${signed(dh)}`)
      return esc(parts.join('; ') || 'box changed')
    }
    case 'paint-order':
      return `stacking order ${change.before} → ${change.after}`
    case 'contrast': {
      const body = `${swatch(change.foreground)}on${swatch(change.background)} — ratio ${change.before} → ${change.after}`
      return change.crosses
        ? `<span class="fail">${body} · falls below WCAG ${esc(change.crosses)}</span>`
        : body
    }
  }
}

/** Only inline a swatch for values that are unambiguously colors. */
function swatch(value: string | undefined): string {
  if (!value || !/^rgba?\(/.test(value)) return ''
  return `<span class="swatch" style="background:${esc(value)}"></span>`
}

function esc(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&quot;'
      default:
        return '&#39;'
    }
  })
}
