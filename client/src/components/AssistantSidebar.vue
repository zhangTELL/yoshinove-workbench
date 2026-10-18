<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { ChatDotRound, Close, Setting, Position, RefreshLeft, Check } from '@element-plus/icons-vue'
import type { AssistantTarget, AssistantTurn } from '@wb/shared'
import { assistant, loadAssistant, resolveAssistant, saveAssistantKey, sendAssistant, targetLocation } from '../stores/assistant'
import { hasUnsavedEdits } from '../composables/useUnsavedChanges'

const route = useRoute()
const router = useRouter()
const keyValue = ref('')
const configVisible = ref(false)
const keySaving = ref(false)
const messagesEl = ref<HTMLElement>()
const localMessage = ref('')
const canSend = computed(() => !!assistant.config?.configured && !assistant.sending && !assistant.state.busy && !assistant.state.pending && !!assistant.draft.trim())
let poll: ReturnType<typeof setInterval> | undefined
let refreshing = false
let initialized = false
let seenRevision = ''
async function locate(target: AssistantTarget, turn: AssistantTurn) {
  if (hasUnsavedEdits()) { assistant.error = 'AI 修改已就绪，请先保存当前草稿，再点击修改条目定位。'; return }
  await router.push(targetLocation(target, turn))
}
async function refresh() {
  if (refreshing || document.hidden) return
  refreshing = true
  try {
    await loadAssistant()
    const latest = assistant.state.turns.at(-1)
    const revision = latest ? `${latest.id}-${latest.status}` : ''
    if (initialized && revision !== seenRevision && latest?.changes.length) {
      assistant.open = true
      await locate(latest.changes[0].target, latest)
    }
    seenRevision = revision
    initialized = true
  } catch { /* 后台轮询暂时失败，下轮重试 */ }
  finally { refreshing = false }
}
async function submit() {
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
async function saveKey() {
  keySaving.value = true
  assistant.error = ''
  try {
    await saveAssistantKey(keyValue.value)
    keyValue.value = ''
    configVisible.value = false
    ElMessage.success(assistant.config?.configured ? 'DeepSeek API Key 已保存在本机' : 'API Key 已移除')
  } catch (error) { assistant.error = (error as Error).message }
  finally { keySaving.value = false }
}
function onShortcut(event: KeyboardEvent) {
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'k') { event.preventDefault(); assistant.open = !assistant.open }
  if (event.key === 'Escape' && assistant.open) assistant.open = false
}
watch(() => assistant.open, open => { if (open) { void refresh(); void nextTick().then(() => messagesEl.value?.scrollTo({ top: messagesEl.value.scrollHeight })) } })
watch(() => [assistant.state.turns.length, assistant.sending], () => { void nextTick().then(() => messagesEl.value?.scrollTo({ top: messagesEl.value.scrollHeight, behavior: 'smooth' })) })
onMounted(() => { void refresh(); poll = setInterval(() => { void refresh() }, 4000); window.addEventListener('keydown', onShortcut); if (route.query.assistant === 'open') assistant.open = true })
onBeforeUnmount(() => { if (poll) clearInterval(poll); window.removeEventListener('keydown', onShortcut) })
</script>

<template>
  <button class="assistant-launch" :class="{ active: assistant.open }" aria-label="打开 AI 助手" title="AI 助手 · Ctrl+Shift+K" @click="assistant.open = !assistant.open">
    <el-icon :size="21"><ChatDotRound /></el-icon><span>AI 助手</span><i v-if="assistant.state.pending" />
  </button>
  <aside v-if="assistant.open" class="assistant-panel" aria-label="AI 助手侧栏">
    <header class="assistant-head">
      <div><strong>小TELL</strong><small>DeepSeek V4.1 Flash</small></div>
      <el-button text :icon="Setting" aria-label="设置 DeepSeek API" @click="configVisible = !configVisible" />
      <el-button text :icon="Close" aria-label="关闭 AI 助手" @click="assistant.open = false" />
    </header>
    <section v-if="configVisible || !assistant.config?.configured" class="assistant-key">
      <strong>连接 DeepSeek</strong>
      <p>填写你的 DeepSeek API Key，开始对话和修改工作台。</p>
      <el-input v-model="keyValue" type="password" show-password autocomplete="off" aria-label="DeepSeek API Key" :placeholder="assistant.config?.keyMask || 'sk-…'" @keydown.enter="saveKey" />
      <div class="key-actions"><a href="https://platform.deepseek.com/api_keys" target="_blank" rel="noopener noreferrer">获取 API Key</a><el-button type="primary" size="small" :loading="keySaving" :disabled="!keyValue.trim() && !assistant.config?.configured" @click="saveKey">{{ keyValue.trim() || !assistant.config?.configured ? '保存 Key' : '移除 Key' }}</el-button></div>
      <small>Key 仅保存在本机；发送消息时，问题和相关本地记录会提交至 DeepSeek。</small>
    </section>
    <div ref="messagesEl" class="assistant-messages" aria-live="polite">
      <div v-if="!assistant.state.turns.length" class="assistant-welcome">
        <span class="assistant-spark">✦</span><h3>聊一聊，也能帮你办事</h3>
        <p>改课表、记倒计日、整理笔记，直接告诉我。</p>
        <button v-for="example in ['新增一个下周五交实验报告的倒计日', '把笔记整理成复习提纲', '今天跑了 2.5 公里，帮我打卡']" :key="example" @click="assistant.draft = example">{{ example }} <span>↗</span></button>
      </div>
      <article v-for="turn in assistant.state.turns" :key="turn.id" class="assistant-turn">
        <div class="user-message">{{ turn.prompt }}</div>
        <div class="ai-message"><span class="speaker">小TELL</span><p>{{ turn.answer }}</p></div>
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
    <footer class="assistant-compose">
      <el-alert v-if="assistant.error" :title="assistant.error" type="error" show-icon :closable="false" />
      <p v-if="assistant.state.pending" class="pending-hint">请先撤销或确定上方修改，再继续发送。</p>
      <el-input v-model="assistant.draft" type="textarea" :autosize="{ minRows: 2, maxRows: 6 }" maxlength="12000" aria-label="发给 AI 的消息" placeholder="一句话告诉我想做什么…" @keydown.ctrl.enter.prevent="submit" @keydown.meta.enter.prevent="submit" />
      <div class="compose-actions"><small>Ctrl + Enter 发送</small><el-button type="primary" :icon="Position" :disabled="!canSend" :loading="assistant.sending" @click="submit">发送</el-button></div>
    </footer>
  </aside>
