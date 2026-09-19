<script setup lang="ts">
import type { Course, CourseSession, ReminderRule, Semester, SectionTime, WeekParity } from '@wb/shared'
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, Plus, Upload } from '@element-plus/icons-vue'
import { useRoute, useRouter } from 'vue-router'
import SectionPicker from '../components/SectionPicker.vue'
import PushChannelCard from '../components/PushChannelCard.vue'
import { del, get, post, put, upload } from '../api/http'

// ==================== 板块切换（由左侧主导航的「课表」折叠分组驱动）====================
const route = useRoute()
const router = useRouter()
const SCHEDULE_TABS = ['grid', 'remind'] as const

const activeTab = computed(() => {
  const tab = route.query.tab
  return typeof tab === 'string' && (SCHEDULE_TABS as readonly string[]).includes(tab) ? tab : SCHEDULE_TABS[0]
})

// ==================== 上课提醒 ====================
// 本板块承载两件事：① 提醒规则（提前多久 / 模板 / 走哪些通道）② 通道凭据（PushPlus / 企业微信 / 浏览器）。
// 两者放一起是因为「选了 pushplus 通道却没填 token」是最常见的失效原因，规则和凭据同屏才好排查。
// 「设置」页因此瘦身成纯个性化配置（外观 / 主题 / 语言 / 字号，且暂未生效）。
const reminderRules = ref<ReminderRule[]>([])
const savingRules = ref(false)

async function loadReminderRules() {
  const saved = await get<Record<string, unknown>>('/api/settings')
  reminderRules.value = (saved['notification.rules'] as ReminderRule[] | undefined) ?? []
}

async function saveReminderRules() {
  savingRules.value = true
  try {
    await put('/api/settings', { 'notification.rules': reminderRules.value })
    ElMessage.success('提醒规则已保存')
  } catch (e) {
    ElMessage.error(`保存失败：${(e as Error).message}`)
  } finally {
    savingRules.value = false
  }
}

function addRule() {
  reminderRules.value.push({
    minutesBefore: 20,
    template: '{minutes}分钟后 {课程} @ {教室} 开始上课',
    channels: ['browser'],
    enabled: false,
  })
}

function removeRule(index: number) {
  reminderRules.value.splice(index, 1)
}

const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
const SLOT_H = 66 // 行高 64 + 行距 2

interface CourseWithSessions extends Course {
  sessions: CourseSession[]
}
interface ScheduleData {
  courses: CourseWithSessions[]
  sessions: CourseSession[]
}
interface ReviewRow {
  name: string
  teacher: string
  room: string
  credit: number
  examType: string
  weekday: number
  startSection: number
  endSection: number
  weeks: number[]
  weeksText: string
  weekParity: WeekParity
  rawText: string
}
interface ParseResult {
  cells: {
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
    rawText: string
  }[]
  semesterNameHint: string | null
  diagnostics: { pageCount: number; columnsFound: number; sectionRowsFound: number; cellCount: number; warnings: string[] }
}

// ===== 状态 =====
const semesters = ref<Semester[]>([])
const currentSemesterId = ref<number | null>(null)
const schedule = ref<ScheduleData>({ courses: [], sessions: [] })
const currentWeek = ref(1)
const loading = ref(false)

const courseById = computed(() => new Map(schedule.value.courses.map((c) => [c.id, c])))
const currentSemester = computed(() => semesters.value.find((s) => s.id === currentSemesterId.value) ?? null)
const sectionTimes = computed<SectionTime[]>(() => currentSemester.value?.sectionTimes ?? [])
const totalWeeks = computed(() => currentSemester.value?.totalWeeks ?? 20)

const weekRange = computed(() => {
  if (!currentSemester.value) return ''
  const start = weekStart(currentWeek.value)
  const end = new Date(start)
  end.setDate(end.getDate() + 6)
  const fmt = (d: Date) => `${d.getMonth() + 1}/${d.getDate()}`
  return `${fmt(start)} ~ ${fmt(end)}`
})

function weekStart(week: number): Date {
  const start = new Date(currentSemester.value!.startDate + 'T00:00:00')
  start.setDate(start.getDate() + (week - 1) * 7)
  return start
}

// ===== 课表设置（学期信息 + 显示 + 背景 + 节次时间）=====
interface DisplaySettings {
  showWeekend: boolean
  daySections: number
  backgroundUrl: string
  mask: number
}

const display = reactive<DisplaySettings>({
  showWeekend: true,
  daySections: 12,
  backgroundUrl: '',
  mask: 0.72,
})

async function loadDisplaySettings() {
  // 注意：单键接口返回的是 { value: ... } 包装对象，不是设置本身。
  // 直接 Object.assign(display, 返回值) 只会塞进一个没用的 value 字段，
  // 真正的 showWeekend / backgroundUrl 等全都恢复不了（刷新后回落默认值）。
  const res = await get<{ value: Partial<DisplaySettings> | null }>('/api/settings/schedule.display')
  if (res?.value) Object.assign(display, res.value)
}

const visibleDays = computed(() => (display.showWeekend ? 7 : 5))
/** 网格行数：取「一天课程数」与本周实际课程结束节次的较大值，避免晚课被截断 */
const effectiveRows = computed(() => {
  let maxSection = 0
  for (const s of schedule.value.sessions) {
    if (weeksInclude(s.weeks, s.weekParity, currentWeek.value)) {
      maxSection = Math.max(maxSection, s.endSection)
    }
  }
  return Math.min(15, Math.max(display.daySections, maxSection, 1))
})

