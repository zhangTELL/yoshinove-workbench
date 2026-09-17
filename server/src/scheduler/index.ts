import type { ReminderRule, SectionTime, WeekParity } from '@wb/shared'
import { eq } from 'drizzle-orm'
import { db, sqlite } from '../db/index.js'
import { chaoxingHomework, courses, courseSessions, semesters } from '../db/schema.js'
import { findLowBalances, pruneSnapshots, refreshProfiles, selectProfiles } from '../services/balanceStore.js'
import { syncAll, upsertWorks } from '../services/chaoxing.js'
import { sendPushPlus, sendWecom } from '../services/push.js'

interface NotifSettings {
  rules: ReminderRule[]
  pushplusToken: string
  wecom: { corpId: string; agentId: string; secret: string; toUser: string }
}

function getSettings(): NotifSettings {
  const rows = sqlite.prepare("SELECT key, value FROM settings WHERE key IN ('notification.rules','notification.pushplusToken','notification.wecom')").all() as { key: string; value: string }[]
  const out: NotifSettings = {
    rules: [],
    pushplusToken: '',
    wecom: { corpId: '', agentId: '', secret: '', toUser: '@all' },
  }
  for (const r of rows) {
    try {
      if (r.key === 'notification.rules') out.rules = JSON.parse(r.value)
      else if (r.key === 'notification.pushplusToken') out.pushplusToken = JSON.parse(r.value) ?? ''
      else if (r.key === 'notification.wecom') Object.assign(out.wecom, JSON.parse(r.value) ?? {})
    } catch {
      /* 忽略坏数据 */
    }
  }
  return out
}

function getSetting<T>(key: string, fallback: T): T {
  const row = sqlite.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
  if (!row) return fallback
  try {
    return JSON.parse(row.value) as T
  } catch {
    return fallback
  }
}

// ===== 学习通作业：截止提醒 + 自动同步 =====
let lastAutoSyncAttempt = 0

async function scanChaoxing(): Promise<void> {
  // 自动同步
  const autoSyncMin = getSetting<number>('chaoxing.autoSyncMin', 0)
  if (autoSyncMin > 0 && Date.now() - lastAutoSyncAttempt > autoSyncMin * 60000) {
    lastAutoSyncAttempt = Date.now()
    try {
      const r = await syncAll()
      if (r.ok) upsertWorks(r.works)
      else console.warn('[scheduler] 学习通自动同步失败:', r.detail)
    } catch (e) {
      console.warn('[scheduler] 学习通自动同步异常:', (e as Error).message)
    }
  }

  // 截止提醒：到达"截止时间 - 提前量"即触发，dedupe_key 保证每条只发一次
  const remindBefore = getSetting<number[]>('chaoxing.remindBefore', [])
  const channels = getSetting<string[]>('chaoxing.channels', ['browser'])
  if (!remindBefore.length || !channels.length) return
  const settings = getSettings()
  const now = Date.now()
  const rows = db.select().from(chaoxingHomework).all()
  for (const hw of rows) {
    if (!hw.deadline || hw.status === '已提交') continue
    const dl = new Date(hw.deadline.replace(' ', 'T')).getTime()
    if (Number.isNaN(dl) || dl <= now) continue
    for (const mins of remindBefore) {
      if (now < dl - mins * 60000) continue
      const left = mins >= 1440 ? `${mins / 1440} 天` : mins >= 60 ? `${mins / 60} 小时` : `${mins} 分钟`
      const body = `作业提醒：${hw.courseName}《${hw.title}》将在 ${left}后截止（${hw.deadline}）`
      const dedupeKey = `hw-${hw.id}-${mins}`
      for (const channel of channels) {
        const status = await dispatch(channel, '作业截止提醒', body, settings)
        insertNotification(channel, 'chaoxing', '作业截止提醒', body, status, dedupeKey)
      }
    }
  }
}

// ===== AI 平台余额：定时轮询 + 低余额提醒 =====

/** 距最近一次成功写入快照过了多久（毫秒）；没有快照返回 null */
function lastCaptureAgeMs(): number | null {
  const row = sqlite.prepare('SELECT MAX(captured_at) AS t FROM balance_snapshots').get() as { t: string | null }
  if (!row?.t) return null
  const t = new Date(row.t.replace(' ', 'T')).getTime()
  return Number.isNaN(t) ? null : Date.now() - t
}

async function scanBalance(): Promise<void> {
  const intervalMin = getSetting<number>('balance.intervalMin', 30)
  if (intervalMin <= 0) return // 配成 0 即关闭轮询

  // 用库里最后一次抓取时间判断，而不是内存计时器——重启后不会立刻重抓、
  // 失败写入的 error 快照同样会顺延下一次尝试，天然形成退避
  const age = lastCaptureAgeMs()
  if (age !== null && age < intervalMin * 60000) return

  const targets = selectProfiles().filter((p) => p.balance_enabled)
  if (!targets.length) return

  try {
    const outcomes = await refreshProfiles(targets)
    pruneSnapshots()
    for (const o of outcomes) {
      if (o.status === 'error') console.warn(`[scheduler] 余额抓取失败「${o.profileName}」: ${o.error}`)
    }
  } catch (e) {
    console.warn('[scheduler] 余额抓取异常:', (e as Error).message)
    return
  }

  const channels = getSetting<string[]>('balance.channels', ['browser'])
  if (!channels.length) return
  // findLowBalances 只认 status='ok' 的快照，接口挂掉时不会误报低余额
  const hits = findLowBalances()
  if (!hits.length) return

  const settings = getSettings()
  const d = new Date()
  const dateKey = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
  for (const hit of hits) {
    const body = `${hit.name} 余额仅剩 ${hit.available} ${hit.currency}（阈值 ${hit.threshold}），记得充值`
    // 同一配置同一天只提醒一次
    const dedupeKey = `bal-${hit.profileId}-${hit.threshold}-${dateKey}`
    for (const channel of channels) {
      const status = await dispatch(channel, 'API 余额不足', body, settings)
      insertNotification(channel, 'balance', 'API 余额不足', body, status, dedupeKey)
    }
  }
}

