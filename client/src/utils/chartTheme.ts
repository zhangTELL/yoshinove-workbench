/**
 * echarts 主题用色：echarts 不认 CSS 变量（canvas 绘制），所以每次渲染前
 * 从 documentElement 取语义变量的计算值。
 *
 * 用法：const p = chartPalette() 然后把坐标轴/图例/系列颜色从字面量换成 p.*；
 * 组件里 watch 外观变化（appearance.appearance / fontScale）后重渲染即可换肤。
 *
 * ★ 2026-09-20 扩充：**系列色板与阈值色也进契约层**（原先只在 AiLabView 里写死 8 个色值，
 *   切主题时坐标轴会跟着变、柱子却是死的，等于"半换肤"）。现在三组值都由 CSS 变量提供：
 *
 *   --wb-chart-1..8   分类系列色板（多平台折线 / 饼图 / 多系列柱）
 *   --wb-chart-safe / -warn / -danger   阈值语义色（"剩余天数"这类按数值分档上色）
 *   --wb-accent-text   强调色当**小号文字**用的变体（主色本身对比度不够，见 tokens.css）
 *
 * 四套主题的取值都实测过：对比度 ≥3:1（默认主题对着纯白卡片量的）、
 * 两两 RGB 距离 ≥45（色觉友好基准色相，避免同图两条线分不清）。
 * 改动色值时请重跑这两个量，别只肉眼看。
 */

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

export interface ChartPalette {
  /** 主文本（标题） */
  text1: string
  /** 常规文本（坐标轴标签、图例） */
  text2: string
  /** 次要文本 */
  text3: string
  /** 分隔线/网格线 */
  border: string
  accent: string
  /** 强调色的"文字用"变体（比 accent 暗，小号文字上对比度达标） */
  accentText: string
  success: string
  warning: string
  danger: string
  /** 阈值三档（深→浅：危险 / 警告 / 安全），默认与 success/warning/danger 同源 */
  dangerColor: string
  warnColor: string
  safeColor: string
  /** 同三档的**文字版**（比色块版更深，小字/图标上才够 4.5:1） */
  dangerText: string
  warnText: string
  safeText: string
  /** 图表背景（一般保持透明，深浅色都由容器承担） */
  bg: string
}

export function chartPalette(): ChartPalette {
  // 语义三档**分两族**读（原因见 tokens.css 的"色块族/文字族"注释）：
  //   --wb-chart-safe/warn/danger        色块档（≥3:1，取亮档不累眼）→ success/warning/danger 与三个 *Color
  //   --wb-chart-*-text                  文字档（≥4.5:1）→ safeText/warnText/dangerText
  // 两族默认值都回落到 EP 的状态色，保证任何主题下都不会"没颜色可用"。
  const safe = cssVar('--wb-chart-safe', cssVar('--el-color-success', '#4E9A51'))
  const warn = cssVar('--wb-chart-warn', cssVar('--el-color-warning', '#C08214'))
  const danger = cssVar('--wb-chart-danger', cssVar('--el-color-danger', '#C7463A'))
  const safeText = cssVar('--wb-chart-safe-text', cssVar('--el-color-success', '#3D8A3F'))
  const warnText = cssVar('--wb-chart-warn-text', cssVar('--el-color-warning', '#A06B00'))
  const dangerText = cssVar('--wb-chart-danger-text', cssVar('--el-color-danger', '#C0392B'))
  return {
    text1: cssVar('--el-text-color-primary', '#303133'),
    text2: cssVar('--el-text-color-regular', '#606266'),
    text3: cssVar('--el-text-color-secondary', '#909399'),
    border: cssVar('--el-border-color', '#ebeef5'),
    accent: cssVar('--el-color-primary', '#409eff'),
    accentText: cssVar('--wb-accent-text', cssVar('--el-color-primary', '#409eff')),
    success: safe,
    warning: warn,
    danger,
    dangerColor: danger,
    warnColor: warn,
    safeColor: safe,
    safeText,
    warnText,
    dangerText,
    bg: 'transparent',
  }
}

