import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.dirname(fileURLToPath(import.meta.url))
const html = await readFile(path.join(root, 'index.html'), 'utf8')
const styles = await readFile(path.join(root, 'style', 'styles.css'))
const apiUrl = process.env.EXCHANGE_API_URL || 'http://localhost:3001'
const assets = {
  '/assets/image/zelle.svg': { data: await readFile(path.join(root, 'assets', 'image', 'zelle.svg')), type: 'image/svg+xml' },
  '/assets/image/cashapp.svg': { data: await readFile(path.join(root, 'assets', 'image', 'cashapp.svg')), type: 'image/svg+xml' },
}

createServer((request, response) => {
  if (request.url === '/style/styles.css') {
    response.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' })
    return response.end(styles)
  }
  if (assets[request.url]) {
    response.writeHead(200, { 'Content-Type': assets[request.url].type, 'Cache-Control': 'no-cache' })
    return response.end(assets[request.url].data)
  }
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  response.end(html.replaceAll('__EXCHANGE_API_URL__', apiUrl))
}).listen(Number(process.env.PORT || 3000), '0.0.0.0', () => {
  console.log(`Exchange frontend listening on port ${process.env.PORT || 3000}`)
})
