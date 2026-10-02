import { computed, ref } from 'vue'
import { ElMessage, ElNotification } from 'element-plus'
import { get, post } from '../api/http'

interface PomodoroData {
  todayMin: number
  daily: { date: string; minutes: number }[]
  recent: { id: number; taskLabel: string; courseTag: string; startedAt: string; durationMin: number }[]
}
export const pomoData = ref<PomodoroData | null>(null)
export const pomoRunning = ref(false)
export const pomoPaused = ref(false)
export const pomoMode = ref<'work' | 'break'>('work')
export const pomoRemain = ref(25 * 60)
export const pomoWorkMin = ref(25)
export const pomoBreakMin = ref(5)
export const pomoTask = ref('')
export const pomoTag = ref('')
let startedAt = ''
let deadline = 0
let pausedMs = 0
let timer: number | undefined
const STORAGE_KEY = 'wb.pomodoro.active'

export const pomoDisplay = computed(() => `${String(Math.floor(pomoRemain.value / 60)).padStart(2, '0')}:${String(pomoRemain.value % 60).padStart(2, '0')}`)

function persist() {
  try {
    if (!pomoRunning.value) sessionStorage.removeItem(STORAGE_KEY)
    else sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ mode: pomoMode.value, paused: pomoPaused.value, deadline, pausedMs, startedAt, work: pomoWorkMin.value, rest: pomoBreakMin.value, task: pomoTask.value, tag: pomoTag.value }))
  } catch { /* 存储不可用时仍支持当前页面会话 */ }
}

export async function loadPomodoro() {
  try { pomoData.value = await get<PomodoroData>('/api/pomodoro?days=14') }
  catch (e) { ElMessage.error(`专注统计加载失败：${(e as Error).message}`) }
}

async function record(minutes: number, endedAt: number) {
  if (minutes < 1) return
  const payload = { taskLabel: pomoTask.value, courseTag: pomoTag.value, startedAt, endedAt: new Date(endedAt).toISOString(), durationMin: minutes }
  try {
    await post('/api/pomodoro', payload)
    await loadPomodoro()
  } catch (e) { ElMessage.error(`专注记录保存失败：${(e as Error).message}`) }
}

function reset() {
  pomoRunning.value = false
  pomoPaused.value = false
  pomoMode.value = 'work'
  pomoRemain.value = pomoWorkMin.value * 60
  if (timer !== undefined) window.clearInterval(timer)
  timer = undefined
  persist()
}

function tick() {
  if (!pomoRunning.value || pomoPaused.value) return
  const now = Date.now()
  if (now >= deadline && pomoMode.value === 'work') {
    const endedAt = deadline
    pomoMode.value = 'break'
    deadline += pomoBreakMin.value * 60000
    persist()
    void record(pomoWorkMin.value, endedAt)
    ElNotification({ title: '番茄完成 🍅', message: `专注 ${pomoWorkMin.value} 分钟，休息一下！`, type: 'success' })
  }
  if (now >= deadline) {
    reset()
    ElNotification({ title: '休息结束', message: '开始下一个番茄吧！', type: 'info' })
    return
  }
  pomoRemain.value = Math.max(0, Math.ceil((deadline - now) / 1000))
}

function runTimer() {
  if (timer === undefined) timer = window.setInterval(tick, 1000)
  tick()
}

export function pomoStart() {
  if (pomoRunning.value) return
  pomoRunning.value = true
  pomoPaused.value = false
  pomoMode.value = 'work'
  startedAt = new Date().toISOString()
  deadline = Date.now() + pomoWorkMin.value * 60000
  persist()
  runTimer()
}

export function pomoTogglePause() {
  if (!pomoRunning.value) return
  tick()
  if (!pomoRunning.value) return
  if (pomoPaused.value) {
    deadline = Date.now() + pausedMs
    pomoPaused.value = false
  } else {
    pausedMs = Math.max(0, deadline - Date.now())
    pomoPaused.value = true
  }
  persist()
  tick()
}

export function pomoGiveUp() {
  tick()
  if (!pomoRunning.value) return
  const remainMs = pomoPaused.value ? pausedMs : Math.max(0, deadline - Date.now())
  const minutes = Math.floor((pomoWorkMin.value * 60000 - remainMs) / 60000)
  if (pomoMode.value === 'work') void record(minutes, Date.now())
  reset()
}

// 每个标签页独立恢复；完成阶段先持久化，再提交记录，避免切页或刷新重复完成。
try {
  const raw = sessionStorage.getItem(STORAGE_KEY)
  if (raw) {
    const state = JSON.parse(raw)
    if ((state.mode === 'work' || state.mode === 'break') && typeof state.paused === 'boolean' && Number.isFinite(state.deadline) && Number.isFinite(state.pausedMs) && state.work >= 5 && state.work <= 120 && state.rest >= 3 && state.rest <= 30 && typeof state.startedAt === 'string' && Number.isFinite(Date.parse(state.startedAt))) {
      pomoRunning.value = true
      pomoPaused.value = state.paused
      pomoMode.value = state.mode
      pomoWorkMin.value = state.work
      pomoBreakMin.value = state.rest
      pomoTask.value = typeof state.task === 'string' ? state.task : ''
      pomoTag.value = typeof state.tag === 'string' ? state.tag : ''
      startedAt = state.startedAt
      deadline = state.deadline
      pausedMs = state.pausedMs
      pomoRemain.value = Math.ceil((state.paused ? pausedMs : Math.max(0, deadline - Date.now())) / 1000)
      runTimer()
    } else sessionStorage.removeItem(STORAGE_KEY)
  }
} catch { /* 无效的本地状态不影响启动 */ }
document.addEventListener('visibilitychange', () => { if (!document.hidden) tick() })
