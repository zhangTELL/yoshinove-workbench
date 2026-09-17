<script setup lang="ts">
import type { ChaoxingHomework, Course, CourseSession, SectionTime, Semester, WeekParity } from '@wb/shared'
import { termOf } from '@wb/shared'
import { computed, nextTick, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import type { InputInstance } from 'element-plus'
import { ElMessage } from 'element-plus'
import {
  Calendar,
  Check,
  Edit,
  Histogram,
  MagicStick,
  Notebook,
  Reading,
  Refresh,
  Setting,
} from '@element-plus/icons-vue'
import { get, post } from '../api/http'
import { DEFAULT_NAME, displayName, NAME_MAX, saveDisplayName } from '../stores/profile'

/**
 * 首页 Dashboard：纯前端组装，数据全部来自既有接口，不新增后端路由。
 *   今日课程 ← /api/semesters + /api/schedule?semesterId=  （周次过滤复用 ScheduleView 的 weeksInclude 语义）
 *   未交作业 ← /api/chaoxing/homework
 *   倒计日   ← /api/countdowns
 *   健康跑   ← /api/runs（+/api/runs/checkin 快捷打卡）
 *   低余额   ← /api/ai/balance（仅在低于阈值时显示，失败静默）
 * 每个请求各自兜错：单模块数据挂了只该空掉自己那张卡，不能让整页白屏。
 */

interface Countdown {
  id: number
  title: string
  date: string
  category: string
  note: string
}
interface RunsView {
  dates: string[]
  total: number
  streak: number
  weekCount: number
  monthCount: number
  today: boolean
}
interface SchedulePayload {
  courses: Course[]
  /** 顶层 sessions 的 weeks 已被服务端解析成数组 */
  sessions: (Omit<CourseSession, 'weeks'> & { weeks: number[] | string })[]
}
interface BalanceViewLite {
  profiles: { id: number; name: string }[]
  latest: { profileId: number; snapshot: { status: string; available: number | null; currency: string } | null }[]
  settings: { lowThreshold: number }
}

const router = useRouter()

// ==================== 时间基准 ====================
/** 整页共用一个"现在"，避免渲染过程中跨分钟导致状态不一致 */
const now = ref(new Date())
const pad = (n: number) => String(n).padStart(2, '0')
const fmtDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const todayStr = computed(() => fmtDate(now.value))
/** 今天是周几：课表用 1=周一 … 7=周日 */
const todayWeekday = computed(() => {
  const d = now.value.getDay()
  return d === 0 ? 7 : d
})
const hhmm = computed(() => `${pad(now.value.getHours())}:${pad(now.value.getMinutes())}`)

const greeting = computed(() => {
  const h = now.value.getHours()
  if (h < 6) return '夜深了'
  if (h < 11) return '早上好'
  if (h < 14) return '中午好'
  if (h < 18) return '下午好'
  return '晚上好'
})

const WEEKDAY_CN = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日']

// ==================== 称呼（可自定义，点问候语里的名字就地改）====================
// 状态放在 stores/profile.ts：标签页标题也要用它，两处必须共享同一份。
// 这里只保留编辑器的交互状态；加载/保存/去重逻辑都在那个模块里。
const editingName = ref(false)
const nameDraft = ref('')
const nameInputRef = ref<InputInstance>()

function startEditName() {
  nameDraft.value = displayName.value
  editingName.value = true
  void nextTick().then(() => nameInputRef.value?.focus())
}

function cancelName() {
  editingName.value = false
}

async function saveName() {
  // 回车与失焦都会触发；取消时 editingName 已被置 false，靠它去重
  if (!editingName.value) return
  editingName.value = false

  const next = nameDraft.value.trim().slice(0, NAME_MAX)
  if (next === displayName.value) return

  try {
    await saveDisplayName(next)
    ElMessage.success(next ? '称呼已保存' : `已清空称呼，将显示为「${DEFAULT_NAME}」`)
  } catch (e) {
    ElMessage.error(`保存失败：${(e as Error).message}`)
  }
}

// ==================== 数据 ====================
const loading = ref(true)
const refreshedAt = ref('')
const semesters = ref<Semester[]>([])
const courses = ref<Course[]>([])
const sessions = ref<SchedulePayload['sessions']>([])
const homework = ref<ChaoxingHomework[]>([])
const countdowns = ref<Countdown[]>([])
const runs = ref<RunsView | null>(null)
const lowBalances = ref<{ name: string; available: number; currency: string }[]>([])
const checking = ref(false)

/** 当前学期：优先 isCurrent，否则取第一个 */
const semester = computed(() => semesters.value.find((s) => s.isCurrent) ?? semesters.value[0] ?? null)
const totalWeeks = computed(() => semester.value?.totalWeeks ?? 0)
const sectionTimes = computed<SectionTime[]>(() => semester.value?.sectionTimes ?? [])

/** 当前周次：第一周周一为 startDate（与 ScheduleView 的 guessCurrentWeek 同一算法） */
const currentWeek = computed(() => {
  const s = semester.value
  if (!s) return 0
  const today = new Date(now.value.getFullYear(), now.value.getMonth(), now.value.getDate())
  const start = new Date(`${s.startDate}T00:00:00`)
  const w = Math.floor((today.getTime() - start.getTime()) / 86400000 / 7) + 1
  return Math.min(Math.max(w, 1), totalWeeks.value || 1)
})

/** 周次过滤：与 ScheduleView.weeksInclude 保持一致（weeks 可能是 JSON 字符串） */
function weeksInclude(weeksJson: number[] | string, parity: WeekParity, week: number): boolean {
  let weeks: number[]
  try {
    weeks = Array.isArray(weeksJson) ? weeksJson : (JSON.parse(weeksJson) as number[])
  } catch {
    return false
  }
  if (!weeks.includes(week)) return false
  if (parity === 'odd') return week % 2 === 1
  if (parity === 'even') return week % 2 === 0
  return true
}

const courseById = computed(() => new Map(courses.value.map((c) => [c.id, c])))

function sectionTime(n: number): SectionTime | null {
  return sectionTimes.value[n - 1] ?? null
}

/** 某节课的时刻文本，如 08:00 - 09:35 */
function timeRange(startSection: number, endSection: number): string {
  const a = sectionTime(startSection)
  const b = sectionTime(endSection)
  if (!a || !b) return '—'
  return `${a.start} - ${b.end}`
}

// ==================== 今日课程 ====================
interface TodayItem {
  id: number
  name: string
  teacher: string
  room: string
  color: string
  startSection: number
  endSection: number
  timeText: string
  state: '待上课' | '上课中' | '已下课'
}

const todayItems = computed<TodayItem[]>(() => {
  const list: TodayItem[] = []
  for (const s of sessions.value) {
    if (s.weekday !== todayWeekday.value) continue
    if (!weeksInclude(s.weeks, s.weekParity, currentWeek.value)) continue
    const c = courseById.value.get(s.courseId)
    if (!c) continue
    const a = sectionTime(s.startSection)
    const b = sectionTime(s.endSection)
    const timeText = timeRange(s.startSection, s.endSection)
    let state: TodayItem['state'] = '待上课'
    if (a && b) {
      if (hhmm.value > b.end) state = '已下课'
      else if (hhmm.value >= a.start) state = '上课中'
    }
    list.push({
      id: s.id,
      name: c.name,
      teacher: c.teacher,
      room: s.room,
      color: c.color || '#409eff',
      startSection: s.startSection,
      endSection: s.endSection,
      timeText,
      state,
    })
  }
  return list.sort((x, y) => x.startSection - y.startSection)
})

/** 今天没课时用：往后找 7 天内最近的一节课 */
const nextCourse = computed<{ label: string; name: string; room: string; timeText: string } | null>(() => {
  if (!semester.value || !sessions.value.length) return null
  const start = new Date(`${semester.value.startDate}T00:00:00`)
  for (let offset = 1; offset <= 7; offset++) {
    const d = new Date(now.value.getFullYear(), now.value.getMonth(), now.value.getDate() + offset)
    const wd = d.getDay() === 0 ? 7 : d.getDay()
    const week = Math.floor((d.getTime() - start.getTime()) / 86400000 / 7) + 1
    if (week < 1 || week > totalWeeks.value) continue
    const hit = sessions.value
      .filter((s) => s.weekday === wd && weeksInclude(s.weeks, s.weekParity, week))
      .sort((a, b) => a.startSection - b.startSection)[0]
    if (!hit) continue
    const c = courseById.value.get(hit.courseId)
    if (!c) continue
    const gap = offset === 1 ? '明天' : offset === 2 ? '后天' : `${WEEKDAY_CN[wd]}`
    return { label: `${gap} · 第 ${week} 周`, name: c.name, room: hit.room, timeText: timeRange(hit.startSection, hit.endSection) }
  }
  return null
})

// ==================== 待办作业 ====================
function dlTs(h: ChaoxingHomework): number | null {
  if (!h.deadline) return null
  const t = new Date(h.deadline.replace(' ', 'T')).getTime()
  return Number.isNaN(t) ? null : t
}

/** 当前学期的学期标签，由学期起始日推断（与 termOf 同口径），用于过滤作业 */
const currentTerm = computed(() => termOf(semester.value?.startDate))

/**
 * 库里是否已经有学期信息。一条都没有 → 说明还没跑过带 courseStart 的同步，
 * 这时**不过滤**，否则整张卡会空白（比显示多了几条更糟）。
 */
const hasTermData = computed(() => homework.value.some((h) => h.courseStart))

/**
 * 是否属于本学期：用作业所属课程的「开课时间」推断学期来比。
 *
 * 为什么不是按课程名匹配：两边写法不一致（课表「大学体育(3)」vs 学习通「大学体育(3)-2026-2027-1排球」），
 * 实测精确匹配只命中 2/11 门课。学习通的课程列表虽无结构化学期字段，但课程块里有「开课时间」。
 *
 * 为什么"没有开课时间就排除"而不是放行：实测 36 门课里 12 门无开课时间，**全部是「退课」或「课程已结束」**
 * （退课 7 门、已结束 5 门），无一例外。放行会把退课课程的作业当成待办。
 * 兜底：隐藏数量会显示在卡片说明里，「学习通作业」页仍显示全部，不会真的看不到。
 */
function inCurrentTerm(h: ChaoxingHomework): boolean {
  const term = currentTerm.value
  if (!term || !hasTermData.value) return true
  return termOf(h.courseStart) === term
}

/** 未提交 + 本学期 */
const pendingHomework = computed(() =>
  homework.value
    .filter((h) => h.status !== '已提交' && inCurrentTerm(h))
    .sort((a, b) => {
      const ta = dlTs(a)
      const tb = dlTs(b)
      if (ta !== null && tb !== null) return ta - tb
      if (ta !== null) return -1
      if (tb !== null) return 1
      return b.id - a.id
    }),
)

/** 被学期过滤挡掉的未提交作业数：显示出来，免得用户以为作业"丢了" */
const hiddenOtherTerm = computed(() =>
  currentTerm.value && hasTermData.value
    ? homework.value.filter((h) => h.status !== '已提交' && !inCurrentTerm(h)).length
    : 0,
)
/** 展示上限：这张卡是最高的，限 5 条以免把整列撑高、让另一列下方留出大洞；其余走「共 N 项」链接 */
const HOMEWORK_LIMIT = 5
const homeworkShown = computed(() => pendingHomework.value.slice(0, HOMEWORK_LIMIT))

/** 截止时间的人话描述 */
function deadlineText(h: ChaoxingHomework): { text: string; level: 'danger' | 'warning' | 'info' } | null {
  const ts = dlTs(h)
  if (ts === null) return null
  const diff = ts - now.value.getTime()
  if (diff < 0) return { text: '已截止', level: 'info' }
  const hours = diff / 3600000
  if (hours < 24) return { text: `${Math.floor(hours)} 小时后截止`, level: 'danger' }
  const days = Math.ceil(hours / 24)
  return { text: `${days} 天后截止`, level: days <= 3 ? 'warning' : 'info' }
}

// ==================== 倒计日 ====================
function daysLeft(date: string): number {
  const target = new Date(`${date}T00:00:00`).getTime()
  const today = new Date(now.value.getFullYear(), now.value.getMonth(), now.value.getDate()).getTime()
  return Math.round((target - today) / 86400000)
}
/** 只显示今天及以后，最近的排前面 */
const upcomingCountdowns = computed(() =>
  countdowns.value.filter((c) => daysLeft(c.date) >= 0).sort((a, b) => daysLeft(a.date) - daysLeft(b.date)),
)
const countdownShown = computed(() => upcomingCountdowns.value.slice(0, 4))

// ==================== 健康跑 ====================
async function checkinToday() {
  checking.value = true
  try {
    await post('/api/runs/checkin', { date: todayStr.value })
    ElMessage.success('今日已打卡')
    await loadRuns()
  } catch (e) {
    ElMessage.error((e as Error).message)
  } finally {
    checking.value = false
  }
}

async function loadRuns() {
  try {
    runs.value = await get<RunsView>('/api/runs')
  } catch {
    runs.value = null
  }
}

// ==================== 快捷入口 ====================
const shortcuts = [
  { path: '/schedule', title: '课表', hint: '周视图 / 提醒', icon: Calendar },
  { path: '/chaoxing', title: '学习通作业', hint: '同步 / 待办', icon: Reading },
  { path: '/notes', title: '笔记', hint: 'Markdown', icon: Notebook },
  { path: '/ai-lab?tab=balance', title: 'AI 实验区', hint: '余额 / 对比', icon: MagicStick },
  { path: '/tools?tab=runs', title: '日常工具', hint: '打卡 / 绩点', icon: Histogram },
  { path: '/settings', title: '设置', hint: '外观 / 主题', icon: Setting },
]

const go = (path: string) => void router.push(path)

// ==================== 加载 ====================
async function loadLowBalance() {
  try {
    const v = await get<BalanceViewLite>('/api/ai/balance')
    const out: { name: string; available: number; currency: string }[] = []
    for (const p of v.profiles) {
      const snap = v.latest.find((x) => x.profileId === p.id)?.snapshot
      if (!snap || snap.status !== 'ok' || typeof snap.available !== 'number') continue
      if (snap.available < (v.settings?.lowThreshold ?? 10)) {
        // 逆向端点会给到 3.70388032 这种长小数，展示前先量化，否则标题会拖一长串
        out.push({ name: p.name, available: Math.round(snap.available * 100) / 100, currency: snap.currency })
      }
    }
    lowBalances.value = out
  } catch {
    lowBalances.value = []
  }
}

async function loadAll() {
  loading.value = true
  now.value = new Date()
  // 各自兜错：某个接口挂掉只空掉对应卡片
  const [sem, hw, cds] = await Promise.allSettled([
    get<Semester[]>('/api/semesters'),
    get<ChaoxingHomework[]>('/api/chaoxing/homework'),
    get<Countdown[]>('/api/countdowns'),
  ])
  semesters.value = sem.status === 'fulfilled' ? (sem.value ?? []) : []
  homework.value = hw.status === 'fulfilled' ? (hw.value ?? []) : []
  countdowns.value = cds.status === 'fulfilled' ? (cds.value ?? []) : []

  const sid = semester.value?.id
  if (sid) {
    try {
      const sch = await get<SchedulePayload>(`/api/schedule?semesterId=${sid}`)
      courses.value = sch.courses ?? []
      sessions.value = sch.sessions ?? []
    } catch {
      courses.value = []
      sessions.value = []
    }
  } else {
    courses.value = []
    sessions.value = []
  }

  await Promise.all([loadRuns(), loadLowBalance()])
  refreshedAt.value = hhmm.value
  loading.value = false
}

onMounted(loadAll)
</script>

<template>
  <div v-loading="loading" class="page">
    <!-- ==================== 问候 + 今日概览 ==================== -->
    <section class="hero">
      <div class="hero-main">
        <!-- 称呼可点即改：存 settings 的 ui.displayName，未设置时回落到「同学」 -->
        <div class="hero-greet">
          <span>{{ greeting }}，</span>
          <span
            v-if="!editingName"
            class="name-text"
            :class="{ 'is-unset': !displayName }"
            :title="displayName ? '点击修改称呼' : '点击设置你的称呼'"
            @click="startEditName"
          >{{ displayName || DEFAULT_NAME }}<el-icon class="name-pen"><Edit /></el-icon></span>
          <el-input
            v-else
            ref="nameInputRef"
            v-model="nameDraft"
            class="name-input"
            size="small"
            :maxlength="NAME_MAX"
            placeholder="怎么称呼你"
            @keyup.enter="saveName"
            @keyup.esc="cancelName"
            @blur="saveName"
          />
          <span> 🐾</span>
        </div>
        <div class="hero-sub">
          {{ todayStr }} · {{ WEEKDAY_CN[todayWeekday] }}
          <template v-if="semester">
            <span class="dot">·</span> 第 {{ currentWeek }} / {{ totalWeeks }} 周
            <span class="dot">·</span> {{ semester.name }}
          </template>
          <template v-else><span class="dot">·</span> 还没有学期，先去课表新建一个</template>
        </div>
      </div>

      <div class="hero-stats">
        <div class="hs">
          <div class="hs-num">{{ todayItems.length }}</div>
          <div class="hs-label">今日课程</div>
        </div>
        <div class="hs">
          <div class="hs-num" :class="{ warn: pendingHomework.length > 0 }">{{ pendingHomework.length }}</div>
          <div class="hs-label">待交作业</div>
        </div>
        <div class="hs">
          <div class="hs-num">{{ runs?.streak ?? 0 }}</div>
          <div class="hs-label">连续跑步（天）</div>
        </div>
        <el-button class="hero-refresh" size="small" :icon="Refresh" text @click="loadAll">
          {{ refreshedAt ? `${refreshedAt} 刷新` : '刷新' }}
        </el-button>
      </div>
    </section>

    <el-alert
      v-if="lowBalances.length"
      type="warning"
      :closable="false"
      show-icon
      :title="`${lowBalances.map((b) => `${b.name} ${b.currency === 'USD' ? '$' : '¥'}${b.available.toFixed(2)}`).join('、')} 余额偏低`"
      description="在「AI 实验区 → 账户余额」可以看到走势、调整提醒金额"
    />

    <!-- ==================== 主体双列 ==================== -->
    <div class="cols">
      <div class="col">
        <!-- 今日课程 -->
        <el-card class="card-today">
          <template #header>
            <div class="card-head">
              <span>今日课程</span>
              <el-button size="small" text @click="go('/schedule')">查看课表</el-button>
            </div>
          </template>

          <div v-if="todayItems.length" class="cls-list">
            <div v-for="it in todayItems" :key="it.id" class="cls-item" :class="{ done: it.state === '已下课', now: it.state === '上课中' }">
              <div class="cls-bar" :style="{ background: it.color }" />
              <div class="cls-time">
                <div class="cls-range">{{ it.timeText }}</div>
                <div class="cls-sec">第 {{ it.startSection }}<template v-if="it.endSection !== it.startSection">-{{ it.endSection }}</template> 节</div>
              </div>
              <div class="cls-body">
                <div class="cls-name">{{ it.name }}</div>
                <div class="cls-meta">
                  <span v-if="it.room">{{ it.room }}</span>
                  <span v-if="it.teacher">{{ it.teacher }}</span>
                </div>
              </div>
              <el-tag size="small" :type="it.state === '上课中' ? 'success' : it.state === '已下课' ? 'info' : 'primary'" effect="plain">
                {{ it.state }}
              </el-tag>
            </div>
          </div>

          <div v-else class="empty-block">
            <div class="empty-title">今天没有课 🎉</div>
            <div v-if="nextCourse" class="empty-next">
              <span class="en-label">{{ nextCourse.label }}</span>
              <span class="en-name">{{ nextCourse.name }}</span>
              <span class="en-meta">{{ nextCourse.timeText }}<template v-if="nextCourse.room"> · {{ nextCourse.room }}</template></span>
            </div>
            <div v-else class="empty-tip">
              {{ sessions.length ? '近 7 天没有安排课程' : '还没有课程，去课表导入或添加' }}
            </div>
          </div>
        </el-card>

        <!-- 健康跑：与「今日课程」同列。左列 =「今天的事」，右列 =「要交 / 要到期」。
             这个配对是量出来的：482 / 478（差 4px），而「今日课程+倒计日 / 待办作业+健康跑」
             是 411 / 549（差 138px，左列下方会空一大块）。 -->
        <el-card class="card-run">
          <template #header>
            <div class="card-head">
              <span>健康跑</span>
              <el-button size="small" text @click="go('/tools?tab=runs')">统计</el-button>
            </div>
          </template>
          <div class="run-main">
            <div class="run-state" :class="{ ok: runs?.today }">
              {{ runs?.today ? '今天已打卡' : '今天还没打卡' }}
            </div>
            <el-button v-if="runs && !runs.today" type="primary" size="small" :icon="Check" :loading="checking" @click="checkinToday">
              立即打卡
            </el-button>
            <div v-else-if="!runs" class="run-tip">暂时读不到数据</div>
          </div>
          <div class="run-stats">
            <div class="rs"><span class="rs-num">{{ runs?.streak ?? 0 }}</span><span class="rs-label">连续天数</span></div>
            <div class="rs"><span class="rs-num">{{ runs?.weekCount ?? 0 }}</span><span class="rs-label">本周</span></div>
            <div class="rs"><span class="rs-num">{{ runs?.monthCount ?? 0 }}</span><span class="rs-label">本月</span></div>
            <div class="rs"><span class="rs-num">{{ runs?.total ?? 0 }}</span><span class="rs-label">累计</span></div>
          </div>
          <div class="run-tip">打卡后统计会自动更新；达标要求见「日常工具 → 健康跑」</div>
        </el-card>
      </div>

      <div class="col">
        <!-- 倒计日：与「待办作业」同列 -->
        <el-card class="card-countdown">
          <template #header>
            <div class="card-head">
              <span>临近倒计日</span>
              <el-button size="small" text @click="go('/tools?tab=countdown')">管理</el-button>
            </div>
          </template>
          <div v-if="countdownShown.length" class="cd-list">
            <div v-for="c in countdownShown" :key="c.id" class="cd-item" @click="go('/tools?tab=countdown')">
              <div class="cd-days">
                <template v-if="daysLeft(c.date) === 0"><span class="cd-num today">今天</span></template>
                <template v-else><span class="cd-num">{{ daysLeft(c.date) }}</span><span class="cd-unit">天</span></template>
              </div>
              <div class="cd-body">
                <div class="cd-title">{{ c.title }}</div>
                <div class="cd-meta">{{ c.date }} · {{ c.category }}</div>
              </div>
            </div>
          </div>
          <div v-else class="empty-block">
            <div class="empty-title">没有临近的倒计日</div>
            <div class="empty-tip">到「日常工具 → 倒计日」可以加上考试、报名截止这类重要日子</div>
          </div>
        </el-card>

        <!-- 未交作业 -->
        <el-card class="card-homework">
          <template #header>
            <div class="card-head">
              <span>待办作业</span>
              <el-button size="small" text @click="go('/chaoxing')">去学习通</el-button>
            </div>
          </template>
          <div class="hw-list">
            <a v-for="h in homeworkShown" :key="h.id" class="hw-item" :href="h.url" target="_blank" rel="noreferrer">
              <div class="hw-body">
                <div class="hw-title">{{ h.title }}</div>
                <div class="hw-meta">{{ h.courseName }}</div>
              </div>
              <el-tag v-if="deadlineText(h)" size="small" :type="deadlineText(h)!.level" effect="plain">
                {{ deadlineText(h)!.text }}
              </el-tag>
              <el-tag v-else size="small" type="info" effect="plain">未提交</el-tag>
            </a>
          </div>
          <div v-if="pendingHomework.length > homeworkShown.length" class="hw-more">
            共 {{ pendingHomework.length }} 项待办，去「学习通作业」查看全部
          </div>
          <div v-if="!homeworkShown.length" class="empty-block">
            <div class="empty-title">本学期没有未提交的作业 🎉</div>
            <div class="empty-tip">
              <template v-if="hiddenOtherTerm">另有 {{ hiddenOtherTerm }} 项往期或已结束课程的作业没有显示（在「学习通作业」能看到全部）；</template>
              点右上角「去学习通」可以手动同步一次
            </div>
          </div>

          <div class="hw-note">
            只显示<strong>本学期</strong>的作业<template v-if="hiddenOtherTerm">，另外 {{ hiddenOtherTerm }} 项往期或已结束课程的作业没有显示</template>。有截止时间的排在前面。
          </div>
        </el-card>
      </div>
    </div>

    <!-- 快捷入口：整行放在两列之外。放列内会随「待办作业」条数变化而不平衡
         （这张卡少则 2 条、多则 5 条，高度在 200~500px 之间浮动）。 -->
    <el-card class="card-shortcuts">
      <template #header>快捷入口</template>
      <div class="sc-grid">
        <button v-for="s in shortcuts" :key="s.path" class="sc-item" @click="go(s.path)">
          <el-icon class="sc-icon"><component :is="s.icon" /></el-icon>
          <div class="sc-body">
            <div class="sc-title">{{ s.title }}</div>
            <div class="sc-hint">{{ s.hint }}</div>
          </div>
        </button>
      </div>
    </el-card>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 16px;
  /* 内容区在 1600px 视口下有 1360px，别用小 max-width 把右侧空出来 */
  max-width: 1400px;
}