function weekParityMatch(parity: WeekParity, week: number): boolean {  if (parity === 'odd') return week % 2 === 1
  if (parity === 'even') return week % 2 === 0
  return true
}

/** 写入通知记录；dedupe_key 冲突说明已发过，返回 false */
function insertNotification(channel: string, type: string, title: string, body: string, status: string, dedupeKey: string | null): boolean {
  try {
    sqlite
      .prepare(
        'INSERT INTO notification_log (channel, type, title, body, status, sent_at, dedupe_key) VALUES (?, ?, ?, ?, ?, datetime(\'now\', \'localtime\'), ?)',
      )
      .run(channel, type, title, body, status, dedupeKey)
    return true
  } catch {
    return false // 唯一索引冲突 = 已发送过
  }
}

function renderTemplate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{([^}]+)\}/g, (_, k: string) => vars[k.trim()] ?? `{${k}}`)
}

function toMinutes(hm: string): number {
  const [h, m] = hm.split(':').map(Number)
  return (h || 0) * 60 + (m || 0)
}

async function dispatch(channel: string, title: string, body: string, settings: NotifSettings): Promise<string> {
  if (channel === 'browser') return 'pending' // 由前端轮询投递
  if (channel === 'pushplus') {
    const r = await sendPushPlus(settings.pushplusToken, title, body)
    return r.ok ? 'sent' : `failed: ${r.detail}`
  }
  if (channel === 'wecom') {
    const r = await sendWecom(settings.wecom, title, body)
    return r.ok ? 'sent' : `failed: ${r.detail}`
  }
  return 'skipped: 未知通道'
}

/** 每分钟扫描：上课提醒 + 学习通作业截止提醒/自动同步 + AI 平台余额轮询 */
export async function scanAndRemind(): Promise<void> {
  await scanChaoxing().catch((e) => console.error('[scheduler] chaoxing', e))
  await scanBalance().catch((e) => console.error('[scheduler] balance', e))

  const settings = getSettings()
  const rules = (settings.rules ?? []).filter((r) => r.enabled && r.minutesBefore > 0)
  if (!rules.length) return

  const semester = db.select().from(semesters).where(eq(semesters.isCurrent, 1)).get()
  if (!semester) return

  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const start = new Date(semester.startDate + 'T00:00:00')
  const week = Math.floor((today.getTime() - start.getTime()) / 86400000 / 7) + 1
  if (week < 1 || week > semester.totalWeeks) return

  const weekday = (today.getDay() + 6) % 7 + 1
  const nowMin = now.getHours() * 60 + now.getMinutes()

  const sectionTimes = JSON.parse(semester.sectionTimes) as SectionTime[]
  const sessions = db.select().from(courseSessions).where(eq(courseSessions.semesterId, semester.id)).all()
  const allCourses = db.select().from(courses).where(eq(courses.semesterId, semester.id)).all()
  const courseById = new Map(allCourses.map((c) => [c.id, c]))

  for (const s of sessions) {
    if (s.weekday !== weekday) continue
    const weeks: number[] = JSON.parse(s.weeks)
    if (!weeks.includes(week)) continue
    if (!weekParityMatch(s.weekParity as WeekParity, week)) continue
    const section = sectionTimes[s.startSection - 1]
    if (!section?.start) continue
    const startMin = toMinutes(section.start)
    const course = courseById.get(s.courseId)
    if (!course) continue

    for (const rule of rules) {
      const targetMin = startMin - rule.minutesBefore
      if (nowMin !== targetMin) continue

      const vars: Record<string, string> = {
        课程: course.name,
        教室: s.room || '未填写',
        教师: course.teacher || '未知',
        时间: section.start,
        minutes: String(rule.minutesBefore),
      }
      const body = renderTemplate(rule.template, vars)
      const title = '上课提醒'
      const dateKey = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`
      const dedupeKey = `class-${s.id}-${rule.minutesBefore}-${dateKey}-${section.start}`

      for (const channel of rule.channels ?? []) {
        const status = await dispatch(channel, title, body, settings)
        insertNotification(channel, 'class', title, body, status, dedupeKey)
      }
    }
  }
}

let timer: NodeJS.Timeout | null = null

export function startScheduler(): void {
  if (timer) return
  // 对齐到每分钟的第 1.5 秒扫描一次（提醒精度为分钟级，无需更频繁）
  const scheduleNext = () => {
    const delay = 60000 - (Date.now() % 60000) + 1500
    timer = setTimeout(() => {
      void scanAndRemind().catch((e) => console.error('[scheduler]', e))
      scheduleNext()
    }, delay)
  }
  void scanAndRemind().catch((e) => console.error('[scheduler]', e))
  scheduleNext()
  console.log('[scheduler] 通知调度器已启动（每分钟扫描一次）')
}
