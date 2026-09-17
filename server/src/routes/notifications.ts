import { desc, eq, inArray } from 'drizzle-orm'
import type { FastifyPluginAsync } from 'fastify'
import { db, sqlite } from '../db/index.js'
import { notificationLog } from '../db/schema.js'
import { sendPushPlus, sendWecom } from '../services/push.js'

function getSetting<T>(key: string, fallback: T): T {
  const row = sqlite.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
  if (!row) return fallback
  try {
    return JSON.parse(row.value) as T
  } catch {
    return fallback
  }
}

export const notificationRoutes: FastifyPluginAsync = async (app) => {
  // 前端轮询：取待投递的浏览器通知
  app.get('/api/notifications/pending', async () => {
    const rows = db
      .select()
      .from(notificationLog)
      .where(eq(notificationLog.channel, 'browser'))
      .orderBy(desc(notificationLog.id))
      .limit(20)
      .all()
    return rows.filter((r) => r.status === 'pending')
  })

  app.post('/api/notifications/mark-delivered', async (req) => {
    const { ids } = req.body as { ids: number[] }
    if (Array.isArray(ids) && ids.length) {
      db.update(notificationLog).set({ status: 'delivered' }).where(inArray(notificationLog.id, ids)).run()
    }
    return { ok: true }
  })

  // 通知历史
  app.get('/api/notifications/log', async (req) => {
    const { limit } = req.query as { limit?: string }
    return db.select().from(notificationLog).orderBy(desc(notificationLog.id)).limit(Math.min(Number(limit) || 50, 200)).all()
  })

  // 测试推送：向指定通道发送测试消息
  app.post('/api/notifications/test', async (req) => {
    const { channels } = req.body as { channels: string[] }
    const title = '工作台测试通知'
    const body = `这是一条测试通知，发送于 ${new Date().toLocaleString('zh-CN')}`
    const results: { channel: string; ok: boolean; detail: string }[] = []

    for (const channel of channels ?? []) {
      if (channel === 'browser') {
        results.push({ channel, ok: true, detail: '浏览器通知由页面轮询投递，请保持页面打开' })
        sqlite
          .prepare(
            'INSERT INTO notification_log (channel, type, title, body, status, sent_at) VALUES (?, ?, ?, ?, ?, datetime(\'now\', \'localtime\'))',
          )
          .run('browser', 'test', title, body, 'pending')
        continue
      }
      if (channel === 'pushplus') {
        const token = getSetting<string>('notification.pushplusToken', '')
        const r = await sendPushPlus(token, title, body)
        results.push({ channel, ok: r.ok, detail: r.detail })
      } else if (channel === 'wecom') {
        const cfg = getSetting('notification.wecom', { corpId: '', agentId: '', secret: '', toUser: '@all' })
        const r = await sendWecom(cfg, title, body)
        results.push({ channel, ok: r.ok, detail: r.detail })
      }
    }
    return results
  })
}
