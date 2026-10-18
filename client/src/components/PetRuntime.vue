<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { get } from '../api/http'
import { assistant, loadAssistant } from '../stores/assistant'
import '../styles/pet.css'
const props = defineProps<{ settings?: boolean }>()
const host = ref<HTMLElement>()
const error = ref('')
let dispose: (() => void) | undefined
let alive = true
async function start() {
  error.value = ''
  try {
    await get('/dsh-pet-7340/config')
    const { mountPet } = await import('../pet/runtime.js')
    if (alive && host.value) dispose = mountPet(host.value, props.settings)
  } catch { if (alive) error.value = '桌宠暂未连接，请确认后端已运行；首次启动请执行 pnpm pet:prepare。' }
}
function onChat() { assistant.open = true; void loadAssistant() }
function onChange() { void loadAssistant() }
onMounted(() => { void start(); if (!props.settings) { document.addEventListener('workbench-assistant-change', onChange); document.addEventListener('workbench-assistant-open', onChat) } })
onBeforeUnmount(() => { alive = false; dispose?.(); document.removeEventListener('workbench-assistant-change', onChange); document.removeEventListener('workbench-assistant-open', onChat) })
</script>
<template>
  <section v-if="settings" class="pet-settings-section">
    <h3>桌宠</h3><p>网页和独立桌面窗口共用配置、动画与对话记忆，右键或双击宠物即可快速 AI 对话，桌面端也可按 Ctrl+Alt+K。</p>
    <p>对话使用侧栏中填写的 DeepSeek Key，启用自动碎碎念后也会使用 API 额度。</p>
    <el-alert v-if="error" :title="error" type="warning" :closable="false"><el-button text @click="start">重新连接</el-button></el-alert>
    <div ref="host" />
  </section>
  <div v-else ref="host" class="pet-overlay-host" />
</template>
<style scoped>
.pet-settings-section { margin-top: 28px; padding-top: 20px; border-top: 1px solid var(--el-border-color); }.pet-settings-section > h3 { font-size: 19px; margin: 0 0 12px; }.pet-settings-section > p { font-size: 13px; line-height: 1.7; color: var(--el-text-color-secondary); }.pet-overlay-host { position: relative; z-index: 1700; }
</style>
