import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('.', import.meta.url))
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css' }

/**
 * Serves the app in one of two variants.
 *
 * `?variant=regressed` swaps in the broken stylesheet and rewrites the hashed
 * utility class, standing in for "somebody pushed a commit". Everything else — the
 * markup, the URL path, the viewport — is identical, which is the situation qain
 * exists for.
 */
function render(html, variant) {
  if (variant !== 'regressed') return html
  return (
    html
      .replace('/styles/theme.css', '/styles/theme.regressed.css')
      // A CSS-Modules-style hash churns on every build. qain must stay silent about it.
      .replaceAll('css-a1b2c3', 'css-9f8e7d')
  )
}

export function start(port = 5600) {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    const path = normalize(decodeURIComponent(url.pathname))
    if (path.includes('..')) return void response.writeHead(403).end()

    const file = join(ROOT, path === '/' ? 'index.html' : path)
    try {
      const body = await readFile(file, 'utf8')
      response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'text/plain' })
      response.end(extname(file) === '.html' ? render(body, url.searchParams.get('variant')) : body)
    } catch {
      response.writeHead(404).end('not found')
    }
  })
  return new Promise((resolve) => server.listen(port, () => resolve(server)))
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 5600)
  await start(port)
  process.stdout.write(`example app on http://localhost:${port}/\n`)
}
