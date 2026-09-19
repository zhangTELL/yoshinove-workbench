<script setup lang="ts">
import type { Semester } from '@wb/shared'
import * as echarts from 'echarts'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox, ElNotification } from 'element-plus'
import { Delete, Edit, Plus, Upload } from '@element-plus/icons-vue'
import { useRoute, useRouter } from 'vue-router'
import { del, get, post, put, upload } from '../api/http'
import { chartAlertColor, chartBarColor, chartPalette } from '../utils/chartTheme'

// ==================== 工具页布局 ====================
// 栏目切换由左侧主导航的「日常工具」折叠分组控制，本页只按 ?tab= 渲染对应板块
const route = useRoute()
const router = useRouter()
const TOOL_KEYS = ['runs', 'countdown', 'scores', 'pomodoro'] as const

const activeTab = computed(() => {
  const tab = route.query.tab
  return typeof tab === 'string' && (TOOL_KEYS as readonly string[]).includes(tab) ? tab : TOOL_KEYS[0]
})

// 切到成绩/健康跑板块时才渲染图表：容器处于隐藏状态时初始化会得到 0 尺寸
watch(activeTab, (tab) => {
  if (tab === 'scores') return void nextTick().then(() => renderScoreCharts())
  if (tab === 'runs') return void nextTick().then(() => renderRunCharts())
})

// ==================== 健康跑 ====================
interface RunRecord {
  date: string
  distanceKm: number | null
  steps: number | null
}
interface RunStats {
  dates: string[]
  records?: RunRecord[]
  total: number
  streak: number
  weekCount: number
  monthCount: number
  weekKm?: number
  monthKm?: number
  today: boolean
}

const runStats = ref<RunStats | null>(null)
const runYear = ref(new Date().getFullYear())
const runMonth = ref(new Date().getMonth())

const runDates = computed(() => new Set(runStats.value?.dates ?? []))

/** 最近 8 条有里程或步数的记录（图表之外再给一个快速入口） */
const recentRecords = computed(() => (runStats.value?.records ?? []).filter((r) => r.distanceKm != null || r.steps != null).slice(0, 8))
const runCalendar = computed(() => {
  const y = runYear.value
  const m = runMonth.value
  const first = new Date(y, m, 1)
  const days = new Date(y, m + 1, 0).getDate()
  const offset = (first.getDay() + 6) % 7 // 周一开头
  const cells: (null | { day: number; date: string; checked: boolean; isToday: boolean; future?: boolean })[] = []
  for (let i = 0; i < offset; i++) cells.push(null)
  const todayStr = fmtDay(new Date())
  for (let d = 1; d <= days; d++) {
    const date = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    cells.push({
      day: d,
      date,
      checked: runDates.value.has(date),
      isToday: date === todayStr,
      future: date > todayStr,
    })
  }
  return cells
})

function fmtDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

async function loadRuns() {
  runStats.value = await get<RunStats>('/api/runs')
  // 数据变了就重画（仅当前板块可见时；隐藏容器 init 会得到 0 尺寸）
  if (activeTab.value === 'runs') renderRunCharts()
}

// ---- 手动录入：统一走弹窗（点打卡按钮或日历任意一天打开） ----

// ---- 某天记录的查看/编辑（点日历格打开） ----
const runDlg = ref(false)
const runDlgDate = ref('')
const runDlgKm = ref<number | null>(null)
const runDlgSteps = ref<number | null>(null)
const runDlgChecked = ref(false)

function openRunDialog(date: string, checked: boolean) {
  const rec = runStats.value?.records?.find((r) => r.date === date)
  runDlgDate.value = date
  runDlgKm.value = rec?.distanceKm ?? null
  runDlgSteps.value = rec?.steps ?? null
  runDlgChecked.value = checked
  runDlg.value = true
}

async function saveRunDialog() {
  if (runDlgChecked.value) {
    await put(`/api/runs/checkin/${runDlgDate.value}`, { distanceKm: runDlgKm.value, steps: runDlgSteps.value })
    ElMessage.success('已保存')
  } else {
    await post('/api/runs/checkin', { date: runDlgDate.value, distanceKm: runDlgKm.value, steps: runDlgSteps.value })
    ElMessage.success('打卡成功')
  }
  runDlg.value = false
  await loadRuns()
}

async function removeRunDialog() {
  try {
    await ElMessageBox.confirm(`撤销 ${runDlgDate.value} 的打卡？记录的里程/步数会一并删除`, '撤销打卡', { type: 'warning' })
  } catch {
    return
  }
  await del(`/api/runs/checkin/${runDlgDate.value}`)
  runDlg.value = false
  await loadRuns()
}

function shiftMonth(delta: number) {
  const d = new Date(runYear.value, runMonth.value + delta, 1)
  runYear.value = d.getFullYear()
  runMonth.value = d.getMonth()
}

// ==================== 健康跑图表 ====================
const runWeekChartEl = ref<HTMLDivElement>()
const runDayChartEl = ref<HTMLDivElement>()

/** 近 N 天的日期序列（含今天，升序） */
function recentDates(n: number): string[] {
  const out: string[] = []
  const d = new Date()
  for (let i = n - 1; i >= 0; i--) {
    const t = new Date(d)
    t.setDate(d.getDate() - i)
    out.push(fmtDay(t))
  }
  return out
}

/** 近 n 周的「周一日期」序列（含本周，升序） */
function recentWeekStarts(n: number): string[] {
  const out: string[] = []
  const d = new Date()
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7)) // 回到本周一
  for (let i = n - 1; i >= 0; i--) {
    const t = new Date(d)
    t.setDate(d.getDate() - i * 7)
    out.push(fmtDay(t))
  }
  return out
}

