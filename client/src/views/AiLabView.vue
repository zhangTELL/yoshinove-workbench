<script setup lang="ts">
import type {
  AiProfile,
  BalanceBurnStat,
  BalanceHistory,
  BalanceHistorySeries,
  BalanceView,
  ProviderMeta,
  PromptRecord,
} from '@wb/shared'
import * as echarts from 'echarts'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, Plus, Refresh } from '@element-plus/icons-vue'
import { useRoute, useRouter } from 'vue-router'
import { del, get, post, put } from '../api/http'
import { chartPalette } from '../utils/chartTheme'
import { wrapPreviewDoc } from '../utils/previewDoc'

// ==================== 板块切换（由左侧主导航的折叠分组驱动）====================
const route = useRoute()
const router = useRouter()
const AI_TABS = ['balance', 'prompts', 'compare', 'sandbox'] as const

const activeTab = computed(() => {
  const tab = route.query.tab
  return typeof tab === 'string' && (AI_TABS as readonly string[]).includes(tab) ? tab : AI_TABS[0]
})

// ==================== 账户余额 ====================
const balView = ref<BalanceView | null>(null)
const refreshing = ref(false)
const balSettings = ref({ intervalMin: 30, lowThreshold: 10, channels: ['browser'] as string[] })

const providers = computed(() => balView.value?.providers ?? [])
const profiles = computed(() => balView.value?.profiles ?? [])
const providerOf = (id: string) => providers.value.find((p) => p.id === id)
const latestOf = (profileId: number) => balView.value?.latest.find((l) => l.profileId === profileId) ?? null

/** 默认平台里还没配置的 → 渲染成「待配置」占位卡，首屏有内容又不脏库 */
const pendingDefaults = computed(() =>
  providers.value.filter((p) => p.isDefault && !profiles.value.some((pr) => pr.provider === p.id)),
)
const addableProviders = computed(() => providers.value.filter((p) => !profiles.value.some((pr) => pr.provider === p.id)))

const SOURCE_LABEL: Record<string, string> = { official: '官方接口', reverse: '兼容方式', manual: '手动填写' }
const SOURCE_TAG: Record<string, 'success' | 'warning' | 'info'> = { official: 'success', reverse: 'warning', manual: 'info' }
const CHANNEL_LABEL: Record<string, string> = { browser: '浏览器通知', pushplus: 'PushPlus', wecom: '企业微信' }

function fmtMoney(v: unknown, currency = 'CNY'): string {
  if (typeof v !== 'number') return '—'
  const symbol = currency === 'USD' ? '$' : currency === 'CNY' ? '¥' : ''
  return `${symbol}${v.toFixed(2)}`
}

/** 余额大字优先取 available，退回 total */
function headlineOf(profileId: number): { value: string; label: string } {
  const snap = latestOf(profileId)?.snapshot
  if (!snap || snap.status !== 'ok') return { value: '—', label: '' }
  const currency = snap.currency || 'CNY'
  if (typeof snap.available === 'number') return { value: fmtMoney(snap.available, currency), label: '可用余额' }
  if (typeof snap.total === 'number') return { value: fmtMoney(snap.total, currency), label: '余额' }
  return { value: '—', label: '' }
}

function quotaPercent(q: { percentage: number | null; used_value: number | null; limit_value: number | null }): number {
  if (typeof q.percentage === 'number') return Math.min(100, Math.max(0, q.percentage))
  if (typeof q.used_value === 'number' && typeof q.limit_value === 'number' && q.limit_value > 0) {
    return Math.min(100, (q.used_value / q.limit_value) * 100)
  }
  return 0
}

async function loadBalance() {
  balView.value = await get<BalanceView>('/api/ai/balance')
  const s = balView.value.settings
  balSettings.value = { intervalMin: s.intervalMin, lowThreshold: s.lowThreshold, channels: [...s.channels] }
}

async function refreshAll(ids?: number[]) {
  if (!profiles.value.length) {
    ElMessage.warning('还没有配置任何平台')
    return
  }
  refreshing.value = true
  try {
    const r = await post<BalanceView & { outcomes: { profileName: string; status: string; error?: string }[] }>(
      '/api/ai/balance/refresh',
      ids ? { profileIds: ids } : {},
    )
    balView.value = r
    const failed = (r.outcomes ?? []).filter((o) => o.status !== 'ok')
    if (failed.length) ElMessage.warning(`${failed.length} 个平台抓取失败，见卡片上的错误提示`)
    else ElMessage.success('已刷新')
    await loadHistory()
  } catch (e) {
    ElMessage.error((e as Error).message)
  } finally {
    refreshing.value = false
  }
}

async function saveBalSettings() {
  try {
    await put('/api/settings', {
      'balance.intervalMin': balSettings.value.intervalMin,
      'balance.lowThreshold': balSettings.value.lowThreshold,
      'balance.channels': balSettings.value.channels,
    })
    ElMessage.success('监控设置已保存')
  } catch (e) {
    ElMessage.error((e as Error).message)
  }
}

// ===== 平台配置弹窗 =====
const profileDialog = ref(false)
const profileForm = ref({
  id: 0,
  name: '',
  provider: 'custom',
  baseUrl: '',
  apiKey: '',
  apiSecret: '',
  model: '',
  authStyle: 'bearer',
  balancePath: '',
  enabled: true,
  balanceEnabled: true,
})
const formProvider = computed(() => providerOf(profileForm.value.provider))
const needSecret = computed(() => formProvider.value?.credentials.includes('secret') ?? false)

function openAddProvider(p: ProviderMeta) {
  profileForm.value = {
    id: 0,
    name: p.label,
    provider: p.id,
    baseUrl: p.defaultBaseUrl,
    apiKey: '',
    apiSecret: '',
    model: '',
    // 智谱逆向端点用裸 Key，默认替用户选对
    authStyle: p.id === 'zhipu' ? 'raw' : 'bearer',
    balancePath: '',
    enabled: true,
    balanceEnabled: true,
  }
  profileDialog.value = true
}

function openEditProfile(pr: AiProfile) {
  profileForm.value = {
    id: pr.id,
    name: pr.name,
    provider: pr.provider,
    baseUrl: pr.baseUrl,
    apiKey: '',
    apiSecret: '',
    model: pr.model,
    authStyle: pr.authStyle,
    balancePath: pr.balancePath,
    enabled: pr.enabled,
    balanceEnabled: pr.balanceEnabled,
  }
  profileDialog.value = true
}

async function saveProfile() {
  const f = profileForm.value
  if (!f.name.trim()) {
    ElMessage.warning('请填写配置名称')
    return
  }
  try {
    if (f.id) {
      // Key / Secret 留空 = 不修改（前端只有掩码，不能回写覆盖真实值）
      await put(`/api/ai/profiles/${f.id}`, f)
    } else {
      await post('/api/ai/profiles', f)
    }
    profileDialog.value = false
    await loadBalance()
    ElMessage.success('已保存')
  } catch (e) {
    ElMessage.error((e as Error).message)
  }
}

async function removeProfile(pr: AiProfile) {
  try {
    await ElMessageBox.confirm(`删除配置「${pr.name}」？它的历史余额记录也会一起删除。`, '确认', { type: 'warning' })
  } catch {
    return
  }
  await del(`/api/ai/profiles/${pr.id}`)
  await loadBalance()
  ElMessage.success('已删除')
}

// ===== 手工录入 =====
const manualDialog = ref(false)
const manualForm = ref({ profileId: 0, total: 0, currency: 'CNY', note: '' })

function openManual(pr?: AiProfile) {
  manualForm.value = { profileId: pr?.id ?? profiles.value[0]?.id ?? 0, total: 0, currency: 'CNY', note: '' }
  manualDialog.value = true
}

async function saveManual() {
  if (!manualForm.value.profileId) {
    ElMessage.warning('请选择要录入的配置')
    return
  }
  try {
    balView.value = await post<BalanceView>('/api/ai/balance/manual', manualForm.value)
    manualDialog.value = false
    ElMessage.success('已录入')
  } catch (e) {
    ElMessage.error((e as Error).message)
  }
}

