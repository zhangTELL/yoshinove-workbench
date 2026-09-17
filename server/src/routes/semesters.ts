import { desc, eq } from 'drizzle-orm'
import type { FastifyPluginAsync } from 'fastify'
import type { SectionTime } from '@wb/shared'
import { db, sqlite } from '../db/index.js'
import { semesters } from '../db/schema.js'

export const DEFAULT_SECTION_TIMES: SectionTime[] = [
  { start: '08:00', end: '08:45' },
  { start: '08:55', end: '09:40' },
  { start: '10:00', end: '10:45' },
  { start: '10:55', end: '11:40' },
  { start: '14:00', end: '14:45' },
  { start: '14:55', end: '15:40' },
  { start: '16:00', end: '16:45' },
  { start: '16:55', end: '17:40' },
  { start: '19:00', end: '19:45' },
  { start: '19:55', end: '20:40' },
  { start: '20:50', end: '21:35' },
  { start: '21:45', end: '22:30' },
]

interface SemesterBody {
  name: string
  startDate: string
  totalWeeks?: number
  sectionTimes?: SectionTime[]
}

function serializeRow(row: typeof semesters.$inferSelect) {
  return { ...row, sectionTimes: JSON.parse(row.sectionTimes) as SectionTime[], isCurrent: !!row.isCurrent }
}

export const semesterRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/semesters', async () => {
    const rows = db.select().from(semesters).orderBy(desc(semesters.isCurrent), desc(semesters.id)).all()
    return rows.map(serializeRow)
  })

  app.post('/api/semesters', async (req) => {
    const body = req.body as SemesterBody
    if (!body.name || !body.startDate) throw Object.assign(new Error('名称与开始日期必填'), { statusCode: 400 })
    const result = db
      .insert(semesters)
      .values({
        name: body.name,
        startDate: body.startDate,
        totalWeeks: body.totalWeeks ?? 20,
        sectionTimes: JSON.stringify(body.sectionTimes ?? DEFAULT_SECTION_TIMES),
        isCurrent: 0,
        createdAt: new Date().toISOString(),
      })
      .run()
    const row = db.select().from(semesters).where(eq(semesters.id, result.lastInsertRowid as number)).get()!
    return serializeRow(row)
  })

  app.put('/api/semesters/:id', async (req) => {
    const { id } = req.params as { id: string }
    const body = req.body as Partial<SemesterBody>
    const patch: Partial<typeof semesters.$inferInsert> = {}
    if (body.name !== undefined) patch.name = body.name
    if (body.startDate !== undefined) patch.startDate = body.startDate
    if (body.totalWeeks !== undefined) patch.totalWeeks = body.totalWeeks
    if (body.sectionTimes !== undefined) patch.sectionTimes = JSON.stringify(body.sectionTimes)
    db.update(semesters).set(patch).where(eq(semesters.id, Number(id))).run()
    const row = db.select().from(semesters).where(eq(semesters.id, Number(id))).get()
    if (!row) throw Object.assign(new Error('学期不存在'), { statusCode: 404 })
    return serializeRow(row)
  })

  app.post('/api/semesters/:id/activate', async (req) => {
    const { id } = req.params as { id: string }
    sqlite.transaction(() => {
      sqlite.prepare('UPDATE semesters SET is_current = 0').run()
      sqlite.prepare('UPDATE semesters SET is_current = 1 WHERE id = ?').run(Number(id))
    })()
    const row = db.select().from(semesters).where(eq(semesters.id, Number(id))).get()
    return row ? serializeRow(row) : null
  })

  app.delete('/api/semesters/:id', async (req) => {
    const { id } = req.params as { id: string }
    db.delete(semesters).where(eq(semesters.id, Number(id))).run()
    return { ok: true }
  })
}
