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
  await app.register(cors, { origin: true })
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
