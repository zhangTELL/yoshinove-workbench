import zhCn from 'element-plus/es/locale/lang/zh-cn'
import zhTw from 'element-plus/es/locale/lang/zh-tw'
import en from 'element-plus/es/locale/lang/en'
import ja from 'element-plus/es/locale/lang/ja'
import { computed } from 'vue'
import { appearance } from '../stores/appearance'

/**
 * 轻量 i18n：
 *  - `t()`：界面文案字典（当前覆盖侧边导航与标签页标题；功能页内容文案渐进迁移）
 *  - `epLocale`：Element Plus 组件语言（日期面板 / 分页 / 表格空态等，全量生效）
 *
 * t() 在模板里直接调用即可保持响应式——渲染时读了 appearance.language，会被依赖收集。
 */

type Dict = Record<string, string>

const zhCN: Dict = {
  'nav.dashboard': '首页',
  'nav.schedule': '课表',
  'nav.scheduleGrid': '课程表',
  'nav.scheduleRemind': '上课提醒',
  'nav.chaoxing': '学习通作业',
  'nav.notes': '笔记',
  'nav.projects': '项目管理',
  'nav.ai-lab': 'AI 实验区',
  'nav.balance': '账户余额',
  'nav.prompts': 'Prompt 库',
  'nav.compare': '模型对比',
  'nav.sandbox': '沙箱渲染',
  'nav.tools': '日常工具',
  'nav.runs': '健康跑',
  'nav.countdown': '倒计日',
  'nav.scores': '成绩绩点',
  'nav.pomodoro': '番茄钟',
  'nav.settings': '设置',
  'app.suffix': ' 的工作台',
  'app.name': 'Yoshinove',
}

const zhTW: Dict = {
  'nav.dashboard': '首頁',
  'nav.schedule': '課表',
  'nav.scheduleGrid': '課程表',
  'nav.scheduleRemind': '上課提醒',
  'nav.chaoxing': '學習通作業',
  'nav.notes': '筆記',
  'nav.projects': '專案管理',
  'nav.ai-lab': 'AI 實驗區',
  'nav.balance': '帳戶餘額',
  'nav.prompts': 'Prompt 庫',
  'nav.compare': '模型對比',
  'nav.sandbox': '沙箱渲染',
  'nav.tools': '日常工具',
  'nav.runs': '健康跑',
  'nav.countdown': '倒數日',
  'nav.scores': '成績績點',
  'nav.pomodoro': '番茄鐘',
  'nav.settings': '設定',
  'app.suffix': ' 的工作台',
  'app.name': 'Yoshinove',
}

const enUS: Dict = {
  'nav.dashboard': 'Home',
  'nav.schedule': 'Timetable',
  'nav.scheduleGrid': 'Timetable',
  'nav.scheduleRemind': 'Class Alerts',
  'nav.chaoxing': 'Homework',
  'nav.notes': 'Notes',
  'nav.projects': 'Projects',
  'nav.ai-lab': 'AI Lab',
  'nav.balance': 'Balance',
  'nav.prompts': 'Prompts',
  'nav.compare': 'Model Compare',
  'nav.sandbox': 'Sandbox',
  'nav.tools': 'Utilities',
  'nav.runs': 'Running',
  'nav.countdown': 'Countdown',
  'nav.scores': 'Scores & GPA',
  'nav.pomodoro': 'Pomodoro',
  'nav.settings': 'Settings',
  'app.suffix': "'s Workspace",
  'app.name': 'Yoshinove',
}

const jaJP: Dict = {
  'nav.dashboard': 'ホーム',
  'nav.schedule': '時間割',
  'nav.scheduleGrid': '授業表',
  'nav.scheduleRemind': '授業リマインダー',
  'nav.chaoxing': '課題',
  'nav.notes': 'ノート',
  'nav.ai-lab': 'AIラボ',
  'nav.balance': '残高',
  'nav.prompts': 'Promptライブラリ',
  'nav.compare': 'モデル比較',
  'nav.sandbox': 'サンドボックス',
  'nav.tools': 'ツール',
  'nav.runs': 'ランニング',
  'nav.countdown': 'カウントダウン',
  'nav.scores': '成績・GPA',
  'nav.pomodoro': 'ポモドーロ',
  'nav.settings': '設定',
  'app.suffix': 'のワークスペース',
  'app.name': 'Yoshinove',
}

const DICTS: Record<string, Dict> = { 'zh-CN': zhCN, 'zh-TW': zhTW, 'en-US': enUS, 'ja-JP': jaJP }

export function t(key: string): string {
  return DICTS[appearance.language]?.[key] ?? zhCN[key] ?? key
}

/** Element Plus 组件语言（el-config-provider 用） */
export const epLocale = computed(() => {
  switch (appearance.language) {
    case 'zh-TW':
      return zhTw
    case 'en-US':
      return en
    case 'ja-JP':
      return ja
    default:
      return zhCn
  }
})
