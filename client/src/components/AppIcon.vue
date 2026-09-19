<script setup lang="ts">
import { computed } from 'vue'
import type { Component } from 'vue'

/**
 * macOS 风格的应用图标（squircle）。
 *
 * 为什么要有这个组件：原来的「工作台」logo 是一个 emoji（📚），emoji 在 macOS 观感的界面里
 * 是最突兀的一类元素——它是**彩色位图**、风格不受控、还随系统字体变。macOS 的图标语言是
 * **圆角方形（squircle）+ 上浅下深的渐变 + 顶部高光 + 白色字形**，所以这里把这套语言做成组件。
 *
 * 形状用的是真 Big Sur 比例：`border-radius: 22.37%`（Apple 图标网格的连续圆角比例），
 * 而不是随手一个 8px——这是"像不像 Mac"最关键的一点。
 *
 * 配色默认跟着当前强调色走（用 color-mix 现算），所以换主题/换强调色时图标会一起变。
 *
 * ★ 2026-09-20 修正（原设计有坑）：早期版本把「每个入口各自的系统色」写成 **from / to 两个 props**
 *   （见 DashboardView 的快捷入口）。因为 props 落到 style 上是**行内声明**，优先级高于任何作者样式，
 *   于是 claude / paper 主题里那两条 `background: none`（意图是"去掉色块、只留细线字形"）
 *   **永远压不过行内渐变**——侧栏 logo 已换成裸线/赭橘，首页那 6 个快捷入口却还是彩虹方块。
 *   根因是"用行内优先级表达主题相关的外观"，与主题体系直接冲突（主题就是靠 CSS 层叠工作的）。
 *
 *   修法：不再暴露颜色 props，改成**让上下文给变量**——
 *     · 默认 / macOS：模板在 .sc-item 上写行内 `--sc-from` / `--sc-to`（行内层级，主题压不过它，
 *       这正是想要的：这两套主题就保留六色辨识度，且渐变值一个都不变）；
 *     · 主题预设：在 .sc-item .app-icon 上把 `--ai-bg` / `--ai-glow` 换成自己的值，
 *       一次把色块与高光都去掉——由 CSS 层叠决定，不再被行内样式挡死。
 *   前提是本组件的底色与高光都走 var()，逐条可被替换。 */


const props = withDefaults(
  defineProps<{
    /** 图标组件（@element-plus/icons-vue 的任意一个） */
    icon?: Component
    /** 无 icon 时显示的字符（通常一个汉字），与 icon 二选一 */
    char?: string
    /** 边长（px） */
    size?: number
    /* ⚠️ 刻意**不**提供颜色 props：颜色必须能被主题用 CSS 改写，
       而 props 会成为行内声明（不可覆盖）——详见文件头 2026-09-20 的说明。
       要每个入口不同色，请由调用方给上下文变量 --sc-from / --sc-to（见 DashboardView 的快捷入口）。 */
  }>(),
  { size: 26 },
)

/** 字形占图标边长的比例：macOS 图标里字形视觉重量大约占一半多一点 */
const glyphSize = computed(() => `${Math.round(props.size * 0.54)}px`)

const style = computed(() => ({
  '--ai-size': `${props.size}px`,
  /* ⚠️ 注意与 --ai-glyph（字形色，string）区分：这个是**字形字号** */
  '--ai-glyph-size': glyphSize.value,
}))
</script>

<template>
  <span class="app-icon" :style="style">
    <el-icon v-if="icon" class="app-icon__glyph"><component :is="icon" /></el-icon>
    <span v-else-if="char" class="app-icon__char">{{ char }}</span>
  </span>
</template>

<style scoped>
/* ===== 外观契约（★ 2026-09-20 重写，原因是"行内 vs 层叠"这一对矛盾）=====

   组件本身**只读 token，不出厂默认值** —— 这是刻意的，也是这次修正的核心：

     · 组件里的 `background: var(--ai-bg, linear-gradient(…))` 这种"自引用兜底"是**陷阱**：
       主题写 `--ai-bg: unset` 时，`unset` 让本层变量回落到"无值"，
       于是 var() 取兜底值 —— 渐变**又被装回来了**，主题想关的色块根本关不掉。
       （本次实测到的正是这类静默失效：层叠看着对，屏幕上没变。）
     · 所以组件里不写兜底：默认外观由 tokens.css 的 :root **层**提供，
       调用方上下文（.sc-item）与主题都只是"更靠近元素"的覆盖层，谁离得近谁赢。
     · `.logo` 用 unset / 透明清掉外层规则（仍靠层叠取 :root 的值）；
       `.sc-item` 是**唯一读取上下文的 --sc-from / --sc-to 的地方**——所以 logo 不会误染第一个快捷入口的颜色。

   四个 token 的含义：
     --ai-bg     底色（一个颜色或一个渐变）
     --ai-glyph  字形色
     --ai-from / --ai-to   渐变起止色（只有 --ai-bg 是渐变的主题/上下文才需要）
     --ai-glow   顶部镜面高光的起点色；**主题去掉色块时必须一并去掉**，
                 否则"裸墨线"图标上会凭空多出一道白光（浅色调下才看得见，极易漏测）。 */

.app-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: var(--ai-size);
  height: var(--ai-size);
  /* ★ Big Sur 图标网格的圆角比例；用百分比是为了跟着尺寸等比缩放 */
  border-radius: 22.37%;
  background: var(--ai-bg);
  color: var(--ai-glyph);
  /* 顶部内高光 + 底部内阴影 + 轻微外投影 —— macOS 图标的立体感就来自这三层 */
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.45),
    inset 0 -1px 1px rgba(0, 0, 0, 0.12),
    0 1px 2px rgba(0, 0, 0, 0.14);
  position: relative;
  overflow: hidden;
}

/* 侧栏 logo（26px）与其它位置（30px）正好共用这套外观，这里只把 token 清干净：
   底/字形/高光都 unset → 层叠取 :root 的默认值；两个渐变参数 unset → 层叠回默认蓝。
   注意 .logo 在 MainLayout 里、是 .sc-item 的兄弟而非父级，所以 --sc-from / --sc-to 不会串到它上面。 */
.logo .app-icon {
  --ai-bg: unset;
  --ai-glyph: unset;
  --ai-from: unset;
  --ai-to: unset;
  --ai-glow: unset;
}

/* 首页快捷入口：唯一使用"各自的系统色"的地方。
   模板行内给 `--sc-from` / `--sc-to`（六支各自调过的渐变，见 DashboardView 的 Shortcut 接口），
   这里的兜底是"没有上下文时"的那一支（等回强调色的上浅下深）。 */
.sc-item .app-icon {
  --ai-bg: linear-gradient(
    180deg,
    var(--ai-from, var(--sc-from, var(--el-color-primary))),
    var(--ai-to, var(--sc-to, color-mix(in srgb, var(--el-color-primary) 88%, #000)))
  );
  --ai-glyph: #fff;
  --ai-glow: rgba(255, 255, 255, 0.38);
}

/* 上半部分的柔和镜面高光 */
.app-icon::before {
  content: '';
  position: absolute;
  inset: 0 0 auto;
  height: 48%;
  background: linear-gradient(180deg, var(--ai-glow), transparent);
  pointer-events: none;
}

.app-icon__glyph {
  position: relative;
  font-size: var(--ai-glyph-size);
}

.app-icon__char {
  position: relative;
  font-size: calc(var(--ai-glyph) * 0.92);
  font-weight: 600;
  line-height: 1;
  letter-spacing: 0;
}
</style>
