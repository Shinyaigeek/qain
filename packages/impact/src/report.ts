import type { CauseRef, ComponentImpact, ImpactReport, OriginRef, TargetImpact } from './types.js'

export interface FormatOptions {
  color?: boolean
}

const ANSI = {
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
  reset: '\x1b[0m',
}

function paint(text: string, code: string, color: boolean): string {
  return color ? `${code}${text}${ANSI.reset}` : text
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length)
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

function describeCause(cause: CauseRef): string {
  const selector = cause.selector ?? 'inline style'
  const from = cause.before ?? '(unset)'
  const to = cause.after ?? '(unset)'
  return `${selector} { ${cause.property}: ${from} → ${to} }  ${cause.source}`
}

function label(origin: OriginRef): string {
  return `${origin.kind}:${origin.name}`
}

const STATUS_TEXT: Record<TargetImpact['status'], string> = {
  changed: 'changed',
  unchanged: 'unchanged',
  'missing-baseline': 'no baseline',
  error: 'error',
}

/**
 * The terminal report. Origins first, because "this PR is 80% design-system churn"
 * is the sentence a reviewer needs before any per-component detail.
 */
export function formatImpactText(report: ImpactReport, options: FormatOptions = {}): string {
  const color = options.color ?? false
  const { summary } = report
  const lines: string[] = []

  const headline =
    summary.changes === 0
      ? `qain impact — no change across ${plural(summary.targets, 'target')}`
      : `qain impact — ${summary.targetsChanged} of ${summary.targets} targets changed · ` +
        `${plural(summary.changes, 'change')} (${summary.primary} primary, ${summary.derived} derived)`
  lines.push(paint(headline, ANSI.bold, color))

  if (report.byOrigin.length > 0) {
    lines.push('', 'by origin')
    const width = Math.max(0, ...report.byOrigin.map((o) => label(o.origin).length))
    for (const entry of report.byOrigin) {
      const kind = entry.origin.kind === 'library' ? ANSI.yellow : ANSI.dim
      lines.push(
        `  ${paint(pad(label(entry.origin), width), kind, color)}  ` +
          `${plural(entry.changes, 'change')} · ${plural(entry.components.length, 'component')} · ` +
          `${plural(entry.targets.length, 'target')}`,
      )
    }
  }

  if (report.components.length > 0) {
    lines.push('', 'components')
    for (const component of report.components) {
      lines.push(`  ${paint(component.component, ANSI.bold, color)}  ${countsOf(component)}`)
      lines.push(`    ${paint(`in ${component.targets.join(', ')}`, ANSI.dim, color)}`)
      for (const cause of component.causes) {
        lines.push(
          `    ${paint('←', ANSI.dim, color)} ${describeCause(cause)}  ` +
            paint(`[${label(cause.origin)}]`, ANSI.dim, color),
        )
      }
      for (const example of component.examples.slice(0, 1)) {
        lines.push(`    ${paint(`e.g. ${example}`, ANSI.dim, color)}`)
      }
    }
  }

  lines.push('', 'targets')
  const statusWidth = Math.max(0, ...report.targets.map((t) => STATUS_TEXT[t.status].length))
  const nameWidth = Math.max(0, ...report.targets.map((t) => t.name.length))
  for (const target of report.targets) {
    const code =
      target.status === 'changed'
        ? ANSI.red
        : target.status === 'unchanged'
          ? ANSI.green
          : ANSI.yellow
    let line = `  ${paint(pad(STATUS_TEXT[target.status], statusWidth), code, color)}  ${pad(target.name, nameWidth)}`
    if (target.status === 'changed') {
      line += `  ${plural(target.changes, 'change')} (${target.primary} primary)`
      if (target.components.length > 0) {
        line += `  ${paint(target.components.slice(0, 4).join(', '), ANSI.dim, color)}`
      }
    }
    if (target.error) line += `  ${paint(target.error, ANSI.red, color)}`
    lines.push(line)
  }

  for (const warning of report.warnings) {
    lines.push(paint(`warning: ${warning}`, ANSI.yellow, color))
  }

  return lines.join('\n')
}

function countsOf(component: ComponentImpact): string {
  return `${plural(component.changes, 'change')} (${component.primary} primary)`
}

/** A PR comment. Same information, folded so it does not dominate the thread. */
export function formatImpactMarkdown(report: ImpactReport): string {
  const { summary } = report
  const out: string[] = ['### qain impact', '']

  if (summary.changes === 0) {
    out.push(`No style change across ${plural(summary.targets, 'target')}.`)
    return `${out.join('\n')}\n`
  }

  out.push(
    `**${summary.targetsChanged} of ${summary.targets} targets changed** — ` +
      `${plural(summary.changes, 'change')} (${summary.primary} primary, ${summary.derived} derived) ` +
      `across ${plural(summary.components, 'component')}.`,
    '',
    '| origin | changes | components | targets |',
    '| --- | ---: | ---: | ---: |',
  )
  for (const entry of report.byOrigin) {
    out.push(
      `| \`${label(entry.origin)}\` | ${entry.changes} | ${entry.components.length} | ${entry.targets.length} |`,
    )
  }

  if (report.components.length > 0) {
    out.push('', '<details><summary>Components</summary>', '')
    for (const component of report.components) {
      out.push(
        `**${component.component}** — ${countsOf(component)} in ${component.targets.join(', ')}`,
      )
      for (const cause of component.causes) out.push(`- \`${describeCause(cause)}\``)
      out.push('')
    }
    out.push('</details>')
  }

  const notable = report.targets.filter((t) => t.status !== 'unchanged')
  if (notable.length > 0) {
    out.push(
      '',
      '<details><summary>Targets</summary>',
      '',
      '| target | status | changes |',
      '| --- | --- | ---: |',
    )
    for (const target of notable) {
      out.push(`| ${target.name} | ${STATUS_TEXT[target.status]} | ${target.changes} |`)
    }
    out.push('', '</details>')
  }

  for (const warning of report.warnings) out.push('', `> ⚠️ ${warning}`)

  return `${out.join('\n')}\n`
}
