import { desc, eq } from 'drizzle-orm'
import type { FastifyPluginAsync } from 'fastify'
import * as XLSX from 'xlsx'
import { db } from '../db/index.js'
import { countdowns, pomodoroSessions, runCheckins, scores } from '../db/schema.js'

const fmtDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** 常见绩点换算（可按学校规则调整） */
function gpaFromScore(score: number): number {
  if (score >= 90) return 4.0
  if (score >= 85) return 3.7
  if (score >= 82) return 3.3
  if (score >= 78) return 3.0
  if (score >= 75) return 2.7
  if (score >= 72) return 2.3
  if (score >= 68) return 2.0
  if (score >= 64) return 1.5
  if (score >= 60) return 1.0
  return 0
}

export const toolRoutes: FastifyPluginAsync = async (app) => {
  // ===== 健康跑打卡 =====
  app.get('/api/runs', async () => {
    const rows = db.select().from(runCheckins).orderBy(desc(runCheckins.date)).all()
    const dates = new Set(rows.map((r) => r.date))
    const today = new Date()
    const todayStr = fmtDate(today)
    // 连续天数：从今天（或昨天）往前数
    const cursor = new Date(today)
    if (!dates.has(fmtDate(cursor))) cursor.setDate(cursor.getDate() - 1)
    let streak = 0
    while (dates.has(fmtDate(cursor))) {
      streak++
      cursor.setDate(cursor.getDate() - 1)
    }
    // 本周（周一起）
    const weekStart = new Date(today)
    weekStart.setDate(today.getDate() - ((today.getDay() + 6) % 7))
    const weekCount = rows.filter((r) => r.date >= fmtDate(weekStart) && r.date <= todayStr).length
    const monthPrefix = todayStr.slice(0, 7)
    const monthCount = rows.filter((r) => r.date.startsWith(monthPrefix)).length
    // 里程合计（只计录了里程的天）
    const kmOf = (r: (typeof rows)[number]) => r.distanceKm ?? 0
    const weekKm = rows.filter((r) => r.date >= fmtDate(weekStart) && r.date <= todayStr).reduce((s, r) => s + kmOf(r), 0)
    const monthKm = rows.filter((r) => r.date.startsWith(monthPrefix)).reduce((s, r) => s + kmOf(r), 0)
    return {
      dates: rows.map((r) => r.date),
      records: rows.map((r) => ({ date: r.date, distanceKm: r.distanceKm, steps: r.steps })),
      total: rows.length,
      streak,
      weekCount,
      monthCount,
      weekKm: Math.round(weekKm * 100) / 100,
      monthKm: Math.round(monthKm * 100) / 100,
      today: dates.has(todayStr),
    }
  })

  /** 里程/步数的合法区间；undefined = 不修改，null = 清空 */
  const parseMetrics = (body: { distanceKm?: unknown; steps?: unknown }) => {
    const patch: { distanceKm?: number | null; steps?: number | null } = {}
    if ('distanceKm' in body) {
      const v = body.distanceKm
      if (v !== null && (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 500)) {
        throw Object.assign(new Error('里程需在 0~500 km 之间'), { statusCode: 400 })
      }
      patch.distanceKm = v === null ? null : Math.round(v * 100) / 100
    }
    if ('steps' in body) {
      const v = body.steps
      if (v !== null && (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 500000)) {
        throw Object.assign(new Error('步数需为 0~500000 的整数'), { statusCode: 400 })
      }
      patch.steps = v
    }
    return patch
  }

  // 打卡（upsert 语义）：同一天重复提交时更新里程/步数，不再返回「已打卡」而忽略数据
  app.post('/api/runs/checkin', async (req) => {
    const { date, note } = req.body as { date?: string; note?: string }
    const metrics = parseMetrics(req.body as Record<string, unknown>)
    const d = date ?? fmtDate(new Date())
    const exists = db.select().from(runCheckins).where(eq(runCheckins.date, d)).get()
    if (exists) {
      if (Object.keys(metrics).length) db.update(runCheckins).set(metrics).where(eq(runCheckins.date, d)).run()
      return { ok: true, detail: Object.keys(metrics).length ? '已更新该日记录' : '该日期已打卡', updated: true }
    }
    db.insert(runCheckins).values({ date: d, note: note ?? '', ...metrics, createdAt: new Date().toISOString() }).run()
    return { ok: true, detail: '打卡成功', updated: false }
  })

  // 修改某天的里程/步数
  app.put('/api/runs/checkin/:date', async (req) => {
    const { date } = req.params as { date: string }
    const metrics = parseMetrics(req.body as Record<string, unknown>)
    if (!Object.keys(metrics).length) throw Object.assign(new Error('没有要修改的字段'), { statusCode: 400 })
    const exists = db.select().from(runCheckins).where(eq(runCheckins.date, date)).get()
    if (!exists) throw Object.assign(new Error('该日期尚未打卡'), { statusCode: 404 })
    db.update(runCheckins).set(metrics).where(eq(runCheckins.date, date)).run()
    return { ok: true }
  })

  app.delete('/api/runs/checkin/:date', async (req) => {
    const { date } = req.params as { date: string }
    db.delete(runCheckins).where(eq(runCheckins.date, date)).run()
    return { ok: true }
  })

  // ===== 倒计日 =====
  app.get('/api/countdowns', async () => {
    return db.select().from(countdowns).orderBy(desc(countdowns.date)).all()
  })

  app.post('/api/countdowns', async (req) => {
    const b = req.body as { title: string; date: string; category?: string; note?: string }
    if (!b.title || !b.date) throw Object.assign(new Error('标题与日期必填'), { statusCode: 400 })
    const r = db.insert(countdowns).values({ title: b.title, date: b.date, category: b.category ?? '其他', note: b.note ?? '' }).run()
    return { id: r.lastInsertRowid }
  })

  app.put('/api/countdowns/:id', async (req) => {
    const { id } = req.params as { id: string }
    const b = req.body as Partial<{ title: string; date: string; category: string; note: string }>
    const patch: Record<string, unknown> = {}
    if (b.title !== undefined) patch.title = b.title
    if (b.date !== undefined) patch.date = b.date
    if (b.category !== undefined) patch.category = b.category
    if (b.note !== undefined) patch.note = b.note
    db.update(countdowns).set(patch).where(eq(countdowns.id, Number(id))).run()
    return { ok: true }
  })

  app.delete('/api/countdowns/:id', async (req) => {
    const { id } = req.params as { id: string }
    db.delete(countdowns).where(eq(countdowns.id, Number(id))).run()
    return { ok: true }
  })

  // ===== 成绩绩点 =====
  app.get('/api/scores', async () => {
    const rows = db.select().from(scores).orderBy(desc(scores.id)).all()
    const withGp = rows.map((r) => ({ ...r, gradePoint: r.gradePoint || gpaFromScore(r.score) }))
    // 按学期汇总加权绩点
    const bySemester = new Map<string, { totalCredit: number; weighted: number; count: number }>()
    let allCredit = 0
    let allWeighted = 0
    for (const r of withGp) {
      const s = bySemester.get(r.semester) ?? { totalCredit: 0, weighted: 0, count: 0 }
      s.totalCredit += r.credit
      s.weighted += r.credit * r.gradePoint
      s.count++
      bySemester.set(r.semester, s)
      allCredit += r.credit
      allWeighted += r.credit * r.gradePoint
    }
    const semesters = [...bySemester.entries()].map(([semester, s]) => ({
      semester,
      gpa: s.totalCredit ? +(s.weighted / s.totalCredit).toFixed(2) : 0,
      totalCredit: +s.totalCredit.toFixed(1),
      count: s.count,
    }))
    return {
      rows: withGp,
      semesters,
      overallGpa: allCredit ? +(allWeighted / allCredit).toFixed(2) : 0,
      overallCredit: +allCredit.toFixed(1),
    }
  })

  app.post('/api/scores', async (req) => {
    const b = req.body as { semester: string; courseName: string; credit: number; score: number; gradePoint?: number }
    if (!b.semester || !b.courseName || !b.credit || b.score === undefined) {
      throw Object.assign(new Error('学期/课程/学分/成绩均必填'), { statusCode: 400 })
    }
    const r = db
      .insert(scores)
      .values({
        semester: b.semester,
        courseName: b.courseName,
        credit: b.credit,
        score: b.score,
        gradePoint: b.gradePoint || gpaFromScore(b.score),
        examType: '',
      })
      .run()
    return { id: r.lastInsertRowid }
  })

  app.delete('/api/scores/:id', async (req) => {
    const { id } = req.params as { id: string }
    db.delete(scores).where(eq(scores.id, Number(id))).run()
    return { ok: true }
  })

  // ===== Excel 导入成绩（教务系统导出格式，列名自动匹配）=====
  app.post('/api/scores/import', async (req) => {
    const file = await req.file()
    if (!file) throw Object.assign(new Error('请上传 xlsx 文件'), { statusCode: 400 })
    const buf = await file.toBuffer()
    const wb = XLSX.read(buf, { type: 'buffer' })
    const ws = wb.Sheets[wb.SheetNames[0]]
    if (!ws) throw Object.assign(new Error('Excel 中没有工作表'), { statusCode: 400 })
    const grid = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, defval: '' })
    if (!grid.length) throw Object.assign(new Error('Excel 是空的'), { statusCode: 400 })

    // 1. 找表头行（含"课程名称"与"成绩"的行， tolerate 前几行是标题的情况）
    let headerRow = -1
    for (let i = 0; i < Math.min(grid.length, 10); i++) {
      const cells = grid[i].map((c) => String(c).trim())
      if (cells.some((c) => c.includes('课程名称')) && cells.some((c) => c === '成绩' || c.includes('成绩'))) {
        headerRow = i
        break
      }
    }
    if (headerRow === -1) {
      throw Object.assign(new Error('没找到表头行（需要包含"课程名称"和"成绩"列）'), { statusCode: 400 })
    }
    const headers = grid[headerRow].map((c) => String(c).trim())
    const colOf = (...names: string[]) => headers.findIndex((h) => names.some((n) => h === n || h.includes(n)))
    const col = {
      year: colOf('学年'),
      term: colOf('学期'),
      name: colOf('课程名称'),
      credit: colOf('学分'),
      score: headers.indexOf('成绩'),
      gp: colOf('绩点'),
    }
    if (col.name === -1 || col.score === -1) {
      throw Object.assign(new Error('缺少"课程名称"或"成绩"列'), { statusCode: 400 })
    }

    // 2. 逐行解析（学期 = 学年 + "第" + 学期 + "学期"）
    const existing = db.select().from(scores).all()
    const key = (r: { semester: string; courseName: string }) => `${r.semester}|${r.courseName}`
    const known = new Map(existing.map((r) => [key(r), r]))
    let inserted = 0
    let updated = 0
    let skipped = 0
    const semestersSeen = new Set<string>()

    for (let i = headerRow + 1; i < grid.length; i++) {
      const cells = grid[i]
      const courseName = String(cells[col.name] ?? '').trim()
      const scoreRaw = cells[col.score]
      if (!courseName || scoreRaw === '' || scoreRaw === null || scoreRaw === undefined) {
        skipped++
        continue
      }
      const score = Number(scoreRaw)
      if (Number.isNaN(score)) {
        skipped++
        continue
      }
      const credit = Number(cells[col.credit] ?? 0) || 0
      const gpCell = col.gp !== -1 ? Number(cells[col.gp]) : NaN
      const gradePoint = Number.isNaN(gpCell) || !gpCell ? gpaFromScore(score) : gpCell
      const year = col.year !== -1 ? String(cells[col.year] ?? '').trim() : ''
      const term = col.term !== -1 ? String(cells[col.term] ?? '').trim() : ''
      const semester =
        year && term ? `${year}第${parseInt(term, 10) || term}学期` : year || `导入${new Date().getFullYear()}`
      semestersSeen.add(semester)

      const entry = { semester, courseName, credit, score, gradePoint }
      const old = known.get(key(entry))
      if (old) {
        db.update(scores)
          .set({ credit, score, gradePoint })
          .where(eq(scores.id, old.id))
          .run()
        updated++
      } else {
        const r = db.insert(scores).values({ ...entry, examType: '' }).run()
        known.set(key(entry), { id: r.lastInsertRowid as number, ...entry, examType: '' })
        inserted++
      }
    }

    return {
      ok: true,
      detail: `导入完成：新增 ${inserted} 条、更新 ${updated} 条、跳过 ${skipped} 行`,
      inserted,
      updated,
      skipped,
      semesters: [...semestersSeen],
    }
  })

  // ===== 番茄钟 =====
  app.get('/api/pomodoro', async (req) => {
    const { days } = req.query as { days?: string }
    const n = Math.min(Number(days) || 30, 365)
    const rows = db.select().from(pomodoroSessions).orderBy(desc(pomodoroSessions.id)).all()
    // 按日聚合（最近 n 天）
    const daily = new Map<string, number>()
    const today = new Date()
    for (let i = 0; i < n; i++) {
      const d = new Date(today)
      d.setDate(today.getDate() - i)
      daily.set(fmtDate(d), 0)
    }
    for (const r of rows) {
      const day = r.startedAt.slice(0, 10)
      if (daily.has(day)) daily.set(day, (daily.get(day) ?? 0) + r.durationMin)
    }
    const todayStr = fmtDate(today)
    const todayMin = rows.filter((r) => r.startedAt.slice(0, 10) === todayStr).reduce((s, r) => s + r.durationMin, 0)
    return {
      todayMin,
      daily: [...daily.entries()].map(([date, minutes]) => ({ date, minutes })).reverse(),
      recent: rows.slice(0, 30),
    }
  })

  app.post('/api/pomodoro', async (req) => {
    const b = req.body as { taskLabel?: string; courseTag?: string; startedAt: string; endedAt: string; durationMin: number }
    if (!b.startedAt || !b.endedAt || !b.durationMin) throw Object.assign(new Error('参数不完整'), { statusCode: 400 })
    const r = db
      .insert(pomodoroSessions)
      .values({
        taskLabel: b.taskLabel ?? '',
        courseTag: b.courseTag ?? '',
        startedAt: b.startedAt,
        endedAt: b.endedAt,
        durationMin: Math.max(1, Math.round(b.durationMin)),
      })
      .run()
    return { id: r.lastInsertRowid }
  })

  app.delete('/api/pomodoro/:id', async (req) => {
    const { id } = req.params as { id: string }
    db.delete(pomodoroSessions).where(eq(pomodoroSessions.id, Number(id))).run()
    return { ok: true }
  })
}