const settingsDialogVisible = ref(false)
const settingsForm = reactive({
  startDate: '',
  totalWeeks: 20,
  daySections: 12,
  showWeekend: true,
  backgroundUrl: '',
  mask: 0.72,
  sectionTimes: [] as SectionTime[],
})

function openSettings() {
  if (!currentSemester.value) return
  settingsForm.startDate = currentSemester.value.startDate
  settingsForm.totalWeeks = currentSemester.value.totalWeeks
  settingsForm.sectionTimes = currentSemester.value.sectionTimes.map((t) => ({ ...t }))
  settingsForm.showWeekend = display.showWeekend
  settingsForm.daySections = display.daySections
  settingsForm.backgroundUrl = display.backgroundUrl
  settingsForm.mask = display.mask
  settingsDialogVisible.value = true
}

/** 大学一节课 45 分钟：修改某节起始时间时，结束时间自动 +45 分钟 */
function onSectionStartChange(index: number, val: string | null) {
  if (!val) return
  const [h, m] = val.split(':').map(Number)
  const total = h * 60 + m + 45
  const eh = Math.floor(Math.min(total, 23 * 60 + 59) / 60)
  const em = Math.min(total, 23 * 60 + 59) % 60
  settingsForm.sectionTimes[index].end = `${String(eh).padStart(2, '0')}:${String(em).padStart(2, '0')}`
}

async function saveSettings() {
  if (!currentSemester.value) return
  if (!settingsForm.startDate) {
    ElMessage.warning('请选择开学时间（第一周周一）')
    return
  }
  if (settingsForm.sectionTimes.some((t) => !t.start || !t.end)) {
    ElMessage.warning('节次时间不完整')
    return
  }
  await put(`/api/semesters/${currentSemester.value.id}`, {
    startDate: settingsForm.startDate,
    totalWeeks: settingsForm.totalWeeks,
    sectionTimes: settingsForm.sectionTimes,
  })
  await put('/api/settings', {
    'schedule.display': {
      showWeekend: settingsForm.showWeekend,
      daySections: settingsForm.daySections,
      backgroundUrl: settingsForm.backgroundUrl,
      mask: settingsForm.mask,
    },
  })
  Object.assign(display, {
    showWeekend: settingsForm.showWeekend,
    daySections: settingsForm.daySections,
    backgroundUrl: settingsForm.backgroundUrl,
    mask: settingsForm.mask,
  })
  await loadSemesters()
  settingsDialogVisible.value = false
  guessCurrentWeek()
  ElMessage.success('课表设置已保存')
}

const bgUploading = ref(false)

async function onBgChange(file: { raw?: File }) {
  if (!file?.raw || bgUploading.value) return
  bgUploading.value = true
  try {
    const res = await upload<{ url: string }>('/api/upload/image', file.raw)
    // 上传成功立即保存生效（不依赖下方「保存」按钮），网格实时预览
    settingsForm.backgroundUrl = res.url
    await put('/api/settings', {
      'schedule.display': {
        showWeekend: settingsForm.showWeekend,
        daySections: settingsForm.daySections,
        backgroundUrl: res.url,
        mask: settingsForm.mask,
      },
    })
    display.backgroundUrl = res.url
    ElMessage.success('背景已更新')
  } catch (e) {
    ElMessage.error(`背景上传失败：${(e as Error).message}`)
  } finally {
    bgUploading.value = false
  }
}

// ===== 数据加载 =====
async function loadSemesters() {
  semesters.value = await get<Semester[]>('/api/semesters')
  if (!currentSemesterId.value && semesters.value.length) {
    currentSemesterId.value = semesters.value.find((s) => s.isCurrent)?.id ?? semesters.value[0].id
  }
}

async function loadSchedule() {
  if (!currentSemesterId.value) {
    schedule.value = { courses: [], sessions: [] }
    return
  }
  loading.value = true
  try {
    schedule.value = await get<ScheduleData>(`/api/schedule?semesterId=${currentSemesterId.value}`)
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  // 裸访问 /schedule 时补上默认板块，保证左侧导航有对应的高亮项
  if (!route.query.tab) void router.replace({ path: '/schedule', query: { tab: SCHEDULE_TABS[0] } })
  await loadDisplaySettings()
  await loadSemesters()
  await loadSchedule()
  guessCurrentWeek()
  await loadReminderRules()
})

// 切到提醒板块时重新拉一次，避免多标签页/多端编辑时看到旧规则
watch(activeTab, (tab) => {
  if (tab === 'remind') void loadReminderRules()
})

watch(currentSemesterId, () => {
  loadSchedule()
  guessCurrentWeek()
})

/** 按学期开始日期（第一周周一）推算的当前周次，clamp 到 1~totalWeeks */
const realWeek = computed<number | null>(() => {
  if (!currentSemester.value) return null
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const start = new Date(currentSemester.value.startDate + 'T00:00:00')
  const w = Math.floor((today.getTime() - start.getTime()) / 86400000 / 7) + 1
  return Math.min(Math.max(w, 1), totalWeeks.value)
})

function guessCurrentWeek() {
  if (realWeek.value == null) return
  currentWeek.value = realWeek.value
}

// ===== 周视图 =====
interface GridItem extends CourseSession {
  course: Course
}

