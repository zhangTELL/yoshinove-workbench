<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { get } from '../api/http'
import { assistant, loadAssistant } from '../stores/assistant'
import '../styles/pet.css'
const host = ref<HTMLElement>()
let dispose: (() => void) | undefined
let alive = true
async function start() {
  try {
    await get('/dsh-pet-7340/config')
    const { mountPet } = await import('../pet/runtime.js')
    if (alive && host.value) dispose = mountPet(host.value)
  } catch (error) { if (alive) console.warn('桌宠暂未连接，请检查后端运行状态。', error) }
}
function onChat() { assistant.open = true; void loadAssistant() }
function onChange() { void loadAssistant() }
onMounted(() => { void start(); document.addEventListener('workbench-assistant-change', onChange); document.addEventListener('workbench-assistant-open', onChat) })
onBeforeUnmount(() => { alive = false; dispose?.(); document.removeEventListener('workbench-assistant-change', onChange); document.removeEventListener('workbench-assistant-open', onChat) })
</script>
<template>
  <div ref="host" class="pet-overlay-host" :class="{ 'assistant-open': assistant.open }" />
</template>
<style scoped>
.pet-overlay-host { position: fixed; inset: 0 var(--assistant-inset, 0px) 0 0; contain: layout; pointer-events: none; z-index: 1700; }
@media (max-width: 999px) { .pet-overlay-host.assistant-open { visibility: hidden; pointer-events: none; } }
</style>
