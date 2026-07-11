#!/usr/bin/env node
// Builds the sticky PR-comment body from a qain diff. Kept pure and free of any
// GitHub API so it can be run and eyeballed locally:
//
//   node format-comment.mjs --json qain-diff.json --text qain-diff.txt --name web
//
// The marker on the first line is how the action finds its own comment to update
// instead of piling on a new one every push.
import { readFileSync } from 'node:fs'

const args = parseArgs(process.argv.slice(2))
const diff = JSON.parse(readFileSync(args.json, 'utf8'))
const text = args.text ? safeRead(args.text) : ''
const name = args.name || 'qain'
const runUrl = args['run-url'] || ''
const hasReport = args['has-report'] === 'true'

const marker = markerFor(name)
const { total = 0, primary = 0, derived = 0 } = diff.summary ?? {}
const warnings = diff.warnings ?? []

const out = [marker]
out.push(`### qain — style diff${name && name !== 'qain' ? ` · \`${name}\`` : ''}`)
out.push('')

if (total === 0) {
  out.push('✅ **No style changes.** Computed styles, layout boxes, paint order and')
  out.push('WCAG contrast all match the base.')
} else {
  const contrast = countContrast(diff)
  out.push(
    `🎨 **${total}** change${total === 1 ? '' : 's'} — ` +
      `**${primary}** primary, ${derived} derived${contrast ? `, ⚠️ ${contrast} contrast regression${contrast === 1 ? '' : 's'}` : ''}.`,
  )
  for (const w of warnings) out.push(`> ⚠️ ${w}`)
  out.push('')
  out.push('<details><summary><b>What changed — and the rule behind it</b></summary>')
  out.push('')
  out.push('```')
  out.push((text.trim() || renderFallback(diff)).slice(0, 60_000))
  out.push('```')
  out.push('</details>')
  if (hasReport && runUrl) {
    out.push('')
    out.push(
      `📎 [Interactive HTML report + fade-between replay ↗](${runUrl}) — download the \`qain-report-${name}\` artifact.`,
    )
  }
}

out.push('')
out.push(
  '<sub>qain compares the browser’s <i>used values</i>, not pixels — so class churn and one-pixel font shifts stay quiet.</sub>',
)

process.stdout.write(`${out.join('\n')}\n`)

// ---------------------------------------------------------------------------

/** The hidden anchor the action greps for to update its own comment in place. */
export function markerFor(name) {
  return `<!-- qain-report:${name} -->`
}

function countContrast(diff) {
  return (diff.changes ?? []).filter((c) => c.kind === 'contrast' && c.crosses).length
}

/** If the pretty text output is missing, at least list the primary changes. */
function renderFallback(diff) {
  const primary = (diff.changes ?? []).filter((c) => !c.cause || c.cause !== 'derived')
  if (primary.length === 0) return '(no primary changes)'
  return primary
    .slice(0, 40)
    .map((c) => `${c.state}  ${c.path}  ${c.kind}`)
    .join('\n')
}

function safeRead(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token.startsWith('--')) {
      out[token.slice(2)] = argv[i + 1]
      i++
    }
  }
  return out
}