const gridItems = computed<GridItem[][]>(() => {
  const cols: GridItem[][] = [[], [], [], [], [], [], []]
  for (const s of schedule.value.sessions) {
    const course = courseById.value.get(s.courseId)
    if (!course) continue
    if (!weeksInclude(s.weeks, s.weekParity, currentWeek.value)) continue
    cols[s.weekday - 1].push({ ...s, course })
  }
  for (const col of cols) col.sort((a, b) => a.startSection - b.startSection)
  return cols
})

/** 同一时段的冲突课程并排分栏：按"冲突簇"独立计算，只有互相重叠的课才分栏，避免无冲突课程被挤窄 */
const gridLayout = computed(() => {
  return gridItems.value.map((items) => {
    const sorted = [...items].sort((a, b) => a.startSection - b.startSection || a.endSection - b.endSection)
    // 1. 划分冲突簇：新课程与当前簇内任一课程时间重叠则并入，否则开新簇
    const clusters: GridItem[][] = []
    for (const it of sorted) {
      const last = clusters[clusters.length - 1]
      if (last && last.some((o) => o.endSection > it.startSection && o.startSection < it.endSection)) {
        last.push(it)
      } else {
        clusters.push([it])
      }
    }
    // 2. 簇内贪心分栏，宽度统一取该簇的总栏数
    const placed: { item: GridItem; lane: number; laneCount: number }[] = []
    for (const cluster of clusters) {
      const lanes: GridItem[][] = []
      const assign: { item: GridItem; lane: number }[] = []
      for (const it of cluster) {
        let lane = 0
        for (; lane < lanes.length; lane++) {
          if (lanes[lane].every((o) => o.endSection < it.startSection || o.startSection > it.endSection)) break
        }
        if (lane === lanes.length) lanes.push([])
        lanes[lane].push(it)
        assign.push({ item: it, lane })
      }
      for (const { item, lane } of assign) placed.push({ item, lane, laneCount: lanes.length })
    }
    return { placed }
  })
})

function weeksInclude(weeksJson: number[] | string, parity: WeekParity, week: number): boolean {
  const weeks = Array.isArray(weeksJson) ? weeksJson : JSON.parse(weeksJson)
  if (!weeks.includes(week)) return false
  if (parity === 'odd') return week % 2 === 1
  if (parity === 'even') return week % 2 === 0
  return true
}

function parseWeeksText(text: string): number[] {
  const out = new Set<number>()
  for (const part of text.split(/[,，]/)) {
    const m = part.trim().match(/^(\d+)(?:-(\d+))?$/)
    if (!m) continue
    const a = parseInt(m[1], 10)
    const b = m[2] ? parseInt(m[2], 10) : a
    for (let w = a; w <= b; w++) out.add(w)
  }
  return [...out].sort((x, y) => x - y)
}

function weeksText(weeksJson: number[] | string, parity: WeekParity): string {
  const weeks = Array.isArray(weeksJson) ? weeksJson : JSON.parse(weeksJson)
  const ranges: string[] = []
  let i = 0
  while (i < weeks.length) {
    let j = i
    while (j + 1 < weeks.length && weeks[j + 1] === weeks[j] + 1) j++
    ranges.push(i === j ? `${weeks[i]}` : `${weeks[i]}-${weeks[j]}`)
    i = j + 1
  }
  const t = ranges.join(',')
  return parity === 'odd' ? `${t}(单)` : parity === 'even' ? `${t}(双)` : t
}

function isTodayCol(dayIdx: number): boolean {
  if (!currentSemester.value) return false
  const start = weekStart(currentWeek.value)
  const d = new Date(start)
  d.setDate(d.getDate() + dayIdx)
  const now = new Date()
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
}

function cardStyle(item: GridItem, lane: number, laneCount: number): Record<string, string> {
  // 半透明白底保证任意背景图上的可读性，颜色靠边框和标题区分；冲突课程按栏并排
  const laneWidth = 100 / laneCount
  return {
    top: `${(item.startSection - 1) * SLOT_H + 2}px`,
    height: `${(item.endSection - item.startSection + 1) * SLOT_H - 8}px`,
    left: `calc(${(lane * laneWidth).toFixed(3)}% + 2px)`,
    width: `calc(${laneWidth.toFixed(3)}% - 4px)`,
    background: 'rgba(255, 255, 255, 0.78)',
    borderColor: item.course.color,
  }
}

function gridRowsStyle(): Record<string, string> {
  return { gridTemplateRows: `repeat(${effectiveRows.value}, 64px)` }
}

function gridVarsStyle(): Record<string, string> {
  // 格子不透明度越低，背景图透出越多
  return { '--cell-alpha': String(display.mask) }
}

const headGridStyle = computed<Record<string, string>>(() => ({
  gridTemplateColumns: `64px repeat(${visibleDays.value}, 1fr)`,
}))

// ===== 学期管理 =====
const semesterDialogVisible = ref(false)
const semesterForm = ref({ name: '', startDate: '', totalWeeks: 20 })

async function addSemester() {
  if (!semesterForm.value.name || !semesterForm.value.startDate) {
    ElMessage.warning('请填写学期名称与开始日期')
    return
  }
  const s = await post<Semester>('/api/semesters', semesterForm.value)
  await loadSemesters()
  currentSemesterId.value = s.id
  semesterDialogVisible.value = false
  ElMessage.success('学期已创建，接下来可导入课表 PDF')
}