function renderRunCharts() {
  const p = chartPalette() // 每次渲染取当前主题用色，深浅色切换重画即换肤
  const records = runStats.value?.records ?? []
  const byDate = new Map(records.map((r) => [r.date, r]))
  const kmOf = (r?: RunRecord) => (r?.distanceKm ? r.distanceKm : 0)

  // ① 近 12 周每周里程
  const weekChart = renderOrGet(runWeekChartEl.value)
  if (weekChart) {
    const weeks = recentWeekStarts(12)
    const sums = weeks.map((ws) => {
      const start = new Date(ws + 'T00:00:00')
      const end = new Date(start)
      end.setDate(end.getDate() + 7)
      let s = 0
      for (const r of records) {
        if (r.date >= ws && r.date < fmtDay(end)) s += kmOf(r)
      }
      return Math.round(s * 100) / 100
    })
    weekChart.setOption({
      title: { text: '近 12 周里程', left: 'center', top: 4, textStyle: { fontSize: 13, color: p.text1 } },
      tooltip: { valueFormatter: (v: number) => `${v} km` },
      grid: { left: 44, right: 16, top: 40, bottom: 24 },
      xAxis: {
        type: 'category',
        data: weeks.map((ws) => ws.slice(5).replace('-', '/')),
        axisLabel: { color: p.text3, fontSize: 10 },
        axisLine: { lineStyle: { color: p.border } },
      },
      yAxis: {
        type: 'value',
        axisLabel: { color: p.text3, fontSize: 10 },
        splitLine: { lineStyle: { color: p.border, type: 'solid' } },
      },
      series: [
        {
          type: 'bar',
          barWidth: '55%',
          name: '里程',
          itemStyle: { color: p.accent, borderRadius: [4, 4, 0, 0] },
          data: sums,
        },
      ],
    })
    weekChart.resize()
  }

  // ② 近 30 天：每日里程（柱）+ 步数（线，右轴；只画记录了步数的天）
  const dayChart = renderOrGet(runDayChartEl.value)
  if (dayChart) {
    const days = recentDates(30)
    const kmData = days.map((d) => kmOf(byDate.get(d)))
    const stepData = days.map((d) => {
      const s = byDate.get(d)?.steps
      return typeof s === 'number' && s > 0 ? s : null
    })
    const hasSteps = stepData.some((v) => v !== null)
    dayChart.setOption({
      title: { text: '近 30 天里程与步数', left: 'center', top: 4, textStyle: { fontSize: 13, color: p.text1 } },
      legend: {
        bottom: 0,
        textStyle: { color: p.text3, fontSize: 11 },
        data: hasSteps ? ['里程 (km)', '步数'] : ['里程 (km)'],
      },
      tooltip: { trigger: 'axis' },
      grid: { left: 44, right: hasSteps ? 52 : 16, top: 40, bottom: hasSteps ? 36 : 24 },
      xAxis: {
        type: 'category',
        data: days.map((d) => d.slice(5)),
        axisLabel: { color: p.text3, fontSize: 10 },
        axisLine: { lineStyle: { color: p.border } },
      },
      yAxis: [
        {
          type: 'value',
          name: 'km',
          nameTextStyle: { color: p.text3 },
          axisLabel: { color: p.text3, fontSize: 10 },
          splitLine: { lineStyle: { color: p.border, type: 'solid' } },
        },
        ...(hasSteps
          ? [
              {
                type: 'value' as const,
                name: '步',
                nameTextStyle: { color: p.text3 },
                axisLabel: { color: p.text3, fontSize: 10 },
                splitLine: { show: false },
              },
            ]
          : []),
      ],
      series: [
        {
          name: '里程 (km)',
          type: 'bar',
          barWidth: '60%',
          itemStyle: { color: p.accent, borderRadius: [2, 2, 0, 0] },
          data: kmData,
        },
        ...(hasSteps
          ? [
              {
                name: '步数',
                type: 'line' as const,
                yAxisIndex: 1,
                smooth: true,
                symbolSize: 4,
                /* 2026-09-20：与「里程」同为**主题数据色**的两个档（里程 = accent 85%，
                   步数 = accent 的柔化浅档），不再用绿色的语义色——两套轴上的两条系列
                   都是"数据"，不是"好/坏"，语义绿留给真正的阈值图（见 chartBarColor 注释）。
                   两条线靠"深浅 + 圆点/线型 + 双轴刻度"区分，另有图例与 tooltip。 */
                itemStyle: { color: chartBarColor(0.45) },
                lineStyle: { color: chartBarColor(0.45), width: 2 },
                data: stepData,
              },
            ]
          : []),
      ],
    })
    dayChart.resize()
  }
}

// ==================== 倒计日 ====================
interface Countdown {
  id: number
  title: string
  date: string
  category: string
  note: string
}

const countdowns = ref<Countdown[]>([])
const cdDialogVisible = ref(false)
const cdForm = ref({ id: 0, title: '', date: '', category: '考试', note: '' })

const CD_CATEGORIES = ['考试', '作业', '报名', '其他']
const cdSorted = computed(() =>
  [...countdowns.value].sort((a, b) => {
    const da = daysLeft(a.date)
    const db_ = daysLeft(b.date)
    // 未到期的排前面
    if (da >= 0 && db_ < 0) return -1
    if (da < 0 && db_ >= 0) return 1
    return da - db_
  }),
)

function daysLeft(date: string): number {
  const target = new Date(date + 'T00:00:00').getTime()
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return Math.round((target - today.getTime()) / 86400000)
}

async function loadCountdowns() {
  countdowns.value = await get<Countdown[]>('/api/countdowns')
}

function openCdDialog(item?: Countdown) {
  cdForm.value = item
    ? { id: item.id, title: item.title, date: item.date, category: item.category, note: item.note }
    : { id: 0, title: '', date: '', category: '考试', note: '' }
  cdDialogVisible.value = true
}

async function saveCd() {
  const f = cdForm.value
  if (!f.title || !f.date) {
    ElMessage.warning('请填写标题和日期')
    return
  }
  if (f.id) {
    await put(`/api/countdowns/${f.id}`, f)
  } else {
    await post('/api/countdowns', f)
  }
  cdDialogVisible.value = false
  await loadCountdowns()
  ElMessage.success('已保存')
}

async function removeCd(item: Countdown) {
  await ElMessageBox.confirm(`删除倒计日「${item.title}」？`, '确认', { type: 'warning' })
  await del(`/api/countdowns/${item.id}`)
  await loadCountdowns()
}

// ==================== 成绩绩点 ====================
interface ScoreRow {
  id: number
  semester: string
  courseName: string
  credit: number
  score: number
  gradePoint: number
}
interface ScoreData {
  rows: ScoreRow[]
  semesters: { semester: string; gpa: number; totalCredit: number; count: number }[]
  overallGpa: number
  overallCredit: number
}

