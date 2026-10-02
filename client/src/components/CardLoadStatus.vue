<script setup lang="ts">
defineProps<{ state: { loading: boolean; error: string; at: string } }>()
defineEmits<{ retry: [] }>()
</script>

<template>
  <div class="load-status" role="status" aria-live="polite">
    <span v-if="state.loading">正在加载…</span>
    <template v-else-if="state.error">
      <span class="error">加载失败：{{ state.error }}</span>
      <el-button size="small" @click="$emit('retry')">重试</el-button>
    </template>
    <span v-if="state.at">{{ state.error ? '保留上次成功数据 · ' : '更新于 ' }}{{ state.at }}</span>
  </div>
</template>

<style scoped>
.load-status { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; font-size: 12px; color: var(--el-text-color-secondary); }
.load-status:empty { display: none; }
.error { color: var(--el-color-danger); }
</style>
