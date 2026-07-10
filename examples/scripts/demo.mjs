#!/usr/bin/env node
/**
 * The workflow a coding agent would run: snapshot, change the code, snapshot,
 * diff. It shells out to the real `qain` binary rather than importing the
 * library, so this doubles as an end-to-end test of the CLI — including its exit
 * codes, which is how an agent or a CI job decides whether anything broke.
 */
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { start } from '../app/server.mjs'

const PORT = 5601
const BASE = `http://localhost:${PORT}/`
const REGRESSED = `${BASE}?variant=regressed`

function qain(args) {
  return new Promise((resolve) => {
    const child = spawn('qain', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

function heading(text) {
  process.stdout.write(`\n\x1b[1m${text}\x1b[0m\n${'─'.repeat(text.length)}\n`)
}

const browser = process.env.QAIN_CHROME_PATH ? ['--browser', process.env.QAIN_CHROME_PATH] : []
const server = await start(PORT)
const dir = await mkdtemp(join(tmpdir(), 'qain-example-'))
const before = join(dir, 'before.json')
const after = join(dir, 'after.json')

try {
  heading('1. Snapshot the page as it is today')
  const snapArgs = ['--rules', '--replay', '--states', 'hover', ...browser]
  const a = await qain(['snap', BASE, ...snapArgs, '-o', before])
  process.stdout.write(a.stderr || a.stdout)
  if (a.code !== 0) throw new Error(`qain snap failed: ${a.stderr}`)

  heading('2. Somebody edits theme.css — four changes, of four different kinds')
  process.stdout.write(
    [
      '  .btn            padding 8px 16px -> 14px 16px',
      '  .btn-primary    :hover background no longer differs from rest',
      '  .badge          z-index 2 -> 0',
      '  .muted          color   #6b7280 -> #c7cbd4',
      '  (and every css-a1b2c3 class is rehashed to css-9f8e7d)\n',
    ].join('\n'),
  )

  heading('3. Snapshot again')
  const b = await qain(['snap', REGRESSED, ...snapArgs, '-o', after])
  process.stdout.write(b.stderr || b.stdout)
  if (b.code !== 0) throw new Error(`qain snap failed: ${b.stderr}`)

  heading('4. What broke — causes only')
  const terse = await qain(['diff', before, after, '--omit-derived', '--no-color'])
  process.stdout.write(terse.stdout)

  heading('5. The same diff, with the collateral it suppressed')
  const full = await qain(['diff', before, after, '--no-color'])
  const tail = full.stdout.trimEnd().split('\n').slice(-14).join('\n')
  process.stdout.write(`${tail}\n`)

  heading('6. Exit codes, for CI and for agents')
  const clean = await qain(['diff', before, before, '--no-color'])
  process.stdout.write(
    `  qain diff before before   -> exit ${clean.code}  (${clean.stdout.trim()})\n`,
  )
  process.stdout.write(`  qain diff before after    -> exit ${full.code}\n`)

  if (clean.code !== 0) throw new Error('a snapshot compared against itself must exit 0')
  if (full.code !== 1) throw new Error('a non-empty diff must exit 1')

  // The four edits, and nothing else. If this ever fires, the example is lying.
  const json = await qain(['diff', before, after, '--omit-derived', '--json'])
  const result = JSON.parse(json.stdout)
  const primaryKeys = new Set(result.changes.map((c) => c.key))
  const expected = ['@pay', '@download', '@plan-badge', '@usage-note', '@invoice-note', '@footnote']
  const missing = expected.filter((key) => !primaryKeys.has(key))
  if (missing.length > 0) throw new Error(`example did not detect: ${missing.join(', ')}`)

  heading('7. And the class rehash?')
  const churn = result.changes.filter((c) => c.kind === 'attr' && c.attribute === 'class')
  process.stdout.write(`  class attribute changes reported: ${churn.length}\n`)
  if (churn.length !== 0) throw new Error('class churn must not appear in a diff')

  heading('8. Rebuild both pages so a human can look at them')
  const replay = join(dirname(fileURLToPath(new URL('.', import.meta.url))), 'replay.html')
  const built = await qain(['diff', before, after, '--replay', replay, '--no-color'])
  if (built.code !== 1) throw new Error('replay run should still report the diff')

  const html = await readFile(replay, 'utf8')
  const stages = html.match(/class="stage"/g)?.length ?? 0
  if (stages !== 2) throw new Error(`expected a before and an after stage, got ${stages}`)
  process.stdout.write(
    `  ${replay}\n  Open it: fade between before and after to watch the footnote slide 12px.\n`,
  )

  process.stdout.write('\n\x1b[32mExample verified.\x1b[0m\n')
} finally {
  server.close()
  await rm(dir, { recursive: true, force: true })
}