const scoreData = ref<ScoreData | null>(null)
const scoreDialogVisible = ref(false)
const scoreForm = ref({ semester: '', courseName: '', credit: 2, score: 90 })

const scoreSemesterFilter = ref('全部')
const scoreSemesters = computed(() => ['全部', ...(scoreData.value?.semesters.map((s) => s.semester) ?? [])])
const scoreFiltered = computed(() =>
  !scoreData.value || scoreSemesterFilter.value === '全部'
    ? (scoreData.value?.rows ?? [])
    : scoreData.value.rows.filter((r) => r.semester === scoreSemesterFilter.value),
)

// ===== 成绩分析（Excel 导入 + 范围切换 + 图表）=====
const importingScore = ref(false)
const scoreFileInput = ref<HTMLInputElement>()
const scoreScope = ref<'current' | 'year' | 'all'>('all')
const currentSemesterName = ref('')
const currentYear = ref('')
const distChartEl = ref<HTMLDivElement>()
const trendChartEl = ref<HTMLDivElement>()
const courseChartEl = ref<HTMLDivElement>()
const chartInstances = new Set<echarts.ECharts>()

const scopedRows = computed<ScoreRow[]>(() => {
  const rows = scoreData.value?.rows ?? []
  // 学期下拉是更具体的过滤：选中具体学期时由它说了算。
  // 之前这里完全没看 scoreSemesterFilter，导致选了学期、图表仍显示全部（已实测确认的 bug）。
  if (scoreSemesterFilter.value !== '全部') {
    return rows.filter((r) => r.semester === scoreSemesterFilter.value)
  }
  if (scoreScope.value === 'current') return rows.filter((r) => r.semester === currentSemesterName.value)
  if (scoreScope.value === 'year') return rows.filter((r) => r.semester.startsWith(currentYear.value))
  return rows
})
/** 当前生效的过滤范围描述：统计卡标签与图表空态都要用它，别再各写一份 */
const scoreFilterLabel = computed(() => {
  if (scoreSemesterFilter.value !== '全部') return scoreSemesterFilter.value
  if (scoreScope.value === 'current') return '本学期'
  if (scoreScope.value === 'year') return `本学年 ${currentYear.value}`
  return '全部'
})
const scopedGpa = computed(() => {
  let credit = 0
  let weighted = 0
  for (const r of scopedRows.value) {
    credit += r.credit
    weighted += r.credit * r.gradePoint
  }
  return credit ? +(weighted / credit).toFixed(2) : 0
})

async function loadSemesterInfo() {
  const sems = await get<Semester[]>('/api/semesters')
  const cur = sems.find((s) => s.isCurrent) ?? sems[0]
  if (cur) {
    currentSemesterName.value = cur.name
    currentYear.value = cur.name.split('第')[0]
  }
}

async function importScoreExcel(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  importingScore.value = true
  try {
    const r = await upload<{ detail: string; semesters: string[] }>('/api/scores/import', file)
    ElMessage.success(r.detail)
    await loadScores()
    await renderScoreCharts()
  } catch (err) {
    ElMessage.error((err as Error).message)
  } finally {
    importingScore.value = false
    input.value = ''
  }
}

/** 取回已有实例或新建，并登记以便统一销毁（重复渲染不会重复登记） */
function renderOrGet(el?: HTMLDivElement): echarts.ECharts | null {
  if (!el) return null
  const chart = echarts.getInstanceByDom(el) ?? echarts.init(el)
  chartInstances.add(chart)
  return chart
}

