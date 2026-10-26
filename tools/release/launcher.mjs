import { createServer as httpServer, request } from 'node:http'
import { createServer as netServer } from 'node:net'
import { spawn } from 'node:child_process'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes, timingSafeEqual } from 'node:crypto'

const root = dirname(fileURLToPath(import.meta.url))
const version = JSON.parse(readFileSync(join(root, 'version.json'), 'utf8'))
const webPort = Number(process.env.WORKBENCH_WEB_PORT || process.env.WORKBENCH_HTTP_PORT || 5173)
const apiPort = Number(process.env.PORT || process.env.WORKBENCH_API_PORT || 5175)
const url = `http://127.0.0.1:${webPort}`
const data = resolve(root, 'server', process.env.WORKBENCH_DATA_DIR?.trim() || 'data')
const recordPath = join(data, 'launcher', 'instance.json')
const token = randomBytes(32).toString('hex')
const client = join(root, 'client', 'dist')
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.wasm': 'application/wasm', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.map': 'application/json' }
let child
let frontend
let ready = false
let stopping = false

function openBrowser(address = url) {
  if (process.argv.includes('--no-browser')) return
  const browser = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', address], { detached: true, stdio: 'ignore', windowsHide: true })
  browser.on('error', () => console.log(`请手动打开 ${address}`))
  browser.unref()
}

function authenticated(req) {
  const supplied = Buffer.from(req.headers.authorization || '')
  const expected = Buffer.from(`Bearer ${token}`)
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}

async function shutdown(code = 0) {
  if (stopping) return
  stopping = true
  ready = false
  try {
    if (JSON.parse(readFileSync(recordPath, 'utf8')).token === token) rmSync(recordPath)
  } catch {}
  frontend?.close()
  frontend?.closeAllConnections()
  if (child && child.exitCode === null) child.kill()
  setTimeout(() => process.exit(code), 1000)
}

async function checkExisting(stop = false) {
  try {
    const saved = JSON.parse(readFileSync(recordPath, 'utf8'))
    if (saved.root !== root || !Number.isInteger(saved.webPort) || saved.webPort < 1 || saved.webPort > 65535 || !/^[a-f0-9]{64}$/.test(saved.token)) return false
    const response = await fetch(`http://127.0.0.1:${saved.webPort}/__workbench/${stop ? 'stop' : 'status'}`, {
      method: stop ? 'POST' : 'GET', headers: { Authorization: `Bearer ${saved.token}` }, signal: AbortSignal.timeout(1500), redirect: 'error',
    })
    if (!response.ok) return false
    return saved
  } catch { return false }
}

async function portAvailable(port) {
  await new Promise((resolvePort, reject) => {
    const socket = netServer()
    socket.once('error', reject)
    socket.listen(port, '127.0.0.1', () => socket.close(resolvePort))
  })
}

function serve(req, res) {
  const allowedHosts = new Set([`127.0.0.1:${webPort}`, `localhost:${webPort}`])
  if (webPort === 80) { allowedHosts.add('127.0.0.1'); allowedHosts.add('localhost') }
  if (!allowedHosts.has((req.headers.host || '').toLowerCase())) { res.writeHead(403); res.end('不允许此主机访问本地工作台'); return }
  let pathname
  try { pathname = new URL(req.url, url).pathname }
  catch { res.writeHead(400); res.end('请求地址无效'); return }
  if (pathname.startsWith('/__workbench/')) {
    if (!authenticated(req)) { res.writeHead(403); res.end(); return }
    if (pathname === '/__workbench/status' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ready, version: version.version }))
    } else if (pathname === '/__workbench/stop' && req.method === 'POST') {
      res.writeHead(200); res.end('服务已停止'); void shutdown()
    } else { res.writeHead(404); res.end() }
    return
  }
  if (!ready) { res.writeHead(503); res.end('工作台正在启动，请稍后刷新。'); return }
  if (/^\/(api|dsh-pet-7340|uploads|themes)(\/|$)/.test(pathname)) {
    const headers = { ...req.headers, host: `127.0.0.1:${apiPort}` }
    const upstream = request({ host: '127.0.0.1', port: apiPort, path: req.url, method: req.method, headers }, response => {
      res.writeHead(response.statusCode, response.headers)
      response.pipe(res)
    })
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('后端连接中断，请查看 server/data/launcher 日志。') })
    res.on('close', () => upstream.destroy())
    req.pipe(upstream)
    return
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return }
  let file
  try {
    file = resolve(client, `.${decodeURIComponent(pathname)}`)
    const part = relative(client, file)
    if (part.startsWith('..') || isAbsolute(part)) throw new Error('路径越界')
    if (!existsSync(file) || !statSync(file).isFile()) {
      if (extname(pathname)) { res.writeHead(404); res.end(); return }
      file = join(client, 'index.html')
    }
    res.writeHead(200, { 'Content-Type': mime[extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': statSync(file).size, 'Cache-Control': extname(file) === '.html' ? 'no-cache' : 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff' })
    if (req.method === 'HEAD') res.end()
    else createReadStream(file).on('error', () => res.destroy()).pipe(res)
  } catch { if (!res.headersSent) res.writeHead(400); res.end('请求路径无效') }
}