</template>

<style scoped>
.assistant-launch { display: flex; align-items: center; justify-content: center; gap: 8px; margin: 12px; padding: 11px 8px; color: var(--el-color-primary); border: 1px solid var(--el-border-color); border-radius: var(--el-border-radius-base); background: var(--el-fill-color-light); cursor: pointer; font: inherit; position: relative; }
.assistant-launch.active { background: var(--el-color-primary-light-9); border-color: var(--el-color-primary); }
.assistant-launch i { width: 7px; height: 7px; background: var(--el-color-warning); border-radius: 50%; }
.assistant-panel { position: fixed; inset: 12px 12px 12px auto; width: min(410px, calc(100vw - 24px)); z-index: 1800; background: var(--el-bg-color); color: var(--el-text-color-primary); border: 1px solid var(--el-border-color-light); border-radius: 14px; box-shadow: 0 16px 60px #0002; display: flex; flex-direction: column; overflow: hidden; }
.assistant-head { display: flex; align-items: center; gap: 4px; padding: 16px; border-bottom: 1px solid var(--el-border-color-lighter); }
.assistant-head > div { flex: 1; }.assistant-head strong { font-size: 18px; }.assistant-head small { display: block; font-size: 11px; color: var(--el-text-color-secondary); margin-top: 4px; }
.assistant-key { padding: 16px; background: var(--el-fill-color-light); border-bottom: 1px solid var(--el-border-color-light); }.assistant-key p { font-size: 13px; line-height: 1.6; }.assistant-key small { color: var(--el-text-color-secondary); font-size: 11px; line-height: 1.6; display: block; }.key-actions { display: flex; justify-content: space-between; align-items: center; margin: 10px 0; }.key-actions a { font-size: 12px; color: var(--el-color-primary); }
.assistant-messages { flex: 1; min-height: 80px; overflow-y: auto; padding: 18px 16px; overscroll-behavior: contain; }.assistant-welcome { padding: 20px 0; }.assistant-spark { font-size: 36px; color: var(--el-color-primary); }.assistant-welcome h3 { font-size: 19px; margin: 14px 0 8px; }.assistant-welcome p { font-size: 13px; color: var(--el-text-color-secondary); line-height: 1.7; }.assistant-welcome button { display: flex; justify-content: space-between; width: 100%; text-align: left; padding: 12px; margin-top: 8px; background: var(--el-fill-color-light); border: 1px solid var(--el-border-color-lighter); border-radius: 8px; color: var(--el-text-color-regular); cursor: pointer; font: inherit; font-size: 12px; gap: 8px; }
.assistant-turn { margin-bottom: 26px; }.user-message { margin-left: 24px; padding: 11px 13px; background: var(--el-color-primary-light-9); border-radius: 12px 12px 2px 12px; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13px; line-height: 1.7; }.ai-message { margin-top: 16px; }.speaker { color: var(--el-color-primary); font-size: 11px; font-weight: 600; }.ai-message p { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13px; line-height: 1.8; margin: 6px 0 12px; }
.assistant-changes { border: 1px solid var(--el-border-color); border-radius: 9px; padding: 10px; }.assistant-changes > button { display: flex; align-items: center; gap: 8px; width: 100%; padding: 9px 4px; background: transparent; border: none; border-bottom: 1px solid var(--el-border-color-lighter); color: inherit; cursor: pointer; text-align: left; }.assistant-changes > button span { font-size: 10px; padding: 3px 5px; border-radius: 4px; color: var(--el-color-primary); background: var(--el-color-primary-light-9); }.assistant-changes > button b { font-size: 12px; font-weight: 500; flex: 1; overflow-wrap: anywhere; }.assistant-changes details { font-size: 12px; margin: 10px 0; }.assistant-changes summary { cursor: pointer; color: var(--el-text-color-secondary); }.change-diff { margin: 12px 0; }.change-diff pre { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 220px; overflow: auto; background: var(--el-fill-color-light); padding: 8px; font-size: 11px; }.assistant-decision { display: flex; justify-content: flex-end; margin-top: 12px; }.resolved-state { display: block; margin-top: 12px; color: var(--el-text-color-secondary); }
.assistant-compose { padding: 12px 16px 16px; border-top: 1px solid var(--el-border-color-lighter); }.compose-actions { display: flex; justify-content: space-between; align-items: center; margin-top: 10px; }.compose-actions small,.pending-hint { font-size: 11px; color: var(--el-text-color-secondary); }.thinking,.assistant-feedback { font-size: 12px; line-height: 1.6; color: var(--el-text-color-secondary); }.thinking span { display: inline-block; width: 7px; height: 7px; background: var(--el-color-primary); border-radius: 50%; margin-right: 5px; }.assistant-feedback { color: var(--el-color-success); }
@media(max-width:1080px) { .assistant-launch { margin: 8px; }.assistant-launch > span { display: none; } }
</style>