async function renderScoreCharts() {
  await nextTick()
  const rows = scopedRows.value
  const p = chartPalette() // 每次渲染都取当前主题的用色，深浅色切换后重画即换肤

  // ① 成绩分布
  const distChart = renderOrGet(distChartEl.value)
  if (distChart) {
    const bins = [
      { name: '90-100', min: 90, max: 101 },
      { name: '80-89', min: 80, max: 90 },
      { name: '70-79', min: 70, max: 80 },
      { name: '60-69', min: 60, max: 70 },
      { name: '<60', min: -1, max: 60 },
    ]
    distChart.setOption({
      title: { text: '成绩分布', left: 'center', textStyle: { fontSize: 13, color: p.text1 } },
      tooltip: {},
      grid: { left: 40, right: 16, top: 36, bottom: 28 },
      xAxis: { type: 'category', data: bins.map((b) => b.name), axisLabel: { color: p.text2 } },
      yAxis: { type: 'value', minInterval: 1, axisLabel: { color: p.text2 }, splitLine: { lineStyle: { color: p.border } } },
      series: [
        {
          type: 'bar',
          barWidth: '55%',
          // 与「各课程成绩」同一支柔化色，两张图看起来才是一套
          itemStyle: { color: chartBarColor(), borderRadius: [4, 4, 0, 0] },
          data: bins.map((b) => rows.filter((r) => r.score >= b.min && r.score < b.max).length),
        },
      ],
    })
    distChart.resize()
  }

  // ② 学期绩点趋势（始终展示全部学期）
  const trendChart = renderOrGet(trendChartEl.value)
  if (trendChart) {
    const sems = [...(scoreData.value?.semesters ?? [])].sort((a, b) => a.semester.localeCompare(b.semester))
    trendChart.setOption({
      title: { text: '学期绩点趋势', left: 'center', textStyle: { fontSize: 13, color: p.text1 } },
      tooltip: { trigger: 'axis' },
      grid: { left: 40, right: 24, top: 36, bottom: 40 },
      xAxis: {
        type: 'category',
        data: sems.map((s) => s.semester),
        axisLabel: { rotate: 20, fontSize: 10, color: p.text2 },
      },
      yAxis: { type: 'value', max: 4, axisLabel: { color: p.text2 }, splitLine: { lineStyle: { color: p.border } } },
      series: [
        {
          type: 'line',
          smooth: true,
          symbolSize: 8,
          data: sems.map((s) => s.gpa),
          lineStyle: { color: p.success, width: 3 },
          itemStyle: { color: p.success },
          label: { show: true, formatter: '{c}', color: p.text2 },
        },
      ],
    })
    trendChart.resize()
  }

  // ③ 各课程成绩（当前范围）
  const courseChart = renderOrGet(courseChartEl.value)
  if (courseChart) {
    const sorted = [...rows].sort((a, b) => a.score - b.score)
    const height = Math.max(220, sorted.length * 26 + 60)
    courseChartEl.value!.style.height = `${height}px`
    courseChart.resize()
    /* "低于平均分"的对照线：用户 2026-09-20 要求把"不及格才变色"改成"低于平均分就变色"。
       平均分按当前筛选范围算（`rows` 已经是筛选后的集合，与图表同源），保留 1 位小数。
       浮点相等的情况（正好等于平均分）**不变色**，避免"平均分那一门"来回跳。 */
    const avg = rows.length ? rows.reduce((s, r) => s + r.score, 0) / rows.length : 0
    const avgText = avg.toFixed(1)
    courseChart.setOption({
      title: { text: '各课程成绩', left: 'center', textStyle: { fontSize: 13, color: p.text1 } },
      tooltip: {
        formatter: (ps: unknown) => {
          const arr = ps as { dataIndex: number }[]
          const r = sorted[arr[0].dataIndex]
          if (!r) return ''
          const below = r.score < avg
          return [
            `<b>${r.courseName}</b>`,
            `成绩：${r.score}${below ? `（低于平均分 ${avgText}）` : ''}`,
            r.semester ? `学期：${r.semester}` : '',
            r.credit ? `学分：${r.credit}` : '',
          ]
            .filter(Boolean)
            .join('<br/>')
        },
      },
      grid: { left: 130, right: 40, top: 36, bottom: 28 },
      xAxis: { type: 'value', max: 100, axisLabel: { color: p.text2 }, splitLine: { lineStyle: { color: p.border } } },
      yAxis: {
        type: 'category',
        data: sorted.map((r) => r.courseName),
        axisLabel: { fontSize: 11, width: 120, overflow: 'truncate', color: p.text2 },
      },
      series: [
        {
          type: 'bar',
          barWidth: '60%',
          label: { show: true, position: 'right', fontSize: 11, color: p.text2 },
          itemStyle: {
            borderRadius: [0, 4, 4, 0],
            /* ★ 2026-09-20 第三版（用户三轮反馈逐步收敛）：
               ① 主数据柱 = **主题强调色柔化 50%**（accent 混 surface），不再整屏一个饱和绿；
               ② 低于平均分的柱子 = **accent 同族但色相偏转 + 降饱和的柔化档**（chartAlertColor），
                  不再四套共用一支琥珀——"四个主题的低分柱都是琥珀色"本身就是没主题化的表现。
                  为什么不用"主题危险色"：纸页主题的 accent 是印章红、danger 也是红，
                  两者柔化后色差只有 9.3，低分柱会直接消失（见 chartAlertColor 的注释）；
               ③ 两者都柔化到同一档，**明度关系一致**，差异只在色相上；
               ④ 另加一条**平均分虚线**：让"低于平均分"这个口径看得见（颜色不再是唯一线索）。 */
            color: (q: { value: number }) =>
              q.value < avg ? chartAlertColor(0.5) : chartBarColor(0.5, p.accent),
          },
          data: sorted.map((r) => r.score),
          /* 平均分参考线：有了它，"低于平均分"才是一个**看得见的口径**，
             否则用户只能从颜色反推阈值。虚线用主题边框色，标注压在顶边。
             ⚠️ 数据全是整数、平均分带小数，所以线会落在两根柱子刻度之间（这正是想要的暗示）。 */
          markLine: {
            silent: true,
            symbol: 'none',
            data: [{ xAxis: Number(avgText) }],
            lineStyle: { color: p.border, type: 'dashed', width: 1 },
            label: {
              position: 'end',
              formatter: `平均 ${avgText}`,
              fontSize: 10,
              color: p.text3,
            },
          },
        },
      ],
    })
    courseChart.resize()
  }
}

function disposeCharts() {
  for (const c of chartInstances) c.dispose()
  chartInstances.clear()
}

function onScoreScopeChange() {
  void renderScoreCharts()
}

// 主题变化（深浅色/主题色）后重画图表（echarts 画在 canvas 上，不会自动跟随 CSS 变量）
function onThemeChange() {
  if (activeTab.value === 'scores') void renderScoreCharts()
  if (activeTab.value === 'runs') void renderRunCharts()
}

/** 切学期下拉同样要重画图表——之前缺了这个，选学期后图表纹丝不动 */
function onScoreSemesterChange() {
  void renderScoreCharts()
}

async function loadScores() {
  scoreData.value = await get<ScoreData>('/api/scores')
}

function openScoreDialog() {
  scoreForm.value = { semester: scoreSemesterFilter.value === '全部' ? '' : scoreSemesterFilter.value, courseName: '', credit: 2, score: 90 }
  scoreDialogVisible.value = true
}

async function saveScore() {
  const f = scoreForm.value
  if (!f.semester || !f.courseName) {
    ElMessage.warning('请填写学期与课程名')
    return
  }
  await post('/api/scores', f)
  scoreDialogVisible.value = false
  await loadScores()
  ElMessage.success('已录入')
}

async function removeScore(r: ScoreRow) {
  await ElMessageBox.confirm(`删除「${r.courseName}」的成绩？`, '确认', { type: 'warning' })
  await del(`/api/scores/${r.id}`)
  await loadScores()
}

// ==================== 番茄钟 ====================
interface PomodoroData {
  todayMin: number
  daily: { date: string; minutes: number }[]
  recent: { id: number; taskLabel: string; courseTag: string; startedAt: string; durationMin: number }[]
}

const pomoData = ref<PomodoroData | null>(null)
const pomoRunning = ref(false)
const pomoMode = ref<'work' | 'break'>('work')
const pomoRemain = ref(25 * 60)
const pomoWorkMin = ref(25)
const pomoBreakMin = ref(5)
const pomoTask = ref('')
const pomoTag = ref('')
const pomoStartedAt = ref('')
const pomoElapsed = ref(0)
let pomoTimer: number | undefined

const pomoDisplay = computed(() => {
  const m = Math.floor(pomoRemain.value / 60)
  const s = pomoRemain.value % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
})
const pomoProgress = computed(() => {
  const total = (pomoMode.value === 'work' ? pomoWorkMin.value : pomoBreakMin.value) * 60
  return (pomoElapsed.value / total) * 100
})
const pomoMaxDaily = computed(() => Math.max(60, ...(pomoData.value?.daily ?? []).map((d) => d.minutes)))

