import { desc, eq } from 'drizzle-orm'
import type { FastifyPluginAsync } from 'fastify'
import { db, sqlite } from '../db/index.js'
import { chaoxingHomework } from '../db/schema.js'
import { getStatus, initChaoxing, syncAll, upsertWorks, validateCookie } from '../services/chaoxing.js'
import { courseIdentityKey, courseIdentityOf } from '../services/chaoxingKey.js'

export const chaoxingRoutes: FastifyPluginAsync = async (app) => {
  initChaoxing(sqlite)

  app.get('/api/chaoxing/status', async () => {
    const st = getStatus()
    const last = db.select().from(chaoxingHomework).orderBy(desc(chaoxingHomework.syncedAt)).limit(1).get()
    const rows = db.select().from(chaoxingHomework).all()
    const total = rows.filter(row => row.remotePresent).length
    return { ...st, total, archived: rows.length - total, lastSync: last?.syncedAt ?? null }
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
    if (result.ok) added = upsertWorks(result.works, result.completedCourses)
    return {
      ok: result.ok,
      detail: result.ok ? `${result.detail}，新增 ${added} 条作业` : result.detail,
      total: db.select().from(chaoxingHomework).where(eq(chaoxingHomework.remotePresent, true)).all().length,
    }
  })

  app.get('/api/chaoxing/homework', async req => {
    const includeArchived = (req.query as { includeArchived?: string }).includeArchived === '1'
    const rows = db.select().from(chaoxingHomework).orderBy(desc(chaoxingHomework.id)).all().filter(row => includeArchived || row.remotePresent)
    const classes = new Map<string, Set<string>>()
    for (const row of rows) {
      const course = courseIdentityOf(row.url)
      const key = course ? courseIdentityKey(course) : row.courseName
      const variants = classes.get(row.courseName) ?? new Set<string>()
      variants.add(key)
      classes.set(row.courseName, variants)
    }
    return rows.map(row => {
      const course = courseIdentityOf(row.url)
      const courseKey = course ? courseIdentityKey(course) : row.courseName
      const classLabel = course && (classes.get(row.courseName)?.size ?? 0) > 1 ? `${row.courseStart ? row.courseStart + '开课 · ' : ''}班级 ${course.classId}` : ''
      return { ...row, courseKey, classLabel, courseLabel: classLabel ? `${row.courseName} · ${classLabel}` : row.courseName }
    })
  })

  app.delete('/api/chaoxing/homework/:id', async (req) => {
    const { id } = req.params as { id: string }
    db.delete(chaoxingHomework).where(eq(chaoxingHomework.id, Number(id))).run()
    return { ok: true }
  })
}
