<script setup lang="ts">
import { termOf, type Semester } from '@wb/shared'
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, Refresh } from '@element-plus/icons-vue'
import { del, get, post, put } from '../api/http'

interface Homework {
  id: number
  courseName: string
  title: string
  deadline: string | null
  url: string
  status: string
  /** 开课时间（用于推断学期；退课/已结束的课程没有） */
  courseStart: string | null
  syncedAt: string
  remindedAt: string | null
}

interface ChaoxingStatus {
  hasCookie: boolean
  uid: string | null
  total: number
  lastSync: string | null
}

// ===== 状态 =====
const loading = ref(true)
const status = ref<ChaoxingStatus | null>(null)
const homework = ref<Homework[]>([])
const cookieInput = ref('')
const savingCookie = ref(false)
const syncing = ref(false)
const filterCourse = ref('全部')
const filterStatus = ref<'进行中' | '已提交' | '全部'>('进行中')
const semesterFilter = ref<'current' | 'all'>('current')
/** 本学期课表里的课程名（学期筛选用） */
const currentCourseNames = ref<Set<string>>(new Set())
/** 当前学期的学期标签（与 termOf 同口径，用于课程分组） */
const currentTerm = ref<string | null>(null)
const semesterRange = ref<{ start: string; end: string } | null>(null)

// 提醒设置
const remindBefore = ref<number[]>([])
const channels = ref<string[]>(['browser'])
const autoSyncMin = ref(0)
const savingSettings = ref(false)

const REMIND_OPTIONS = [
  { value: 1440, label: '提前 1 天' },
  { value: 720, label: '提前 12 小时' },
  { value: 360, label: '提前 6 小时' },
  { value: 60, label: '提前 1 小时' },
]
const CHANNEL_OPTIONS = [
  { value: 'browser', label: '浏览器通知' },
  { value: 'pushplus', label: 'PushPlus（微信）' },
  { value: 'wecom', label: '企业微信' },
]
const AUTO_SYNC_OPTIONS = [
  { value: 0, label: '关闭（仅手动同步）' },
  { value: 30, label: '每 30 分钟' },
  { value: 60, label: '每 1 小时' },
  { value: 180, label: '每 3 小时' },
]

/**
 * 课程下拉的分组：本学期 / 其他学期。
 * 判据与首页一致 —— 用作业所属课程的**开课时间**推断学期，不用课程名匹配
 * （课表「大学体育(3)」vs 学习通「大学体育(3)-2026-2027-1排球」，精确匹配只命中 2/11 门课）。
 * 退课 / 已结束的课程没有开课时间，一律归入「其他学期」。
 */
const courseGroups = computed(() => {
  const termOfCourse = new Map<string, Set<string>>()
  for (const h of homework.value) {
    const set = termOfCourse.get(h.courseName) ?? new Set<string>()
    const t = termOf(h.courseStart)
    if (t) set.add(t)
    termOfCourse.set(h.courseName, set)
  }
  const cur: string[] = []
  const other: string[] = []
  for (const [name, terms] of termOfCourse) {
    if (currentTerm.value && terms.has(currentTerm.value)) cur.push(name)
    else other.push(name)
  }
  // 中文按拼音排序，下拉里找课更快
  const byName = new Intl.Collator('zh-Hans-CN').compare
  const groups = [
    { label: `本学期${currentTerm.value ? `（${currentTerm.value}）` : ''}`, items: cur.sort(byName) },
    { label: '其他学期 / 已结束', items: other.sort(byName) },
  ]
  // 没有学期信息时不分错组，退回平铺
  if (!currentTerm.value) return [{ label: '课程', items: [...termOfCourse.keys()].sort(byName) }]
  return groups.filter((g) => g.items.length)
})
const filtered = computed(() =>
  homework.value.filter((h) => {
    if (filterCourse.value !== '全部' && h.courseName !== filterCourse.value) return false
    if (filterStatus.value !== '全部' && h.status !== filterStatus.value) return false
    if (semesterFilter.value === 'current' && currentCourseNames.value.size) {
      const nameMatch = currentCourseNames.value.has(h.courseName)
      const dlInSemester =
        !!h.deadline &&
        !!semesterRange.value &&
        h.deadline.slice(0, 10) >= semesterRange.value.start &&
        h.deadline.slice(0, 10) <= semesterRange.value.end
      if (!nameMatch && !dlInSemester) return false
    }
    return true
  }),
)

