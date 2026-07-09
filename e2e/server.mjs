import { createReadStream } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures')
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript' }

createServer((request, response) => {
  const path = normalize(decodeURIComponent(new URL(request.url, 'http://x').pathname))
  if (path.includes('..')) {
    response.writeHead(403).end()
    return
  }
  const file = join(ROOT, path)
  const stream = createReadStream(file)
  stream.on('error', () => response.writeHead(404).end('not found'))
  stream.on('open', () => {
    response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
    stream.pipe(response)
  })
}).listen(5599)
