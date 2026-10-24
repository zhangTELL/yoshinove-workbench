<script setup lang="ts">
import { assistantLayout, setAssistantDefaultWidth } from '../stores/assistantLayout'
</script>

<template>
  <el-form label-position="top" class="assistant-width-setting">
    <el-form-item label="默认展开宽度">
      <el-input-number :model-value="assistantLayout.defaultWidth" :min="320" :max="1200" :step="20" controls-position="right" aria-label="AI 侧栏默认展开宽度" @change="setAssistantDefaultWidth" />
      <span class="width-unit">px</span>
    </el-form-item>
    <p>每次展开采用此宽度，也可拖动分隔线临时调整；窗口较窄时自动适配。</p>
  </el-form>
</template>

<style scoped>
.assistant-width-setting .el-form-item { margin-bottom: 8px; }
.width-unit { margin-left: 10px; color: var(--el-text-color-secondary); }
p { margin: 0; color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.7; }
</style>
