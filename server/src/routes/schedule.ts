import { eq } from 'drizzle-orm'
import type { FastifyPluginAsync } from 'fastify'
import type { CourseCellInput } from '@wb/shared'
import { inSemester, isDateStr, weekOfDate, weekdayOfDate } from '@wb/shared'
import { db, sqlite } from '../db/index.js'
import { courses, courseSessions, scheduleSwaps, semesters } from '../db/schema.js'

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
  // 完整课表：课程 + 排课 + 调休例外
  app.get('/api/schedule', async (req) => {
    const { semesterId } = req.query as { semesterId?: string }
    const sid = Number(semesterId)
    if (!sid) return { courses: [], sessions: [], swaps: [] }
    const courseRows = db.select().from(courses).where(eq(courses.semesterId, sid)).all()
    const sessionRows = db.select().from(courseSessions).where(eq(courseSessions.semesterId, sid)).all()
    const swapRows = db.select().from(scheduleSwaps).where(eq(scheduleSwaps.semesterId, sid)).all()
    return {
      courses: courseRows.map((c) => ({ ...c, sessions: sessionRows.filter((s) => s.courseId === c.id) })),
      sessions: sessionRows.map((s) => ({ ...s, weeks: JSON.parse(s.weeks) as number[] })),
      swaps: swapRows,
    }
  })

  // ==================== 调休（日期互换）====================
  //
  // 记法：`targetDate ← sourceDate`，即"targetDate 这一天按 sourceDate 那天的课表上课"。
  //   · 只覆盖（copy）：一行               —— 把源日的课复制到目标日，源日不变
  //   · 互换（swap）  ：两行（正反各一）   —— 调休的常态：周末补周二的课、周二放假
  // 详见 services/scheduleSwap.ts 里对"为什么不去改周模板"的说明。

  app.post('/api/schedule/swaps', async (req) => {
    const b = req.body as {
      semesterId?: number
      sourceDate?: string
      targetDate?: string
      mode?: 'swap' | 'copy'
    }
    const sid = Number(b?.semesterId)
    const sourceDate = b?.sourceDate
    const targetDate = b?.targetDate
    const mode = b?.mode === 'copy' ? 'copy' : 'swap'

    const semester = sid ? db.select().from(semesters).where(eq(semesters.id, sid)).get() : null
    if (!semester) throw Object.assign(new Error('学期不存在'), { statusCode: 400 })
    if (!isDateStr(sourceDate) || !isDateStr(targetDate)) {
      throw Object.assign(new Error('日期格式应为 YYYY-MM-DD'), { statusCode: 400 })
    }
    if (sourceDate === targetDate) {
      throw Object.assign(new Error('源日期与目标日期不能是同一天'), { statusCode: 400 })
    }
    const cal = { startDate: semester.startDate, totalWeeks: semester.totalWeeks }
    for (const [label, d] of [
      ['源日期', sourceDate],
      ['目标日期', targetDate],
    ] as const) {
      if (!inSemester(d, cal)) {
        throw Object.assign(
          new Error(`${label} ${d} 不在本学期范围内（${semester.startDate} 起共 ${semester.totalWeeks} 周）`),
          { statusCode: 400 },
        )
      }
    }

    const now = new Date().toLocaleString('zh-CN', { hour12: false })
    let removedBefore = 0
    sqlite.transaction(() => {
      // ⚠️ 新规则落地前，先把"涉及这两天"的旧记录清干净：既包括以它们为**目标**的，
      //    也包括**以它们为来源**的（`C ← A` 这种）。否则会出现"A 既被替换、又被别人借用"的叠加，
      //    而解析只做一跳，叠加后的语义没法解释、界面上也无从呈现。
      const info = sqlite
        .prepare('DELETE FROM schedule_swaps WHERE semester_id = ? AND (date IN (?, ?) OR source_date IN (?, ?))')
        .run(sid, sourceDate, targetDate, sourceDate, targetDate)
      removedBefore = info.changes
      db.insert(scheduleSwaps).values({ semesterId: sid, date: targetDate, sourceDate, createdAt: now }).run()
      if (mode === 'swap') {
        db.insert(scheduleSwaps).values({ semesterId: sid, date: sourceDate, sourceDate: targetDate, createdAt: now }).run()
      }
    })()
    // 正常情况下"删掉的"就是本次要重建的那 1~2 条；多出来的说明动了无关的旧调休，
    // 这时必须告诉用户，否则他会发现"之前设的调休怎么没了"却不知道是谁动的
    const inserted = mode === 'swap' ? 2 : 1
    const replaced = Math.max(0, removedBefore - inserted)

    const rows = db.select().from(scheduleSwaps).where(eq(scheduleSwaps.semesterId, sid)).all()
    return {
      ok: true,
      mode,
      replaced,
      swaps: rows,
      effect: {
        target: {
          date: targetDate,
          week: weekOfDate(targetDate, cal),
          weekday: weekdayOfDate(targetDate),
          sourceWeek: weekOfDate(sourceDate, cal),
          sourceWeekday: weekdayOfDate(sourceDate),
        },
      },
    }
  })

  /** 恢复某一天：删掉"以它为目标的"和"以它为来源的"所有例外（互换会一次删掉两条） */
  app.delete('/api/schedule/swaps', async (req) => {
    const { semesterId, date } = req.query as { semesterId?: string; date?: string }
    const sid = Number(semesterId)
    if (!sid || !isDateStr(date)) throw Object.assign(new Error('参数错误'), { statusCode: 400 })
    const info = sqlite
      .prepare('DELETE FROM schedule_swaps WHERE semester_id = ? AND (date = ? OR source_date = ?)')
      .run(sid, date, date)
    return { ok: true, removed: info.changes }
  })

  /** 精确删一条 */
  app.delete('/api/schedule/swaps/:id', async (req) => {
    const { id } = req.params as { id: string }
    db.delete(scheduleSwaps).where(eq(scheduleSwaps.id, Number(id))).run()
    return { ok: true }
  })

  // 导出为 Android 端可导入的互通文档（YoshinoveTimetable/开发计划.md 3.7）
  app.get('/api/schedule/export', async (req) => {
    const { semesterId } = req.query as { semesterId?: string }
    const sid = Number(semesterId)
    const semRows = sid
      ? db.select().from(semesters).where(eq(semesters.id, sid)).all()
      : db.select().from(semesters).all()

    return {
      format: 'yoshinove-timetable',
      version: 1,
      exportedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
      semesters: semRows.map((s) => {
        const courseRows = db.select().from(courses).where(eq(courses.semesterId, s.id)).all()
        const sessionRows = db
          .select()
          .from(courseSessions)
          .where(eq(courseSessions.semesterId, s.id))
          .all()
        return {
          name: s.name,
          startDate: s.startDate,
          totalWeeks: s.totalWeeks,
          isCurrent: !!s.isCurrent,
          sectionTimes: (JSON.parse(s.sectionTimes) as { start: string; end: string }[]).map((t) => ({
            start: t.start,
            end: t.end,
          })),
          courses: courseRows.map((c) => ({
            name: c.name,
            teacher: c.teacher,
            color: c.color,
            credit: c.credit,
            examType: c.examType,
            note: c.note,
            sessions: sessionRows
              .filter((ses) => ses.courseId === c.id)
              .map((ses) => ({
                weekday: ses.weekday,
                startSection: ses.startSection,
                endSection: ses.endSection,
                weeks: JSON.parse(ses.weeks) as number[],
                weekParity: ses.weekParity,
                room: ses.room,
                note: ses.note,
              })),
          })),
        }
      }),
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
