import { reactive, watch } from 'vue'

/**
 * 外观设置：主题模式 / 主题色 / 圆角 / 字号 / 语言。
 *
 * 与旧版「占位页」的区别：这里的状态会真实写到 documentElement 上——
 *   - 主题模式：html.dark（Element Plus 官方深色变量）+ auto 跟随系统
 *   - 主题色：--el-color-primary 及其 light/dark 梯度（按 EP 官方 tint 比例用 color-mix 现算）
 *   - 圆角：--el-border-radius-* 与卡片圆角
 *   - 字号：#app 的 zoom（EP 全用 px，改根 font-size 无效；本地应用与 Electron 都是 Chromium）
 * 持久化沿用 workbench.uiPrefs（与占位时期同键，老数据直接迁移）。
 */

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
  /** 主题预置卡（樱花/森林/暗夜）：暂未生效，只记录选择 */
  theme: 'default',
}

export const appearance = reactive({ ...DEFAULTS })

export function resetAppearance(): void {
  Object.assign(appearance, DEFAULTS)
}

const media = window.matchMedia?.('(prefers-color-scheme: dark)')

function isDark(): boolean {
  return appearance.appearance === 'dark' || (appearance.appearance === 'auto' && !!media?.matches)
}

/** 把当前外观写到 documentElement。所有副作用集中在这里，方便整体重放 */
export function applyAppearance(): void {
  const root = document.documentElement
  root.classList.toggle('dark', isDark())

  const s = root.style
  const a = appearance.accent
  // EP 官方梯度：light-N = 主色 N×10% 混白；dark-2 = 主色 80% 混黑
  s.setProperty('--el-color-primary', a)
  s.setProperty('--el-color-primary-dark-2', `color-mix(in srgb, ${a} 80%, #000)`)
  for (const n of [3, 5, 7, 8, 9]) {
    s.setProperty(`--el-color-primary-light-${n}`, `color-mix(in srgb, ${a} ${100 - n * 10}%, #fff)`)
  }

  const r = appearance.radius
  s.setProperty('--el-border-radius-base', `${r}px`)
  s.setProperty('--el-border-radius-small', `${Math.max(2, Math.round(r * 0.6))}px`)
  s.setProperty('--el-card-border-radius', `${Math.max(3, Math.round(r * 1.5))}px`)

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