// ==================== 趋势与消耗分析 ====================
const history = ref<BalanceHistory | null>(null)
const historyDays = ref(30)
const trendChartEl = ref<HTMLDivElement>()
const dailyChartEl = ref<HTMLDivElement>()
const burnChartEl = ref<HTMLDivElement>()
const quotaChartEl = ref<HTMLDivElement>()
const chartInstances = new Set<echarts.ECharts>()
/** 分析面板里选的币种（多币种混画会误导，所以分开） */
const analysisCurrency = ref('')

const CURRENCY_SYMBOL: Record<string, string> = { CNY: '¥', USD: '$' }

function money(v: number | null, currency: string): string {
  if (typeof v !== 'number') return '—'
  return `${CURRENCY_SYMBOL[currency] ?? ''}${v.toFixed(2)}`
}

/** 有数据的币种列表 */
const analysisCurrencies = computed(() => {
  const set = new Set<string>()
  for (const s of history.value?.series ?? []) {
    if (s.points.some((p) => p.status === 'ok' && p.available !== null)) set.add(s.currency || 'CNY')
  }
  return [...set]
})

const chartSeries = computed<BalanceHistorySeries[]>(() =>
  (history.value?.series ?? []).filter((s) => (s.currency || 'CNY') === analysisCurrency.value),
)

/** 失败抓取点数量——不画进曲线，但要让用户知道有缺口 */
const failedPoints = computed(() => {
  let n = 0
  for (const s of chartSeries.value) for (const p of s.points) if (p.status !== 'ok') n++
  return n
})

const hasTrend = computed(() => chartSeries.value.some((s) => s.points.some((p) => p.status === 'ok' && p.available !== null)))

/** 能算出预计可用天数的平台（限定当前币种，保证汇总口径一致） */
const burnAvailable = computed(() =>
  (history.value?.stats ?? []).filter(
    (s) => s.daysLeft !== null && (s.currency || 'CNY') === analysisCurrency.value,
  ),
)
/** 算不出来的平台，附带原因 */
const burnSkipped = computed(() => (history.value?.stats ?? []).filter((s) => s.daysLeft === null))

/** 当前币种下的合计余额 */
const totalBalance = computed(() => {
  let sum = 0
  let has = false
  for (const s of chartSeries.value) {
    const ok = s.points.filter((p) => p.status === 'ok' && p.available !== null)
    if (!ok.length) continue
    sum += ok[ok.length - 1].available as number
    has = true
  }
  return has ? Number(sum.toFixed(2)) : null
})

/** 预计最快见底的平台 */
const soonestOut = computed<BalanceBurnStat | null>(() => {
  const list = [...burnAvailable.value].sort((a, b) => (a.daysLeft ?? 0) - (b.daysLeft ?? 0))
  return list[0] ?? null
})

/**
 * 时间轴标签格式随跨度自适应。
 * 固定用日期时，如果快照都集中在今天几分钟内，会出现一排重复的「09-14」。
 */
