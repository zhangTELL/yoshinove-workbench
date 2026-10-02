import cors from '@fastify/cors'
import multipart from '@fastify/multipart'
import Fastify from 'fastify'
import { ensureSchema } from './db/index.js'
import { aiRoutes } from './routes/ai.js'
import { chaoxingRoutes } from './routes/chaoxing.js'
import { importRoutes } from './routes/import.js'
import { noteRoutes } from './routes/notes.js'
import { notificationRoutes } from './routes/notifications.js'
import { promptRoutes } from './routes/prompts.js'
import { projectRoutes } from './routes/projects.js'
import { stopAllPreviews } from './services/previewServer.js'
import { semesterRoutes } from './routes/semesters.js'
import { scheduleRoutes } from './routes/schedule.js'
import { settingsRoutes } from './routes/settings.js'
import { toolRoutes } from './routes/tools.js'
import { uploadRoutes } from './routes/uploads.js'
import { startScheduler } from './scheduler/index.js'

const PORT = Number(process.env.PORT ?? 5175)

async function main() {
  ensureSchema()

  const app = Fastify({ logger: { level: 'warn' } })
  // ★ 本地 API 的 Origin 白名单（2026-10-01 审查修复 #1）。
  // 原来的 cors({ origin: true }) 会反射**任意**调用方 Origin——浏览器里任何网页都能
  // 跨源读取本机 API（设置接口里有学习通 Cookie、推送凭据）。
  // CORS 只控制浏览器读取响应；简单请求必须在路由执行前直接拒绝。
  // 无 Origin 的请求（curl / 桌面客户端 / 同源页面）不受影响。
  const ALLOWED_ORIGINS = new Set(['http://localhost:5173', 'http://127.0.0.1:5173'])
  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin
    if (origin !== undefined && !ALLOWED_ORIGINS.has(origin)) {
      return reply.code(403).send({ message: '不允许此来源访问本地接口' })
    }
  })
  await app.register(cors, {
    origin: (origin, cb) => {
      cb(null, !origin || ALLOWED_ORIGINS.has(origin))
    },
  })
  await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024 } })

  // 空请求体 + JSON 头时视为 {}，避免无 body 的 POST/DELETE 返回 400
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    if (body === '' || body === undefined) return done(null, {})
    try {
      done(null, JSON.parse(body as string))
    } catch (err) {
      ;(err as Error & { statusCode: number }).statusCode = 400
      done(err as Error, undefined)
    }
  })

  await app.register(settingsRoutes)
  await app.register(semesterRoutes)
  await app.register(scheduleRoutes)
  await app.register(importRoutes)
  await app.register(uploadRoutes)
  await app.register(notificationRoutes)
  await app.register(chaoxingRoutes)
  await app.register(toolRoutes)
  await app.register(noteRoutes)
  await app.register(aiRoutes)
  await app.register(promptRoutes)
  await app.register(projectRoutes)

  // 服务关闭时把项目预览服务器的监听口一并关掉
  app.addHook('onClose', async () => stopAllPreviews())

  startScheduler()

  app.get('/api/health', async () => ({ ok: true, ts: Date.now() }))

  await app.listen({ port: PORT, host: '127.0.0.1' })
  console.log(`[server] listening on http://127.0.0.1:${PORT}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