/** 分类系列色板（默认主题的 8 支；主题可整体替换） */
export function chartSeries(): string[] {
  const defaults = ['#3B6FB6', '#2F855A', '#A85F0A', '#C2185B', '#7C3AED', '#0E7490', '#8A5A3C', '#52525B']
  return defaults.map((d, i) => cssVar(`--wb-chart-${i + 1}`, d))
}

/**
 * "数据柱"的颜色：**某个基色混向表面色的柔化版**（默认基色 = 当前主题强调色）。
 *
 * 为什么需要它、而不是直接用 `chartPalette().accent`：
 *   成绩绩点那种"23 门课 23 根长条"的图，如果每根都用高饱和色，一屏就是**一面色墙**，
 *   再叠上语义色同框，观感很吵（用户 2026-09-20 连续三轮反馈）。
 *   做法：**数据柱用"基色柔化 N%"**（跟着主题走、天生协调）；
 *   要标出来的档位（如低于平均分）用**同一个函数、基色换成主题危险色**——
 *   语义仍在（要留意），但色相也跟着主题走，而不是四套共用一支琥珀。
 *
 * 三种用法：
 *   chartBarColor(0.5, p.accent)   主数据柱（灰一点的主题色）
 *   chartBarColor(0.5, p.danger)   需要标出的档位（灰一点的主题危险色）
 *   chartBarColor()                不给基色时的兜底 = `--wb-chart-bar`，其次 accent 85%
 *
 * ⚠️ **必须在 JS 里算出 hex，不能把 `color-mix()` 字符串交给 echarts**：
 *   zrender 用的是自己的颜色解析器，不认 CSS 的 color-mix ⇒ 解析失败会**静默回落成灰色**
 *   （2026-09-20 实测：柱子整排变成 `#555`，页面不报错、typecheck 也不报）。同类坑还有
 *   `var(--x)` 字符串、`light-dark()` 等，凡是"浏览器才懂"的语法都别丢给 canvas。
 *
 * ⚠️ 柔化后的对比度是 1.6~2.4:1，**低于** WCAG 对"纯色图形"的 3:1。
 *   这是**有意的取舍**，前提是该图**每根柱子都带数值标签**（本项目所有成绩/消耗图都带），
 *   颜色只是"结构性冗余"，去掉颜色也不影响读数。若将来有**不带标签**的柱状图，
 *   请直接用 `chartSeries()` 或语义色，别用这个函数。
 * @param strength 基色占比（0~1）：越小越淡
 * @param base 基色（hex/rgb 可解析的颜色）；省略则用 `--wb-chart-bar`，其次 accent 85%
 */
export function chartBarColor(strength = 0.85, base?: string): string {
  if (!base) {
    const explicit = cssVar('--wb-chart-bar', '')
    if (explicit) return explicit
  }
  const from = base ?? cssVar('--el-color-primary', '#409eff')
  const surface = cssVar('--wb-surface', '#ffffff')
  return mixHex(from, surface, strength)
}

/**
 * "要注意的那几档"的柱色（本项目的用法：成绩图里**低于平均分**的课）。
 *
 * 规则 = **同一支主题色，但明显更深的一档**（色相不动、明度压到 0.62）。
 *
 * 为什么最后落到"只改明度、而且往深走"（三轮试错的结论，别改回去）：
 *   ① 用主题危险色（`chartBarColor(0.5, p.danger)`）→ **纸页主题翻车**：
 *      accent `#b7282e` 与 danger `#ba3a32` 柔化后色差只有 9.3，低分柱直接消失；
 *   ② 改用"色相偏转"（朝 danger 方向偏 28°/48°/60°/75° 都试过）→ **暖色主题无解**：
 *      Claude 的 accent `#d97757` 到 danger `#b8463a` 只有约 17° 空间，色差被卡在 12 左右；
 *   ③ 试"同色相更浅"→ **也没有空间**：主柱柔化 50% 之后明度已经是 0.81，
 *      再往上抬对比只有 1.01（等于没变，实测数字）；
 *   ④ 最终：色相不动、**明度压到 0.62**（主柱 0.81 → 标记柱 0.62）——
 *      颜色仍是"本主题的色"，但深了一档，四套实测明度对比 1.6~2.4（肉眼可分）。
 *
 * 与主柱配套：主柱 `chartBarColor(0.5, p.accent)`，标记柱 `chartAlertColor()`。
 * 另外图上还有一条**平均分虚线**，所以颜色不是唯一的线索（这是刻意的冗余）。
 */
