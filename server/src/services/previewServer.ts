/**
 * P8-4：本地预览服务器——给带 index.html 的项目起一个只读静态服务
 *
 * 生命周期：每个项目最多一个实例（幂等启动）；服务进程退出时端口随之释放。
 * 安全：以 index.html 所在目录为根，**逐请求 realpath 校验**，永远出不了项目目录。
 */
import http from 'node:http'
import { createReadStream, existsSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { projects } from '../db/schema.js'

const bad = (msg: string, code = 400) => Object.assign(new Error(msg), { statusCode: code })

const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p)

interface Preview {
  server: http.Server
  port: number
  root: string
  startedAt: string
}

/** 项目 id → 运行中的预览实例 */
const running = new Map<number, Preview>()

const MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  wasm: 'application/wasm',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
}

function mimeOf(p: string): string {
  const ext = path.extname(p).toLowerCase().replace(/^\./, '')
  return MIME[ext] ?? 'application/octet-stream'
}

export interface PreviewStatus {
  running: boolean
  url: string | null
  port: number | null
  startedAt: string | null
}

export function previewStatus(projectId: number): PreviewStatus {
  const p = running.get(projectId)
  return p
    ? { running: true, url: `http://127.0.0.1:${p.port}/`, port: p.port, startedAt: p.startedAt }
    : { running: false, url: null, port: null, startedAt: null }
}

function listenOn(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    let tries = 0
    const tryPort = () => {
      if (++tries > 10) {
        reject(bad('找不到可用的本地端口', 500))
        return
      }
      const port = 49152 + Math.floor(Math.random() * 16000)
      const onError = () => {
        cleanup()
        tryPort()
      }
      const onListen = () => {
        cleanup()
        resolve(port)
      }
      const cleanup = () => {
        server.removeListener('error', onError)
        server.removeListener('listening', onListen)
      }
      server.once('error', onError)
      server.once('listening', onListen)
      server.listen(port, '127.0.0.1')
    }
    tryPort()
  })
}

export async function startPreview(projectId: number): Promise<PreviewStatus> {
  const existing = running.get(projectId)
  if (existing) return previewStatus(projectId)

  const row = db.select().from(projects).where(eq(projects.id, projectId)).get()
  if (!row) throw bad('项目不存在', 404)
  if (!existsSync(row.path)) throw bad('项目目录已经不存在了', 404)

  // 找 index.html：项目根 → dist → build → out
  let root: string | null = null
  for (const cand of ['', 'dist', 'build', 'out']) {
    const dir = path.join(row.path, cand)
    if (existsSync(path.join(dir, 'index.html'))) {
      root = dir
      break
    }
  }
  if (!root) throw bad('项目里没有找到 index.html（查了根目录、dist、build、out），无法启动预览')
  const rootReal = realpathSync.native(root)

  const server = http.createServer((req, res) => {
    const done = (code: number, msg: string) => {
      res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(msg)
    }
    try {
      const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0])
      let filePath = path.resolve(rootReal, '.' + path.posix.normalize('/' + urlPath))
      // 只在文件确实存在后做 realpath 校验（不存在的路径直接 404，不用逃逸探测）
      if (!existsSync(filePath)) {
        done(404, 'Not Found')
        return
      }
      if (norm(realpathSync.native(filePath)).startsWith(norm(rootReal) + path.sep) === false && norm(realpathSync.native(filePath)) !== norm(rootReal)) {
        done(403, 'Forbidden')
        return
      }
      if (statSync(filePath).isDirectory()) filePath = path.join(filePath, 'index.html')
      if (!existsSync(filePath) || !statSync(filePath).isFile()) {
        done(404, 'Not Found')
        return
      }
      res.writeHead(200, { 'content-type': mimeOf(filePath) })
      createReadStream(filePath).pipe(res)
    } catch {
      done(500, 'Internal Error')
    }
  })
  // 静态服务不该被慢客户端拖死
  server.requestTimeout = 30_000
  server.headersTimeout = 30_000

  const port = await listenOn(server)
  running.set(projectId, { server, port, root: rootReal, startedAt: new Date().toISOString() })
  return previewStatus(projectId)
}

export function stopPreview(projectId: number): PreviewStatus {
  const p = running.get(projectId)
  if (p) {
    p.server.close()
    running.delete(projectId)
  }
  return { running: false, url: null, port: null, startedAt: null }
}

/** 服务进程退出时把所有监听口关掉（Windows 上进程死了端口也会释放，这是双保险） */
export function stopAllPreviews(): void {
  for (const [, p] of running) p.server.close()
  running.clear()
}
