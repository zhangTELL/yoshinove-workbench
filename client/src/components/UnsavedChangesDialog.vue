<script setup lang="ts">
import { chooseLeave, leaveDialog } from '../composables/useUnsavedChanges'
const { visible, saving, label } = leaveDialog
</script>

<template>
  <el-dialog :model-value="visible" title="未保存的修改" width="min(460px, 92vw)" :show-close="!saving" :close-on-click-modal="false" :close-on-press-escape="!saving" @close="chooseLeave('stay')">
    <p>{{ label }}有未保存的修改，离开前是否保存？</p>
    <template #footer>
      <el-button :disabled="saving" @click="chooseLeave('stay')">继续编辑</el-button>
      <el-button :disabled="saving" @click="chooseLeave('discard')">放弃修改</el-button>
      <el-button type="primary" :loading="saving" @click="chooseLeave('save')">保存后离开</el-button>
    </template>
  </el-dialog>
</template>
