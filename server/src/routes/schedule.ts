import { eq } from 'drizzle-orm'
import type { FastifyPluginAsync } from 'fastify'
import type { CourseCellInput } from '@wb/shared'
import { db, sqlite } from '../db/index.js'
import { courses, courseSessions } from '../db/schema.js'

const PALETTE = [
  '#409eff', '#67c23a', '#e6a23c', '#f56c6c', '#9c68ec',
  '#00b8a9', '#f6416c', '#3f72af', '#ff9f43', '#6c5ce7',
]

function colorFor(name: string): string {
  let h = 0
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return PALETTE[h % PALETTE.length]
}

export const scheduleRoutes: FastifyPluginAsync = async (app) => {
  // 完整课表：课程 + 排课
  app.get('/api/schedule', async (req) => {
    const { semesterId } = req.query as { semesterId?: string }
    const sid = Number(semesterId)
    if (!sid) return { courses: [], sessions: [] }
    const courseRows = db.select().from(courses).where(eq(courses.semesterId, sid)).all()
    const sessionRows = db.select().from(courseSessions).where(eq(courseSessions.semesterId, sid)).all()
    return {
      courses: courseRows.map((c) => ({ ...c, sessions: sessionRows.filter((s) => s.courseId === c.id) })),
      sessions: sessionRows.map((s) => ({ ...s, weeks: JSON.parse(s.weeks) as number[] })),
    }
  })

  // 导入解析结果：按课程名去重建课程，写入排课
  app.post('/api/schedule/import', async (req) => {
    const body = req.body as { semesterId: number; cells: CourseCellInput[]; replace?: boolean }
    if (!body?.semesterId || !Array.isArray(body.cells)) {
      throw Object.assign(new Error('参数错误'), { statusCode: 400 })
    }
    const sid = body.semesterId
    const result = sqlite.transaction(() => {
      if (body.replace) {
        sqlite.prepare('DELETE FROM courses WHERE semester_id = ?').run(sid)
      }
      const existing = db.select().from(courses).where(eq(courses.semesterId, sid)).all()
      const byName = new Map(existing.map((c) => [c.name, c]))
      let added = 0
      for (const cell of body.cells) {
        let course = byName.get(cell.name)
        if (!course) {
          const res = db
            .insert(courses)
            .values({
              semesterId: sid,
              name: cell.name,
              teacher: cell.teacher,
              color: cell.color || colorFor(cell.name),
              credit: cell.credit,
              examType: cell.examType,
              note: cell.note ?? '',
            })
            .run()
          course = db.select().from(courses).where(eq(courses.id, res.lastInsertRowid as number)).get()!
          byName.set(cell.name, course)
          added++
        } else if (cell.teacher && !course.teacher) {
          db.update(courses).set({ teacher: cell.teacher }).where(eq(courses.id, course.id)).run()
          course = { ...course, teacher: cell.teacher }
        }
        db.insert(courseSessions)
          .values({
            courseId: course.id,
            semesterId: sid,
            weekday: cell.weekday,
            startSection: cell.startSection,
            endSection: cell.endSection,
            weeks: JSON.stringify(cell.weeks),
            weekParity: cell.weekParity,
            room: cell.room,
            note: '',
          })
          .run()
      }
      return { coursesTotal: byName.size, coursesAdded: added, sessionsAdded: body.cells.length }
    })()
    return result
  })

  // 手动编辑排课
  app.put('/api/schedule/session/:id', async (req) => {
    const { id } = req.params as { id: string }
    const b = req.body as Partial<CourseCellInput>
    const patch: Record<string, unknown> = {}
    if (b.weekday !== undefined) patch.weekday = b.weekday
    if (b.startSection !== undefined) patch.startSection = b.startSection
    if (b.endSection !== undefined) patch.endSection = b.endSection
    if (b.weeks !== undefined) patch.weeks = JSON.stringify(b.weeks)
    if (b.weekParity !== undefined) patch.weekParity = b.weekParity
    if (b.room !== undefined) patch.room = b.room
    db.update(courseSessions).set(patch).where(eq(courseSessions.id, Number(id))).run()
    const row = db.select().from(courseSessions).where(eq(courseSessions.id, Number(id))).get()
    return row ? { ...row, weeks: JSON.parse(row.weeks) } : null
  })

  app.post('/api/schedule/session', async (req) => {
    const b = req.body as CourseCellInput & { courseId: number; semesterId: number }
    const res = db
      .insert(courseSessions)
      .values({
        courseId: b.courseId,
        semesterId: b.semesterId,
        weekday: b.weekday,
        startSection: b.startSection,
        endSection: b.endSection,
        weeks: JSON.stringify(b.weeks ?? []),
        weekParity: b.weekParity ?? 'all',
        room: b.room ?? '',
        note: '',
      })
      .run()
    return { id: res.lastInsertRowid }
  })

  app.delete('/api/schedule/session/:id', async (req) => {
    const { id } = req.params as { id: string }
    db.delete(courseSessions).where(eq(courseSessions.id, Number(id))).run()
    return { ok: true }
  })

  app.delete('/api/schedule/course/:id', async (req) => {
    const { id } = req.params as { id: string }
    db.delete(courses).where(eq(courses.id, Number(id))).run()
    return { ok: true }
  })

  app.put('/api/schedule/course/:id', async (req) => {
    const { id } = req.params as { id: string }
    const b = req.body as { color?: string; note?: string; teacher?: string }
    const patch: Record<string, unknown> = {}
    if (b.color !== undefined) patch.color = b.color
    if (b.note !== undefined) patch.note = b.note
    if (b.teacher !== undefined) patch.teacher = b.teacher
    db.update(courses).set(patch).where(eq(courses.id, Number(id))).run()
    return { ok: true }
  })
}