async function loadPomodoro() {
  pomoData.value = await get<PomodoroData>('/api/pomodoro?days=14')
}

/**
 * 布局切换（进入/退出专注态）用 View Transition 做「一镜到底」：
 * 钟表元素带 view-transition-name，新旧两帧里各出现一次，浏览器自动从原位 morph 到新位。
 * 不支持的浏览器（非 Chromium 111+）直接切换，无动画。
 */
function withViewTransition(fn: () => void): void {
  const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown }
  if (typeof doc.startViewTransition === 'function') doc.startViewTransition(fn)
  else fn()
}

function pomoStart() {
  if (pomoRunning.value) return
  withViewTransition(() => {
    pomoRunning.value = true
    pomoMode.value = 'work'
    pomoRemain.value = pomoWorkMin.value * 60
    pomoElapsed.value = 0
    pomoStartedAt.value = new Date().toISOString()
  })
  pomoTimer = window.setInterval(() => {
    pomoRemain.value--
    pomoElapsed.value++
    if (pomoRemain.value <= 0) {
      if (pomoMode.value === 'work') {
        void recordPomodoro(pomoWorkMin.value)
        ElNotification({ title: '番茄完成 🍅', message: `专注 ${pomoWorkMin.value} 分钟，休息一下！`, type: 'success' })
        pomoMode.value = 'break'
        pomoRemain.value = pomoBreakMin.value * 60
        pomoElapsed.value = 0
      } else {
        ElNotification({ title: '休息结束', message: '开始下一个番茄吧！', type: 'info' })
        exitFocusUI()
      }
    }
  }, 1000)
}

function pomoStop() {
  pomoRunning.value = false
  if (pomoTimer) clearInterval(pomoTimer)
}

/** 退出专注态：复位到准备就绪布局（带一镜到底动画） */
function exitFocusUI() {
  withViewTransition(() => {
    pomoRunning.value = false
    if (pomoTimer) clearInterval(pomoTimer)
    pomoMode.value = 'work'
    pomoRemain.value = pomoWorkMin.value * 60
    pomoElapsed.value = 0
  })
}

async function recordPomodoro(minutes: number) {
  if (pomoElapsed.value < 60 && minutes < 1) return
  await post('/api/pomodoro', {
    taskLabel: pomoTask.value,
    courseTag: pomoTag.value,
    startedAt: pomoStartedAt.value,
    endedAt: new Date().toISOString(),
    durationMin: minutes,
  })
  await loadPomodoro()
}

async function pomoGiveUp() {
  const minutes = Math.floor(pomoElapsed.value / 60)
  const wasWork = pomoMode.value === 'work'
  exitFocusUI()
  if (minutes >= 1 && wasWork) {
    await recordPomodoro(minutes)
    ElMessage.success(`已记录 ${minutes} 分钟专注`)
  }
}

// ==================== 初始化 ====================
onMounted(() => {
  // 直接访问 /tools 时补上默认板块，保证左侧导航有对应的高亮项
  if (!route.query.tab) void router.replace({ path: '/tools', query: { tab: TOOL_KEYS[0] } })

  void loadCountdowns()
  void loadPomodoro()
  void (async () => {
    await loadRuns()
    await loadScores()
    await loadSemesterInfo()
    if (activeTab.value === 'scores') await renderScoreCharts()
  })()
  window.addEventListener('resize', onWindowResize)
  window.addEventListener('wb-theme-change', onThemeChange)
})
onUnmounted(() => {
  pomoStop()
  disposeCharts()
  window.removeEventListener('resize', onWindowResize)
  window.removeEventListener('wb-theme-change', onThemeChange)
})

function onWindowResize() {
  for (const c of chartInstances) c.resize()
}
</script>