async function activateSemester(s: Semester) {
  try {
    await post(`/api/semesters/${s.id}/activate`)
    await loadSemesters()
    ElMessage.success(`已设为当前学期：${s.name}`)
  } catch (e) {
    ElMessage.error((e as Error).message)
  }
}

async function removeSemester(s: Semester) {
  await ElMessageBox.confirm(`删除学期「${s.name}」及其全部课表数据？`, '确认', { type: 'warning' })
  try {
    await del(`/api/semesters/${s.id}`)
    if (currentSemesterId.value === s.id) currentSemesterId.value = null
    await loadSemesters()
    await loadSchedule()
    ElMessage.success(`已删除：${s.name}`)
  } catch (e) {
    ElMessage.error((e as Error).message)
  }
}

async function clearBackground() {
  settingsForm.backgroundUrl = ''
  try {
    await put('/api/settings', {
      'schedule.display': {
        showWeekend: settingsForm.showWeekend,
        daySections: settingsForm.daySections,
        backgroundUrl: '',
        mask: settingsForm.mask,
      },
    })
    display.backgroundUrl = ''
    ElMessage.success('背景已清除')
  } catch (e) {
    ElMessage.error((e as Error).message)
  }
}

// ===== 手动添加课程 =====
const addDialogVisible = ref(false)
const addForm = ref({
  name: '',
  teacher: '',
  room: '',
  weekday: 1,
  startSection: 1,
  endSection: 2,
  weeksText: '1-16',
  parity: 'all' as WeekParity,
  color: '',
})

function openAddCourse() {
  addForm.value = {
    name: '',
    teacher: '',
    room: '',
    weekday: ((new Date().getDay() + 6) % 7) + 1,
    startSection: 1,
    endSection: 2,
    weeksText: `1-${totalWeeks.value}`,
    parity: 'all',
    color: '',
  }
  addDialogVisible.value = true
}

async function saveAddCourse() {
  const f = addForm.value
  if (!f.name.trim()) {
    ElMessage.warning('请填写课程名称')
    return
  }
  const weeks = parseWeeksText(f.weeksText)
  if (!weeks.length) {
    ElMessage.warning('周次格式无效，示例：1-16 或 1-2,4-5,7-8')
    return
  }
  if (f.endSection < f.startSection) {
    ElMessage.warning('结束节次不能早于开始节次')
    return
  }
  await post('/api/schedule/import', {
    semesterId: currentSemesterId.value,
    replace: false,
    cells: [
      {
        name: f.name.trim(),
        teacher: f.teacher.trim(),
        room: f.room.trim(),
        credit: 0,
        examType: '',
        weekday: f.weekday,
        startSection: f.startSection,
        endSection: f.endSection,
        weeks,
        weekParity: f.parity,
        note: '',
        color: f.color || undefined,
      },
    ],
  })
  addDialogVisible.value = false
  await loadSchedule()
  ElMessage.success(`已添加课程：${f.name.trim()}`)
}

// ===== PDF 导入 =====
const importing = ref(false)
const reviewVisible = ref(false)
const parseResult = ref<ParseResult | null>(null)
const reviewRows = ref<ReviewRow[]>([])
const replaceExisting = ref(true)
const uploadRef = ref()

async function onPdfChange(file: { raw?: File }) {
  if (!file?.raw) return
  // 清空内部文件列表，保证重复选择同一文件也能再次触发
  uploadRef.value?.clearFiles()
  importing.value = true
  try {
    parseResult.value = await upload<ParseResult>('/api/import/pdf', file.raw)
    reviewRows.value = parseResult.value.cells.map((c) => ({
      ...c,
      weeksText: '',
    }))
    reviewVisible.value = true
    const d = parseResult.value.diagnostics
    if (d.warnings.length) ElMessage.warning(d.warnings.join('；'))
    else ElMessage.success(`解析完成：${d.cellCount} 个课程安排，请核对后导入`)
  } catch (e) {
    ElMessage.error(`解析失败：${(e as Error).message}`)
  } finally {
    importing.value = false
  }
}

function removeReviewRow(index: number) {
  reviewRows.value.splice(index, 1)
}

async function confirmImport() {
  if (!currentSemesterId.value) {
    ElMessage.warning('请先创建并选择学期')
    return
  }
  if (!reviewRows.value.length) {
    ElMessage.warning('没有可导入的课程')
    return
  }
  loading.value = true
  try {
    const res = await post<{ coursesAdded: number; sessionsAdded: number }>('/api/schedule/import', {
      semesterId: currentSemesterId.value,
      cells: reviewRows.value.map((r) => ({
        name: r.name,
        teacher: r.teacher,
        room: r.room,
        credit: r.credit,
        examType: r.examType,
        weekday: r.weekday,
        startSection: r.startSection,
        endSection: r.endSection,
        weeks: r.weeksText.trim() ? parseWeeksText(r.weeksText) : r.weeks,
        weekParity: r.weekParity,
        note: '',
      })),
      replace: replaceExisting.value,
    })
    reviewVisible.value = false
    await loadSchedule()
    ElMessage.success(`已导入 ${res.coursesAdded} 门课程、${res.sessionsAdded} 个安排`)
  } catch (e) {
    ElMessage.error(`导入失败：${(e as Error).message}`)
  } finally {
    loading.value = false
  }
}

// ===== 编辑排课 =====
const editDialogVisible = ref(false)
const editForm = ref({
  id: 0,
  courseId: 0,
  name: '',
  teacher: '',
  weekday: 1,
  startSection: 1,
  endSection: 2,
  weeksText: '',
  parity: 'all' as WeekParity,
  room: '',
})

