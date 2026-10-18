import type Database from 'better-sqlite3'
import type { AssistantChange, AssistantEntity, AssistantTarget } from '@wb/shared'

type Row = Record<string, unknown>
interface EntitySpec { table: string; label: string; fields: Record<string, string>; path: string; tab?: string }
export const ASSISTANT_ENTITIES: Record<AssistantEntity, EntitySpec> = {
  countdown: { table: 'countdowns', label: '倒计日', fields: { title: 'title', date: 'date', category: 'category', note: 'note' }, path: '/tools', tab: 'countdown' },
  note: { table: 'notes', label: '笔记', fields: { title: 'title', content: 'content', courseTag: 'course_tag', category: 'category' }, path: '/notes' },
  homework: { table: 'chaoxing_homework', label: '作业本地记录', fields: { title: 'title', courseName: 'course_name', deadline: 'deadline', status: 'status' }, path: '/chaoxing' },
  prompt: { table: 'prompts', label: '提示词', fields: { name: 'name', content: 'content' }, path: '/ai-lab', tab: 'prompts' },
  score: { table: 'scores', label: '成绩', fields: { semester: 'semester', courseName: 'course_name', credit: 'credit', score: 'score', gradePoint: 'grade_point', examType: 'exam_type' }, path: '/tools', tab: 'scores' },
  run: { table: 'run_checkins', label: '健康跑', fields: { date: 'date', distanceKm: 'distance_km', steps: 'steps', note: 'note' }, path: '/tools', tab: 'runs' },
  course: { table: 'courses', label: '课程', fields: { semesterId: 'semester_id', name: 'name', teacher: 'teacher', color: 'color', credit: 'credit', examType: 'exam_type', note: 'note' }, path: '/schedule', tab: 'grid' },
  session: { table: 'course_sessions', label: '排课', fields: { semesterId: 'semester_id', courseId: 'course_id', weekday: 'weekday', startSection: 'start_section', endSection: 'end_section', weeks: 'weeks', weekParity: 'week_parity', room: 'room', note: 'note' }, path: '/schedule', tab: 'grid' },
}
export interface StoredChange {
  entity: AssistantEntity
  action: AssistantChange['action']
  id: number
  label: string
  before: Row | null
  after: Row | null
  children: { table: string; rows: Row[] }[]
  target: AssistantTarget
}
export function assistantError(message: string, statusCode = 400) { return Object.assign(new Error(message), { statusCode }) }
export function entityOf(value: unknown): AssistantEntity {
  if (typeof value !== 'string' || !Object.hasOwn(ASSISTANT_ENTITIES, value)) throw assistantError('不支持的修改对象')
  return value as AssistantEntity
}
export function readRecord(database: Database.Database, entity: AssistantEntity, id: number): Row | null {
  return database.prepare(`SELECT * FROM ${ASSISTANT_ENTITIES[entity].table} WHERE id = ?`).get(id) as Row ?? null
}
export function recordDto(entity: AssistantEntity, row: Row | null): Row | null {
  if (!row) return null
  const dto: Row = { id: row.id }
  for (const [field, column] of Object.entries(ASSISTANT_ENTITIES[entity].fields)) {
    dto[field] = field === 'weeks' ? JSON.parse(String(row[column])) : row[column]
  }
  return dto
}
export const sameRow = (a: Row | null, b: Row | null): boolean => JSON.stringify(a) === JSON.stringify(b)
function text(value: unknown, name: string, required = false, limit = 200): string {
  if (typeof value !== 'string' || value.length > limit || (required && !value.trim())) throw assistantError(`${name}需为${required ? '非空' : ''}文本，最多 ${limit} 字符`)
  return value
}
function number(value: unknown, name: string, min: number, max: number, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) throw assistantError(`${name}需在 ${min}～${max} 之间${integer ? '且为整数' : ''}`)
  return value
}
function date(value: unknown): string {
  const d = text(value, '日期', true, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !Number.isFinite(Date.parse(d)) || new Date(d).toISOString().slice(0, 10) !== d) throw assistantError('日期必须是有效的 YYYY-MM-DD')
  return d
}
function gradePoint(score: number): number {
  for (const [min, gp] of [[90, 4], [85, 3.7], [82, 3.3], [78, 3], [75, 2.7], [72, 2.3], [68, 2], [64, 1.5], [60, 1]]) if (score >= min) return gp
  return 0
}
function prepareValues(database: Database.Database, entity: AssistantEntity, incoming: Row, before: Row | null, applied: StoredChange[]): Row {
  const spec = ASSISTANT_ENTITIES[entity]
  const values = { ...incoming }
  if (entity === 'session' && typeof values.courseId === 'string' && /^\$\d+$/.test(values.courseId)) {
    const reference = applied[Number(values.courseId.slice(1))]
    if (!reference || reference.entity !== 'course' || reference.action !== 'create') throw assistantError('新增排课引用的课程无效')
    values.courseId = reference.id
  }
  const out: Row = {}
  for (const [field, value] of Object.entries(values)) {
    if (!Object.hasOwn(spec.fields, field)) throw assistantError(`${spec.label}不支持字段 ${field}`)
    const column = spec.fields[field]
    if (!column) throw assistantError(`${spec.label}不支持字段 ${field}`)
    if (['title', 'name', 'courseName', 'semester'].includes(field)) out[column] = text(value, field, true, 300).trim()
    else if (['content', 'note'].includes(field)) out[column] = text(value, field, false, 131072)
    else if (['teacher', 'courseTag', 'category', 'examType', 'room'].includes(field)) out[column] = text(value, field, false, 300)
    else if (field === 'date') out[column] = date(value)
    else if (field === 'deadline') {
      if (value !== null && (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?$/.test(value) || !Number.isFinite(Date.parse(value)))) throw assistantError('截止时间需为有效日期时间，或 null')
      if (typeof value === 'string') date(value.slice(0, 10))
      out[column] = value
    } else if (field === 'status') {
      if (!['未提交', '已提交', '进行中', '已完成', '待批阅', '已批阅'].includes(String(value))) throw assistantError('作业状态无效')
      out[column] = value
    } else if (field === 'color') {
      if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) throw assistantError('课程颜色需为六位十六进制颜色')
      out[column] = value
    } else if (field === 'weekParity') {
      if (!['all', 'odd', 'even'].includes(String(value))) throw assistantError('单双周需为 all、odd 或 even')
      out[column] = value
    } else if (field === 'weeks') {
      if (!Array.isArray(value) || !value.length) throw assistantError('周次不能为空')
      value.forEach(w => number(w, '周次', 1, 100, true))
      out[column] = JSON.stringify([...new Set(value)].sort((a, b) => a - b))
    } else if (field === 'distanceKm') out[column] = value === null ? null : Math.round(number(value, '里程', 0, 500) * 100) / 100
    else if (field === 'steps') out[column] = value === null ? null : number(value, '步数', 0, 500000, true)
    else if (['semesterId', 'courseId'].includes(field)) out[column] = number(value, field, 1, Number.MAX_SAFE_INTEGER, true)
    else if (field === 'weekday') out[column] = number(value, '星期', 1, 7, true)
    else if (['startSection', 'endSection'].includes(field)) out[column] = number(value, '节次', 1, 100, true)
    else if (field === 'credit') out[column] = number(value, '学分', entity === 'score' ? 0.01 : 0, 100)
    else if (field === 'score') out[column] = number(value, '成绩', 0, 100)
    else if (field === 'gradePoint') out[column] = number(value, '绩点', 0, 5)
  }
  const now = new Date().toISOString()
  if (!before) {
    const defaults: Partial<Record<AssistantEntity, Row>> = {
      countdown: { category: '其他', note: '' }, note: { content: '', course_tag: '', category: '', created_at: now },
      homework: { deadline: null, status: '未提交', url: '', synced_at: now }, prompt: { content: '', version: 0 },
      score: { exam_type: '' }, run: { note: '', distance_km: null, steps: null, created_at: now },
      course: { teacher: '', color: '#409eff', credit: 0, exam_type: '', note: '' }, session: { week_parity: 'all', room: '', note: '' },
    }
    for (const [key, value] of Object.entries(defaults[entity] ?? {})) if (!(key in out)) out[key] = value
  }
  const merged = { ...before, ...out }
  const required: Record<AssistantEntity, string[]> = {
    countdown: ['title', 'date'], note: ['title'], homework: ['title', 'course_name'], prompt: ['name'],
    score: ['semester', 'course_name', 'credit', 'score'], run: ['date'], course: ['semester_id', 'name'],
    session: ['semester_id', 'course_id', 'weekday', 'start_section', 'end_section', 'weeks'],
  }
  if (required[entity].some(field => merged[field] === undefined || merged[field] === null || merged[field] === '')) throw assistantError(`${spec.label}缺少必填字段`)
  if (entity === 'run' && String(merged.date) > new Date().toLocaleDateString('sv-SE')) throw assistantError('不能提前打卡未来日期')
  if (entity === 'note') out.updated_at = now
  if (entity === 'prompt') {
    out.variables = JSON.stringify([...new Set([...String(merged.content).matchAll(/\{([^}]+)\}/g)].map(m => m[1].trim()).filter(Boolean))])
    out.version = Number(before?.version ?? 0) + 1
    out.updated_at = now
  }
  if (entity === 'score' && !('grade_point' in out) && (!before || 'score' in out)) out.grade_point = gradePoint(Number(merged.score))
  if (entity === 'course' || entity === 'session') {
    const semester = database.prepare('SELECT * FROM semesters WHERE id = ?').get(merged.semester_id) as Row | undefined
    if (!semester) throw assistantError('学期不存在')
    if (entity === 'course' && before && merged.semester_id !== before.semester_id && database.prepare('SELECT 1 FROM course_sessions WHERE course_id = ?').get(before.id)) throw assistantError('已有排课的课程不能直接更换学期，请先调整排课')
    if (entity === 'session') {
      const course = readRecord(database, 'course', Number(merged.course_id))
      if (!course || course.semester_id !== merged.semester_id) throw assistantError('课程不属于该学期')
      const maxSections = (JSON.parse(String(semester.section_times)) as unknown[]).length
      if (Number(merged.start_section) > Number(merged.end_section) || Number(merged.end_section) > maxSections) throw assistantError('节次范围超出学期作息表')
      if ((JSON.parse(String(merged.weeks)) as number[]).some(w => w > Number(semester.total_weeks))) throw assistantError('周次超出学期范围')
    }
  }
  return out
}
function insertRow(database: Database.Database, table: string, row: Row): number {
  const columns = Object.keys(row)
  return Number(database.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...Object.values(row)).lastInsertRowid)
}
export function changeTarget(database: Database.Database, entity: AssistantEntity, id: number, row: Row, label: string): AssistantTarget {
  const spec = ASSISTANT_ENTITIES[entity]
  const query: Record<string, string> = { aiEntity: entity, aiId: String(id) }
  if (spec.tab) query.tab = spec.tab
  if (row.semester_id) query.semesterId = String(row.semester_id)
  if (entity === 'run') query.aiDate = String(row.date)
  if (entity === 'session') {
    const weeks = JSON.parse(String(row.weeks)) as number[]
    const sem = database.prepare('SELECT start_date FROM semesters WHERE id = ?').get(row.semester_id) as { start_date: string } | undefined
    const weekNow = sem ? Math.floor((Date.now() - new Date(sem.start_date + 'T00:00:00').getTime()) / 604800000) + 1 : 1
    query.week = String(weeks.find(w => w >= weekNow && (row.week_parity === 'all' || w % 2 === (row.week_parity === 'odd' ? 1 : 0))) ?? weeks[0])
  }
  return { entity, id, label, path: spec.path, query }
}
export function applyChanges(database: Database.Database, changes: AssistantChange[], observed: Map<string, Row>): StoredChange[] {
  if (!Array.isArray(changes) || !changes.length || changes.length > 20) throw assistantError('每次需修改 1～20 项')
  const applied: StoredChange[] = []
  const touched = new Set<string>()
  for (const change of changes) {
    if (!change || typeof change !== 'object') throw assistantError('修改指令格式无效')
    const entity = entityOf(change.entity)
    if (!['create', 'update', 'delete'].includes(change.action)) throw assistantError('修改动作无效')
    const spec = ASSISTANT_ENTITIES[entity]
    let id = change.id ?? 0
    let before: Row | null = null
    if (change.action !== 'create') {
      number(id, '记录编号', 1, Number.MAX_SAFE_INTEGER, true)
      before = readRecord(database, entity, id)
      const expected = observed.get(`${entity}:${id}`)
      if (!expected || !before || !sameRow(before, expected)) throw assistantError('目标记录在分析期间发生变化，请重新发送请求', 409)
      if (touched.has(`${entity}:${id}`)) throw assistantError('同一批不能重复修改同一条记录')
    }
    const children: StoredChange['children'] = []
    if (change.action === 'delete') {
      if (entity === 'course') {
        const sessions = database.prepare('SELECT * FROM course_sessions WHERE course_id = ?').all(id) as Row[]
        if (sessions.some(row => touched.has(`session:${row.id}`))) throw assistantError('删除课程已包含排课，请勿在同一批重复修改其排课')
        children.push({ table: 'course_sessions', rows: sessions })
        for (const row of sessions) touched.add(`session:${row.id}`)
      }
      if (entity === 'prompt') children.push({ table: 'prompt_cases', rows: database.prepare('SELECT * FROM prompt_cases WHERE prompt_id = ?').all(id) as Row[] })
      for (const child of children) for (const row of child.rows) database.prepare(`DELETE FROM ${child.table} WHERE id = ?`).run(row.id)
      database.prepare(`DELETE FROM ${spec.table} WHERE id = ?`).run(id)
    } else {
      if (!change.values || typeof change.values !== 'object' || Array.isArray(change.values) || !Object.keys(change.values).length) throw assistantError('缺少要写入的字段')
      const values = prepareValues(database, entity, change.values, before, applied)
      if (change.action === 'create') id = insertRow(database, spec.table, values)
      else database.prepare(`UPDATE ${spec.table} SET ${Object.keys(values).map(column => `${column} = ?`).join(',')} WHERE id = ?`).run(...Object.values(values), id)
    }
    touched.add(`${entity}:${id}`)
    const after = readRecord(database, entity, id)
    const record = after ?? before!
    const label = String(record.title ?? record.name ?? record.course_name ?? record.date ?? spec.label)
    applied.push({ entity, action: change.action, id, label, before, after, children, target: changeTarget(database, entity, id, record, label) })
  }
  return applied
}
export function undoChanges(database: Database.Database, changes: StoredChange[]) {
  for (const change of changes) if (!sameRow(readRecord(database, change.entity, change.id), change.after)) throw assistantError('记录随后又被修改，撤销会覆盖新内容；请保留当前记录或先处理冲突', 409)
  for (const change of [...changes].reverse()) {
    const table = ASSISTANT_ENTITIES[change.entity].table
    if (!change.before) {
      if (change.entity === 'course' && database.prepare('SELECT 1 FROM course_sessions WHERE course_id = ?').get(change.id)) throw assistantError('新课程已有后续排课，暂不能撤销', 409)
      if (change.entity === 'prompt' && database.prepare('SELECT 1 FROM prompt_cases WHERE prompt_id = ?').get(change.id)) throw assistantError('新提示词已有后续用例，暂不能撤销', 409)
      database.prepare(`DELETE FROM ${table} WHERE id = ?`).run(change.id)
    } else if (!change.after) {
      insertRow(database, table, change.before)
      for (const child of change.children) for (const row of child.rows) insertRow(database, child.table, row)
    } else {
      const values = { ...change.before }; delete values.id
      database.prepare(`UPDATE ${table} SET ${Object.keys(values).map(column => `${column} = ?`).join(',')} WHERE id = ?`).run(...Object.values(values), change.id)
    }
  }
}
