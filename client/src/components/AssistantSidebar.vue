<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ChatDotRound, Close, Setting, Position, RefreshLeft, Check, Plus } from '@element-plus/icons-vue'
import type { AssistantTarget, AssistantTurn } from '@wb/shared'
import { assistant, loadAssistant, resolveAssistant, switchAssistantSession, sendAssistant, targetLocation } from '../stores/assistant'
import { hasUnsavedEdits } from '../composables/useUnsavedChanges'
import AssistantSettings from './AssistantSettings.vue'

const route = useRoute()
const router = useRouter()
const configVisible = ref(false)
const messagesEl = ref<HTMLElement>()
const localMessage = ref('')
const following = ref(true)
const resizing = ref(false)
const width = ref(420)
const viewportWidth = ref(window.innerWidth)
const name = computed(() => assistant.config?.name || 'AI助手')
const canSend = computed(() => !!assistant.config?.configured && !assistant.sending && !assistant.state.busy && !assistant.state.pending && !!assistant.draft.trim())
let poll: ReturnType<typeof setInterval> | undefined
let refreshing = false
let initialized = false
let seenRevision = ''
let seenSession = ''
let drag: { x: number; width: number; userSelect: string; cursor: string } | null = null
let preferredWidth = 420
function limitWidth(value: number) { return Math.round(Math.max(320, Math.min(value, Math.max(320, window.innerWidth - 560)))) }
function applyWidth() { document.documentElement.style.setProperty('--assistant-width', width.value + 'px') }
function onResize() { viewportWidth.value = window.innerWidth; if (window.innerWidth >= 1000) width.value = limitWidth(preferredWidth); applyWidth() }
function rememberWidth() { preferredWidth = width.value; try { localStorage.setItem('wb.assistant.width', String(width.value)) } catch { /* 无法持久化时仍可调整 */ } }
function beginResize(event: PointerEvent) {
  if (event.button !== 0) return
  event.preventDefault()
  drag = { x: event.clientX, width: width.value, userSelect: document.body.style.userSelect, cursor: document.body.style.cursor }
  resizing.value = true
  document.body.style.userSelect = 'none'
  document.body.style.cursor = 'col-resize'
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
}
function moveResize(event: PointerEvent) {
  if (!drag) return
  width.value = limitWidth(drag.width + drag.x - event.clientX)
  applyWidth()
}
function endResize() {
  if (!drag) return
  document.body.style.userSelect = drag.userSelect
  document.body.style.cursor = drag.cursor
  drag = null
  resizing.value = false
  rememberWidth()
}
function resizeWithKeyboard(event: KeyboardEvent) {
  if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return
  event.preventDefault()
  width.value = limitWidth(event.key === 'Home' ? 420 : width.value + (event.key === 'ArrowLeft' ? 24 : -24))
  applyWidth(); rememberWidth()
}
function onScroll() {
  const el = messagesEl.value
  if (el) following.value = el.scrollHeight - el.scrollTop - el.clientHeight < 64
}
async function toLatest() {
  following.value = true
  await nextTick()
  const el = messagesEl.value
  if (el) el.scrollTop = el.scrollHeight
}
async function changeSession(id?: string) {
  if (await switchAssistantSession(id)) {
    configVisible.value = false
    localMessage.value = ''
    seenSession = assistant.state.sessionId
    const latest = assistant.state.turns.at(-1)
    seenRevision = latest ? `${latest.id}-${latest.status}` : ''
    await toLatest()
  }
}
async function locate(target: AssistantTarget, turn: AssistantTurn) {
  if (hasUnsavedEdits()) { assistant.error = 'AI 修改已就绪，请先保存当前草稿，再点击修改条目定位。'; return }
  await router.push(targetLocation(target, turn))
}
async function refresh() {
  if (refreshing || document.hidden || assistant.switching) return
  refreshing = true
  try {
    await loadAssistant()
    const latest = assistant.state.turns.at(-1)
    const revision = latest ? `${latest.id}-${latest.status}` : ''
    const changedSession = seenSession !== assistant.state.sessionId
    if (!initialized && assistant.state.pending && route.query.aiTurn !== assistant.state.pending.id) await locate(assistant.state.pending.changes[0].target, assistant.state.pending)
    if (initialized && !changedSession && revision !== seenRevision && latest?.changes.length) {
      await locate(latest.changes[0].target, latest)
    }
    seenSession = assistant.state.sessionId
    seenRevision = revision
    initialized = true
  } catch { /* 后台轮询暂时失败，下轮重试 */ }
  finally { refreshing = false }
}
async function submit() {
  if (!canSend.value) return
  await toLatest()
  const focused = [...document.querySelectorAll<HTMLElement>('[data-ai-context]')].find(el => el.getClientRects().length)
  const turn = await sendAssistant({ path: route.fullPath, entity: focused?.dataset.aiEntity ?? route.query.aiEntity, id: focused?.dataset.aiId ?? route.query.aiId })
  if (turn) {
    seenRevision = `${turn.id}-${turn.status}`
    if (turn.changes.length) {
      if (window.innerWidth < 1200) assistant.open = false
      await locate(turn.changes[0].target, turn)
    }
  }
}
async function decide(turn: AssistantTurn, action: 'confirm' | 'undo') {
  const result = await resolveAssistant(turn, action)
  if (result) {
    seenRevision = `${result.id}-${result.status}`
    localMessage.value = action === 'undo' ? '已撤销，原始内容已恢复' : '已确定修改'
    await locate(result.changes[0].target, result)
  }
}
function onShortcut(event: KeyboardEvent) {
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'k') { event.preventDefault(); assistant.open = !assistant.open }
  if (event.key === 'Escape' && assistant.open) assistant.open = false
}
watch(() => assistant.open, open => { if (open) { void refresh(); void toLatest() } else endResize() })
// 分别监听标量；轮询仅替换对象时不触发滚动。阅读历史期间新消息也不抢位置。
watch([() => assistant.state.turns.at(-1)?.id, () => assistant.state.turns.at(-1)?.status, () => assistant.sending], () => { if (following.value) void toLatest() })
watch(() => assistant.state.sessionId, () => { localMessage.value = ''; void toLatest() })
onMounted(() => {
  try { const saved = Number(localStorage.getItem('wb.assistant.width')); if (Number.isFinite(saved) && saved >= 320) preferredWidth = saved } catch { /* 使用默认宽度 */ }
  onResize(); void refresh(); poll = setInterval(() => { void refresh() }, 4000)
  window.addEventListener('keydown', onShortcut); window.addEventListener('resize', onResize)
  if (route.query.assistant === 'open') assistant.open = true
})
onBeforeUnmount(() => { endResize(); if (poll) clearInterval(poll); window.removeEventListener('keydown', onShortcut); window.removeEventListener('resize', onResize) })
</script>