function openEdit(item: GridItem) {
  editForm.value = {
    id: item.id,
    courseId: item.courseId,
    name: item.course.name,
    teacher: item.course.teacher,
    weekday: item.weekday,
    startSection: item.startSection,
    endSection: item.endSection,
    weeksText: weeksText(item.weeks, item.weekParity),
    parity: item.weekParity,
    room: item.room,
  }
  editDialogVisible.value = true
}

async function saveEdit() {
  const weeks = parseWeeksText(editForm.value.weeksText)
  if (!weeks.length) {
    ElMessage.warning('周次格式无效，示例：1-16 或 1-2,4-5,7-8')
    return
  }
  // 教师是课程级属性，单独更新课程
  await put(`/api/schedule/course/${editForm.value.courseId}`, { teacher: editForm.value.teacher.trim() })
  await put(`/api/schedule/session/${editForm.value.id}`, {
    weekday: editForm.value.weekday,
    startSection: editForm.value.startSection,
    endSection: editForm.value.endSection,
    weeks,
    weekParity: editForm.value.parity,
    room: editForm.value.room,
  })
  editDialogVisible.value = false
  await loadSchedule()
  ElMessage.success('已保存')
}

async function removeSession() {
  await ElMessageBox.confirm('删除这个课程安排？', '确认', { type: 'warning' })
  await del(`/api/schedule/session/${editForm.value.id}`)
  editDialogVisible.value = false
  await loadSchedule()
}
</script>

