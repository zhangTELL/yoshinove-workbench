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
/* 主题底纹（如 macOS 那套的柔和渐变"壁纸"）：默认 none，固定不随滚动 */
body {
  background-image: var(--wb-bg-image);
  background-attachment: fixed;
  background-size: cover;
  background-repeat: no-repeat;
}
#app {
  background: transparent;
}
</style>
