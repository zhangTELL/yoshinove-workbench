import type { ReminderRule, SectionTime, WeekParity } from '@wb/shared'
import { resolveDate, toDateStr } from '@wb/shared'
import { eq } from 'drizzle-orm'
import { db, sqlite } from '../db/index.js'
import { chaoxingHomework, courses, courseSessions, scheduleSwaps, semesters } from '../db/schema.js'
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
      await emitNotification(channels, 'chaoxing', '作业截止提醒', body, dedupeKey, settings)
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
    await emitNotification(channels, 'balance', 'API 余额不足', body, dedupeKey, settings)
  }
}

function weekParityMatch(parity: WeekParity, week: number): boolean {  if (parity === 'odd') return week % 2 === 1
  if (parity === 'even') return week % 2 === 0
  return true
}

/* ===== 认领式发送（2026-10-01 审查修复 #5）=====
   旧顺序是「先 dispatch 发送、后 insert 记账」，有两个洞：
     ① 记账前崩溃 / 并发扫描 → 同一条事件重复推送（去重只拦得住记账，拦不住已发出去的）；
     ② unique(dedupe_key) 不带通道 → pushplus 先写占坑，browser 的记录被唯一索引吞掉，
        桌面通知永远收不到。
   新顺序：**先 INSERT 占坑（unique(dedupe_key, channel) 的写入就是原子认领），再发送**。
   失败策略（明确）：发送失败把状态记成 failed:…，**不自动重试**——避免坏凭据每分钟刷屏；
   卡在 'sending' 超过 5 分钟的僵尸认领（进程在认领与发送之间崩溃）由 reclaimStaleClaims
   释放，这是唯一的重试路径。 */
function reclaimStaleClaims(): void {
  try {
    sqlite
      .prepare(
        "DELETE FROM notification_log WHERE status = 'sending' AND sent_at < datetime('now', 'localtime', '-5 minutes')",
      )
      .run()
  } catch {
    /* 空库等场景忽略 */
  }
}

async function emitNotification(
  channels: string[],
  type: string,
  title: string,
  body: string,
  dedupeKey: string | null,
  settings: NotifSettings,
): Promise<void> {
  reclaimStaleClaims()
  for (const channel of channels) {
    if (dedupeKey) {
      try {
        sqlite
          .prepare(
            "INSERT INTO notification_log (channel, type, title, body, status, sent_at, dedupe_key) VALUES (?, ?, ?, ?, 'sending', datetime('now', 'localtime'), ?)",
          )
          .run(channel, type, title, body, dedupeKey)
      } catch {
        continue // 唯一索引冲突 = 该事件该通道已认领/已发送
      }
    }
    const status = await dispatch(channel, title, body, settings)
    if (dedupeKey) {
      sqlite
        .prepare('UPDATE notification_log SET status = ? WHERE channel = ? AND dedupe_key = ?')
        .run(status, channel, dedupeKey)
    } else {
      // 无去重键的事件：退回直接落一条（当前所有调用方都带键，这条只是兜底）
      sqlite
        .prepare(
          "INSERT INTO notification_log (channel, type, title, body, status, sent_at) VALUES (?, ?, ?, ?, ?, datetime('now', 'localtime'))",
        )
        .run(channel, type, title, body, status)
    }
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

  const nowMin = now.getHours() * 60 + now.getMinutes()

  const sectionTimes = JSON.parse(semester.sectionTimes) as SectionTime[]
  const sessions = db.select().from(courseSessions).where(eq(courseSessions.semesterId, semester.id)).all()
  const allCourses = db.select().from(courses).where(eq(courses.semesterId, semester.id)).all()
  const courseById = new Map(allCourses.map((c) => [c.id, c]))

  /* 调休：今天可能是"补课日"，要按例外表把它解析成**有效取课来源**再去取课。
     不做这一步的后果很直观——周末补周二的课时，提醒会按周六（通常是空的）推，等于不提醒；
     而被换走的那个工作日反而会照旧推提醒。 */
  const swapRows = db.select().from(scheduleSwaps).where(eq(scheduleSwaps.semesterId, semester.id)).all()
  const swapMap = new Map(swapRows.map((r) => [r.date, r.sourceDate]))
  const origin = resolveDate(
    swapMap,
    { startDate: semester.startDate, totalWeeks: semester.totalWeeks },
    toDateStr(today),
  )

  for (const s of sessions) {
    if (s.weekday !== origin.weekday) continue
    const weeks: number[] = JSON.parse(s.weeks)
    if (!weeks.includes(origin.week)) continue
    if (!weekParityMatch(s.weekParity as WeekParity, origin.week)) continue
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
      await emitNotification(rule.channels ?? [], 'class', title, body, dedupeKey, settings)
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