<template>
  <div class="page">
    <!-- ===== 课程表板块 ===== -->
    <div v-show="activeTab === 'grid'" class="tab-pane">
    <!-- 顶部工具栏 -->
    <div class="toolbar">
      <el-select v-model="currentSemesterId" placeholder="选择学期" style="width: 220px">
        <el-option v-for="s in semesters" :key="s.id" :value="s.id" :label="s.name">
          <span>{{ s.name }}</span>
          <el-tag v-if="s.isCurrent" size="small" type="success" style="margin-left: 8px">当前</el-tag>
        </el-option>
      </el-select>
      <el-button :icon="Plus" @click="semesterDialogVisible = true">新建学期</el-button>
      <el-button v-if="currentSemester" :icon="Plus" @click="openAddCourse">添加课程</el-button>
      <el-button v-if="currentSemester" @click="openSettings">课表设置</el-button>
      <el-divider direction="vertical" />
      <el-upload ref="uploadRef" :show-file-list="false" accept=".pdf" :auto-upload="false" :on-change="onPdfChange">
        <el-button type="primary" :icon="Upload" :loading="importing" :disabled="!currentSemesterId">导入课表 PDF</el-button>
      </el-upload>
    </div>

    <!-- 学期信息条 -->
    <div v-if="currentSemester" class="semester-bar">
      <span>{{ currentSemester.name }}</span>
      <el-tag size="small">第一周周一：{{ currentSemester.startDate }}</el-tag>
      <el-button size="small" text type="primary" @click="activateSemester(currentSemester)">设为当前学期</el-button>
      <el-button size="small" text type="danger" @click="removeSemester(currentSemester)">删除学期</el-button>
    </div>

    <!-- 周选择 -->
    <div v-if="currentSemester" class="week-bar">
      <el-button-group>
        <el-button :disabled="currentWeek <= 1" @click="currentWeek--">上一周</el-button>
        <el-button :disabled="currentWeek >= totalWeeks" @click="currentWeek++">下一周</el-button>
      </el-button-group>
      <el-tooltip content="跳回今天所在的这一周">
        <el-button class="back-today" :disabled="currentWeek === realWeek" @click="guessCurrentWeek">回到本周</el-button>
      </el-tooltip>
      <el-select v-model="currentWeek" style="width: 130px; margin-left: 12px">
        <el-option v-for="w in totalWeeks" :key="w" :value="w" :label="`第 ${w} 周`" />
      </el-select>
      <span class="week-range">{{ weekRange }}</span>
      <span v-if="!schedule.sessions.length" class="hint">该学期还没有课表，点上方「导入课表 PDF」</span>
    </div>

    <!-- 周视图网格 -->
    <div v-if="currentSemester" v-loading="loading" class="grid-wrap">
      <div class="grid" :style="gridVarsStyle()">
        <div
          v-if="display.backgroundUrl"
          class="grid-bg"
          :style="{ backgroundImage: `url(${display.backgroundUrl})` }"
        />
        <div class="grid-head" :style="headGridStyle">
          <div class="head-cell label-cell">节次</div>
          <div v-for="i in visibleDays" :key="i" class="head-cell" :class="{ today: isTodayCol(i - 1) }">
            {{ WEEKDAYS[i - 1] }}
          </div>
        </div>
        <div class="grid-body" :style="headGridStyle">
          <div class="section-col" :style="gridRowsStyle()">
            <div v-for="i in effectiveRows" :key="i" class="section-cell">
              <div class="sec-no">{{ i }}</div>
              <div v-if="sectionTimes[i - 1]" class="sec-time">
                {{ sectionTimes[i - 1].start }}<br />{{ sectionTimes[i - 1].end }}
              </div>
            </div>
          </div>
          <div
            v-for="(day, dayIdx) in gridLayout.slice(0, visibleDays)"
            :key="dayIdx"
            class="day-col"
            :class="{ today: isTodayCol(dayIdx) }"
            :style="gridRowsStyle()"
          >
            <div v-for="i in effectiveRows" :key="i" class="slot-cell" />
            <div
              v-for="{ item, lane, laneCount } in day.placed"
              :key="item.id"
              class="course-card"
              :style="cardStyle(item, lane, laneCount)"
              :title="`${item.course.name}\n${item.room}\n${item.course.teacher}\n${weeksText(item.weeks, item.weekParity)}周`"
              @click="openEdit(item)"
            >
              <div class="course-name" :style="{ color: item.course.color }">{{ item.course.name }}</div>
              <div class="course-room">{{ item.room }}</div>
              <div v-if="item.course.teacher" class="course-teacher">{{ item.course.teacher }}</div>
              <div v-if="item.weekParity !== 'all'" class="course-parity">
                {{ item.weekParity === 'odd' ? '单周' : '双周' }}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <el-empty v-if="!semesters.length" description="还没有学期，先点「新建学期」，填上名字和第一周的周一日期" />
    </div>

    <!-- ===== 上课提醒板块 ===== -->
    <div v-show="activeTab === 'remind'" class="tab-pane">
      <el-card>
        <template #header>
          <div class="card-head">
            <span>上课提醒规则</span>
            <el-button size="small" :icon="Plus" @click="addRule">添加规则</el-button>
          </div>
        </template>
        <el-alert
          type="info"
          :closable="false"
          show-icon
          class="remind-tip"
          title="设置提前多久提醒、用哪些方式提醒；推送账号（PushPlus、企业微信）在下面的「推送通道」里填。"
        />
        <div v-for="(rule, i) in reminderRules" :key="i" class="rule-row">
          <div class="rule-line">
            <span class="rule-label">课前</span>
            <el-input-number v-model="rule.minutesBefore" :min="1" :max="120" size="small" controls-position="right" />
            <span class="rule-label">分钟提醒</span>
            <el-switch v-model="rule.enabled" active-text="启用" />
            <el-button size="small" type="danger" text :icon="Delete" @click="removeRule(i)" />
          </div>
          <div class="rule-line">
            <el-input v-model="rule.template" size="small" placeholder="提醒内容，可用变量：{课程} {教室} {教师} {时间} {minutes}" />
          </div>
          <div class="rule-line">
            <span class="rule-label">通道：</span>
            <el-checkbox-group v-model="rule.channels" size="small">
              <el-checkbox-button value="browser">浏览器通知</el-checkbox-button>
              <el-checkbox-button value="pushplus">PushPlus（微信）</el-checkbox-button>
              <el-checkbox-button value="wecom">企业微信</el-checkbox-button>
            </el-checkbox-group>
          </div>
          <el-divider style="margin: 10px 0" />
        </div>
        <el-empty v-if="!reminderRules.length" description="暂无提醒规则" :image-size="60" />
        <div class="remind-actions">
          <el-button type="primary" :loading="savingRules" @click="saveReminderRules">保存提醒规则</el-button>
          <span class="form-tip">保存后会自动检查时间，按上面的设置提前提醒</span>
        </div>
      </el-card>

      <!-- 通道凭据：从「设置」页搬来，与规则同屏，方便排查"选了通道但没填凭据"导致的不发送 -->
      <PushChannelCard />
    </div>

    <!-- 新建学期 -->
    <el-dialog v-model="semesterDialogVisible" title="新建学期" width="420px">
      <el-form label-width="110px">
        <el-form-item label="学期名称">
          <el-input v-model="semesterForm.name" placeholder="如：2026-2027第1学期" />
        </el-form-item>
        <el-form-item label="第一周周一">
          <el-date-picker v-model="semesterForm.startDate" type="date" value-format="YYYY-MM-DD" placeholder="开学第一周的周一" style="width: 100%" />
        </el-form-item>
        <el-form-item label="总周数">
          <el-input-number v-model="semesterForm.totalWeeks" :min="10" :max="30" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="semesterDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="addSemester">创建</el-button>
      </template>
    </el-dialog>

    <!-- 课表设置 -->
    <el-dialog v-model="settingsDialogVisible" title="课表设置" width="560px" top="4vh">
      <el-divider content-position="left">学期</el-divider>
      <el-form label-width="100px">
        <el-form-item label="开学时间">
          <el-date-picker
            v-model="settingsForm.startDate"
            type="date"
            value-format="YYYY-MM-DD"
            placeholder="第一周周一的日期"
            style="width: 200px"
          />
          <span class="form-tip">填第一周的周一，用来推算现在是第几周</span>
        </el-form-item>
        <el-form-item label="学期周数">
          <el-input-number v-model="settingsForm.totalWeeks" :min="10" :max="30" />
        </el-form-item>
      </el-form>

      <el-divider content-position="left">显示</el-divider>
      <el-form label-width="100px">
        <el-form-item label="一天课程数">
          <el-input-number v-model="settingsForm.daySections" :min="4" :max="15" />
          <span class="form-tip">课表显示到第几节，有更晚的课会自动加上</span>
        </el-form-item>
        <el-form-item label="显示周末">
          <el-switch v-model="settingsForm.showWeekend" active-text="周六日" />
        </el-form-item>
        <el-form-item label="背景图片">
          <el-upload :show-file-list="false" accept="image/png,image/jpeg,image/webp,image/gif" :auto-upload="false" :on-change="onBgChange">
            <el-button size="small" :loading="bgUploading">{{ settingsForm.backgroundUrl ? '更换图片' : '选择图片' }}</el-button>
          </el-upload>
          <el-button v-if="settingsForm.backgroundUrl" size="small" text type="danger" @click="clearBackground">清除</el-button>
          <span v-if="settingsForm.backgroundUrl" class="form-tip">选择后立即生效</span>
        </el-form-item>
        <el-form-item v-if="settingsForm.backgroundUrl" label="格子不透明度">
          <el-slider v-model="settingsForm.mask" :min="0.05" :max="0.95" :step="0.05" style="width: 240px" />
          <span class="form-tip">数值越小背景图越明显，越大文字越清楚（保存后生效）</span>
        </el-form-item>
      </el-form>

      <el-divider content-position="left">节次时间</el-divider>
      <el-scrollbar max-height="240px">
        <div class="section-time-grid">
          <div v-for="(t, i) in settingsForm.sectionTimes" :key="i" class="section-time-row">
            <span class="sec-label">第 {{ i + 1 }} 节</span>
            <el-time-picker
              v-model="t.start"
              format="HH:mm"
              value-format="HH:mm"
              style="width: 105px"
              placeholder="开始"
              @change="onSectionStartChange(i, $event as string | null)"
            />
            <span>~</span>
            <el-time-picker v-model="t.end" format="HH:mm" value-format="HH:mm" style="width: 105px" placeholder="结束" />
          </div>
        </div>
      </el-scrollbar>

      <template #footer>
        <el-button @click="settingsDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="saveSettings">保存</el-button>
      </template>
    </el-dialog>

    <!-- 导入校对 -->
    <el-dialog v-model="reviewVisible" title="校对解析结果" width="1100px" top="4vh">
      <div v-if="parseResult" class="parse-meta">
        共 {{ parseResult.diagnostics.cellCount }} 个安排 · {{ parseResult.diagnostics.columnsFound }} 列 ·
        {{ parseResult.diagnostics.sectionRowsFound }} 个节次行 · {{ parseResult.diagnostics.pageCount }} 页
        <span v-if="parseResult.semesterNameHint"> · 识别学期：{{ parseResult.semesterNameHint }}</span>
      </div>
      <el-table :data="reviewRows" size="small" max-height="55vh">
        <el-table-column label="星期" width="90">
          <template #default="{ row }">
            <el-select v-model="row.weekday" size="small">
              <el-option v-for="(d, i) in WEEKDAYS" :key="i" :value="i + 1" :label="d" />
            </el-select>
          </template>
        </el-table-column>
        <el-table-column label="节次" width="80">
          <template #default="{ row }">{{ row.startSection }}-{{ row.endSection }}节</template>
        </el-table-column>
        <el-table-column label="课程" min-width="150">
          <template #default="{ row }">
            <el-input v-model="row.name" size="small" />
          </template>
        </el-table-column>
        <el-table-column label="教师" width="100">
          <template #default="{ row }">
            <el-input v-model="row.teacher" size="small" />
          </template>
        </el-table-column>
        <el-table-column label="教室" min-width="120">
          <template #default="{ row }">
            <el-input v-model="row.room" size="small" />
          </template>
        </el-table-column>
        <el-table-column label="周次" width="160">
          <template #default="{ row }">
            <el-input v-model="row.weeksText" size="small" :placeholder="weeksText(row.weeks, 'all')" />
          </template>
        </el-table-column>
        <el-table-column label="单双周" width="90">
          <template #default="{ row }">
            <el-select v-model="row.weekParity" size="small">
              <el-option value="all" label="每周" />
              <el-option value="odd" label="单周" />
              <el-option value="even" label="双周" />
            </el-select>
          </template>
        </el-table-column>
        <el-table-column label="原文" width="70">
          <template #default="{ row }">
            <el-tooltip placement="left" :content="row.rawText?.replace(/\n/g, ' ')">
              <el-button size="small" text>查看</el-button>
            </el-tooltip>
          </template>
        </el-table-column>
        <el-table-column width="60">
          <template #default="{ $index }">
            <el-button size="small" type="danger" text :icon="Delete" @click="removeReviewRow($index)" />
          </template>
        </el-table-column>
      </el-table>
      <div style="margin-top: 12px">
        <el-checkbox v-model="replaceExisting">导入时清空该学期已有课程（替换）</el-checkbox>
      </div>
      <template #footer>
        <el-button @click="reviewVisible = false">取消</el-button>
        <el-button type="primary" @click="confirmImport">确认导入（{{ reviewRows.length }}）</el-button>
      </template>
    </el-dialog>

    <!-- 手动添加课程 -->
    <el-dialog v-model="addDialogVisible" title="添加课程" width="460px">
      <el-form label-width="80px">
        <el-form-item label="课程名">
          <el-input v-model="addForm.name" placeholder="必填" />
        </el-form-item>
        <el-form-item label="教师">
          <el-input v-model="addForm.teacher" />
        </el-form-item>
        <el-form-item label="教室">
          <el-input v-model="addForm.room" />
        </el-form-item>
        <el-form-item label="星期">
          <el-select v-model="addForm.weekday" style="width: 110px">
            <el-option v-for="(d, i) in WEEKDAYS" :key="i" :value="i + 1" :label="d" />
          </el-select>
        </el-form-item>
        <el-form-item label="节次">
          <SectionPicker v-model:start="addForm.startSection" v-model:end="addForm.endSection" :count="Math.max(sectionTimes.length, 12)" />
        </el-form-item>
        <el-form-item label="周次">
          <el-input v-model="addForm.weeksText" placeholder="如 1-16 或 1-2,4-5,7-8" />
        </el-form-item>
        <el-form-item label="单双周">
          <el-radio-group v-model="addForm.parity">
            <el-radio value="all">每周</el-radio>
            <el-radio value="odd">单周</el-radio>
            <el-radio value="even">双周</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="颜色">
          <el-color-picker v-model="addForm.color" :predefine="[
            '#409eff', '#67c23a', '#e6a23c', '#f56c6c', '#9c68ec',
            '#00b8a9', '#f6416c', '#3f72af', '#ff9f43', '#6c5ce7',
          ]" />
          <span class="form-tip">留空则自动分配</span>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="addDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="saveAddCourse">添加</el-button>
      </template>
    </el-dialog>

    <!-- 编辑排课 -->
    <el-dialog v-model="editDialogVisible" :title="`编辑：${editForm.name}`" width="440px">
      <el-form label-width="80px">
        <el-form-item label="教师">
          <el-input v-model="editForm.teacher" placeholder="授课教师" />
        </el-form-item>
        <el-form-item label="星期">
          <el-select v-model="editForm.weekday">
            <el-option v-for="(d, i) in WEEKDAYS" :key="i" :value="i + 1" :label="d" />
          </el-select>
        </el-form-item>
        <el-form-item label="节次">
          <SectionPicker v-model:start="editForm.startSection" v-model:end="editForm.endSection" :count="Math.max(sectionTimes.length, 12)" />
        </el-form-item>
        <el-form-item label="周次">
          <el-input v-model="editForm.weeksText" placeholder="如 1-16 或 1-2,4-5,7-8" />
        </el-form-item>
        <el-form-item label="单双周">
          <el-radio-group v-model="editForm.parity">
            <el-radio value="all">每周</el-radio>
            <el-radio value="odd">单周</el-radio>
            <el-radio value="even">双周</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="教室">
          <el-input v-model="editForm.room" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button type="danger" text @click="removeSession">删除安排</el-button>
        <el-button @click="editDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="saveEdit">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