function deadlineInfo(h: Homework): { text: string; type: 'danger' | 'warning' | 'info' | 'success' } {
  if (!h.deadline) return { text: '无截止时间', type: 'info' }
  const dl = new Date(h.deadline.replace(' ', 'T')).getTime()
  if (Number.isNaN(dl)) return { text: h.deadline, type: 'info' }
  const diff = dl - Date.now()
  if (diff <= 0) return { text: `已截止（${h.deadline}）`, type: 'info' }
  const hours = diff / 3600000
  const text = `剩余 ${hours >= 24 ? `${Math.floor(hours / 24)} 天 ${Math.round(hours % 24)} 小时` : `${Math.round(hours)} 小时`} · ${h.deadline}`
  if (hours <= 6) return { text, type: 'danger' }
  if (hours <= 24) return { text, type: 'warning' }
  return { text, type: 'success' }
}

// ===== 数据加载 =====
async function loadSemesterInfo() {
  const sems = await get<Semester[]>('/api/semesters')
  const cur = sems.find((s) => s.isCurrent) ?? sems[0]
  if (!cur) return
  const sched = await get<{ courses: { name: string }[] }>(`/api/schedule?semesterId=${cur.id}`)
  currentCourseNames.value = new Set(sched.courses.map((c) => c.name))
  currentTerm.value = termOf(cur.startDate)
  const start = new Date(cur.startDate + 'T00:00:00')
  const end = new Date(start)
  end.setDate(end.getDate() + cur.totalWeeks * 7)
  const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  semesterRange.value = { start: cur.startDate, end: fmt(end) }
}

async function loadAll() {
  loading.value = true
  try {
    status.value = await get<ChaoxingStatus>('/api/chaoxing/status')
    homework.value = await get<Homework[]>('/api/chaoxing/homework')
    const settings = await get<Record<string, any>>('/api/settings')
    remindBefore.value = settings['chaoxing.remindBefore'] ?? [1440, 360]
    channels.value = settings['chaoxing.channels'] ?? ['browser']
    autoSyncMin.value = settings['chaoxing.autoSyncMin'] ?? 0
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  void loadSemesterInfo()
  void loadAll()
})

// ===== 操作 =====
async function saveCookie() {
  if (!cookieInput.value.trim()) {
    ElMessage.warning('请先粘贴 Cookie')
    return
  }
  savingCookie.value = true
  try {
    const r = await post<{ ok: boolean; detail: string; uid?: string }>('/api/chaoxing/cookie', { cookie: cookieInput.value })
    if (r.ok) {
      ElMessage.success(`Cookie 已保存（${r.detail}）`)
      cookieInput.value = ''
      await loadAll()
    } else {
      ElMessage.error(r.detail)
    }
  } finally {
    savingCookie.value = false
  }
}

async function removeCookie() {
  await ElMessageBox.confirm('删除已保存的 Cookie？作业数据会保留。', '确认', { type: 'warning' })
  await del('/api/chaoxing/cookie')
  await loadAll()
  ElMessage.success('Cookie 已删除')
}

async function sync() {
  syncing.value = true
  try {
    const r = await post<{ ok: boolean; detail: string; total: number }>('/api/chaoxing/sync')
    if (r.ok) ElMessage.success(r.detail)
    else ElMessage.error(r.detail)
    await loadAll()
  } finally {
    syncing.value = false
  }
}

async function saveRemindSettings() {
  savingSettings.value = true
  try {
    // 必须是 PUT：服务端只注册了 PUT /api/settings，用 POST 会 404，
    // 而这里原本是 try/finally 无 catch，失败时连报错都不弹，设置静默丢失。
    await put('/api/settings', {
      'chaoxing.remindBefore': remindBefore.value,
      'chaoxing.channels': channels.value,
      'chaoxing.autoSyncMin': autoSyncMin.value,
    })
    ElMessage.success('提醒设置已保存')
  } catch (e) {
    ElMessage.error(`保存失败：${(e as Error).message}`)
  } finally {
    savingSettings.value = false
  }
}

function openUrl(url: string) {
  window.open(url, '_blank')
}

async function removeHomework(h: Homework) {
  await ElMessageBox.confirm(`删除这条作业记录？\n${h.courseName}《${h.title}》`, '确认', { type: 'warning' })
  await del(`/api/chaoxing/homework/${h.id}`)
  await loadAll()
}
</script>

