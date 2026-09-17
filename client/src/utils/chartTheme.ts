/**
 * echarts 主题用色：echarts 不认 CSS 变量（canvas 绘制），所以每次渲染前
 * 从 documentElement 取语义变量的计算值。
 *
 * 用法：const p = chartPalette() 然后把坐标轴/图例/系列颜色从字面量换成 p.*；
 * 组件里 watch 外观变化（appearance.appearance / fontScale）后重渲染即可换肤。
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
  success: string
  warning: string
  danger: string
  /** 图表背景（一般保持透明，深浅色都由容器承担） */
  bg: string
}

export function chartPalette(): ChartPalette {
  return {
    text1: cssVar('--el-text-color-primary', '#303133'),
    text2: cssVar('--el-text-color-regular', '#606266'),
    text3: cssVar('--el-text-color-secondary', '#909399'),
    border: cssVar('--el-border-color', '#ebeef5'),
    accent: cssVar('--el-color-primary', '#409eff'),
    success: cssVar('--el-color-success', '#67c23a'),
    warning: cssVar('--el-color-warning', '#e6a23c'),
    danger: cssVar('--el-color-danger', '#f56c6c'),
    bg: 'transparent',
  }
}
