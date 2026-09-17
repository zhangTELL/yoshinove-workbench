import { desc, eq } from 'drizzle-orm'
import type { FastifyPluginAsync } from 'fastify'
import { db, sqlite } from '../db/index.js'
import { chaoxingHomework } from '../db/schema.js'
import { getStatus, initChaoxing, syncAll, upsertWorks, validateCookie } from '../services/chaoxing.js'

export const chaoxingRoutes: FastifyPluginAsync = async (app) => {
  initChaoxing(sqlite)

  app.get('/api/chaoxing/status', async () => {
    const st = getStatus()
    const last = db.select().from(chaoxingHomework).orderBy(desc(chaoxingHomework.syncedAt)).limit(1).get()
    const total = db.select().from(chaoxingHomework).all().length
    return { ...st, total, lastSync: last?.syncedAt ?? null }
  })

  app.post('/api/chaoxing/cookie', async (req) => {
    const { cookie } = req.body as { cookie: string }
    const clean = (cookie ?? '').replace(/^Cookie:\s*/i, '').trim()
    const check = await validateCookie(clean)
    if (!check.ok) {
      return { ok: false, detail: check.detail }
    }
    sqlite.prepare(
      "INSERT INTO settings (key, value) VALUES ('chaoxing.cookie', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(JSON.stringify(clean))
    return { ok: true, detail: check.detail, uid: check.uid }
  })

  app.delete('/api/chaoxing/cookie', async () => {
    sqlite.prepare("DELETE FROM settings WHERE key = 'chaoxing.cookie'").run()
    return { ok: true }
  })

  app.post('/api/chaoxing/sync', async () => {
    const result = await syncAll()
    let added = 0
    if (result.ok) added = upsertWorks(result.works)
    return {
      ok: result.ok,
      detail: result.ok ? `${result.detail}，新增 ${added} 条作业` : result.detail,
      total: db.select().from(chaoxingHomework).all().length,
    }
  })

  app.get('/api/chaoxing/homework', async () => {
    const rows = db.select().from(chaoxingHomework).orderBy(desc(chaoxingHomework.id)).all()
    return rows
  })

  app.delete('/api/chaoxing/homework/:id', async (req) => {
    const { id } = req.params as { id: string }
    db.delete(chaoxingHomework).where(eq(chaoxingHomework.id, Number(id))).run()
    return { ok: true }
  })
}
