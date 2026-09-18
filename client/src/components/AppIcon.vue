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
 * 配色默认跟着当前强调色走（用 color-mix 现算），所以换主题/换强调色时图标会一起变；
 * 也可以显式传 from / to 给每个入口各自的系统色（见 DashboardView 的快捷入口）。
 */

const props = withDefaults(
  defineProps<{
    /** 图标组件（@element-plus/icons-vue 的任意一个） */
    icon?: Component
    /** 无 icon 时显示的字符（通常一个汉字），与 icon 二选一 */
    char?: string
    /** 边长（px） */
    size?: number
    /** 渐变起始色（顶部，较浅）；不传则按强调色现算 */
    from?: string
    /** 渐变结束色（底部，较深）；不传则按强调色现算 */
    to?: string
  }>(),
  { size: 26 },
)

/** 字形占图标边长的比例：macOS 图标里字形视觉重量大约占一半多一点 */
const glyphSize = computed(() => `${Math.round(props.size * 0.54)}px`)

const style = computed(() => ({
  '--ai-size': `${props.size}px`,
  '--ai-glyph': glyphSize.value,
  ...(props.from ? { '--ai-from': props.from } : {}),
  ...(props.to ? { '--ai-to': props.to } : {}),
}))
</script>

<template>
  <span class="app-icon" :style="style">
    <el-icon v-if="icon" class="app-icon__glyph"><component :is="icon" /></el-icon>
    <span v-else-if="char" class="app-icon__char">{{ char }}</span>
  </span>
</template>

<style scoped>
.app-icon {
  /* 默认渐变：强调色的"上浅下深"。--ai-from/--ai-to 由父级或 props 覆盖 */
  --ai-from: color-mix(in srgb, var(--el-color-primary) 62%, #fff);
  --ai-to: color-mix(in srgb, var(--el-color-primary) 92%, #000);

  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: var(--ai-size);
  height: var(--ai-size);
  /* ★ Big Sur 图标网格的圆角比例；用百分比是为了跟着尺寸等比缩放 */
  border-radius: 22.37%;
  background: linear-gradient(180deg, var(--ai-from), var(--ai-to));
  color: #fff;
  /* 顶部内高光 + 底部内阴影 + 轻微外投影 —— macOS 图标的立体感就来自这三层 */
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.45),
    inset 0 -1px 1px rgba(0, 0, 0, 0.12),
    0 1px 2px rgba(0, 0, 0, 0.14);
  position: relative;
  overflow: hidden;
}

/* 上半部分的柔和镜面高光 */
.app-icon::before {
  content: '';
  position: absolute;
  inset: 0 0 auto;
  height: 48%;
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.38), rgba(255, 255, 255, 0));
  pointer-events: none;
}

.app-icon__glyph {
  position: relative;
  font-size: var(--ai-glyph);
}

.app-icon__char {
  position: relative;
  font-size: calc(var(--ai-glyph) * 0.92);
  font-weight: 600;
  line-height: 1;
  letter-spacing: 0;
}
</style>
