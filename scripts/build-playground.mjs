#!/usr/bin/env node
/**
 * Assembles the browser playground for the GitHub Pages site
 * (https://shinyaigeek.github.io/qain/playground/).
 *
 * No bundler: @qain/core compiles to ESM whose every import is relative and whose
 * only runtime dependency is the DOM, so the built `dist/` is copied verbatim next
 * to the page and imported natively as `./vendor/index.js`. Run `pnpm build` first
 * so `packages/core/dist` exists.
 */
import { cp, mkdir, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = process.argv[2] ?? join(root, 'site', 'playground')
const dist = join(root, 'packages', 'core', 'dist')

try {
  await readdir(dist)
} catch {
  process.stderr.write('playground: packages/core/dist is missing — run `pnpm build` first\n')
  process.exit(1)
}

await mkdir(join(outDir, 'vendor'), { recursive: true })
await cp(join(root, 'examples', 'playground', 'index.html'), join(outDir, 'index.html'))
await cp(join(root, 'examples', 'playground', 'playground.js'), join(outDir, 'playground.js'))
// Ship the whole dist: index.js pulls in only the pure, browser-safe modules it
// needs, and the .map files keep stack traces readable in the tab.
await cp(dist, join(outDir, 'vendor'), { recursive: true })

process.stderr.write(`playground: assembled → ${outDir}\n`)
