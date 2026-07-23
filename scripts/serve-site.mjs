#!/usr/bin/env node
/**
 * A no-dependency static server for the assembled `site/` directory, for previewing
 * the playground and docs locally. Not used in CI — Pages serves the artifact there.
 */
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'site')
const port = Number(process.env.PORT ?? 4600)
const host = process.env.HOST ?? '0.0.0.0'
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css',
  '.json': 'application/json',
  '.map': 'application/json',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
}

createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost')
  let path = normalize(decodeURIComponent(url.pathname))
  if (path.includes('..')) return void response.writeHead(403).end()
  if (path.endsWith('/')) path = join(path, 'index.html')

  try {
    const body = await readFile(join(root, path))
    response.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' })
    response.end(body)
  } catch {
    response.writeHead(404).end('not found')
  }
}).listen(port, host, () => {
  process.stdout.write(`site on http://${host}:${port}/ (playground: /playground/)\n`)
})
