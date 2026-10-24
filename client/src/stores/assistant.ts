import { reactive } from 'vue'
import type { AssistantConfig, AssistantState, AssistantTarget, AssistantTurn } from '@wb/shared'
import { get, post, put } from '../api/http'
import { hasUnsavedEdits } from '../composables/useUnsavedChanges'

export const assistant = reactive({
  open: false, sending: false, resolving: false, switching: false, loading: false, error: '', draft: '',
  config: null as AssistantConfig | null,
  state: { sessionId: 'main', sessions: [], turns: [], pending: null, busy: false } as AssistantState,
})
let loadVersion = 0
export async function loadAssistant() {
  const version = ++loadVersion
  const [config, state] = await Promise.all([get<AssistantConfig>('/api/assistant/config'), get<AssistantState>('/api/assistant/state')])
  if (version !== loadVersion) return
  assistant.config = config
  assistant.state = state
}
export async function saveAssistantKey(apiKey: string) {
  assistant.config = await put<AssistantConfig>('/api/assistant/config', { apiKey })
}
export async function saveAssistantPreferences(preferences: Pick<AssistantConfig, 'name' | 'petDoubleClick'>) {
  assistant.config = await put<AssistantConfig>('/api/assistant/config', preferences)
}
export async function switchAssistantSession(id?: string) {
  if (assistant.switching || assistant.sending || assistant.state.busy) return false
  if (assistant.state.pending) { assistant.error = '请先撤销或确定当前修改，再新建或切换会话。'; return false }
  assistant.switching = true
  assistant.error = ''
  ++loadVersion
  try {
    const state = id ? await put<AssistantState>('/api/assistant/session', { id }) : await post<AssistantState>('/api/assistant/sessions')
    ++loadVersion
    assistant.state = state
    assistant.draft = ''
    return true
  } catch (error) { assistant.error = (error as Error).message; return false }
  finally { assistant.switching = false }
}
export async function sendAssistant(context: { path: string; entity?: unknown; id?: unknown }): Promise<AssistantTurn | null> {
  if (assistant.sending || assistant.state.busy || assistant.state.pending || !assistant.draft.trim()) return null
  if (hasUnsavedEdits()) { assistant.error = '当前编辑页还有未保存内容，请先保存或放弃草稿，再让 AI 操作。'; return null }
  const message = assistant.draft.trim()
  assistant.error = ''
  assistant.sending = true
  try {
    const { turn } = await post<{ turn: AssistantTurn }>('/api/assistant/chat', { message, context })
    assistant.draft = ''
    await loadAssistant()
    return turn
  } catch (error) {
    assistant.error = error instanceof Error ? error.message : '发送失败，请重试'
    try { await loadAssistant() } catch { /* 保留原始失败原因 */ }
    return null
  } finally { assistant.sending = false }
}
export async function resolveAssistant(turn: AssistantTurn, action: 'confirm' | 'undo') {
  if (assistant.resolving) return null
  if (hasUnsavedEdits()) { assistant.error = '请先保存或放弃编辑页的新修改，再处理 AI 修改。'; return null }
  assistant.resolving = true
  assistant.error = ''
  try {
    const result = await post<{ turn: AssistantTurn }>(`/api/assistant/turns/${turn.id}/${action}`)
    await loadAssistant()
    return result.turn
  } catch (error) { assistant.error = error instanceof Error ? error.message : '处理失败'; return null }
  finally { assistant.resolving = false }
}
export function targetLocation(target: AssistantTarget, turn: AssistantTurn) {
  return { path: target.path, query: { ...target.query, aiTurn: turn.id, aiRevision: `${turn.id}-${turn.status}` } }
}