/* 板块容器：与 .page 同款 flex+gap，包裹后才不会破坏内部的垂直间距 */
.tab-pane {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.card-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.remind-tip {
  margin-bottom: 14px;
}
.rule-row {
  margin-bottom: 4px;
}
.rule-line {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
  flex-wrap: wrap;
}
.rule-label {
  color: var(--el-text-color-regular);
  font-size: 13px;
}
.remind-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-top: 8px;
}
.toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.semester-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--el-text-color-primary);
  font-weight: 500;
}
.week-bar {
  display: flex;
  align-items: center;
}
.back-today {
  margin-left: 12px;
}
.week-range {
  margin-left: 12px;
  color: var(--el-text-color-regular);
}
.hint {
  margin-left: 16px;
  color: var(--el-text-color-secondary);
}
.grid-wrap {
  overflow-x: auto;
}
.grid {
  min-width: 860px;
  position: relative;
}
.grid-bg {
  position: absolute;
  inset: 0;
  background-size: cover;
  background-position: center;
  border-radius: var(--wb-radius-card);
}
.grid-head,
.grid-body {
  position: relative;
  z-index: 1;
}
.grid-head {
  display: grid;
  gap: 4px;
  margin-bottom: 4px;
}
.head-cell {
  background: rgba(255, 255, 255, var(--cell-alpha, 0.85));
  border-radius: var(--wb-radius-base);
  padding: 8px 0;
  text-align: center;
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.head-cell.today {
  background: var(--el-color-primary);
  color: #fff;
}
.grid-body {
  display: grid;
  gap: 4px;
}
.section-col,
.day-col {
  position: relative;
  display: grid;
  gap: 2px;
}
.section-cell,
.slot-cell {
  background: rgba(255, 255, 255, var(--cell-alpha, 0.85));
  border-radius: var(--wb-radius-small);
  min-height: 62px;
}
.section-cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.sec-no {
  font-weight: 600;
  color: var(--el-text-color-regular);
}
.day-col.today .slot-cell {
  background: rgba(236, 245, 255, var(--cell-alpha, 0.85));
}
.course-card {
  position: absolute;
  left: 2px;
  right: 2px;
  border: 1.5px solid;
  border-radius: var(--wb-radius-card);
  padding: 6px 8px;
  cursor: pointer;
  overflow: hidden;
  z-index: 1;
  box-sizing: border-box;
}
.course-name {
  font-size: 13px;
  font-weight: 600;
  line-height: 1.3;
}
.course-room {
  font-size: 12px;
  font-weight: 500;
  color: var(--el-text-color-primary);
  margin-top: 3px;
  line-height: 1.4;
  word-break: break-all;
}
.course-teacher {
  font-size: 11px;
  color: var(--el-text-color-secondary);
  margin-top: 1px;
}
.course-parity {
  font-size: 10px;
  color: var(--el-text-color-secondary);
}
.parse-meta {
  color: var(--el-text-color-secondary);
  margin-bottom: 10px;
}
.section-time-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  column-gap: 24px;
}
.section-time-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.sec-label {
  width: 52px;
  color: var(--el-text-color-regular);
  font-size: 13px;
  flex-shrink: 0;
  white-space: nowrap;
}
.form-tip {
  margin-left: 10px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
</style>