<template>
  <div class="tools-page">
    <section class="tools-content">
      <div v-show="activeTab === 'runs'" class="tab-block">
        <div class="stat-cards">
          <div class="stat-card">
            <div class="stat-num">{{ runStats?.streak ?? 0 }}</div>
            <div class="stat-label">连续天数</div>
          </div>
          <div class="stat-card">
            <div class="stat-num">{{ runStats?.weekCount ?? 0 }}</div>
            <div class="stat-label">本周次数</div>
          </div>
          <div class="stat-card">
            <div class="stat-num">{{ runStats?.monthCount ?? 0 }}</div>
            <div class="stat-label">本月次数</div>
          </div>
          <div class="stat-card">
            <div class="stat-num">{{ runStats?.total ?? 0 }}</div>
            <div class="stat-label">累计</div>
          </div>
          <div class="stat-card">
            <div class="stat-num">{{ runStats?.weekKm ?? 0 }}<span class="stat-unit">km</span></div>
            <div class="stat-label">本周里程</div>
          </div>
          <div class="stat-card">
            <div class="stat-num">{{ runStats?.monthKm ?? 0 }}<span class="stat-unit">km</span></div>
            <div class="stat-label">本月里程</div>
          </div>
        </div>
        <div class="checkin-bar">
          <el-button
            :type="runStats?.today ? 'success' : 'primary'"
            size="large"
            round
            @click="openRunDialog(fmtDay(new Date()), !!runStats?.today)"
          >
            {{ runStats?.today ? '✅ 今天已打卡（点击修改）' : '🏃 今天跑完了，打卡！' }}
          </el-button>
          <div class="checkin-tip">打卡时可以顺手填里程或步数（也可以都不填）；点日历上任意一天能补录或修改</div>
        </div>
        <div class="calendar">
          <div class="cal-head">
            <el-button size="small" text @click="shiftMonth(-1)">‹</el-button>
            <span>{{ runYear }} 年 {{ runMonth + 1 }} 月</span>
            <el-button size="small" text @click="shiftMonth(1)">›</el-button>
          </div>
          <div class="cal-week">
            <span v-for="d in ['一', '二', '三', '四', '五', '六', '日']" :key="d">{{ d }}</span>
          </div>
          <div class="cal-grid">
            <template v-for="(c, i) in runCalendar" :key="i">
              <div v-if="!c" class="cal-cell empty" />
              <div
                v-else
                class="cal-cell"
                :class="{ checked: c.checked, today: c.isToday, future: c.future }"
                :title="c.future ? '未来日期不能打卡' : '点击打卡 / 编辑里程与步数'"
                @click="!c.future && openRunDialog(c.date, c.checked)"
              >
                {{ c.checked ? '🏃' : c.day }}
              </div>
            </template>
          </div>
        </div>
        <div class="run-charts">
          <div ref="runWeekChartEl" class="run-chart"></div>
          <div ref="runDayChartEl" class="run-chart"></div>
        </div>
        <div v-if="recentRecords.length" class="run-records">
          <div class="rr-title">最近记录</div>
          <div v-for="r in recentRecords" :key="r.date" class="rr-row" @click="openRunDialog(r.date, true)">
            <span class="rr-date">{{ r.date }}</span>
            <span class="rr-km">{{ r.distanceKm != null ? r.distanceKm + ' km' : '—' }}</span>
            <span class="rr-steps">{{ r.steps != null ? r.steps.toLocaleString() + ' 步' : '—' }}</span>
            <el-icon class="rr-edit"><Edit /></el-icon>
          </div>
        </div>
      </div>

      <!-- 打卡/编辑记录弹窗 -->
      <el-dialog v-model="runDlg" :title="runDlgChecked ? `编辑 ${runDlgDate} 的记录` : `补打卡 · ${runDlgDate}`" width="380px">
        <div class="run-dlg-form">
          <div class="run-dlg-row">
            <span class="run-dlg-label">里程（km）</span>
            <el-input-number v-model="runDlgKm" :min="0" :max="500" :precision="2" :step="0.5" controls-position="right" placeholder="不填" />
          </div>
          <div class="run-dlg-row">
            <span class="run-dlg-label">步数</span>
            <el-input-number v-model="runDlgSteps" :min="0" :max="500000" :step="100" controls-position="right" placeholder="不填" />
          </div>
          <div class="run-dlg-tip">留空表示当天没记这项数据</div>
        </div>
        <template #footer>
          <el-button v-if="runDlgChecked" type="danger" text @click="removeRunDialog">撤销打卡</el-button>
          <el-button @click="runDlg = false">取消</el-button>
          <el-button type="primary" @click="saveRunDialog">{{ runDlgChecked ? '保存' : '打卡' }}</el-button>
        </template>
      </el-dialog>

      <div v-show="activeTab === 'countdown'" class="tab-block">
        <div class="tab-toolbar">
          <el-button type="primary" :icon="Plus" @click="openCdDialog()">添加倒计日</el-button>
        </div>
        <el-empty v-if="!cdSorted.length" description="还没有倒计日。加上期末考试、四六级、交作业这类重要日子吧" />
        <div v-else class="cd-grid">
          <div v-for="c in cdSorted" :key="c.id" class="cd-card" :class="{ past: daysLeft(c.date) < 0 }" @click="openCdDialog(c)">
            <el-tag size="small" :type="c.category === '考试' ? 'danger' : c.category === '作业' ? 'warning' : 'info'">{{ c.category }}</el-tag>
            <div class="cd-days">
              <template v-if="daysLeft(c.date) > 0">
                <span class="cd-num">{{ daysLeft(c.date) }}</span><span class="cd-unit">天</span>
              </template>
              <span v-else-if="daysLeft(c.date) === 0" class="cd-num today">就是今天</span>
              <template v-else>
                <span class="cd-num past">已过 {{ -daysLeft(c.date) }}</span><span class="cd-unit">天</span>
              </template>
            </div>
            <div class="cd-title">{{ c.title }}</div>
            <div class="cd-date">{{ c.date }}</div>
            <el-icon class="cd-del" @click.stop="removeCd(c)"><Delete /></el-icon>
          </div>
        </div>
      </div>

      <div v-show="activeTab === 'scores'" class="tab-block">
        <div class="gpa-cards">
          <div class="stat-card">
            <div class="stat-num">{{ scoreData?.overallGpa ?? 0 }}</div>
            <div class="stat-label">总绩点（加权）</div>
          </div>
          <div class="stat-card">
            <div class="stat-num">{{ scoreData?.overallCredit ?? 0 }}</div>
            <div class="stat-label">总学分</div>
          </div>
          <div class="stat-card">
            <div class="stat-num">{{ scopedGpa }}</div>
            <div class="stat-label">{{ scoreFilterLabel }}绩点</div>
          </div>
          <div v-for="s in scoreData?.semesters ?? []" :key="s.semester" class="stat-card">
            <div class="stat-num">{{ s.gpa }}</div>
            <div class="stat-label">{{ s.semester }}</div>
          </div>
        </div>
        <div class="tab-toolbar">
          <el-radio-group
            v-model="scoreScope"
            size="small"
            :disabled="scoreSemesterFilter !== '全部'"
            :title="scoreSemesterFilter !== '全部' ? `已按「${scoreSemesterFilter}」过滤，先切回「全部」再用范围切换` : undefined"
            @change="onScoreScopeChange"
          >
            <el-radio-button value="current">本学期</el-radio-button>
            <el-radio-button value="year">本学年</el-radio-button>
            <el-radio-button value="all">全部</el-radio-button>
          </el-radio-group>
          <div style="flex: 1" />
          <el-radio-group v-model="scoreSemesterFilter" size="small" @change="onScoreSemesterChange">
            <el-radio-button v-for="s in scoreSemesters" :key="s" :value="s">{{ s }}</el-radio-button>
          </el-radio-group>
          <input ref="scoreFileInput" type="file" accept=".xlsx,.xls" hidden @change="importScoreExcel" />
          <el-button type="success" :icon="Upload" :loading="importingScore" @click="scoreFileInput?.click()">导入成绩 Excel</el-button>
          <el-button type="primary" :icon="Plus" @click="openScoreDialog">录入成绩</el-button>
        </div>

        <div class="chart-grid">
          <div class="chart-box" style="position: relative">
            <div ref="distChartEl" style="width: 100%; height: 100%" />
            <div v-if="!scopedRows.length" class="chart-empty">「{{ scoreFilterLabel }}」范围内暂无成绩记录</div>
          </div>
          <div ref="trendChartEl" class="chart-box" />
        </div>
        <div class="chart-box course-chart" style="position: relative">
          <div ref="courseChartEl" style="width: 100%; height: 100%" />
          <div v-if="!scopedRows.length" class="chart-empty">「{{ scoreFilterLabel }}」范围内暂无成绩记录</div>
        </div>

        <div class="tab-toolbar">
          <span class="form-tip">成绩明细（{{ scoreFiltered.length }} 条）</span>
        </div>
        <el-empty v-if="!scoreFiltered.length" description="还没有成绩。点「导入成绩 Excel」选教务系统导出的表格，也可以手动录入" />
        <el-table v-else :data="scoreFiltered" size="small">
          <el-table-column prop="semester" label="学期" min-width="140" />
          <el-table-column prop="courseName" label="课程" min-width="180" />
          <el-table-column prop="credit" label="学分" width="70" />
          <el-table-column prop="score" label="成绩" width="70" />
          <el-table-column prop="gradePoint" label="绩点" width="70" />
          <el-table-column width="60">
            <template #default="{ row }">
              <el-button size="small" type="danger" text :icon="Delete" @click="removeScore(row)" />
            </template>
          </el-table-column>
        </el-table>
      </div>

      <div v-show="activeTab === 'pomodoro'" class="tab-block">
        <!-- 专注态：只留钟表，居中于内容区（开始/结束时与常规布局做一镜到底 morph） -->
        <div v-if="pomoRunning" class="pomo-focus">
          <div class="pomo-circle" :class="{ running: pomoRunning, break: pomoMode === 'break' }">
            <div class="pomo-time">{{ pomoDisplay }}</div>
            <div class="pomo-mode">{{ pomoMode === 'work' ? '专注中' : '休息中' }}</div>
          </div>
          <div v-if="pomoTask || pomoTag" class="pomo-focus-task">
            {{ pomoTask }}<template v-if="pomoTask && pomoTag"> · </template>{{ pomoTag }}
          </div>
          <div class="pomo-controls">
            <el-button type="warning" size="large" round @click="pomoGiveUp">结束并记录</el-button>
          </div>
        </div>
        <div v-else class="pomo-layout">
          <div class="pomo-left">
            <div class="pomo-circle" :class="{ running: pomoRunning, break: pomoMode === 'break' }">
              <div class="pomo-time">{{ pomoDisplay }}</div>
              <div class="pomo-mode">{{ pomoRunning ? (pomoMode === 'work' ? '专注中' : '休息中') : '准备就绪' }}</div>
            </div>
            <div class="pomo-controls">
              <el-button type="primary" size="large" round @click="pomoStart">开始专注</el-button>
            </div>
          </div>
          <div class="pomo-right">
            <el-form label-width="70px" style="max-width: 380px">
              <el-form-item label="在做啥">
                <el-input v-model="pomoTask" placeholder="如：写数据结构实验报告" />
              </el-form-item>
              <el-form-item label="课程">
                <el-input v-model="pomoTag" placeholder="可选，如：数据结构" />
              </el-form-item>
              <el-form-item label="时长">
                专注 <el-input-number v-model="pomoWorkMin" :min="5" :max="120" size="small" /> 分钟
                · 休息 <el-input-number v-model="pomoBreakMin" :min="3" :max="30" size="small" /> 分钟
              </el-form-item>
            </el-form>
            <div class="pomo-today">今日专注 {{ pomoData?.todayMin ?? 0 }} 分钟 🍅</div>
            <div class="pomo-bars">
              <div v-for="d in (pomoData?.daily ?? []).slice(-14)" :key="d.date" class="pomo-bar-col" :title="`${d.date}：${d.minutes} 分钟`">
                <div class="pomo-bar" :style="{ height: `${Math.max(2, (d.minutes / pomoMaxDaily) * 80)}px` }" />
                <div class="pomo-bar-label">{{ d.date.slice(8) }}</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  </div>

    <!-- 倒计日对话框 -->
    <el-dialog v-model="cdDialogVisible" :title="cdForm.id ? '编辑倒计日' : '添加倒计日'" width="400px">
      <el-form label-width="70px">
        <el-form-item label="标题">
          <el-input v-model="cdForm.title" placeholder="如：高数期末考试" />
        </el-form-item>
        <el-form-item label="日期">
          <el-date-picker v-model="cdForm.date" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
        </el-form-item>
        <el-form-item label="分类">
          <el-radio-group v-model="cdForm.category">
            <el-radio v-for="c in CD_CATEGORIES" :key="c" :value="c">{{ c }}</el-radio>
          </el-radio-group>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="cdDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="saveCd">保存</el-button>
      </template>
    </el-dialog>

    <!-- 录入成绩对话框 -->
    <el-dialog v-model="scoreDialogVisible" title="录入成绩" width="400px">
      <el-form label-width="70px">
        <el-form-item label="学期">
          <el-input v-model="scoreForm.semester" placeholder="如：2026-2027第1学期" />
        </el-form-item>
        <el-form-item label="课程">
          <el-input v-model="scoreForm.courseName" />
        </el-form-item>
        <el-form-item label="学分">
          <el-input-number v-model="scoreForm.credit" :min="0.5" :max="20" :step="0.5" />
        </el-form-item>
        <el-form-item label="成绩">
          <el-input-number v-model="scoreForm.score" :min="0" :max="100" />
          <span class="form-tip">绩点按常见规则自动算好</span>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="scoreDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="saveScore">保存</el-button>
      </template>
    </el-dialog>
