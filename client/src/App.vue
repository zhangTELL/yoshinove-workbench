<template>
  <el-config-provider :locale="epLocale">
    <router-view />
  </el-config-provider>
</template>

<script setup lang="ts">
import { epLocale } from './locales'
</script>

<style>
html,
body,
#app {
  height: 100%;
  margin: 0;
  font-family: var(--wb-font-ui);
}
/* 页面底色来自 styles/tokens.css 的 --wb-bg（浅色 #f5f7fa / 深色 #0a0a0a，主题预设可覆盖）；
   #app 保持透明，好让 body 上的「底纹」透上来 */
html,
body {
  background-color: var(--wb-bg);
}
/* 页面底 + 主题底纹：
   · --wb-bg-image：主题的"壁纸"（macOS 用柔和渐变；其它主题 none）
   · --wb-texture  ：主题的"纸纹"（paper 用 repeating-linear-gradient 画横格；其它主题 none）
   两者都铺在 body 上、都 fixed 不随滚动，第二层（壁纸）用 cover 撑满。
   ⚠️ 主内容区（.el-main / MainLayout 的 .main）与 EP 各容器**都没有背景色**，
      所以 body 上的纹理能透到内容区里——这是纸纹能看见的前提，别给它们加底。 */
body {
  background-color: var(--wb-bg);
  background-image: var(--wb-texture), var(--wb-bg-image);
  background-size: var(--wb-texture-size), cover;
  background-repeat: repeat, no-repeat;
  background-attachment: fixed, fixed;
}
#app {
  background: transparent;
}
</style>