async function main() {
  process.chdir(root)
  if (process.argv.includes('--stop')) {
    console.log(await checkExisting(true) ? '工作台已停止。' : '没有找到此软件包启动的工作台。')
    return
  }
  const existing = await checkExisting()
  if (existing) { const address = `http://127.0.0.1:${existing.webPort}`; console.log(`工作台已在运行：${address}`); openBrowser(address); return }
  if (![webPort, apiPort].every(port => Number.isInteger(port) && port > 0 && port < 65536) || webPort === apiPort) throw new Error('端口配置无效')
  await portAvailable(apiPort)
  frontend = httpServer(serve)
  await new Promise((done, reject) => { frontend.once('error', reject); frontend.listen(webPort, '127.0.0.1', done) })
  mkdirSync(join(data, 'launcher'), { recursive: true })
  writeFileSync(recordPath, JSON.stringify({ root, token, webPort, apiPort, pid: process.pid }))
  const log = createWriteStream(join(data, 'launcher', '运行日志.log'), { flags: 'a' })
  log.write(`\n${new Date().toISOString()} 启动 ${version.version}\n`)
  const env = { ...process.env, NODE_ENV: 'production', PORT: String(apiPort), WORKBENCH_WEB_PORT: String(webPort), WORKBENCH_DATA_DIR: data, WORKBENCH_PET_HOME: join(data, 'pet'), DSH_PET_ELECTRON_PATH: join(root, 'runtime', 'electron', 'electron.exe') }
  delete env.ELECTRON_RUN_AS_NODE
  child = spawn(process.execPath, [join(root, 'server', 'dist', 'index.js')], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.pipe(log, { end: false })
  child.stderr.pipe(log, { end: false })
  child.on('error', error => { console.error(error.message); void shutdown(1) })
  child.on('exit', code => { if (!stopping) { console.error(`后端已退出（${code}），请查看 server/data/launcher/运行日志.log`); void shutdown(1) } })
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
  const deadline = Date.now() + 120000
  while (!stopping) {
    try {
      const response = await fetch(`http://127.0.0.1:${apiPort}/api/health`, { signal: AbortSignal.timeout(1500) })
      if (response.ok && (await response.json()).ok) break
    } catch {}
    if (Date.now() > deadline) throw new Error('等待后端超时，请查看 server/data/launcher/运行日志.log')
    await new Promise(done => setTimeout(done, 300))
  }
  if (stopping) return
  ready = true
  console.log(`Yoshinove工作台 ${version.version} 已启动：${url}`)
  console.log('请保留此窗口；按 Ctrl+C 或双击“停止工作台.bat”停止服务。')
  openBrowser()
}

main().catch(error => {
  console.error(error.code === 'EADDRINUSE' ? `启动失败：${webPort} 或 ${apiPort} 端口已被占用，请先关闭之前的工作台，再重新启动。` : `启动失败：${error.message}`)
  if (frontend || child) void shutdown(1)
  else process.exitCode = 1
})