<template>
  <div v-loading="loading" class="page">
    <!-- Cookie 配置 -->
    <el-card>
      <template #header>
        <div class="card-head">
          <span>学习通账号</span>
          <el-tag v-if="status?.hasCookie" type="success" size="small">已配置 UID:{{ status.uid }}</el-tag>
          <el-tag v-else type="info" size="small">未配置</el-tag>
        </div>
      </template>
      <template v-if="!status?.hasCookie">
        <ol class="steps">
          <li>用电脑浏览器打开 <a href="https://i.chaoxing.com" target="_blank">i.chaoxing.com</a> 并登录（学习通网页版）</li>
          <li>按 F12 打开开发者工具，切到「网络 / Network」标签，刷新页面后点列表里的第一个请求，找到 <b>Cookie</b> 那一行，把后面的整串值复制下来</li>
          <li>粘贴到下面保存。它只存在你自己的电脑上，不会发给任何第三方</li>
        </ol>
        <div class="cookie-row">
          <el-input v-model="cookieInput" type="textarea" :rows="3" placeholder="把复制到的整串内容粘贴到这里" />
          <el-button type="primary" :loading="savingCookie" @click="saveCookie">保存并验证</el-button>
        </div>
      </template>
      <template v-else>
        <div class="status-row">
          <span v-if="status.lastSync">上次同步：{{ status.lastSync }}</span>
          <span>共 {{ status.total }} 条作业</span>
          <el-button type="primary" :icon="Refresh" :loading="syncing" @click="sync">立即同步</el-button>
          <el-button text type="danger" @click="removeCookie">删除 Cookie</el-button>
        </div>
      </template>
    </el-card>

    <!-- 提醒设置 -->
    <el-card>
      <template #header>截止提醒</template>
      <el-form label-width="100px">
        <el-form-item label="提前提醒">
          <el-checkbox-group v-model="remindBefore">
            <el-checkbox-button v-for="o in REMIND_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</el-checkbox-button>
          </el-checkbox-group>
        </el-form-item>
        <el-form-item label="提醒通道">
          <el-checkbox-group v-model="channels">
            <el-checkbox-button v-for="o in CHANNEL_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</el-checkbox-button>
          </el-checkbox-group>
        </el-form-item>
        <el-form-item label="自动同步">
          <el-select v-model="autoSyncMin" style="width: 200px">
            <el-option v-for="o in AUTO_SYNC_OPTIONS" :key="o.value" :value="o.value" :label="o.label" />
          </el-select>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" :loading="savingSettings" @click="saveRemindSettings">保存提醒设置</el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <!-- 作业列表 -->
    <el-card>
      <template #header>
        <div class="card-head">
          <span>
            作业列表
            <el-radio-group v-model="filterStatus" size="small" style="margin-left: 12px">
              <el-radio-button value="进行中">未提交</el-radio-button>
              <el-radio-button value="已提交">已提交</el-radio-button>
              <el-radio-button value="全部">全部</el-radio-button>
            </el-radio-group>
            <el-radio-group v-model="semesterFilter" size="small" style="margin-left: 8px">
              <el-radio-button value="current">本学期</el-radio-button>
              <el-radio-button value="all">全部学期</el-radio-button>
            </el-radio-group>
          </span>
          <el-select v-model="filterCourse" size="small" style="width: 220px">
            <!-- 「全部」独立在分组之外，分组按开课时间推断的学期划分 -->
            <el-option label="全部课程" value="全部" />
            <el-option-group v-for="g in courseGroups" :key="g.label" :label="g.label">
              <el-option v-for="c in g.items" :key="c" :value="c" :label="c" />
            </el-option-group>
          </el-select>
        </div>
      </template>
      <el-empty
        v-if="!filtered.length"
        :description="filterStatus === '进行中' ? '没有未提交的作业，太棒了 🎉' : '当前筛选条件下没有作业'"
      />
      <div v-else class="hw-list">
        <div v-for="h in filtered" :key="h.id" class="hw-item">
          <div class="hw-main">
            <div class="hw-title">
              <el-tag size="small" type="info">{{ h.courseName }}</el-tag>
              <span>{{ h.title }}</span>
              <el-tag v-if="h.status === '已提交'" size="small" type="success">已提交</el-tag>
            </div>
            <div class="hw-deadline">
              <el-tag :type="deadlineInfo(h).type" size="small" effect="plain">{{ deadlineInfo(h).text }}</el-tag>
            </div>
          </div>
          <div class="hw-actions">
            <el-button v-if="h.url" size="small" text type="primary" @click="openUrl(h.url)">打开作业</el-button>
            <el-button size="small" text type="danger" :icon="Delete" @click="removeHomework(h)" />
          </div>
        </div>
      </div>
    </el-card>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 980px;
}
.card-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
}
.steps {
  margin: 0 0 12px 18px;
  color: var(--el-text-color-regular);
  font-size: 13px;
  line-height: 2;
}
.cookie-row {
  display: flex;
  gap: 10px;
  align-items: flex-start;
}
.status-row {
  display: flex;
  align-items: center;
  gap: 16px;
  color: var(--el-text-color-regular);
  font-size: 13px;
}
.hw-list {
  display: flex;
  flex-direction: column;
}
.hw-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 10px 4px;
  border-bottom: 1px solid var(--el-fill-color);
}
.hw-title {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.hw-deadline {
  margin-top: 4px;
}
.hw-actions {
  display: flex;
  align-items: center;
  flex-shrink: 0;
}
</style>
