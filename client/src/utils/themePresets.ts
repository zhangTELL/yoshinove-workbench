/**
 * 主题预设的元数据。
 *
 * 这里只有「值」：id、名称、描述、该主题默认的强调色与圆角、设置页卡片的预览色块。
 * 具体配色在 `styles/themes/<id>.css` 里（以 `html[data-wb-theme='<id>']` 作用域声明），
 * **两处的 id 必须一致**——加主题时同时改这两处再登记卡片即可。
 *
 * 关于深色：四套预置主题都**只做浅色**，深色只属于 `default`（见 stores/appearance.ts 的强制逻辑）。
 */

export interface ThemePreset {
  id: string
  name: string
  desc: string
  /** 是否已上线：false 时卡片显示「规划中」且不可点，避免出现"选了没反应" */
  ready: boolean
  /** 切换到该主题时写入外观设置的强调色（之后用户可自行修改，以用户为准） */
  accent?: string
  /** 切换到该主题时写入的界面圆角 */
  radius?: number
  /** 设置页卡片的小样配色：[强调色, 底色, 文字色] */
  colors: [string, string, string]
}

export const THEME_PRESETS: ThemePreset[] = [
  {
    id: 'default',
    name: '默认',
    desc: '蓝色 + 标准间距。唯一支持深色的主题',
    ready: true,
    accent: '#409eff',
    radius: 6,
    colors: ['#409eff', '#f5f7fa', '#303133'],
  },
  {
    id: 'macos',
    name: 'macOS',
    desc: '系统蓝 + 毛玻璃侧栏 + 柔和渐变底',
    ready: true,
    accent: '#007aff',
    radius: 10,
    colors: ['#007aff', '#edf0f5', '#1d1d1f'],
  },
  {
    id: 'claude',
    name: 'Claude',
    desc: '暖纸墨橘，细线图标，阅读优先',
    ready: true,
    accent: '#d97757',
    radius: 6,
    colors: ['#d97757', '#faf9f5', '#2c2b28'],
  },
  {
    id: 'paper',
    name: '纸页',
    desc: '纸白 + 衬线正文 + 横格纹 + 印章红，零圆角',
    ready: true,
    accent: '#b7282e',
    radius: 0,
    colors: ['#b7282e', '#fffff8', '#151515'],
  },
  {
    id: 'miko',
    name: '巫女·和风',
    desc: '和纸 + 朱色 + 藤紫',
    ready: false,
    accent: '#eb6101',
    radius: 2,
    colors: ['#eb6101', '#fbfaf5', '#2b2028'],
  },
]

/** 取预设；未知 id 一律回落 `default` */
export function themePreset(id: string): ThemePreset {
  return THEME_PRESETS.find((t) => t.id === id) ?? THEME_PRESETS[0]
}
