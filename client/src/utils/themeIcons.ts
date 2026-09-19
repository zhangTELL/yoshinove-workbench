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
 * macOS 那套靠彩色圆角方形（见 `components/AppIcon.vue`），而 Claude 的界面是
 * **细线、单色、暖灰**，两者混着用就会"不搭"（用户 2026-09-18 的原话）。
 * 所以这里把「导航/入口用哪个图标」抽象成**逻辑名**（`IconKey`），各主题各自登记一张表：
 *
 *   逻辑名 'notes'  →  default/macos: EP 的 Notebook（实心面）  /  claude: Lucide 的 NotebookPen（细线）
 *
 * 加一套主题时：想换图标就在表里加一列，不想换就什么都不用做（自动回落 `default`）。
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

interface IconSet {
  /** 兜底：default 与 macOS 共用（用户 2026-09-18 明确说这两套保持一样即可） */
  default: Component
  /** Claude 主题：换成一套细线图标，与 Epic 的实心面拉开区别 */
  claude?: Component
}

const ICONS: Record<IconKey, IconSet> = {
  logo: { default: Grid, claude: ClaudeMark },

  dashboard: { default: House, claude: LayoutDashboard },

  schedule: { default: Calendar, claude: CalendarDays },
  scheduleGrid: { default: Calendar, claude: CalendarDays },
  scheduleRemind: { default: Bell, claude: BellLine },

  chaoxing: { default: Reading, claude: BookOpen },
  notes: { default: Notebook, claude: NotebookPen },
  projects: { default: FolderOpened, claude: FolderOpen },

  aiLab: { default: MagicStick, claude: Sparkles },
  balance: { default: Wallet, claude: WalletLine },
  prompts: { default: Collection, claude: Library },
  compare: { default: DataAnalysis, claude: ChartColumn },
  sandbox: { default: View, claude: Monitor },

  tools: { default: Histogram, claude: Wrench },
  runs: { default: Football, claude: Footprints },
  countdown: { default: AlarmClock, claude: CalendarClock },
  scores: { default: TrendCharts, claude: GraduationCap },
  pomodoro: { default: Timer, claude: TimerLine },

  settings: { default: Setting, claude: SettingsLine },
}

/** 取当前主题下该逻辑名对应的图标组件 */
export function themedIcon(key: IconKey): Component {
  const set = ICONS[key]
  return set[appearance.theme as keyof IconSet] ?? set.default
}
