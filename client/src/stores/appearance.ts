import { reactive, watch } from 'vue'

/**
 * 外观设置：主题预置 / 主题模式 / 主题色 / 圆角 / 字号 / 语言。
 *
 * 变量分层（详见 styles/tokens.css 的说明）：
 *   主题预设（themes/*.css）→ --wb-* 语义契约 → bridge.css 映射到 --el-*（组件只认 EP 变量）
 * 本文件负责把状态写到 documentElement：
 *   - 主题预置：`data-wb-theme=<id>`（预置主题的规则靠这个属性命中）
 *   - 主题模式：`html.dark`（**只有 default 主题允许**：四套预置主题都是浅色专用）
 *   - 主题色：--el-color-primary 及其 light/dark 梯度（按 EP 官方 tint 比例用 color-mix 现算）
 *   - 圆角：--wb-radius-{base,small,card}（契约层；bridge.css 再映射到 EP 的 --el-*）
 *   - 字号：#app 的 zoom（EP 全用 px，改根 font-size 无效；本地应用与 Electron 都是 Chromium）
 * 持久化沿用 workbench.uiPrefs（与占位时期同键，老数据直接迁移）。
 */
import { themePreset } from '../utils/themePresets'

export type AppearanceMode = 'light' | 'dark' | 'auto'
export type FontScale = 'small' | 'normal' | 'large' | 'xlarge'
export type AppLanguage = 'zh-CN' | 'zh-TW' | 'en-US' | 'ja-JP'

const KEY = 'workbench.uiPrefs'
const ZOOM: Record<FontScale, number> = { small: 0.9, normal: 1, large: 1.08, xlarge: 1.2 }

const DEFAULTS = {
  appearance: 'light' as AppearanceMode,
  accent: '#409eff',
  radius: 6,
  fontScale: 'normal' as FontScale,
  language: 'zh-CN' as AppLanguage,
  /** 主题预置：见 utils/themePresets.ts（default / macos / claude / paper / miko） */
  theme: 'default',
}

export const appearance = reactive({ ...DEFAULTS })

export function resetAppearance(): void {
  Object.assign(appearance, DEFAULTS)
}

/**
 * 切换主题预设。
 * 把该主题的默认强调色/圆角一并写入——「主题自带一套协调的默认值，之后用户改了就以用户为准」，
 * 这样比"主题只改背景色、强调色还是上一个人的"要可预期得多。
 * 预置主题都是浅色专用，所以顺手把明暗切回浅色。
 */
export function applyThemePreset(id: string): void {
  const p = themePreset(id)
  if (!p.ready) return
  appearance.theme = p.id
  if (p.accent) appearance.accent = p.accent
  if (typeof p.radius === 'number') appearance.radius = p.radius
  if (p.id !== 'default') appearance.appearance = 'light'
}

/** 当前主题是否锁定了明暗（四套预置主题都没有深色，UI 上要把明暗切换禁用掉） */
export function themeLocksMode(): boolean {
  return themePreset(appearance.theme).id !== 'default'
}

const media = window.matchMedia?.('(prefers-color-scheme: dark)')

function isDark(): boolean {
  return appearance.appearance === 'dark' || (appearance.appearance === 'auto' && !!media?.matches)
}

/** 把当前外观写到 documentElement。所有副作用集中在这里，方便整体重放 */
export function applyAppearance(): void {
  const root = document.documentElement
  const preset = themePreset(appearance.theme)
  // 深色只属于 default 主题：四套预置主题都是浅色专用，激活时强制不挂 html.dark
  root.classList.toggle('dark', preset.id === 'default' && isDark())
  // 预置主题的规则以 data-wb-theme 作用域声明（见 styles/themes/*.css）
  root.dataset.wbTheme = preset.id

  const s = root.style
  const a = appearance.accent
  // EP 官方梯度：light-N = 主色 N×10% 混白；dark-2 = 主色 80% 混黑
  s.setProperty('--el-color-primary', a)
  s.setProperty('--el-color-primary-dark-2', `color-mix(in srgb, ${a} 80%, #000)`)
  for (const n of [3, 5, 7, 8, 9]) {
    s.setProperty(`--el-color-primary-light-${n}`, `color-mix(in srgb, ${a} ${100 - n * 10}%, #fff)`)
  }

  // 圆角：写的是契约层的 --wb-radius-*，由 bridge.css 映射到 EP。
  // ⚠️ 不要在这里直接写 --el-card-border-radius：EP 把它声明在 .el-card 自己身上，
  //    html 上的值传不进去（2026-09-18 实测踩过，卡片圆角被锁死在 4px）。
  const r = appearance.radius
  s.setProperty('--wb-radius-base', `${r}px`)
  s.setProperty('--wb-radius-small', `${Math.max(2, Math.round(r * 0.6))}px`)
  s.setProperty('--wb-radius-card', `${Math.max(3, Math.round(r * 1.5))}px`)

  const app = document.getElementById('app')
  const z = ZOOM[appearance.fontScale] ?? 1
  if (app) {
    // zoom 会把"已使用的宽高"一起放大，宽高各除回去，保证缩放后仍正好占满视口
    app.style.zoom = String(z)
    app.style.width = `${100 / z}%`
    app.style.height = `${100 / z}%`
  }
}

/** 主题相关状态变化后广播；画在 canvas 上的 echarts 靠这个事件重渲染换肤 */
export function emitThemeChange(): void {
  window.dispatchEvent(new CustomEvent('wb-theme-change'))
}

export function initAppearance(): void {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) Object.assign(appearance, JSON.parse(raw))
  } catch {
    /* 坏数据回落默认值 */
  }
  // 老版本占位期的主题 id（sakura / forest / night）已经不存在了，
  // 不归一化的话会出现「主题名是个不存在的值、样式却没有」的中间态。
  if (!themePreset(appearance.theme).ready) appearance.theme = DEFAULTS.theme
  applyAppearance()

  watch(appearance, () => {
    applyAppearance()
    emitThemeChange()
    try {
      localStorage.setItem(KEY, JSON.stringify(appearance))
    } catch {
      /* 隐私模式下 localStorage 可能不可用，忽略 */
    }
  })

  // 跟随系统：系统切换深浅色时即时响应（appearance 值不变，watch 不会触发，所以单独发事件）
  media?.addEventListener('change', () => {
    if (appearance.appearance === 'auto') {
      applyAppearance()
      emitThemeChange()
    }
  })
}
