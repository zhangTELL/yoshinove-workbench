import { eq } from 'drizzle-orm'
import type { FastifyPluginAsync } from 'fastify'
import { db, sqlite } from '../db/index.js'
import { settings } from '../db/schema.js'

export const settingsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/settings', async () => {
    const rows = db.select().from(settings).all()
    const out: Record<string, unknown> = {}
    for (const r of rows) {
      try {
        out[r.key] = JSON.parse(r.value)
      } catch {
        out[r.key] = r.value
      }
    }
    return out
  })

  app.put('/api/settings', async (req) => {
    const body = req.body as Record<string, unknown>
    const upsert = sqlite.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    )
    const tx = sqlite.transaction(() => {
      for (const [key, value] of Object.entries(body)) {
        upsert.run(key, JSON.stringify(value))
      }
    })
    tx()
    return { ok: true }
  })

  app.get('/api/settings/:key', async (req) => {
    const { key } = req.params as { key: string }
    const row = db.select().from(settings).where(eq(settings.key, key)).get()
    // 注意：必须包在对象里返回——裸字符串会被 Fastify 以 text/plain 输出，客户端 res.json() 会解析失败
    return { value: row ? JSON.parse(row.value) : null }
  })
}
