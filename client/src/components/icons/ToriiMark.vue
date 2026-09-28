<script setup lang="ts">
/**
 * 自绘的「鸟居」标——巫女·和风主题的 logo 字形。
 *
 * 为什么自绘：Lucide（本仓库版本 1.47.0）没有鸟居图标；`Landmark` 是希腊神庙柱式、
 * `Shell` 是贝壳，都不对味。鸟居的几何非常简单（笠木一道反曲 + 贯 + 两根柱），
 * 几笔线稿就能画准，自绘反而比"找个近似的"更像。
 *
 * 原创线稿（无版权来源问题），按 Lucide 的约定画：
 *   viewBox 24、`stroke="currentColor"`、`fill="none"`、stroke-width 2、圆角端点——
 *   和主题里其它 Lucide 线稿完全同一套语言，theme CSS 里对 `.app-icon svg` 的
 *   stroke-width / color 覆盖对它同样生效。
 *
 * 结构对照真实鸟居：`M3 4.6 Q12 7 21 4.6` = 笠木（两端上翘的反曲梁）；
 *   `M4 9.5 H20` = 贯（横贯两柱的直梁，两端出头）；两根竖线 = 柱；
 *   中间短竖 = 额束（笠木与贯之间的芯）。
 */
</script>

<template>
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
  >
    <path d="M3 4.6 Q12 7 21 4.6" />
    <path d="M4 9.5 H20" />
    <path d="M7 6.4 V20" />
    <path d="M17 6.4 V20" />
    <path d="M12 6.4 V8.5" />
  </svg>
</template>

<style scoped>
svg {
  width: 1em;
  height: 1em;
  display: block;
}
</style>
