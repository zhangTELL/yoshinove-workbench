<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { assistant, resolveAssistant, targetLocation } from '../stores/assistant'
const route = useRoute()
const router = useRouter()
const turn = computed(() => assistant.state.pending)
const deleted = computed(() => {
  const turn = assistant.state.turns.find(t => t.id === route.query.aiTurn)
  return turn?.changes.find(c => c.id === Number(route.query.aiId) && c.entity === route.query.aiEntity && (turn.status === 'undone' ? !c.before : !c.after))
})
async function resolve(action: 'undo' | 'confirm') {
  if (!turn.value) return
  const result = await resolveAssistant(turn.value, action)
  if (result) await router.push(targetLocation(result.changes[0].target, result))
}
</script>
<template>
  <div v-if="turn" class="ai-review" role="status">
    <div><strong>AI 已修改 {{ turn.changes.length }} 项</strong><small>请核对页面内容，再确定或撤销。</small></div>
    <el-button size="small" @click="assistant.open = true">查看详情</el-button>
    <el-button size="small" :loading="assistant.resolving" @click="resolve('undo')">撤销</el-button>
    <el-button size="small" type="primary" :loading="assistant.resolving" @click="resolve('confirm')">确定修改</el-button>
  </div>
  <div v-if="deleted" class="ai-deleted" :data-ai-entity="deleted.entity" :data-ai-id="deleted.id">此位置的「{{ deleted.label }}」已移除，可在 AI 对话中查看修改记录。</div>
</template>
<style scoped>
.ai-review { position: sticky; top: -20px; z-index: 10; display: flex; align-items: center; flex-wrap: wrap; gap: 8px; padding: 12px 14px; margin-bottom: 18px; background: var(--el-bg-color); border: 1px solid var(--el-color-primary-light-5); border-left: 3px solid var(--el-color-primary); border-radius: 8px; box-shadow: 0 3px 12px #00000008; }.ai-review > div { flex: 1; min-width: 170px; }.ai-review strong { font-size: 13px; }.ai-review small { display: block; margin-top: 4px; font-size: 11px; color: var(--el-text-color-secondary); }.ai-review :deep(.el-button + .el-button) { margin-left: 0; }.ai-deleted { padding: 16px; margin-bottom: 18px; border: 1px dashed var(--el-color-danger); border-radius: 8px; color: var(--el-text-color-secondary); font-size: 13px; }
</style>