export function chartAlertColor(strength = 0.5, sink = 0.62): string {
  const accent = cssVar('--el-color-primary', '#409eff')
  const surface = cssVar('--wb-surface', '#ffffff')
  const soft = mixHex(accent, surface, strength)
  const softHsl = toHsl(soft)
  if (!softHsl) return soft
  // 明度向 sink 压（若主柱本来就更深，则保持主柱那一档，绝不反向变浅）
  const l = Math.min(softHsl[2], sink)
  // 饱和度保持柔化档的原始比例：**不要再往上提**——
  // 实测提到 ×1.15 会让 Claude/纸页 变成 `#FF6D3D` / `#FF403D` 这种近乎纯色的亮橙/亮红，
  // 与"同色相、只是深一档"的定位不符（也会重新引入"喊叫感"）。
  return fromHsl([softHsl[0], softHsl[1], l])
}

/** hex → [h, s, l]（h 度、s/l 0~1） */
function toHsl(hex: string): [number, number, number] | null {
  const c = parseHex(hex)
  if (!c) return null
  const [r0, g0, b0] = c.map((v) => v / 255) as [number, number, number]
  const mx = Math.max(r0, g0, b0)
  const mn = Math.min(r0, g0, b0)
  const l = (mx + mn) / 2
  if (mx === mn) return [0, 0, l]
  const d = mx - mn
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn)
  let h: number
  if (mx === r0) h = ((g0 - b0) / d + (g0 < b0 ? 6 : 0)) * 60
  else if (mx === g0) h = ((b0 - r0) / d + 2) * 60
  else h = ((r0 - g0) / d + 4) * 60
  return [h, s, l]
}

/** [h, s, l] → hex */
function fromHsl(hsl: [number, number, number]): string {
  const [h, s, l] = hsl
  const c = (1 - Math.abs(2 * l - 1)) * s
  const hp = h / 60
  const x = c * (1 - Math.abs((hp % 2) - 1))
  const m = l - c / 2
  let rgb: [number, number, number]
  if (hp < 1) rgb = [c, x, 0]
  else if (hp < 2) rgb = [x, c, 0]
  else if (hp < 3) rgb = [0, c, x]
  else if (hp < 4) rgb = [0, x, c]
  else if (hp < 5) rgb = [x, 0, c]
  else rgb = [c, 0, x]
  const to255 = (v: number) =>
    Math.max(0, Math.min(255, Math.round((v + m) * 255)))
    .toString(16)
    .padStart(2, '0')
  return `#${to255(rgb[0])}${to255(rgb[1])}${to255(rgb[2])}`
}

/** 把 hex 颜色按 p 的比例混向另一个 hex（返回 hex；解析失败则原样返回 a） */
function mixHex(a: string, b: string, p: number): string {
  const pa = parseHex(a)
  const pb = parseHex(b)
  if (!pa || !pb) return a
  const mix = (i: number) => Math.round(pa[i] * p + pb[i] * (1 - p))
  const hex = (v: number) => v.toString(16).padStart(2, '0')
  return `#${hex(mix(0))}${hex(mix(1))}${hex(mix(2))}`
}

/** 支持 #rgb / #rrggbb / rgb() / rgba()；其它（含 color-mix、var）返回 null */
function parseHex(c: string): [number, number, number] | null {
  const s = c.trim()
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s)
  if (m) {
    const h = m[1]
    if (h.length === 3) {
      return [
        parseInt(h[0] + h[0], 16),
        parseInt(h[1] + h[1], 16),
        parseInt(h[2] + h[2], 16),
      ]
    }
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
  }
  const r = /^rgba?\(\s*(\d+)\s*[,\s]\s*(\d+)\s*[,\s]\s*(\d+)/i.exec(s)
  if (r) return [Number(r[1]), Number(r[2]), Number(r[3])]
  return null
}