<template>
  <button class="assistant-launch" :class="{ active: assistant.open }" aria-label="打开 AI 助手" :title="name + ' · Ctrl+Shift+K'" @click="assistant.open = !assistant.open">
    <el-icon :size="21"><ChatDotRound /></el-icon><span>{{ name }}</span><i v-if="assistant.state.pending" class="assistant-pending-dot" />
  </button>
  <Teleport to="body">
  <div v-if="assistant.open" class="assistant-divider" :class="{ resizing }" role="separator" aria-label="调整 AI 侧栏宽度" aria-orientation="vertical" :aria-valuenow="width" :aria-valuemin="320" :aria-valuemax="Math.max(320, viewportWidth - 560)" tabindex="0" @pointerdown="beginResize" @pointermove="moveResize" @pointerup="endResize" @pointercancel="endResize" @lostpointercapture="endResize" @keydown="resizeWithKeyboard" />
  <aside v-if="assistant.open" class="assistant-panel" aria-label="AI 助手侧栏">
    <header class="assistant-head">
      <div><strong>{{ name }}</strong><small>DeepSeek V4.1 Flash</small></div>
      <el-button text :icon="Plus" aria-label="新会话" title="新会话" :disabled="assistant.sending || assistant.state.busy || assistant.switching" @click="changeSession()" />
      <el-button text :icon="Setting" aria-label="AI 助手设置" title="助手与桌宠设置" :class="{ 'is-active': configVisible }" @click="configVisible = !configVisible" />
      <el-button text :icon="Close" aria-label="关闭 AI 助手" @click="assistant.open = false" />
    </header>
    <AssistantSettings v-if="configVisible" />
    <div v-show="!configVisible" class="assistant-session">
      <el-select :model-value="assistant.state.sessionId" aria-label="历史会话" size="small" :disabled="assistant.sending || assistant.state.busy || assistant.switching" @change="changeSession">
        <el-option v-for="session in assistant.state.sessions" :key="session.id" :value="session.id" :label="session.title" />
      </el-select>
      <span>会话</span>
    </div>
    <div v-show="!configVisible" ref="messagesEl" class="assistant-messages" aria-live="polite" @scroll="onScroll">
      <div v-if="!assistant.config?.configured" class="assistant-connect"><p>填写自己的 DeepSeek API Key 后即可开始。</p><el-button size="small" @click="configVisible = true">连接 DeepSeek</el-button></div>
      <div v-if="!assistant.state.turns.length" class="assistant-welcome">
        <span class="assistant-spark">✦</span><h3>聊一聊，也能帮你办事</h3>
        <p>改课表、记倒计日、整理笔记，直接告诉我。</p>
        <button v-for="example in ['新增一个下周五交实验报告的倒计日', '把笔记整理成复习提纲', '今天跑了 2.5 公里，帮我打卡']" :key="example" @click="assistant.draft = example">{{ example }} <span>↗</span></button>
      </div>
      <article v-for="turn in assistant.state.turns" :key="turn.id" class="assistant-turn">
        <div class="user-message">{{ turn.prompt }}</div>
        <div class="ai-message"><span class="speaker">{{ name }}</span><p>{{ turn.answer }}</p></div>
        <div v-if="turn.changes.length" class="assistant-changes">
          <button v-for="change in turn.changes" :key="`${change.entity}:${change.id}`" @click="locate(change.target, turn)"><span>{{ change.action === 'create' ? '新增' : change.action === 'delete' ? '删除' : '修改' }}</span><b>{{ change.label }}</b><el-icon><Position /></el-icon></button>
          <details><summary>查看修改前后</summary><div v-for="change in turn.changes" :key="change.id + change.entity" class="change-diff"><strong>{{ change.label }}</strong><pre>修改前：{{ JSON.stringify(change.before, null, 2) }}</pre><pre>修改后：{{ JSON.stringify(change.after, null, 2) }}</pre></div></details>
          <div v-if="turn.status === 'pending'" class="assistant-decision"><el-button :icon="RefreshLeft" :loading="assistant.resolving" @click="decide(turn, 'undo')">撤销</el-button><el-button type="primary" :icon="Check" :loading="assistant.resolving" @click="decide(turn, 'confirm')">确定修改</el-button></div>
          <small v-else class="resolved-state">{{ turn.status === 'undone' ? '已撤销 · 原内容已恢复' : '已确定修改' }}</small>
        </div>
      </article>
      <div v-if="assistant.sending || assistant.state.busy" class="thinking"><span />正在读取相关记录并处理…</div>
      <p v-if="localMessage" class="assistant-feedback" role="status">{{ localMessage }}</p>
    </div>
    <div v-if="!configVisible && !following" class="latest-action"><el-button size="small" round @click="toLatest">↓ 回到最新</el-button></div>
    <footer v-show="!configVisible" class="assistant-compose">
      <el-alert v-if="assistant.error" :title="assistant.error" type="error" show-icon :closable="false" />
      <p v-if="assistant.state.pending" class="pending-hint">请先撤销或确定上方修改，再继续发送。</p>
      <el-input v-model="assistant.draft" type="textarea" :autosize="{ minRows: 2, maxRows: 6 }" maxlength="12000" aria-label="发给 AI 的消息" placeholder="一句话告诉我想做什么…" @keydown.ctrl.enter.prevent="submit" @keydown.meta.enter.prevent="submit" />
      <div class="compose-actions"><small>Ctrl + Enter 发送</small><el-button type="primary" :icon="Position" :disabled="!canSend" :loading="assistant.sending" @click="submit">发送</el-button></div>
    </footer>
  </aside>
  </Teleport>
