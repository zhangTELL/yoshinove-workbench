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
  font-family: 'Segoe UI', 'Microsoft YaHei', system-ui, sans-serif;
  /* 页面底色由 styles/theme.css 的 --wb-page-bg 提供（浅色 var(--el-fill-color-light) / 深色 #0a0a0a） */
  background: var(--wb-page-bg);
}
</style>