const trendAxisFormat = computed(() => {
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (const s of chartSeries.value) {
    for (const p of s.points) {
      const t = new Date(p.t.replace(' ', 'T')).getTime()
      if (Number.isNaN(t)) continue
      if (t < min) min = t
      if (t > max) max = t
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return '{MM}-{dd}'
  const hours = (max - min) / 3600000
  if (hours <= 1) return '{HH}:{mm}:{ss}'
  if (hours <= 48) return '{HH}:{mm}'
  return '{MM}-{dd}'
})

// ===== 统一的极简图表样式（浅灰卡片 + 无轴线 + 稀疏网格）=====
// 颜色不能写成常量：canvas 上的字与线不认 CSS 变量，每次渲染前现取当前主题的计算值
function stylePreset() {
  const p = chartPalette()
  return {
    p,
    AXIS_LABEL: { color: p.text3, fontSize: 11 },
    AXIS_LINE: { show: false },
    AXIS_TICK: { show: false },
    GRID: { left: 4, right: 12, top: 10, bottom: 2, containLabel: true },
    SPLIT_LINE: { lineStyle: { color: p.border, type: 'solid' as const } },
    TOOLTIP: {
      // tooltip 是 DOM 元素，CSS 变量可用——深浅色自动跟随
      backgroundColor: 'var(--el-bg-color-overlay, rgba(255,255,255,0.98))',
      borderColor: p.border,
      borderWidth: 1,
      textStyle: { color: 'var(--el-text-color-primary, #303133)', fontSize: 12 },
      extraCssText: 'box-shadow:0 4px 16px rgba(0,0,0,0.08);border-radius: var(--wb-radius-card);',
    },
  }
}

interface DailySpend {
  date: string
  value: number
}

/**
 * 每日消耗：由相邻快照的余额差值推算。
 * 只累加下降部分——充值时余额上升，若把负差值算进去会得到「负消耗」这种没意义的数。
 */
const dailySpend = computed<DailySpend[]>(() => {
  const buckets = new Map<string, number>()
  let earliest = ''
  for (const s of chartSeries.value) {
    const ok = s.points.filter((p) => p.status === 'ok' && p.available !== null)
    for (let i = 0; i < ok.length; i++) {
      const day = ok[i].t.slice(0, 10)
      if (!earliest || day < earliest) earliest = day
      if (i === 0) continue
      const delta = (ok[i - 1].available as number) - (ok[i].available as number)
      if (delta <= 0) continue
      buckets.set(day, (buckets.get(day) ?? 0) + delta)
    }
  }
  if (!earliest) return []
  // 补齐日期区间（含 0 消耗的日子），空白的柱子本身就是信息
  const out: DailySpend[] = []
  const cursor = new Date(`${earliest}T00:00:00`)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  while (cursor <= today && out.length < 92) {
    const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`
    out.push({ date: key, value: Number((buckets.get(key) ?? 0).toFixed(4)) })
    cursor.setDate(cursor.getDate() + 1)
  }
  // 只保留范围内（按选择的天数裁剪尾部之前的部分不动，头部按需裁掉）
  const span = historyDays.value
  return out.slice(Math.max(0, out.length - span))
})

/** 区间内合计消耗 */
const totalSpent = computed(() => {
  const sum = dailySpend.value.reduce((a, b) => a + b.value, 0)
  return dailySpend.value.some((d) => d.value > 0) ? Number(sum.toFixed(2)) : null
})

/** 观测窗口内的日均消耗（按窗口天数平均，含 0 消耗的安静日） */
const dailyAverage = computed(() => {
  if (totalSpent.value === null || !dailySpend.value.length) return null
  return Number((totalSpent.value / dailySpend.value.length).toFixed(2))
})

interface QuotaBar {
  profileName: string
  label: string
  usedPct: number
  remainPct: number
  detail: string
}
const quotaBars = computed<QuotaBar[]>(() => {
  const out: QuotaBar[] = []
  for (const l of balView.value?.latest ?? []) {
    const pr = profiles.value.find((p) => p.id === l.profileId)
    if (!pr) continue
    for (const q of l.quotas) {
      let used = quotaPercent(q)
      // 后端没给 percentage 时用 used/limit 反推
      if (typeof q.percentage !== 'number' && typeof q.used_value === 'number' && typeof q.limit_value === 'number' && q.limit_value > 0) {
        used = (q.used_value / q.limit_value) * 100
      }
      out.push({
        profileName: pr.name,
        label: q.label,
        usedPct: Number(Math.min(100, Math.max(0, used)).toFixed(1)),
        remainPct: Number((100 - Math.min(100, Math.max(0, used))).toFixed(1)),
        detail: `剩余 ${q.remaining ?? '—'}${q.limit_value !== null ? ` / ${q.limit_value}` : ''}${q.reset_at ? ` · 重置 ${q.reset_at}` : ''}`,
      })
    }
  }
  return out
})

function chartOf(el: HTMLDivElement | undefined): echarts.ECharts | null {
  if (!el) return null
  const c = echarts.getInstanceByDom(el) ?? echarts.init(el)
  chartInstances.add(c)
  return c
}

/** 多平台折线共用的调色板 */
const SERIES_COLORS = ['#378ADD', '#5DCAA5', '#EF9F27', '#D4537E', '#7F77DD', '#639922', '#D85A30', '#888780']

/** 余额走势：面积图（面积填充对「水平随时间变化」的读法比纯折线直观） */
function renderTrend() {
  const c = chartOf(trendChartEl.value)
  const S = stylePreset()
  if (!c) return
  const sym = CURRENCY_SYMBOL[analysisCurrency.value] ?? ''
  const series = chartSeries.value.map((s, i) => {
    const color = SERIES_COLORS[i % SERIES_COLORS.length]
    return {
      name: s.name,
      type: 'line' as const,
      smooth: true,
      symbolSize: 5,
      showSymbol: false,
      lineStyle: { width: 2, color },
      itemStyle: { color },
      areaStyle: {
        color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
          { offset: 0, color: `${color}3d` },
          { offset: 1, color: `${color}05` },
        ]),
      },
      // 只画成功抓取的点；失败点在图下方单列提示，不混淆曲线
      data: s.points
        .filter((p) => p.status === 'ok' && p.available !== null)
        .map((p) => [new Date(p.t.replace(' ', 'T')).getTime(), p.available]),
    }
  })
  c.setOption(
    {
      color: SERIES_COLORS,
      tooltip: {
        ...S.TOOLTIP,
        trigger: 'axis',
        axisPointer: { type: 'line', lineStyle: { color: S.p.border } },
        valueFormatter: (v: unknown) => (typeof v === 'number' ? `${sym}${v.toFixed(4)}` : '—'),
      },
      legend: { type: 'scroll', bottom: 0, icon: 'roundRect', itemWidth: 10, itemHeight: 10, textStyle: { fontSize: 11, color: S.p.text3 } },
      grid: { ...S.GRID, bottom: 30 },
      // 跨度很短时该显示时刻而不是日期，所以按跨度自适应
      xAxis: {
        type: 'time',
        axisLine: S.AXIS_LINE,
        axisTick: S.AXIS_TICK,
        splitLine: { show: false },
        axisLabel: { ...S.AXIS_LABEL, hideOverlap: true, formatter: trendAxisFormat.value },
      },
      yAxis: {
        type: 'value',
        scale: true,
        axisLine: S.AXIS_LINE,
        axisTick: S.AXIS_TICK,
        splitLine: S.SPLIT_LINE,
        axisLabel: { ...S.AXIS_LABEL, formatter: `${sym}{value}` },
      },
      series,
    },
    true,
  )
  c.resize()
}

/** 每日消耗：柱状图，样式对齐平台用量仪表盘 */
function renderDaily() {
  const c = chartOf(dailyChartEl.value)
  const S = stylePreset()
  if (!c) return
  const items = dailySpend.value
  if (!items.length || !items.some((d) => d.value > 0)) {
    c.clear()
    return
  }
  const sym = CURRENCY_SYMBOL[analysisCurrency.value] ?? ''
  const max = Math.max(...items.map((d) => d.value))
  c.setOption(
    {
      tooltip: {
        ...S.TOOLTIP,
        trigger: 'axis',
        axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(55,138,221,0.06)' } },
        valueFormatter: (v: unknown) => `${sym}${Number(v ?? 0).toFixed(4)}`,
      },
      grid: S.GRID,
      xAxis: {
        type: 'category',
        data: items.map((d) => d.date.slice(5)),
        axisLine: S.AXIS_LINE,
        axisTick: S.AXIS_TICK,
        splitLine: { show: false },
        axisLabel: { ...S.AXIS_LABEL, hideOverlap: true },
      },
      yAxis: {
        type: 'value',
        axisLine: S.AXIS_LINE,
        axisTick: S.AXIS_TICK,
        splitLine: S.SPLIT_LINE,
        axisLabel: { ...S.AXIS_LABEL, formatter: `${sym}{value}` },
      },
      series: [
        {
          type: 'bar',
          barMaxWidth: 26,
          // 消耗越高的柱子越深，一眼看出哪天烧得多
          data: items.map((d) => ({
            value: d.value,
            itemStyle: { color: max > 0 && d.value / max > 0.6 ? '#EF9F27' : '#85B7EB', borderRadius: [3, 3, 0, 0] },
          })),
        },
      ],
    },
    true,
  )
  c.resize()
}

function renderBurn() {
  const c = chartOf(burnChartEl.value)
  const S = stylePreset()
  if (!c) return
  const items = burnAvailable.value
  if (!items.length) {
    c.clear()
    return
  }
  const colorOf = (d: number) => (d < 7 ? '#E24B4A' : d < 30 ? '#EF9F27' : '#1D9E75')
  c.setOption(
    {
      tooltip: {
        ...S.TOOLTIP,
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        formatter: (ps: unknown) => {
          const arr = ps as { dataIndex: number }[]
          const st = items[arr[0].dataIndex] as BalanceBurnStat
          return [
            `<b>${st.name}</b>`,
            `预计可用：${st.daysLeft} 天`,
            `日均消耗：${money(st.dailyBurn, st.currency)}`,
            `区间消耗：${money(st.spent, st.currency)}（${st.spanHours} 小时）`,
            `当前余额：${money(st.available, st.currency)}`,
          ].join('<br/>')
        },
      },
      grid: { ...S.GRID, right: 58, top: 6, bottom: 6 },
      xAxis: {
        type: 'value',
        axisLine: S.AXIS_LINE,
        axisTick: S.AXIS_TICK,
        splitLine: S.SPLIT_LINE,
        axisLabel: { ...S.AXIS_LABEL, formatter: '{value} 天' },
      },
      yAxis: {
        type: 'category',
        data: items.map((s) => s.name),
        axisLine: S.AXIS_LINE,
        axisTick: S.AXIS_TICK,
        axisLabel: { ...S.AXIS_LABEL, fontSize: 12, color: S.p.text2, width: 140, overflow: 'truncate' },
      },
      series: [
        {
          type: 'bar',
          barMaxWidth: 30,
          data: items.map((s) => ({ value: s.daysLeft, itemStyle: { color: colorOf(s.daysLeft as number), borderRadius: [0, 4, 4, 0] } })),
          label: { show: true, position: 'right', fontSize: 11, color: S.p.text3, formatter: '{c} 天' },
        },
      ],
    },
    true,
  )
  c.resize()
}

function renderQuota() {
  const c = chartOf(quotaChartEl.value)
  const S = stylePreset()
  if (!c) return
  const items = quotaBars.value
  if (!items.length) {
    c.clear()
    return
  }
  c.setOption(
    {
      tooltip: {
        ...S.TOOLTIP,
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        formatter: (ps: unknown) => {
          const arr = ps as { dataIndex: number }[]
          const it = items[arr[0].dataIndex]
          return [`<b>${it.profileName}</b> · ${it.label}`, `已用 ${it.usedPct}%`, it.detail].join('<br/>')
        },
      },
      legend: { bottom: 0, icon: 'roundRect', itemWidth: 10, itemHeight: 10, textStyle: { fontSize: 11, color: S.p.text3 } },
      grid: { ...S.GRID, right: 40, bottom: 30 },
      xAxis: {
        type: 'value',
        max: 100,
        axisLine: S.AXIS_LINE,
        axisTick: S.AXIS_TICK,
        splitLine: S.SPLIT_LINE,
        axisLabel: { ...S.AXIS_LABEL, formatter: '{value}%' },
      },
      yAxis: {
        type: 'category',
        data: items.map((q) => `${q.profileName} · ${q.label}`),
        axisLine: S.AXIS_LINE,
        axisTick: S.AXIS_TICK,
        axisLabel: { ...S.AXIS_LABEL, fontSize: 12, color: S.p.text2, width: 150, overflow: 'truncate' },
      },
      series: [
        {
          name: '已用',
          type: 'bar',
          stack: 'q',
          barMaxWidth: 24,
          data: items.map((q) => q.usedPct),
          itemStyle: { color: '#EF9F27' },
          label: { show: true, fontSize: 10, color: '#fff', formatter: '{c}%' },
        },
        {
          name: '剩余',
          type: 'bar',
          stack: 'q',
          data: items.map((q) => q.remainPct),
          itemStyle: { color: '#85B7EB', borderRadius: [0, 4, 4, 0] },
        },
      ],
    },
    true,
  )
  c.resize()
}

function renderAnalysis() {
  // 隐藏容器里初始化 echarts 会得到 0 尺寸，非激活板块直接跳过
  if (activeTab.value !== 'balance') return
  if (!history.value) return
  renderTrend()
  renderDaily()
  renderBurn()
  renderQuota()
}

async function loadHistory() {
  history.value = await get<BalanceHistory>(`/api/ai/balance/history?days=${historyDays.value}`)
  const list = analysisCurrencies.value
  if (!list.includes(analysisCurrency.value)) analysisCurrency.value = list[0] ?? 'CNY'
  await nextTick()
  renderAnalysis()
}

function onWindowResize() {
  for (const c of chartInstances) c.resize()
}

function disposeCharts() {
  for (const c of chartInstances) c.dispose()
  chartInstances.clear()
}

// ==================== Prompt 库 ====================
const promptList = ref<PromptRecord[]>([])
const curPromptId = ref(0)
const promptForm = ref({ name: '', content: '', cases: [] as { input: string; expected: string }[] })
const promptSearch = ref('')

const filteredPrompts = computed(() => {
  const kw = promptSearch.value.trim().toLowerCase()
  if (!kw) return promptList.value
  return promptList.value.filter((p) => p.name.toLowerCase().includes(kw) || p.content.toLowerCase().includes(kw))
})

/** 实时从正文抽变量；中文变量名也要能匹配，所以不能用 \w */
const previewVars = computed(() => {
  const found = new Set<string>()
  for (const m of promptForm.value.content.matchAll(/\{([^}]+)\}/g)) {
    const name = m[1].trim()
    if (name) found.add(name)
  }
  return [...found]
})

async function loadPrompts() {
  const r = await get<{ prompts: PromptRecord[] }>('/api/ai/prompts')
  promptList.value = r.prompts
  if (!promptList.value.some((p) => p.id === curPromptId.value)) {
    if (promptList.value.length) selectPrompt(promptList.value[0])
    else newPrompt()
  }
}

function selectPrompt(p: PromptRecord) {
  curPromptId.value = p.id
  promptForm.value = {
    name: p.name,
    content: p.content,
    cases: p.cases.map((c) => ({ input: c.input, expected: c.expected })),
  }
}

function newPrompt() {
  curPromptId.value = 0
  promptForm.value = { name: '', content: '', cases: [] }
}

async function savePrompt() {
  const f = promptForm.value
  if (!f.name.trim()) {
    ElMessage.warning('请填写名称')
    return
  }
  try {
    if (curPromptId.value) {
      const r = await put<{ ok: boolean; prompt: PromptRecord }>(`/api/ai/prompts/${curPromptId.value}`, f)
      if (r.prompt) {
        curPromptId.value = r.prompt.id
        ElMessage.success(`已保存（版本 v${r.prompt.version}）`)
      }
    } else {
      const r = await post<{ ok: boolean; id: number }>('/api/ai/prompts', f)
      curPromptId.value = r.id
      ElMessage.success('已新建')
    }
    await loadPrompts()
  } catch (e) {
    ElMessage.error((e as Error).message)
  }
}

async function removePrompt() {
  if (!curPromptId.value) {
    newPrompt()
    return
  }
  try {
    await ElMessageBox.confirm('删除该提示词及其用例？', '确认', { type: 'warning' })
  } catch {
    return
  }
  await del(`/api/ai/prompts/${curPromptId.value}`)
  curPromptId.value = 0
  await loadPrompts()
  ElMessage.success('已删除')
}

function addCase() {
  promptForm.value.cases.push({ input: '', expected: '' })
}

function removeCase(i: number) {
  promptForm.value.cases.splice(i, 1)
}

/** 把 Prompt 库的用例灌到对比页，省得重复录入 */
function pushCasesToCompare() {
  const lines = promptForm.value.cases.map((c) => c.input).filter((s) => s.trim())
  if (!lines.length) {
    ElMessage.warning('当前提示词没有用例')
    return
  }
  cmpPrompt.value = promptForm.value.content
  cmpCases.value = lines.join('\n')
  void router.push({ path: '/ai-lab', query: { tab: 'compare' } })
  ElMessage.success(`已带入 ${lines.length} 条用例`)
}

// ==================== 模型对比 ====================
const cmpProfiles = ref<number[]>([])
const cmpPrompt = ref('')
const cmpCases = ref('')
const cmpRunning = ref(false)

interface CmpOutput {
  caseIndex: number
  caseInput: string
  ok: boolean
  text: string
  error?: string
  latencyMs: number
  tokens: number
}
interface CmpResult {
  profileId: number
  name: string
  model: string
  provider: string
  outputs: CmpOutput[]
}
const cmpResult = ref<{ prompt: string; hasVar: boolean; cases: string[]; results: CmpResult[] } | null>(null)
/** 每个输出块独立切换「渲染 / 源码」 */
const cmpViewMode = ref<Record<string, 'render' | 'text'>>({})

const cmpSelectable = computed(() => profiles.value.filter((p) => p.hasApiKey))

/** 输出里是否含可渲染的 SVG / HTML */
function extractRenderable(text: string): string | null {
  if (!text) return null
  const fence = text.match(/```(?:html|svg|xml)?\s*([\s\S]*?)```/i)
  const candidate = (fence ? fence[1] : text).trim()
  return candidate.startsWith('<') ? candidate : null
}

function toggleViewMode(key: string) {
  cmpViewMode.value[key] = cmpViewMode.value[key] === 'render' ? 'text' : 'render'
}

function viewModeOf(key: string): 'render' | 'text' {
  return cmpViewMode.value[key] ?? 'text'
}

async function runCompare() {
  if (!cmpProfiles.value.length) {
    ElMessage.warning('请至少选择一个模型')
    return
  }
  cmpRunning.value = true
  cmpViewMode.value = {}
  try {
    const cases = cmpCases.value
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
    cmpResult.value = await post('/api/ai/compare', {
      profileIds: cmpProfiles.value,
      prompt: cmpPrompt.value,
      cases: cases.length ? cases : [''],
    })
    ElMessage.success('对比完成')
  } catch (e) {
    ElMessage.error((e as Error).message)
  } finally {
    cmpRunning.value = false
  }
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    ElMessage.success('已复制')
  } catch {
    ElMessage.warning('复制失败，请手动选择文本')
  }
}

// ==================== 沙箱渲染 ====================
const sandboxCode = ref('')
const sandboxSrc = ref('')
const sandboxWrap = ref(false)

function renderSandbox() {
  if (!sandboxCode.value.trim()) {
    ElMessage.warning('请先粘贴 SVG / HTML')
    return
  }
  sandboxSrc.value = sandboxCode.value
}

function clearSandbox() {
  sandboxCode.value = ''
  sandboxSrc.value = ''
}

/**
 * 给沙箱内容套一层外壳（实现已抽到 utils/previewDoc.ts，与项目文件预览共用同一份）。
 * 两个坑：① 裸 `<svg viewBox>` 没有内在尺寸，别再叠加 `height:auto`——在 flex 项里会被算成 0 高；
 * ② 样式不要同时写到 `html` 上，否则 flex 容器会变成根元素，布局不可预期。
 */
const sandboxDoc = computed(() => (sandboxSrc.value ? wrapPreviewDoc(sandboxSrc.value) : ''))

function resultDoc(text: string): string {
  // 对比区里空间窄：内边距收小、svg 上限 300px
  return wrapPreviewDoc(extractRenderable(text) ?? '', { padding: 12, maxHeight: '300px' })
}

// ==================== 初始化 ====================
onMounted(async () => {
  if (!route.query.tab) void router.replace({ path: '/ai-lab', query: { tab: AI_TABS[0] } })
  await loadBalance()
  await loadHistory()
  await loadPrompts()
  window.addEventListener('resize', onWindowResize)
  window.addEventListener('wb-theme-change', onThemeChange)
})

onUnmounted(() => {
  window.removeEventListener('resize', onWindowResize)
  window.removeEventListener('wb-theme-change', onThemeChange)
  disposeCharts()
})

watch(activeTab, async (tab) => {
  await nextTick()
  if (tab === 'prompts' && !promptList.value.length) await loadPrompts()
  // 切回余额板块时重取一次并重画：图表在隐藏容器里会是 0 尺寸，必须等可见后 resize
  if (tab === 'balance') {
    await loadBalance()
    await loadHistory()
  }
})

// 换币种会同时影响走势图与每日消耗图
watch(analysisCurrency, () => {
  void nextTick().then(() => {
    renderTrend()
    renderDaily()
  })
})

// 主题变化（深浅色/主题色）后重画（canvas 不认 CSS 变量，靠重渲染换肤）
function onThemeChange() {
  if (activeTab.value !== 'balance') return
  void nextTick().then(() => {
    renderTrend()
    renderDaily()
    renderBurn()
    renderQuota()
  })
}
</script>

<template>
  <div class="ai-page">
    <!-- ==================== 账户余额 ==================== -->
    <div v-show="activeTab === 'balance'" class="tab-block">
      <div class="tab-head">
        <div class="head-text">
          <h3>API 余额与套餐</h3>
          <p class="sub">带「官方接口」标记的来自平台官方，最可靠；标「兼容方式」的偶尔会失效，出问题不一定是你的 Key 填错了。</p>
        </div>
        <div class="head-actions">
          <el-button type="primary" :icon="Refresh" :loading="refreshing" @click="refreshAll()">刷新全部</el-button>
          <el-button :icon="Plus" :disabled="!profiles.length" @click="openManual()">手工录入</el-button>
        </div>
      </div>

      <div class="monitor-bar">
        <span class="mb-label">自动刷新</span>
        <el-input-number v-model="balSettings.intervalMin" :min="0" :max="1440" :step="5" size="small" />
        <span class="mb-unit">分钟（0 = 关闭，建议不低于 15）</span>
        <el-divider direction="vertical" />
        <span class="mb-label">余额低于多少时提醒</span>
        <el-input-number v-model="balSettings.lowThreshold" :min="0" :precision="2" size="small" />
        <el-divider direction="vertical" />
        <span class="mb-label">提醒通道</span>
        <el-select v-model="balSettings.channels" multiple size="small" style="width: 250px" placeholder="选择推送通道">
          <el-option v-for="(label, key) in CHANNEL_LABEL" :key="key" :label="label" :value="key" />
        </el-select>
        <el-button size="small" type="primary" plain @click="saveBalSettings">保存</el-button>
      </div>

      <div class="card-grid">
        <!-- 已配置的平台 -->
        <div v-for="pr in profiles" :key="pr.id" class="bal-card">
          <div class="bc-head">
            <span class="bc-name">{{ pr.name }}</span>
            <el-tag v-if="providerOf(pr.provider)" size="small" effect="plain" :type="SOURCE_TAG[providerOf(pr.provider)!.source]">
              {{ SOURCE_LABEL[providerOf(pr.provider)!.source] }}
            </el-tag>
            <el-tag v-else size="small" type="info" effect="plain">未知平台</el-tag>
          </div>

          <template v-if="latestOf(pr.id)?.snapshot">
            <div class="bc-money">
              <span class="bc-value">{{ headlineOf(pr.id).value }}</span>
              <span class="bc-label">{{ headlineOf(pr.id).label }}</span>
            </div>
            <div v-if="latestOf(pr.id)!.snapshot!.status === 'ok'" class="bc-split">
              <span v-if="latestOf(pr.id)!.snapshot!.granted !== null">
                赠送 {{ fmtMoney(latestOf(pr.id)!.snapshot!.granted, latestOf(pr.id)!.snapshot!.currency) }}
              </span>
              <span v-if="latestOf(pr.id)!.snapshot!.topped_up !== null">
                充值 {{ fmtMoney(latestOf(pr.id)!.snapshot!.topped_up, latestOf(pr.id)!.snapshot!.currency) }}
              </span>
            </div>
            <el-alert
              v-else
              type="error"
              :closable="false"
              class="bc-error"
              show-icon
              :title="latestOf(pr.id)!.snapshot!.status === 'unsupported' ? '这个平台不支持自动查询' : '查询失败'"
              :description="latestOf(pr.id)!.snapshot!.error || '没有拿到能识别的数据'"
            />
          </template>
          <div v-else class="bc-empty">尚无数据，点「刷新全部」试一次</div>

          <!-- 套餐 / 资源包窗口 -->
          <div v-if="latestOf(pr.id)?.quotas?.length" class="bc-quotas">
            <div v-for="q in latestOf(pr.id)!.quotas" :key="q.id" class="quota-row">
              <div class="quota-top">
                <span>{{ q.label }}</span>
                <span class="quota-num">
                  {{ q.remaining ?? '—' }}<template v-if="q.limit_value !== null"> / {{ q.limit_value }}</template>
                </span>
              </div>
              <el-progress
                :percentage="Number(quotaPercent(q).toFixed(1))"
                :stroke-width="6"
                :show-text="false"
                :status="quotaPercent(q) >= 90 ? 'exception' : undefined"
              />
              <div class="quota-reset">重置：{{ q.reset_at ?? '未知' }}</div>
            </div>
          </div>

          <div class="bc-foot">
            <span class="bc-time">{{ latestOf(pr.id)?.snapshot?.captured_at ?? '—' }} · {{ pr.apiKeyMasked || '未填 Key' }}</span>
            <div class="bc-actions">
              <el-button size="small" text @click="refreshAll([pr.id])">刷新</el-button>
              <el-button size="small" text @click="openManual(pr)">录入</el-button>
              <el-button size="small" text @click="openEditProfile(pr)">编辑</el-button>
              <el-button size="small" text type="danger" @click="removeProfile(pr)">删除</el-button>
            </div>
          </div>
        </div>

        <!-- 默认平台的「待配置」占位卡 -->
        <div v-for="p in pendingDefaults" :key="`pending-${p.id}`" class="bal-card pending" @click="openAddProvider(p)">
          <div class="bc-head">
            <span class="bc-name">{{ p.label }}</span>
            <el-tag size="small" effect="plain" :type="SOURCE_TAG[p.source]">{{ SOURCE_LABEL[p.source] }}</el-tag>
          </div>
          <div class="bc-pending">未配置</div>
          <div class="bc-pending-tip">点一下填写 Key 就能开始监控</div>
          <div class="bc-foot"><span class="bc-time">{{ p.note }}</span></div>
        </div>

        <!-- 添加平台 -->
        <el-popover placement="bottom-start" :width="400" trigger="click">
          <template #reference>
            <div class="bal-card add">
              <div class="add-icon">+</div>
              <div class="add-text">添加平台</div>
            </div>
          </template>
          <div class="provider-picker">
            <div v-if="!addableProviders.length" class="pp-empty">所有平台都已添加</div>
            <div v-for="p in addableProviders" :key="p.id" class="pp-item" @click="openAddProvider(p)">
              <div class="pp-row">
                <span class="pp-name">{{ p.label }}</span>
                <el-tag size="small" effect="plain" :type="SOURCE_TAG[p.source]">{{ SOURCE_LABEL[p.source] }}</el-tag>
              </div>
              <div class="pp-note">{{ p.note }}</div>
              <div class="pp-meta">
                需要：{{ p.credentials.includes('secret') ? 'AccessKey + SecretKey' : 'API Key' }} · 可查：{{
                  p.capabilities.map((c) => (c === 'balance' ? '余额' : '套餐额度')).join(' + ')
                }}
              </div>
            </div>
          </div>
        </el-popover>
      </div>

      <!-- ===== 趋势与消耗分析 ===== -->
      <div class="analysis">
        <div class="an-head">
          <h4>趋势与消耗分析</h4>
          <div class="an-actions">
            <el-radio-group v-if="analysisCurrencies.length > 1" v-model="analysisCurrency" size="small">
              <el-radio-button v-for="c in analysisCurrencies" :key="c" :value="c">{{ c }}</el-radio-button>
            </el-radio-group>
            <el-radio-group v-model="historyDays" size="small" @change="loadHistory">
              <el-radio-button :value="7">7 天</el-radio-button>
              <el-radio-button :value="30">30 天</el-radio-button>
              <el-radio-button :value="90">90 天</el-radio-button>
            </el-radio-group>
          </div>
        </div>

        <div v-if="totalBalance !== null || soonestOut" class="an-summary">
          <div class="an-card an-stat">
            <div class="an-card-head">
              <span class="an-card-title">合计余额</span>
              <span class="an-card-sub">{{ analysisCurrency }} · {{ chartSeries.length }} 个平台</span>
            </div>
            <div class="an-stat-num">{{ money(totalBalance, analysisCurrency) }}</div>
          </div>
          <div v-if="soonestOut" class="an-card an-stat">
            <div class="an-card-head">
              <span class="an-card-title">最快见底</span>
              <span class="an-card-sub">{{ soonestOut.name }}</span>
            </div>
            <div class="an-stat-num" :class="{ 'is-warn': (soonestOut.daysLeft ?? 99) < 7 }">
              {{ soonestOut.daysLeft }} <span class="an-stat-unit">天</span>
            </div>
          </div>
          <div v-if="totalSpent !== null" class="an-card an-stat">
            <div class="an-card-head">
              <span class="an-card-title">区间消耗</span>
              <span class="an-card-sub">近 {{ historyDays }} 天</span>
            </div>
            <div class="an-stat-num">{{ money(totalSpent, analysisCurrency) }}</div>
          </div>
        </div>

        <div v-show="hasTrend" class="an-card">
          <div class="an-card-head">
            <span class="an-card-title">余额走势</span>
            <span class="an-card-sub">{{ analysisCurrency }} · 当前 {{ money(totalBalance, analysisCurrency) }}</span>
          </div>
          <div ref="trendChartEl" class="an-chart" />
          <div v-if="failedPoints" class="an-note">
            区间内有 {{ failedPoints }} 个失败抓取点，未画入曲线——避免把抓取失败当成余额变化
          </div>
        </div>
        <el-empty
          v-if="!hasTrend"
          :image-size="60"
          description="还没有数据。点一次「刷新全部」，多记几次就能看到走势"
        />

        <div class="an-card">
          <div class="an-card-head">
            <span class="an-card-title">每日消耗</span>
            <span class="an-card-sub">
              近 {{ historyDays }} 天 · 日均 {{ money(dailyAverage, analysisCurrency) }}
            </span>
          </div>
          <div v-if="dailySpend.some((d) => d.value > 0)" ref="dailyChartEl" class="an-chart" />
          <el-empty v-else :image-size="60" description="还没有看到余额减少，暂时没有消耗可统计" />
          <div class="an-note">按两次记录之间的余额变化估算，只算减少的部分，充值不算消耗</div>
        </div>

        <div class="an-card">
          <div class="an-card-head">
            <span class="an-card-title">消耗速度与预计可用天数</span>
            <span class="an-card-sub">记录间隔不足 6 小时时先不估算</span>
          </div>
          <div v-if="burnAvailable.length" ref="burnChartEl" class="an-chart" />
          <el-empty v-else :image-size="60" description="记录的时间还不够，暂时算不出消耗速度" />
          <div v-if="burnSkipped.length" class="an-skip">
            <div v-for="s in burnSkipped" :key="s.profileId" class="an-skip-row">
              <span class="an-skip-name">{{ s.name }}</span>
              <span class="an-skip-reason">{{ s.reason }}</span>
            </div>
          </div>
        </div>

        <div class="an-card">
          <div class="an-card-head">
            <span class="an-card-title">套餐额度使用率</span>
          </div>
          <div v-if="quotaBars.length" ref="quotaChartEl" class="an-chart" />
          <el-empty
            v-else
            :image-size="60"
            description="这个平台没有套餐额度可查（按用量付费，本来就没有套餐这个概念）"
          />
        </div>
      </div>
    </div>

    <!-- ==================== Prompt 库 ==================== -->
    <div v-show="activeTab === 'prompts'" class="tab-block">
      <div class="prompt-layout">
        <aside class="pl-list">
          <div class="pl-head">
            <el-input v-model="promptSearch" size="small" placeholder="搜索提示词" clearable />
            <el-button size="small" type="primary" :icon="Plus" @click="newPrompt">新建</el-button>
          </div>
          <div class="pl-items">
            <div
              v-for="p in filteredPrompts"
              :key="p.id"
              class="pl-item"
              :class="{ active: p.id === curPromptId }"
              @click="selectPrompt(p)"
            >
              <div class="pl-name">{{ p.name }}</div>
              <div class="pl-meta">v{{ p.version }} · {{ p.cases.length }} 个用例 · {{ p.updatedAt.slice(0, 10) }}</div>
            </div>
            <el-empty v-if="!filteredPrompts.length" description="还没有提示词" :image-size="70" />
          </div>
        </aside>

        <section class="pl-editor">
          <el-form label-width="70px">
            <el-form-item label="名称">
              <el-input v-model="promptForm.name" placeholder="如：SVG 图标生成器" />
            </el-form-item>
            <el-form-item label="提示词">
              <el-input
                v-model="promptForm.content"
                type="textarea"
                :rows="8"
                placeholder="用 {变量} 作为占位符，例如：画一个 {主题} 的 SVG 图标，用 {颜色} 配色"
              />
            </el-form-item>
            <el-form-item label="变量">
              <div class="var-tags">
                <el-tag v-for="v in previewVars" :key="v" size="small" type="info">{{ v }}</el-tag>
                <span v-if="!previewVars.length" class="form-tip">在正文里写 {名称} 就是变量，这里会自动认出来</span>
              </div>
            </el-form-item>
          </el-form>

          <div class="case-head">
            <span>测试用例（{{ promptForm.cases.length }}）</span>
            <div>
              <el-button size="small" :icon="Plus" @click="addCase">加一条</el-button>
              <el-button size="small" :disabled="!promptForm.cases.length" @click="pushCasesToCompare">带到模型对比</el-button>
            </div>
          </div>
          <div v-for="(c, i) in promptForm.cases" :key="i" class="case-row">
            <el-input v-model="c.input" size="small" placeholder="输入（{输入} 的值）" />
            <el-input v-model="c.expected" size="small" placeholder="期望输出（可选）" />
            <el-button size="small" text type="danger" :icon="Delete" @click="removeCase(i)" />
          </div>
          <el-empty v-if="!promptForm.cases.length" description="没有用例，模型对比时可临时填写" :image-size="60" />

          <div class="editor-actions">
            <el-button type="primary" @click="savePrompt">保存</el-button>
            <el-button type="danger" plain @click="removePrompt">删除</el-button>
          </div>
        </section>
      </div>
    </div>

    <!-- ==================== 模型对比 ==================== -->
    <div v-show="activeTab === 'compare'" class="tab-block">
      <div class="cmp-config">
        <div class="cmp-field">
          <label>参与对比的模型</label>
          <el-select v-model="cmpProfiles" multiple placeholder="从已配置的平台里选（需先填 Key）" style="width: 100%">
            <el-option v-for="p in cmpSelectable" :key="p.id" :label="`${p.name}（${p.model || '未填模型名'}）`" :value="p.id" />
          </el-select>
          <div v-if="!cmpSelectable.length" class="form-tip">还没有可用的模型：先去「账户余额」添加平台并填好 API Key</div>
        </div>
        <div class="cmp-field">
          <label>提示词</label>
          <el-input
            v-model="cmpPrompt"
            type="textarea"
            :rows="5"
            placeholder="含 {输入} 则该处会被每条用例替换；不含则本条作为 system，用例作为 user"
          />
        </div>
        <div class="cmp-field">
          <label>用例（每行一条，留空只跑一次）</label>
          <el-input v-model="cmpCases" type="textarea" :rows="3" placeholder="红色的圆形按钮&#10;蓝色的方形图标" />
        </div>
        <el-button type="primary" :loading="cmpRunning" @click="runCompare">开始对比</el-button>
      </div>

      <div v-if="cmpResult" class="cmp-results">
        <div v-for="r in cmpResult.results" :key="r.profileId" class="cmp-col">
          <div class="cmp-col-head">
            <span class="cmp-col-name">{{ r.name }}</span>
            <span class="cmp-col-model">{{ r.model }}</span>
          </div>
          <div v-for="o in r.outputs" :key="o.caseIndex" class="cmp-out">
            <div class="cmp-out-head">
              <span v-if="cmpResult.cases.length > 1" class="cmp-case">用例 {{ o.caseIndex + 1 }}</span>
              <span class="cmp-stat">{{ o.latencyMs }}ms · {{ o.tokens || 0 }} tokens</span>
              <div style="flex: 1" />
              <el-button v-if="o.ok && extractRenderable(o.text)" size="small" text @click="toggleViewMode(`${r.profileId}-${o.caseIndex}`)">
                {{ viewModeOf(`${r.profileId}-${o.caseIndex}`) === 'render' ? '看代码' : '看效果' }}
              </el-button>
              <el-button v-if="o.ok" size="small" text @click="copyText(o.text)">复制</el-button>
            </div>
            <el-alert v-if="!o.ok" type="error" :closable="false" show-icon :title="o.error ?? '调用失败'" />
            <template v-else>
              <iframe
                v-if="viewModeOf(`${r.profileId}-${o.caseIndex}`) === 'render' && extractRenderable(o.text)"
                class="cmp-frame"
                sandbox="allow-scripts"
                :srcdoc="resultDoc(o.text)"
              />
              <pre v-else class="cmp-text">{{ o.text }}</pre>
            </template>
          </div>
        </div>
      </div>
      <el-empty v-else description="选好模型与提示词后点「开始对比」" />
    </div>

    <!-- ==================== 沙箱渲染 ==================== -->
    <div v-show="activeTab === 'sandbox'" class="tab-block">
      <div class="tab-head">
        <div class="head-text">
          <h3>沙箱渲染</h3>
          <p class="sub">把模型生成的 SVG 或 HTML 粘到下面，就能直接看效果。内容在隔离环境里运行，不会影响这个页面。</p>
        </div>
        <div class="head-actions">
          <el-checkbox v-model="sandboxWrap">自动补全网页结构</el-checkbox>
          <el-button type="primary" @click="renderSandbox">渲染</el-button>
          <el-button @click="clearSandbox">清空</el-button>
        </div>
      </div>
      <el-input
        v-model="sandboxCode"
        type="textarea"
        :rows="10"
        placeholder="把 SVG / HTML 粘到这里，例如：<svg viewBox='0 0 100 100'><circle cx='50' cy='50' r='40' fill='red'/></svg>"
      />
      <div v-if="sandboxSrc" class="sandbox-frame-wrap">
        <iframe class="sandbox-frame" sandbox="allow-scripts" :srcdoc="sandboxDoc" />
      </div>
    </div>

    <!-- ===== 平台配置弹窗 ===== -->
    <el-dialog v-model="profileDialog" :title="profileForm.id ? '编辑配置' : '添加平台'" width="520px">
      <el-form label-width="110px">
        <el-form-item label="平台">
          <el-tag effect="plain" :type="SOURCE_TAG[formProvider?.source ?? 'manual']">
            {{ formProvider?.label ?? profileForm.provider }} · {{ SOURCE_LABEL[formProvider?.source ?? 'manual'] }}
          </el-tag>
        </el-form-item>
        <el-alert
          v-if="formProvider?.note"
          type="warning"
          :closable="false"
          class="dialog-note"
          show-icon
          :title="formProvider.note"
        />
        <el-form-item label="配置名称">
          <el-input v-model="profileForm.name" />
        </el-form-item>
        <el-form-item label="Base URL">
          <el-input v-model="profileForm.baseUrl" placeholder="接口地址（Base URL）" />
        </el-form-item>
        <el-form-item :label="needSecret ? 'AccessKey' : 'API Key'">
          <el-input
            v-model="profileForm.apiKey"
            type="password"
            show-password
            :placeholder="profileForm.id ? '留空表示不修改' : '粘贴你的 Key'"
          />
        </el-form-item>
        <el-form-item v-if="needSecret" label="SecretKey">
          <el-input
            v-model="profileForm.apiSecret"
            type="password"
            show-password
            :placeholder="profileForm.id ? '留空表示不修改' : '粘贴 SecretKey'"
          />
        </el-form-item>
        <el-form-item label="认证方式">
          <el-select v-model="profileForm.authStyle" style="width: 100%">
            <el-option label="Bearer 前缀（多数平台）" value="bearer" />
            <el-option label="直接粘贴 Key（部分平台）" value="raw" />
            <el-option label="火山引擎 AK/SK 签名" value="volc-sign" />
            <el-option label="阿里云 RPC 签名" value="aliyun-rpc" />
          </el-select>
        </el-form-item>
        <el-form-item label="模型名">
          <el-input v-model="profileForm.model" placeholder="模型对比时使用，如 deepseek-v4-flash" />
        </el-form-item>
        <el-form-item label="自定义余额地址">
          <el-input v-model="profileForm.balancePath" placeholder="留空就用平台默认地址" />
        </el-form-item>
        <el-form-item label="自动查询余额">
          <el-switch v-model="profileForm.balanceEnabled" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="profileDialog = false">取消</el-button>
        <el-button type="primary" @click="saveProfile">保存</el-button>
      </template>
    </el-dialog>

    <!-- ===== 手工录入弹窗 ===== -->
    <el-dialog v-model="manualDialog" title="手工录入余额" width="440px">
      <el-form label-width="80px">
        <el-form-item label="配置">
          <el-select v-model="manualForm.profileId" placeholder="选择要录入的配置" style="width: 100%">
            <el-option v-for="p in profiles" :key="p.id" :label="p.name" :value="p.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="金额">
          <el-input-number v-model="manualForm.total" :precision="2" :step="1" style="width: 100%" />
        </el-form-item>
        <el-form-item label="币种">
          <el-select v-model="manualForm.currency" style="width: 100%">
            <el-option label="人民币 CNY" value="CNY" />
            <el-option label="美元 USD" value="USD" />
          </el-select>
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="manualForm.note" placeholder="可选，如：按控制台截图核对" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="manualDialog = false">取消</el-button>
        <el-button type="primary" @click="saveManual">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.ai-page {
  display: block;
}
.tab-block {
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color);
  border-radius: var(--wb-radius-card);
  padding: 16px;
}
.tab-head {
  display: flex;
  /* 必须允许换行：否则窄宽度下右侧按钮会把标题挤成一字一行 */
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
  margin-bottom: 14px;
}
/*
 * 中文没有「单词」概念，min-content 宽度只有一个字符——flex 项一旦被压到
 * min-content 就会逐字换行。给个下限，配合 tab-head 的换行规则即可避免。
 */
.head-text {
  flex: 1 1 auto;
  min-width: 240px;
}
.tab-head h3 {
  margin: 0 0 4px;
  font-size: 15px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.sub {
  margin: 0;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  max-width: 560px;
}
.head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
  margin-left: auto;
}
.monitor-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  background: var(--el-fill-color-lighter);
  border: 1px solid var(--el-fill-color);
  border-radius: var(--wb-radius-base);
  padding: 10px 12px;
  margin-bottom: 16px;
  font-size: 13px;
}
.mb-label {
  color: var(--el-text-color-regular);
}
.mb-unit {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 12px;
}
.bal-card {
  border: 1px solid var(--el-border-color);
  border-radius: var(--wb-radius-card);
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  background: var(--el-bg-color);
}
.bal-card.pending,
.bal-card.add {
  border-style: dashed;
  cursor: pointer;
  align-items: center;
  justify-content: center;
  min-height: 180px;
  color: var(--el-text-color-secondary);
}
.bal-card.pending:hover,
.bal-card.add:hover {
  border-color: var(--el-color-primary);
  background: var(--el-fill-color-extra-light);
}
.bal-card.add:hover {
  color: var(--el-color-primary);
}
.bc-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.bc-name {
  font-weight: 600;
  color: var(--el-text-color-primary);
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bc-money {
  display: flex;
  align-items: baseline;
  gap: 6px;
}
.bc-value {
  font-size: 30px;
  font-weight: 700;
  color: var(--el-color-primary);
  line-height: 1.1;
  font-variant-numeric: tabular-nums;
}
.bc-label {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.bc-split {
  display: flex;
  gap: 12px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.bc-error {
  margin: 0;
}
.bc-error :deep(.el-alert__description) {
  font-size: 12px;
  word-break: break-all;
}
.bc-empty {
  font-size: 13px;
  color: var(--el-text-color-disabled);
}
.bc-pending {
  font-size: 22px;
  font-weight: 600;
  color: var(--el-text-color-disabled);
}
.bc-pending-tip {
  font-size: 12px;
}
.bc-quotas {
  border-top: 1px dashed var(--el-border-color);
  padding-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.quota-top {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  color: var(--el-text-color-regular);
}
.quota-num {
  font-variant-numeric: tabular-nums;
  color: var(--el-text-color-secondary);
}
.quota-reset {
  font-size: 11px;
  color: var(--el-text-color-disabled);
  margin-top: 2px;
}
.bc-foot {
  border-top: 1px solid var(--el-fill-color-light);
  padding-top: 8px;
  margin-top: auto;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.bc-time {
  font-size: 11px;
  color: var(--el-text-color-disabled);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.add-icon {
  font-size: 30px;
  line-height: 1;
}
.add-text {
  font-size: 13px;
  margin-top: 6px;
}
.provider-picker {
  max-height: 380px;
  overflow: auto;
}
.pp-item {
  padding: 10px;
  border-radius: var(--wb-radius-base);
  cursor: pointer;
}
.pp-item:hover {
  background: var(--el-fill-color-light);
}
.pp-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.pp-name {
  font-weight: 600;
  color: var(--el-text-color-primary);
  flex: 1;
}
.pp-note {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin-top: 4px;
  line-height: 1.5;
}
.pp-meta {
  font-size: 11px;
  color: var(--el-text-color-disabled);
  margin-top: 4px;
}
.pp-empty {
  padding: 12px;
  color: var(--el-text-color-secondary);
  font-size: 13px;
}

/* ===== 趋势与消耗分析（浅灰圆角卡片 + 极简坐标轴，对齐平台用量仪表盘的观感）===== */
.analysis {
  margin-top: 20px;
  border-top: 1px solid var(--el-border-color);
  padding-top: 14px;
}
.an-head {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}
.an-head h4 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.an-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.an-card {
  background: var(--el-fill-color-light);
  border-radius: var(--wb-radius-card);
  padding: 14px 16px 10px;
  margin-bottom: 12px;
}
.an-card-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}
.an-card-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--el-text-color-primary);
}
.an-card-sub {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.an-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 12px;
}
/* 汇总卡复用卡片的底色，自己只调内边距与最小宽度 */
.an-stat {
  flex: 1 1 190px;
  min-width: 170px;
  margin-bottom: 0;
  padding: 12px 16px 14px;
}
.an-stat-num {
  font-size: 24px;
  font-weight: 700;
  color: var(--el-text-color-primary);
  line-height: 1.2;
  font-variant-numeric: tabular-nums;
}
.an-stat-num.is-warn {
  color: #e24b4a;
}
.an-stat-unit {
  font-size: 14px;
  font-weight: 500;
  color: var(--el-text-color-secondary);
}
.an-chart {
  width: 100%;
  height: 200px;
}
.an-note {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin-top: 2px;
  padding-bottom: 4px;
}
.an-skip {
  margin-top: 6px;
  background: var(--el-bg-color);
  border-radius: var(--wb-radius-card);
  padding: 8px 10px;
}
.an-skip-row {
  display: flex;
  gap: 8px;
  font-size: 12px;
  line-height: 1.8;
}
.an-skip-name {
  color: var(--el-text-color-regular);
  flex-shrink: 0;
  min-width: 96px;
}
.an-skip-reason {
  color: var(--el-text-color-secondary);
}

.prompt-layout {
  display: flex;
  gap: 14px;
  align-items: flex-start;
}
.pl-list {
  width: 240px;
  flex-shrink: 0;
  border: 1px solid var(--el-border-color);
  border-radius: var(--wb-radius-card);
  padding: 10px;
}
.pl-head {
  display: flex;
  gap: 6px;
  margin-bottom: 10px;
}
.pl-items {
  max-height: 560px;
  overflow: auto;
}
.pl-item {
  padding: 8px 10px;
  border-radius: var(--wb-radius-base);
  cursor: pointer;
  margin-bottom: 2px;
}
.pl-item:hover {
  background: var(--el-fill-color-light);
}
.pl-item.active {
  background: var(--el-color-primary-light-9);
}
.pl-name {
  font-size: 13px;
  color: var(--el-text-color-primary);
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pl-item.active .pl-name {
  color: var(--el-color-primary);
}
.pl-meta {
  font-size: 11px;
  color: var(--el-text-color-disabled);
  margin-top: 2px;
}
.pl-editor {
  flex: 1;
  min-width: 0;
}
.var-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}
.case-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin: 6px 0 8px;
  font-size: 13px;
  color: var(--el-text-color-regular);
}
.case-row {
  display: grid;
  grid-template-columns: 1fr 1fr auto;
  gap: 6px;
  margin-bottom: 6px;
}
.editor-actions {
  margin-top: 14px;
  display: flex;
  gap: 8px;
}

.cmp-config {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-bottom: 18px;
}
.cmp-field label {
  display: block;
  font-size: 13px;
  color: var(--el-text-color-regular);
  margin-bottom: 4px;
}
.cmp-results {
  display: flex;
  gap: 12px;
  overflow-x: auto;
  align-items: flex-start;
}
.cmp-col {
  flex: 1 0 320px;
  min-width: 320px;
  border: 1px solid var(--el-border-color);
  border-radius: var(--wb-radius-card);
  padding: 10px;
}
.cmp-col-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 8px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--el-fill-color-light);
}
.cmp-col-name {
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.cmp-col-model {
  font-size: 11px;
  color: var(--el-text-color-disabled);
}
.cmp-out {
  margin-bottom: 12px;
}
.cmp-out-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}
.cmp-case {
  font-size: 12px;
  color: var(--el-text-color-regular);
  background: var(--el-fill-color-light);
  border-radius: var(--wb-radius-small);
  padding: 1px 6px;
  white-space: nowrap;
}
.cmp-stat {
  font-size: 11px;
  color: var(--el-text-color-disabled);
  white-space: nowrap;
}
.cmp-text {
  margin: 0;
  padding: 8px;
  background: var(--el-fill-color-lighter);
  border: 1px solid var(--el-fill-color);
  border-radius: var(--wb-radius-base);
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 320px;
  overflow: auto;
}
.cmp-frame {
  width: 100%;
  height: 340px;
  border: 1px solid var(--el-border-color);
  border-radius: var(--wb-radius-base);
  background: var(--el-bg-color);
}

.sandbox-frame-wrap {
  margin-top: 12px;
  border: 1px solid var(--el-border-color);
  border-radius: var(--wb-radius-card);
  overflow: hidden;
}
.sandbox-frame {
  width: 100%;
  height: 460px;
  border: 0;
  background: var(--el-bg-color);
  display: block;
}
.dialog-note {
  margin-bottom: 12px;
}
.form-tip {
  color: var(--el-text-color-secondary);
  font-size: 12px;
  margin-top: 4px;
  display: block;
}
</style>
