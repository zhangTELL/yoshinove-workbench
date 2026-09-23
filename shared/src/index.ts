/** 共享类型定义：client / server 共用 */

// ===== 通用 =====
export interface ApiResponse<T = unknown> {
  ok: boolean
  data?: T
  error?: string
}

// ===== 课表 =====
/** 节次时间配置：每节课的 {开始, 结束} 时刻 "HH:mm" */
export interface SectionTime {
  start: string
  end: string
}

export interface Semester {
  id: number
  name: string
  /** 第一周周一日期 YYYY-MM-DD */
  startDate: string
  /** 总周数 */
  totalWeeks: number
  /** 12 节课时间表 */
  sectionTimes: SectionTime[]
  isCurrent: boolean
  createdAt: string
}

/** 周次修饰 */
export type WeekParity = 'all' | 'odd' | 'even'

export interface CourseSession {
  id: number
  courseId: number
  semesterId: number
  /** 星期 1~7（周一~周日） */
  weekday: number
  startSection: number
  endSection: number
  /** 周次列表，如 [1,3,5,7] */
  weeks: number[]
  weekParity: WeekParity
  room: string
  note: string
}

/**
 * 调休（日期互换）：`date` 这一天的课表来源是 `sourceDate`。
 *
 * 课表的底层数据是**周模板**（`CourseSession`：每周星期 N 上什么课、`weeks[]` 决定哪几周），
 * 没有"某一天"的概念。调休（周末补课 / 节假日停课）是**日期例外**，所以单独一层：
 * 互换产生两行（A→B 与 B→A），只覆盖产生一行，删除即恢复。
 */
export interface ScheduleSwap {
  id: number
  semesterId: number
  /** 被替换的日期 YYYY-MM-DD */
  date: string
  /** 课表来源日期 YYYY-MM-DD */
  sourceDate: string
  createdAt: string
}

// ==================== 课表日期换算（服务端与前端共用一份）====================
//
// 为什么放在 shared：这三个口径**必须完全一致**，否则会出现"课表页显示有课、首页说今天没课"
// 这种自相矛盾：
//   · 服务端在 scheduler 里按"今天的有效来源"推上课提醒；
//   · 课表页按"当前周的每一天"渲染网格；
//   · 首页按"今天"挑今日课程、按"往后 7 天"挑最近一节课。
// 之前这几处的周次算法是各写一遍的，加调休时正好把日期换算收敛到这里。

/** 做日期换算只需要学期这两个字段 */
export interface SemesterCal {
  /** 第一周周一，YYYY-MM-DD */
  startDate: string
  totalWeeks: number
}

/** 一天的定位：第几周 + 星期几（1=周一 … 7=周日） */
export interface Slot {
  week: number
  weekday: number
}

/** 解析结果：`origin` 是真正要去读的 (周次, 星期)；`swappedFrom` 有值表示这一天是调休来的 */
export interface ResolvedSlot extends Slot {
  /** 课表来源日期（仅"被调休替换过"的日子有值），用于在界面上标注"本日按 X 的课表上课" */
  swappedFrom?: string
}

