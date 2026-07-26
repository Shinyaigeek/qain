// Builds the sticky PR-comment body from per-baseline diff entries. Kept pure
// and free of any GitHub API so it can be run and eyeballed locally:
//
//   node comment.mjs --demo
//
// The marker on the first line is how the action finds its own comment to
// update (or delete) instead of piling on a new one every push.

const PER_FILE_TEXT_LIMIT = 12_000
const BODY_LIMIT = 60_000

/** The hidden anchor the action greps for to manage its own comment. */
export function markerFor(name) {
  return `<!-- qain-report:${name} -->`
}

/**
 * @param entries one per matched baseline file:
 *   { path, status: 'modified'|'added'|'removed'|'error',
 *     renamedFrom?, total?, primary?, derived?, contrast?, text?, error? }
 * Entries with status 'modified' and total 0 are listed in a footnote only.
 */
export function buildComment({ name = 'qain', runUrl = '', hasReport = false, entries = [] }) {
  const reportable = entries.filter((e) => e.status !== 'modified' || e.total > 0)
  const quiet = entries.filter((e) => e.status === 'modified' && e.total === 0)

  const out = [markerFor(name)]
  out.push(`### qain — style diff${name !== 'qain' ? ` · \`${name}\`` : ''}`)
  out.push('')

  const changed = reportable.filter((e) => e.status === 'modified')
  const total = changed.reduce((n, e) => n + e.total, 0)
  const primary = changed.reduce((n, e) => n + (e.primary ?? 0), 0)
  const contrast = changed.reduce((n, e) => n + (e.contrast ?? 0), 0)
  const added = reportable.filter((e) => e.status === 'added').length
  const removed = reportable.filter((e) => e.status === 'removed').length

  const headline = []
  if (total > 0) {
    const contrastNote = contrast
      ? `, ⚠️ ${contrast} contrast regression${contrast === 1 ? '' : 's'}`
      : ''
    headline.push(
      `**${total}** change${total === 1 ? '' : 's'} across ${changed.length} baseline${changed.length === 1 ? '' : 's'} — **${primary}** primary, ${total - primary} derived${contrastNote}`,
    )
  }
  if (added) headline.push(`**${added}** new baseline${added === 1 ? '' : 's'}`)
  if (removed) headline.push(`**${removed}** baseline${removed === 1 ? '' : 's'} deleted`)
  out.push(`🎨 ${headline.join(' · ')}.`)

  for (const e of reportable) {
    out.push('')
    if (e.status === 'added') {
      out.push(`#### \`${e.path}\` — new baseline`)
      out.push('First snapshot for this target; there is no base to diff against.')
      if (e.images?.after) {
        out.push('')
        out.push('| render |')
        out.push('| --- |')
        out.push(`| ![render](${e.images.after}) |`)
      } else if (e.noReplay) {
        out.push('')
        out.push(
          '<sub>No render — capture the baseline with `qain snap --replay` to embed a screenshot.</sub>',
        )
      }
      continue
    }
    if (e.status === 'removed') {
      out.push(`#### \`${e.path}\` — baseline deleted`)
      continue
    }
    if (e.status === 'error') {
      out.push(`#### \`${e.path}\` — ⚠️ diff failed`)
      out.push(`\`\`\`\n${String(e.error ?? 'unknown error').slice(0, 2000)}\n\`\`\``)
      continue
    }
    const renamed = e.renamedFrom ? ` (renamed from \`${e.renamedFrom}\`)` : ''
    const contrastTail = e.contrast ? `, ⚠️ ${e.contrast} contrast` : ''
    out.push(
      `#### \`${e.path}\`${renamed} — ${e.total} change${e.total === 1 ? '' : 's'}: ${e.primary} primary, ${e.total - e.primary} derived${contrastTail}`,
    )
    for (const w of e.warnings ?? []) out.push(`> ⚠️ ${w}`)
    if (e.images) {
      out.push('')
      out.push('| before | after | diff |')
      out.push('| --- | --- | --- |')
      out.push(
        `| ![before](${e.images.before}) | ![after](${e.images.after}) | ![diff](${e.images.diff}) |`,
      )
      out.push('')
    } else if (e.noReplay) {
      out.push('')
      out.push(
        '<sub>No screenshots — capture the baseline with `qain snap --replay` to embed before/after/diff renders.</sub>',
      )
      out.push('')
    }
    out.push('<details><summary><b>What changed — and the rule behind it</b></summary>')
    out.push('')
    out.push('```')
    out.push((e.text ?? '').trim().slice(0, PER_FILE_TEXT_LIMIT) || '(no readable output)')
    out.push('```')
    out.push('</details>')
  }

  if (quiet.length > 0) {
    out.push('')
    out.push(
      `<sub>${quiet.length} baseline file${quiet.length === 1 ? '' : 's'} changed with no semantic difference (formatting or capture churn): ${quiet.map((e) => `\`${e.path}\``).join(', ')}.</sub>`,
    )
  }

  if (hasReport && runUrl) {
    out.push('')
    out.push(
      `📎 [Interactive HTML report ↗](${runUrl}) — download the \`qain-report-${name}\` artifact.`,
    )
  }

  out.push('')
  out.push(
    '<sub>qain compares the browser’s <i>used values</i>, not pixels — so class churn and one-pixel font shifts stay quiet.</sub>',
  )

  return `${out.join('\n')}\n`.slice(0, BODY_LIMIT)
}

/** True when there is anything worth a comment at all. */
export function isReportable(entries) {
  return entries.some((e) => e.status !== 'modified' || e.total > 0)
}

// Local eyeballing: node comment.mjs --demo
if (process.argv.includes('--demo')) {
  process.stdout.write(
    buildComment({
      name: 'web',
      runUrl: 'https://github.com/example/repo/actions/runs/1',
      hasReport: true,
      entries: [
        {
          path: 'src/__qain__/home.qain.json',
          status: 'modified',
          total: 8,
          primary: 2,
          derived: 6,
          contrast: 1,
          text: 'default state\n  html > body > p\n    color: rgb(90, 90, 90) → rgb(190, 190, 190)',
        },
        {
          path: 'src/__qain__/pricing.qain.json',
          status: 'added',
          images: { after: 'https://example.com/render.png' },
        },
        { path: 'src/__qain__/legacy.qain.json', status: 'removed' },
        { path: 'src/__qain__/quiet.qain.json', status: 'modified', total: 0 },
      ],
    }),
  )
}
