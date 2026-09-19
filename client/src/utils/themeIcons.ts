import {
  AlarmClock,
  Bell,
  Calendar,
  Collection,
  DataAnalysis,
  FolderOpened,
  Football,
  Grid,
  Histogram,
  House,
  MagicStick,
  Notebook,
  Reading,
  Setting,
  Timer,
  TrendCharts,
  View,
  Wallet,
} from '@element-plus/icons-vue'
import {
  Bell as BellLine, // ⚠️ 与 EP 的 Bell 同名，必须别名
  BookOpen,
  CalendarClock,
  CalendarDays,
  ChartColumn,
  Feather,
  FolderOpen,
  Footprints,
  GraduationCap,
  LayoutDashboard,
  Library,
  Monitor,
  NotebookPen,
  Settings as SettingsLine,
  Sparkles,
  Timer as TimerLine,
  Wallet as WalletLine,
  Wrench,
} from '@lucide/vue'
import type { Component } from 'vue'
import { appearance } from '../stores/appearance'
import ClaudeMark from '../components/icons/ClaudeMark.vue'

/**
 * 每个主题可以有**自己的一套图标**。
 *
 * 为什么不是"全站换成某一个图标库"：主题的辨识度很大程度来自图标语言——
 * macOS 那套靠彩色圆角方形（见 `components/AppIcon.vue`），Claude 的界面是
 * **细线、单色、暖灰**，纸质手账则是一支墨线。混着用就会"不搭"（用户 2026-09-18 的原话）。
 * 所以这里把「导航/入口用哪个图标」抽象成**逻辑名**（`IconKey`），各主题各自登记：
 *
 *   逻辑名 'notes' → default/macos: EP 的 Notebook（实心面）
 *                  → claude       : Lucide 的 NotebookPen（细线 + 淡暖底方片）
 *                  → paper        : 同一个 Lucide 字形（裸墨线 + 细一级笔触）
 *
 * Claude 与 paper **共用 Lucide 字形**，但两套主题对它的处理完全不同（见各自 themes/*.css
 * 的「图标语言」段）——真实设计系统里两套主题共用字形、各自处理很常见，真正拉开差别的是
 * 底色/笔触/形状，而不是每个字形都要不同。
 *
 * 加一套主题时：想换字形就加一份映射，不想换就什么都不用做（自动回落 `default`）。
 *
 * 用法：`themedIcon('notes')` —— 读 `appearance.theme`，在模板里调用即自动响应主题切换
 * （Vue 会追踪渲染过程中读到的响应式属性）。
 *
 * 图标许可：`@lucide/vue` 为 **ISC**；EP 图标随 element-plus（MIT）；Claude 星芒见 ClaudeMark.vue 的说明。
 *
 * ⚠️ **两个图标库有同名图标，必须别名**（否则 TypeScript 不报错、静默用成 EP 那个）：
 * 已踩过 `Bell`（EP 实心 vs Lucide 细线，导致 Claude 主题下「上课提醒」混进一个实心图标）。
 * 目前用到别名的：`Bell as BellLine`、`Settings as SettingsLine`、`Timer as TimerLine`、`Wallet as WalletLine`。
 * **加新条目后要实测一次它渲染出来是线稿还是实心**——判断法：Lucide 的 svg 是
 * `stroke="currentColor" fill="none"`，EP 的是 `fill="currentColor"`（见交接文档的自查脚本）。
 */

export type IconKey =
  | 'logo'
  | 'dashboard'
  | 'schedule'
  | 'scheduleGrid'
  | 'scheduleRemind'
  | 'chaoxing'
  | 'notes'
  | 'projects'
  | 'aiLab'
  | 'balance'
  | 'prompts'
  | 'compare'
  | 'sandbox'
  | 'tools'
  | 'runs'
  | 'countdown'
  | 'scores'
  | 'pomodoro'
  | 'settings'

/** 实心面一套：default 与 macOS 共用（用户 2026-09-18 明确说这两套保持一样即可） */
const SOLID: Record<IconKey, Component> = {
  logo: Grid,
  dashboard: House,
  schedule: Calendar,
  scheduleGrid: Calendar,
  scheduleRemind: Bell,
  chaoxing: Reading,
  notes: Notebook,
  projects: FolderOpened,
  aiLab: MagicStick,
  balance: Wallet,
  prompts: Collection,
  compare: DataAnalysis,
  sandbox: View,
  tools: Histogram,
  runs: Football,
  countdown: AlarmClock,
  scores: TrendCharts,
  pomodoro: Timer,
  settings: Setting,
}

/** 细线一套：claude 与 paper 共用**字形**（各自的处理完全不同，见 themes/claude.css、themes/paper.css） */
const LINE: Record<IconKey, Component> = {
  logo: Feather,
  dashboard: LayoutDashboard,
  schedule: CalendarDays,
  scheduleGrid: CalendarDays,
  scheduleRemind: BellLine,
  chaoxing: BookOpen,
  notes: NotebookPen,
  projects: FolderOpen,
  aiLab: Sparkles,
  balance: WalletLine,
  prompts: Library,
  compare: ChartColumn,
  sandbox: Monitor,
  tools: Wrench,
  runs: Footprints,
  countdown: CalendarClock,
  scores: GraduationCap,
  pomodoro: TimerLine,
  settings: SettingsLine,
}

interface IconSet {
  default: Component
  claude?: Component
  paper?: Component
}

const ICONS = Object.fromEntries(
  (Object.keys(SOLID) as IconKey[]).map((k) => [
    k,
    {
      default: SOLID[k],
      // Claude 的 logo 是它自己的星芒（官方图形，见 ClaudeMark.vue），其余走细线一套
      claude: k === 'logo' ? ClaudeMark : LINE[k],
      paper: LINE[k],
    } satisfies IconSet,
  ]),
) as Record<IconKey, IconSet>

/** 取当前主题下该逻辑名对应的图标组件 */
export function themedIcon(key: IconKey): Component {
  const set = ICONS[key]
  return set[appearance.theme as keyof IconSet] ?? set.default
}