/** 日期字符串 → 本地零点；**不要**直接 `new Date('2026-09-07')`，那会按 UTC 解析、整体偏一天 */
function atMidnight(date: string): Date {
  return new Date(`${date}T00:00:00`)
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** Date → YYYY-MM-DD（本地时区） */
export function toDateStr(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/** YYYY-MM-DD 是否合法（顺带挡住 2026-02-30 这类溢出日期） */
export function isDateStr(s: unknown): s is string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  return toDateStr(atMidnight(s)) === s
}

/** 星期几：1=周一 … 7=周日（JS 的 getDay() 里周日是 0） */
export function weekdayOfDate(date: string): number {
  return ((atMidnight(date).getDay() + 6) % 7) + 1
}

/** 第几周：第一周的周一 = sem.startDate */
export function weekOfDate(date: string, sem: SemesterCal): number {
  const diff = atMidnight(date).getTime() - atMidnight(sem.startDate).getTime()
  return Math.floor(diff / 86400000 / 7) + 1
}

/** (第几周, 星期几) → 日期 */
export function dateOfSlot(sem: SemesterCal, slot: Slot): string {
  const d = atMidnight(sem.startDate)
  d.setDate(d.getDate() + (slot.week - 1) * 7 + (slot.weekday - 1))
  return toDateStr(d)
}

/** 日期是否落在本学期内（用它挡住"把课程换到学期外"的输入） */
export function inSemester(date: string, sem: SemesterCal): boolean {
  const w = weekOfDate(date, sem)
  return w >= 1 && w <= sem.totalWeeks
}

/** date → sourceDate 的例外表 */
export type SwapMap = Map<string, string>

/**
 * 解析某一天的「有效取课来源」。
 *
 * ⚠️ **只做一跳，不做链式**：互换会写成 A→B 与 B→A 两行，这时 A 取 B 的**原**课表、
 * B 取 A 的**原**课表。若做链式（A→B 再顺着 B→A 找回去），互换会被解析成"什么都没有"。
 * 实现上就是：把日期映射成 (周次, 星期) 后**直接**去取，不再追问来源日自己的来源。
 */
export function resolveDate(swaps: SwapMap, sem: SemesterCal, date: string): ResolvedSlot {
  const src = swaps.get(date)
  if (!src) return { week: weekOfDate(date, sem), weekday: weekdayOfDate(date) }
  return { week: weekOfDate(src, sem), weekday: weekdayOfDate(src), swappedFrom: src }
}

/** 由例外表构造「date → 它借走了谁的课表」的反向索引（用于反向标注） */
export function swapMapOf(rows: { date: string; sourceDate: string }[]): SwapMap {
  return new Map(rows.map((r) => [r.date, r.sourceDate]))
}

export interface Course {
  id: number
  semesterId: number
  name: string
  teacher: string
  color: string
  credit: number
  examType: string
  note: string
}

export interface CourseCellInput {
  name: string
  teacher: string
  room: string
  credit: number
  examType: string
  weekday: number
  startSection: number
  endSection: number
  weeks: number[]
  weekParity: WeekParity
  note?: string
  /** 可选：手动指定课程颜色（自动导入时留空由系统分配） */
  color?: string
}

// ===== 通知 / 提醒 =====
export interface ReminderRule {
  /** 上课前多少分钟提醒 */
  minutesBefore: number
  /** 提醒内容模板，可用 {课程} {教室} {教师} {时间} */
  template: string
  channels: ('browser' | 'pushplus' | 'wecom')[]
  enabled: boolean
}

// ===== 学习通 =====
export interface ChaoxingHomework {
  id: number
  courseName: string
  title: string
  deadline: string | null
  url: string
  status: string
  /** 所属课程的「开课时间」YYYY-MM-DD；老数据（同步前的行）为 null */
  courseStart: string | null
  syncedAt: string
  remindedAt: string | null
}

/**
 * 由日期推断学期标签，按中国学年习惯（第 1 学期 = 秋季 7 月起，第 2 学期 = 春季）。
 * 例：2026-08-31 → "2026-2027第1学期"（与学期名同格式）；2026-03-01 → "2025-2026第2学期"。
 *
 * 为什么用它而不是课程名匹配：学习通的课程列表**不带结构化的学期字段**
 * （courseType/classState/term 参数全被忽略，li 上只有 courseId/clazzId/personId），
 * 但课程块里有「开课时间：YYYY-MM-DD～YYYY-MM-DD」，实测能准确区分本学期与往期。
 * 课程名匹配则不可靠（课表叫「大学体育(3)」、学习通叫「大学体育(3)-2026-2027-1排球」）。
 */
export function termOf(dateStr: string | null | undefined): string | null {
  if (!dateStr) return null
  const m = /^(\d{4})-(\d{1,2})/.exec(dateStr)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  return mo >= 7 ? `${y}-${y + 1}第1学期` : `${y - 1}-${y}第2学期`
}

// ===== 笔记 =====
export interface NoteMeta {
  id: number
  title: string
  courseTag: string
  category: string
  updatedAt: string
}

// ===== AI 实验区 =====
/** 数据来源：官方接口可长期依赖，逆向端点随时失效，手工录入无接口 */
export type BalanceSource = 'official' | 'reverse' | 'manual'
/** 认证方式由数据决定，不写死在适配器里 */
export type AuthStyle = 'bearer' | 'raw' | 'volc-sign' | 'aliyun-rpc'
/** 能力协商：有的平台只有余额没有套餐额度 */
export type BalanceCapability = 'balance' | 'quota'

export interface ProviderMeta {
  id: string
  label: string
  source: BalanceSource
  capabilities: BalanceCapability[]
  credentials: ('key' | 'secret')[]
  defaultBaseUrl: string
  /** 是否在余额页默认展示（未配置时显示为「待配置」占位卡） */
  isDefault: boolean
  note: string
}

/** 出参形态：Key 只以掩码形式出现，原文永不出后端 */
export interface AiProfile {
  id: number
  name: string
  provider: string
  baseUrl: string
  model: string
  enabled: boolean
  authStyle: AuthStyle
  balancePath: string
  balanceEnabled: boolean
  hasApiKey: boolean
  apiKeyMasked: string
  hasApiSecret: boolean
  apiSecretMasked: string
}

export interface BalanceSnapshot {
  id: number
  profile_id: number
  captured_at: string
  source: BalanceSource
  status: 'ok' | 'error' | 'unsupported'
  currency: string
  total: number | null
  granted: number | null
  topped_up: number | null
  available: number | null
  error: string
}

export interface QuotaWindow {
  id: number
  profile_id: number
  snapshot_id: number | null
  captured_at: string
  label: string
  type: 'TOKENS_LIMIT' | 'TIME_LIMIT' | 'COUNT' | 'CREDIT'
  limit_value: number | null
  used_value: number | null
  remaining: number | null
  percentage: number | null
  reset_at: string | null
}

export interface BalanceView {
  providers: ProviderMeta[]
  profiles: AiProfile[]
  latest: { profileId: number; snapshot: BalanceSnapshot | null; quotas: QuotaWindow[] }[]
  settings: { intervalMin: number; lowThreshold: number; channels: string[] }
}

/** 余额趋势的一个采样点 */
export interface BalanceHistoryPoint {
  t: string
  total: number | null
  available: number | null
  status: string
}

export interface BalanceHistorySeries {
  profileId: number
  name: string
  provider: string
  currency: string
  points: BalanceHistoryPoint[]
}

/** 消耗速度分析：无法估算时 dailyBurn / daysLeft 为 null，原因在 reason 里 */
export interface BalanceBurnStat {
  profileId: number
  name: string
  currency: string
  available: number | null
  spent: number | null
  spanHours: number
  dailyBurn: number | null
  daysLeft: number | null
  reason: string
}

export interface BalanceHistory {
  days: number
  series: BalanceHistorySeries[]
  stats: BalanceBurnStat[]
}

export interface PromptCase {
  id: number
  input: string
  expected: string
}

export interface PromptRecord {
  id: number
  name: string
  content: string
  variables: string[]
  version: number
  updatedAt: string
  cases: PromptCase[]
}