/* ===== 问候条 ===== */
.hero {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  background: linear-gradient(135deg, var(--wb-hero-from) 0%, var(--wb-hero-to) 100%);
  border: 1px solid var(--wb-hero-border);
  border-radius: 12px;
  padding: 18px 22px;
}
.hero-main {
  flex: 1 1 260px;
  min-width: 240px;
}
.hero-greet {
  font-size: 20px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}
/* 称呼是个"可点即改"的控件，靠虚线下划线 + 铅笔图标给出可编辑的暗示 */
.name-text {
  cursor: pointer;
  padding-bottom: 1px;
  border-bottom: 1px dashed transparent;
  transition: color 0.15s, border-color 0.15s;
}
.name-text:hover {
  color: var(--el-color-primary);
  border-bottom-color: color-mix(in srgb, var(--el-color-primary) 45%, transparent);
}
.name-text.is-unset {
  color: var(--el-text-color-secondary);
}
.name-pen {
  font-size: 13px;
  margin-left: 4px;
  opacity: 0.35;
  vertical-align: 2px;
  transition: opacity 0.15s;
}
.name-text:hover .name-pen {
  opacity: 1;
}
.name-input {
  width: 150px;
  vertical-align: middle;
}
.hero-sub {
  margin-top: 6px;
  font-size: 13px;
  color: var(--el-text-color-regular);
}
.dot {
  margin: 0 6px;
  color: var(--el-text-color-disabled);
}
.hero-stats {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 26px;
}
.hs {
  text-align: center;
  min-width: 74px;
}
.hs-num {
  font-size: 24px;
  font-weight: 700;
  color: var(--el-color-primary);
  line-height: 1.1;
  font-variant-numeric: tabular-nums;
}
.hs-num.warn {
  color: var(--el-color-warning);
}
.hs-label {
  margin-top: 3px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.hero-refresh {
  align-self: flex-start;
}
@media (max-width: 900px) {
  .hero-stats {
    gap: 18px;
  }
}

/* ===== 双列 ===== */
.cols {
  display: flex;
  gap: 16px;
  align-items: stretch;
}
.col {
  flex: 1 1 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
/**
 * 响应式对齐：两列等高，短的那列由它的卡片分摊剩余高度。
 * 卡片高度随数据变化（今日课程随当天课数、待办作业 2~5 条、倒计日空态/多条），
 * 静态配对无法保证底部齐平——用 flex 让两列各自撑满：内容少的列，它的卡片平分多出来的高度，
 * 每张卡内部把说明文字压到卡底（margin-top:auto），空白就不会集中成一大块。
 * 窄屏（.col 变 display:contents）是列方向、没有剩余高度，flex-grow 自然无效，无需额外处理。
 */
.col > .el-card {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
}
.col > .el-card :deep(.el-card__body) {
  flex: 1;
  display: flex;
  flex-direction: column;
}
.col > .el-card :deep(.el-card__body) > :last-child {
  margin-top: auto;
}
/* 窄屏单列：用 display:contents 拆掉列包裹层，靠 order 还原阅读顺序 */
@media (max-width: 1100px) {
  .cols {
    flex-direction: column;
    align-items: stretch;
  }
  .col {
    display: contents;
  }
  .card-today {
    order: 1;
  }
  .card-homework {
    order: 2;
  }
  .card-countdown {
    order: 3;
  }
  .card-run {
    order: 4;
  }
}
.card-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

/* ===== 今日课程 ===== */
.cls-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.cls-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid var(--el-border-color);
  border-radius: 8px;
  background: var(--el-bg-color);
}
.cls-item.now {
  border-color: #b3d8ff;
  background: var(--el-color-primary-light-9);
}
.cls-item.done {
  opacity: 0.62;
}
.cls-bar {
  width: 4px;
  align-self: stretch;
  min-height: 38px;
  border-radius: 2px;
  flex-shrink: 0;
}
.cls-time {
  flex-shrink: 0;
  width: 88px;
}
.cls-range {
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-primary);
  font-variant-numeric: tabular-nums;
}
.cls-sec {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin-top: 2px;
}
.cls-body {
  flex: 1;
  min-width: 120px;
}
.cls-name {
  font-size: 14px;
  color: var(--el-text-color-primary);
  font-weight: 500;
}
.cls-meta {
  margin-top: 3px;
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

/* ===== 空态 ===== */
.empty-block {
  padding: 8px 2px 4px;
}
.empty-title {
  font-size: 15px;
  color: var(--el-text-color-primary);
  font-weight: 500;
}
.empty-next {
  margin-top: 12px;
  background: var(--el-fill-color-light);
  border-radius: 8px;
  padding: 12px 14px;
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 10px;
}
.en-label {
  font-size: 12px;
  color: var(--el-color-primary);
  background: var(--el-color-primary-light-9);
  border-radius: 4px;
  padding: 2px 8px;
}
.en-name {
  font-size: 14px;
  color: var(--el-text-color-primary);
  font-weight: 500;
}
.en-meta {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.empty-tip {
  margin-top: 10px;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

/* ===== 倒计日 ===== */
.cd-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.cd-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 9px 12px;
  border: 1px solid var(--el-border-color);
  border-radius: 8px;
  cursor: pointer;
}
.cd-item:hover {
  border-color: var(--el-color-primary-light-8);
  background: var(--el-fill-color-extra-light);
}
.cd-days {
  flex-shrink: 0;
  width: 62px;
  text-align: center;
}
.cd-num {
  font-size: 20px;
  font-weight: 700;
  color: var(--el-color-primary);
  font-variant-numeric: tabular-nums;
}
.cd-num.today {
  font-size: 14px;
  color: var(--el-color-danger);
}
.cd-unit {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin-left: 2px;
}
.cd-body {
  flex: 1;
  min-width: 120px;
}
.cd-title {
  font-size: 14px;
  color: var(--el-text-color-primary);
}
.cd-meta {
  margin-top: 3px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

/* ===== 待办作业 ===== */
.hw-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.hw-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 9px 12px;
  border: 1px solid var(--el-border-color);
  border-radius: 8px;
  text-decoration: none;
  color: inherit;
}
.hw-item:hover {
  border-color: var(--el-color-primary-light-8);
  background: var(--el-fill-color-extra-light);
}
.hw-body {
  flex: 1;
  min-width: 120px;
}
.hw-title {
  font-size: 13px;
  color: var(--el-text-color-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.hw-meta {
  margin-top: 3px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.hw-more {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  padding: 2px 2px 0;
}
.hw-note {
  margin-top: 12px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  line-height: 1.7;
  background: var(--el-fill-color-light);
  border-radius: 6px;
  padding: 8px 12px;
}

/* ===== 健康跑 ===== */
.run-main {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.run-state {
  font-size: 15px;
  font-weight: 500;
  color: var(--el-color-warning);
}
.run-state.ok {
  color: var(--el-color-success);
}
.run-stats {
  margin-top: 14px;
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
}
.rs {
  background: var(--el-fill-color-light);
  border-radius: 8px;
  padding: 10px 6px;
  text-align: center;
}
.rs-num {
  display: block;
  font-size: 18px;
  font-weight: 700;
  color: var(--el-text-color-primary);
  font-variant-numeric: tabular-nums;
}
.rs-label {
  display: block;
  margin-top: 2px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.run-tip {
  margin-top: 10px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  line-height: 1.7;
}

/* ===== 快捷入口 ===== */
.sc-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 12px;
}
.sc-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  border: 1px solid var(--el-border-color);
  border-radius: 10px;
  background: var(--el-bg-color);
  cursor: pointer;
  text-align: left;
  transition: border-color 0.15s, box-shadow 0.15s, transform 0.15s;
}
.sc-item:hover {
  border-color: var(--el-color-primary-light-8);
  box-shadow: 0 2px 10px rgba(64, 158, 255, 0.12);
  transform: translateY(-1px);
}
.sc-icon {
  font-size: 20px;
  color: var(--el-color-primary);
  flex-shrink: 0;
}
.sc-body {
  min-width: 0;
}
.sc-title {
  font-size: 14px;
  font-weight: 500;
  color: var(--el-text-color-primary);
}
.sc-hint {
  margin-top: 2px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