</template>

<style scoped>
.assistant-launch { display: flex; align-items: center; justify-content: center; gap: 8px; margin: 12px; padding: 11px 8px; color: var(--el-color-primary); border: 1px solid var(--el-border-color); border-radius: var(--el-border-radius-base); background: var(--el-fill-color-light); cursor: pointer; font: inherit; position: relative; }
.assistant-launch.active { background: var(--el-color-primary-light-9); border-color: var(--el-color-primary); }
.assistant-pending-dot { width: 7px; height: 7px; background: var(--el-color-warning); border-radius: 50%; }
.assistant-panel { position: fixed; inset: 0 0 0 auto; width: var(--assistant-width, 420px); z-index: 1800; background: var(--el-bg-color); color: var(--el-text-color-primary); display: flex; flex-direction: column; overflow: hidden; }
.assistant-divider { position: fixed; top: 0; bottom: 0; right: calc(var(--assistant-width, 420px) - 5px); width: 10px; z-index: 1801; cursor: col-resize; touch-action: none; }
.assistant-divider::after { content: ''; position: absolute; inset: 0 auto 0 4px; width: 2px; background: #202020; }
.assistant-divider:hover::after,.assistant-divider.resizing::after,.assistant-divider:focus-visible::after { width: 3px; background: var(--el-color-primary); }
.assistant-session { padding: 10px 16px; display: flex; align-items: center; gap: 12px; border-bottom: 1px solid var(--el-border-color-lighter); }.assistant-session .el-select { flex: 1; min-width: 0; }.assistant-session > span { font-size: 11px; color: var(--el-text-color-secondary); }
.assistant-connect { font-size: 12px; line-height: 1.7; background: var(--el-fill-color-light); padding: 12px; border-radius: 8px; margin-bottom: 20px; }.assistant-connect p { margin-top: 0; }
.latest-action { height: 0; position: relative; text-align: center; bottom: 36px; z-index: 1; }
.assistant-head { display: flex; align-items: center; gap: 4px; padding: 16px; border-bottom: 1px solid var(--el-border-color-lighter); }
.assistant-head > div { flex: 1; min-width: 0; }.assistant-head strong { display: block; font-size: 18px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.assistant-head small { display: block; font-size: 11px; color: var(--el-text-color-secondary); margin-top: 4px; }.assistant-head > .el-button { margin-left: 0; flex-shrink: 0; }
.assistant-messages { flex: 1; min-height: 80px; overflow-y: auto; padding: 18px 16px; overscroll-behavior: contain; scrollbar-width: thin; }.assistant-welcome { padding: 20px 0; }.assistant-spark { font-size: 36px; color: var(--el-color-primary); }.assistant-welcome h3 { font-size: 19px; margin: 14px 0 8px; }.assistant-welcome p { font-size: 13px; color: var(--el-text-color-secondary); line-height: 1.7; }.assistant-welcome button { display: flex; justify-content: space-between; width: 100%; text-align: left; padding: 12px; margin-top: 8px; background: var(--el-fill-color-light); border: 1px solid var(--el-border-color-lighter); border-radius: 8px; color: var(--el-text-color-regular); cursor: pointer; font: inherit; font-size: 12px; gap: 8px; }
.assistant-turn { margin-bottom: 26px; }.user-message { margin-left: 24px; padding: 11px 13px; background: var(--el-color-primary-light-9); border-radius: 12px 12px 2px 12px; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13px; line-height: 1.7; }.ai-message { margin-top: 16px; }.speaker { color: var(--el-color-primary); font-size: 11px; font-weight: 600; }.ai-message p { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13px; line-height: 1.8; margin: 6px 0 12px; }
.assistant-changes { border: 1px solid var(--el-border-color); border-radius: 9px; padding: 10px; }.assistant-changes > button { display: flex; align-items: center; gap: 8px; width: 100%; padding: 9px 4px; background: transparent; border: none; border-bottom: 1px solid var(--el-border-color-lighter); color: inherit; cursor: pointer; text-align: left; }.assistant-changes > button span { font-size: 10px; padding: 3px 5px; border-radius: 4px; color: var(--el-color-primary); background: var(--el-color-primary-light-9); }.assistant-changes > button b { font-size: 12px; font-weight: 500; flex: 1; overflow-wrap: anywhere; }.assistant-changes details { font-size: 12px; margin: 10px 0; }.assistant-changes summary { cursor: pointer; color: var(--el-text-color-secondary); }.change-diff { margin: 12px 0; }.change-diff pre { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 220px; overflow: auto; background: var(--el-fill-color-light); padding: 8px; font-size: 11px; }.assistant-decision { display: flex; justify-content: flex-end; margin-top: 12px; }.resolved-state { display: block; margin-top: 12px; color: var(--el-text-color-secondary); }
.assistant-compose { padding: 12px 16px 16px; border-top: 1px solid var(--el-border-color-lighter); }.compose-actions { display: flex; justify-content: space-between; align-items: center; margin-top: 10px; }.compose-actions small,.pending-hint { font-size: 11px; color: var(--el-text-color-secondary); }.thinking,.assistant-feedback { font-size: 12px; line-height: 1.6; color: var(--el-text-color-secondary); }.thinking span { display: inline-block; width: 7px; height: 7px; background: var(--el-color-primary); border-radius: 50%; margin-right: 5px; }.assistant-feedback { color: var(--el-color-success); }
@media(max-width:1080px) { .assistant-launch { margin: 8px; }.assistant-launch > span { display: none; } }
@media(max-width:999px) { .assistant-panel { width: 100vw; }.assistant-divider { display: none; } }
</style>