</template>

<style scoped>
.tools-page {
  display: block;
}
.tools-content {
  min-width: 0;
}
.tab-block {
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color);
  border-radius: var(--wb-radius-card);
  padding: 16px;
}
.tab-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 14px;
  flex-wrap: wrap;
  gap: 10px;
}
.stat-cards,
.gpa-cards {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  justify-content: center;
  margin-bottom: 16px;
}
.stat-card {
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color);
  border-radius: var(--wb-radius-card);
  padding: 14px 22px;
  text-align: center;
  min-width: 110px;
}
.stat-num {
  font-size: 26px;
  font-weight: 700;
  color: var(--wb-accent-text);
}
.stat-label {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin-top: 4px;
}
.checkin-bar {
  text-align: center;
  margin: 10px 0 20px;
}
.checkin-tip {
  margin-top: 8px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.stat-unit {
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-secondary);
  margin-left: 3px;
}
.run-charts {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
  max-width: 1240px;
  margin: 8px auto 20px;
}
.run-chart {
  height: 360px;
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color);
  border-radius: var(--wb-radius-card);
  padding: 8px;
}
@media (max-width: 900px) {
  .run-charts {
    grid-template-columns: 1fr;
  }
}
.run-records {
  max-width: 480px;
  margin: 0 auto;
}
.rr-title {
  font-weight: 600;
  font-size: 14px;
  color: var(--el-text-color-primary);
  margin: 8px 0 8px;
}
.rr-row {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 8px 12px;
  border: 1px solid var(--el-border-color);
  border-radius: var(--wb-radius-card);
  margin-bottom: 6px;
  background: var(--el-bg-color);
  font-size: 13px;
  cursor: pointer;
}
.rr-row:hover {
  border-color: var(--el-color-primary);
}
.rr-date {
  color: var(--el-text-color-secondary);
  min-width: 86px;
}
.rr-km {
  color: var(--el-text-color-primary);
  font-weight: 600;
  min-width: 70px;
}
.rr-steps {
  color: var(--el-text-color-regular);
  flex: 1;
  text-align: right;
}
.rr-edit {
  color: var(--el-text-color-placeholder);
}
.run-dlg-form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.run-dlg-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.run-dlg-label {
  font-size: 14px;
  color: var(--el-text-color-regular);
}
.run-dlg-tip {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.calendar {
  max-width: 560px;
  margin: 0 auto;
}
.cal-head {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 16px;
  margin-bottom: 8px;
  font-weight: 600;
}
.cal-week,
.cal-grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 5px;
}
.cal-week span {
  text-align: center;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.cal-cell {
  height: 58px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--wb-radius-card);
  background: var(--el-bg-color);
  font-size: 15px;
  color: var(--el-text-color-regular);
  cursor: pointer;
  user-select: none;
}
.cal-cell.checked {
  /* 原来是写死的 #f0f9eb（EP 默认绿 palette 的浅档），换个主题就露出不属于该主题的绿；
     color-mix 从当前状态色现算浅底，跟得上主题 */
  background: color-mix(in srgb, var(--el-color-success) 12%, var(--el-bg-color));
  border: 1px solid var(--el-color-success);
}
.cal-cell.today {
  box-shadow: 0 0 0 2px var(--el-color-primary) inset;
}
.cal-cell.future {
  color: var(--el-border-color-light);
  cursor: not-allowed;
  background: var(--el-fill-color-lighter);
}
.cd-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 12px;
}
.cd-card {
  position: relative;
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color);
  border-radius: var(--wb-radius-card);
  padding: 16px;
  text-align: center;
  cursor: pointer;
}
.cd-card.past {
  opacity: 0.55;
}
.cd-days {
  margin: 10px 0 6px;
}
.cd-num {
  font-size: 34px;
  font-weight: 700;
  color: var(--wb-accent-text);
}
.cd-num.today {
  font-size: 22px;
  color: var(--el-color-warning);
}
.cd-num.past {
  font-size: 20px;
  color: var(--el-text-color-secondary);
}
.cd-unit {
  font-size: 13px;
  color: var(--el-text-color-secondary);
  margin-left: 4px;
}
.cd-title {
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.cd-date {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin-top: 4px;
}
.cd-del {
  position: absolute;
  top: 10px;
  right: 10px;
  color: var(--el-text-color-disabled);
}
.cd-del:hover {
  color: var(--el-color-danger);
}
.pomo-layout {
  display: flex;
  gap: 40px;
  align-items: center;
  flex-wrap: wrap;
}
.pomo-left {
  text-align: center;
}
/* 专注态舞台：占满内容区可视高度，钟表居中 */
.pomo-focus {
  min-height: min(620px, calc(100vh - 280px));
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
}
.pomo-focus .pomo-circle {
  width: 280px;
  height: 280px;
  margin: 0 0 8px;
}
.pomo-focus .pomo-time {
  font-size: 60px;
}
.pomo-focus-task {
  font-size: 14px;
  color: var(--el-text-color-secondary);
  margin-bottom: 12px;
}
/* 一镜到底：钟表 morph 慢起-中快-慢收（easeInOutCubic），收尾留足余韵 */
::view-transition-group(pomo-clock) {
  animation-duration: 0.9s;
  animation-timing-function: cubic-bezier(0.65, 0, 0.35, 1);
}
/* 旧/新帧的淡入淡出与飞行同速，避免钟表图在中途提前消失/出现 */
::view-transition-old(pomo-clock),
::view-transition-new(pomo-clock) {
  animation-duration: 0.9s;
  animation-timing-function: cubic-bezier(0.65, 0, 0.35, 1);
}
.pomo-circle {
  view-transition-name: pomo-clock; /* 新旧帧各一个同名元素，morph 出一镜到底 */
  width: 220px;
  height: 220px;
  border-radius: 50%;
  border: 8px solid var(--el-border-color);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  margin: 0 auto 16px;
}
.pomo-circle.running {
  border-color: var(--el-color-primary);
}
.pomo-circle.break {
  border-color: var(--el-color-success);
}
.pomo-time {
  font-size: 48px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--el-text-color-primary);
}
.pomo-mode {
  color: var(--el-text-color-secondary);
  font-size: 13px;
  margin-top: 6px;
}
.pomo-today {
  margin: 10px 0;
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.pomo-bars {
  display: flex;
  align-items: flex-end;
  gap: 6px;
  height: 110px;
}
.pomo-bar-col {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  height: 100%;
}
.pomo-bar {
  width: 18px;
  background: var(--el-color-primary);
  border-radius: var(--wb-radius-small) 3px 0 0;
  min-height: 2px;
}
.pomo-bar-label {
  font-size: 10px;
  color: var(--el-text-color-disabled);
  margin-top: 4px;
}
.form-tip {
  margin-left: 10px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
.chart-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  margin-bottom: 12px;
}
.chart-box {
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color);
  border-radius: var(--wb-radius-card);
  height: 260px;
}
.chart-empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--el-text-color-secondary);
  font-size: 13px;
  background: var(--el-bg-color);
}
.course-chart {
  height: auto;
  min-height: 220px;
  margin-bottom: 12px;
}
</style>
