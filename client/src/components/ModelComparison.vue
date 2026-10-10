<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, Plus, Search } from '@element-plus/icons-vue'
import { MAX_COMPARISON_CODE_BYTES, MAX_COMPARISON_MODELS, normalizeComparisonCode } from '@wb/shared'
import type { ComparisonEntry, ComparisonInput, ComparisonSummary, ComparisonTopic } from '@wb/shared'
import { del, get, post, put } from '../api/http'
import { useCompactLayout } from '../composables/useCompactLayout'
import { useRememberedSelection } from '../composables/useRememberedSelection'
import { useUnsavedChanges } from '../composables/useUnsavedChanges'
import { wrapPreviewDoc } from '../utils/previewDoc'

const pageEl = ref<HTMLElement>()
const compact = useCompactLayout(pageEl, 1000)
const listVisible = ref(false)
const topics = ref<ComparisonSummary[]>([])
const search = ref('')
const currentId = ref(0)
const lastTopicId = useRememberedSelection<number>('workbench.compareTopic', 0, (value): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0)
const form = ref<ComparisonInput | null>(null)
const snapshot = ref('null')
const dirty = computed(() => JSON.stringify(form.value) !== snapshot.value)
const loading = ref(false)
const saving = ref(false)
const readingFile = ref(false)
const busy = computed(() => loading.value || saving.value || readingFile.value)
const loadError = ref('')
const saveError = ref('')
const selectedIds = ref<string[]>([])
const previewCodes = ref<Record<string, string>>({})
const editorId = ref('')
const editorVisible = ref(false)
const editingEntry = computed(() => form.value?.entries.find((entry) => entry.id === editorId.value))
const expandedId = ref('')
const expandedEntry = computed(() => form.value?.entries.find((entry) => entry.id === expandedId.value))
const expandedVisible = ref(false)
const fileInput = ref<HTMLInputElement>()
let fileTargetId = ''
let initialLoad: Promise<void> = Promise.resolve()
const confirmLeave = useUnsavedChanges(dirty, saveTopic, '当前对比主题', true)

const filteredTopics = computed(() => {
  const keyword = search.value.trim().toLowerCase()
  return topics.value.filter((topic) => topic.name.toLowerCase().includes(keyword))
})
const visibleEntries = computed(() => form.value?.entries.filter((entry) => selectedIds.value.includes(entry.id)) ?? [])
const gridStyle = computed(() => ({ gridTemplateColumns: `repeat(${Math.max(1, Math.min(3, visibleEntries.value.length))}, minmax(280px, 1fr))` }))

function emptyEntry(index: number): ComparisonEntry {
  return { id: crypto.randomUUID(), name: `模型 ${index}`, code: '', format: 'html', fileName: '' }
}

function applyTopic(topic: ComparisonTopic) {
  currentId.value = topic.id
  lastTopicId.value = topic.id
  form.value = { name: topic.name, prompt: topic.prompt, entries: topic.entries }
  snapshot.value = JSON.stringify(form.value)
  selectedIds.value = topic.entries.map((entry) => entry.id)
  previewCodes.value = Object.fromEntries(topic.entries.map((entry) => [entry.id, entry.code]))
  saveError.value = ''
  if (compact.value) listVisible.value = false
}

async function loadTopics(): Promise<boolean> {
  loadError.value = ''
  try {
    topics.value = (await get<{ topics: ComparisonSummary[] }>('/api/ai/comparisons')).topics
    return true
  } catch (e) {
    loadError.value = (e as Error).message
    return false
  }
}

async function openTopic(topic: ComparisonSummary) {
  if (busy.value || topic.id === currentId.value || !(await confirmLeave())) return
  loading.value = true
  try { applyTopic((await get<{ topic: ComparisonTopic }>(`/api/ai/comparisons/${topic.id}`)).topic) }
  catch (e) { ElMessage.error(`打开主题失败：${(e as Error).message}`) }
  finally { loading.value = false }
}

async function newTopic(seed?: { name: string; prompt: string }) {
  await initialLoad
  if (busy.value || !(await confirmLeave())) return
  currentId.value = 0
  form.value = { name: seed?.name ?? '', prompt: seed?.prompt ?? '', entries: [emptyEntry(1), emptyEntry(2)] }
  snapshot.value = 'null'
  selectedIds.value = form.value.entries.map((entry) => entry.id)
  previewCodes.value = {}
  saveError.value = ''
  listVisible.value = false
  await nextTick()
  pageEl.value?.querySelector<HTMLInputElement>('[aria-label="主题名称"]')?.focus()
}
defineExpose({ newTopic })

async function saveTopic(): Promise<boolean> {
  if (busy.value || !form.value) return false
  const original = form.value
  const originalSnapshot = JSON.stringify(original)
  let payload: ComparisonInput
  try {
    if (!original.name.trim()) throw new Error('请填写主题名称')
    payload = {
      name: original.name.trim(), prompt: original.prompt.trim(),
      entries: original.entries.map((entry, index) => {
        if (!entry.name.trim()) throw new Error(`请填写第 ${index + 1} 个模型的名称`)
        if (new TextEncoder().encode(entry.code).byteLength > MAX_COMPARISON_CODE_BYTES) throw new Error(`${entry.name} 的代码不能超过 2 MB`)
        return { ...entry, name: entry.name.trim(), ...normalizeComparisonCode(entry.code) }
      }),
    }
  } catch (e) {
    ElMessage.warning((e as Error).message)
    return false
  }
  saving.value = true
  saveError.value = ''
  try {
    const response = currentId.value
      ? await put<{ topic: ComparisonTopic }>(`/api/ai/comparisons/${currentId.value}`, payload)
      : await post<{ topic: ComparisonTopic }>('/api/ai/comparisons', payload)
    if (form.value === original) {
      currentId.value = response.topic.id
      lastTopicId.value = response.topic.id
      if (JSON.stringify(form.value) === originalSnapshot) {
        form.value = { name: response.topic.name, prompt: response.topic.prompt, entries: response.topic.entries }
      }
      snapshot.value = JSON.stringify({ name: response.topic.name, prompt: response.topic.prompt, entries: response.topic.entries })
      previewCodes.value = Object.fromEntries(response.topic.entries.map((entry) => [entry.id, entry.code]))
    }
    ElMessage.success('主题已保存，随时可以从左侧重新打开')
    if (!(await loadTopics())) ElMessage.warning('主题已保存，主题列表刷新失败，可点击重试')
    return true
  } catch (e) {
    saveError.value = (e as Error).message
    ElMessage.error(`保存失败：${saveError.value}`)
    return false
  } finally { saving.value = false }
}

async function removeTopic() {
  if (busy.value || !form.value || !currentId.value) return
  try { await ElMessageBox.confirm(`删除「${form.value.name}」及其中的所有模型作品？`, '删除对比主题', { type: 'warning' }) }
  catch { return }
  saving.value = true
  try {
    await del(`/api/ai/comparisons/${currentId.value}`)
    currentId.value = 0
    lastTopicId.value = 0
    form.value = null
    snapshot.value = 'null'
    await loadTopics()
    ElMessage.success('主题已删除')
  } catch (e) { ElMessage.error(`删除失败：${(e as Error).message}`) }
  finally { saving.value = false }
  if (topics.value[0]) await openTopic(topics.value[0])
}

function addEntry() {
  if (!form.value || busy.value) return
  const entry = emptyEntry(form.value.entries.length + 1)
  form.value.entries.push(entry)
  selectedIds.value.push(entry.id)
}

async function removeEntry(entry: ComparisonEntry) {
  if (!form.value || busy.value || form.value.entries.length <= 2) return
  if (entry.code.trim()) {
    try { await ElMessageBox.confirm(`移除「${entry.name}」及其作品？保存主题后生效。`, '移除模型', { type: 'warning' }) }
    catch { return }
  }
  form.value.entries = form.value.entries.filter((item) => item.id !== entry.id)
  selectedIds.value = selectedIds.value.filter((id) => id !== entry.id)
  delete previewCodes.value[entry.id]
}

function editCode(entry: ComparisonEntry) {
  editorId.value = entry.id
  editorVisible.value = true
}

function updatePreview(entry: ComparisonEntry): boolean {
  try {
    const normalized = normalizeComparisonCode(entry.code)
    if (new TextEncoder().encode(normalized.code).byteLength > MAX_COMPARISON_CODE_BYTES) throw new Error('作品代码不能超过 2 MB')
    Object.assign(entry, normalized)
    previewCodes.value[entry.id] = entry.code
    return true
  } catch (e) { ElMessage.warning((e as Error).message); return false }
}

async function saveEditor() {
  if (editingEntry.value && updatePreview(editingEntry.value) && await saveTopic() && !dirty.value) editorVisible.value = false
}

function chooseFile(entry: ComparisonEntry) {
  fileTargetId = entry.id
  fileInput.value?.click()
}

async function importFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  const topic = form.value
  const entry = topic?.entries.find((item) => item.id === fileTargetId)
  if (!file || !entry || busy.value) return
  if (!/\.(svg|html?)$/i.test(file.name)) { ElMessage.warning('请选择 .svg、.html 或 .htm 文件'); return }
  if (file.size > MAX_COMPARISON_CODE_BYTES) { ElMessage.warning('文件不能超过 2 MB'); return }
  readingFile.value = true
  try {
    const normalized = normalizeComparisonCode(await file.text())
    if (!normalized.code) throw new Error('文件是空的，请选择包含 SVG 或 HTML 代码的文件')
    if (form.value !== topic) return
    Object.assign(entry, normalized, { fileName: file.name })
    previewCodes.value[entry.id] = entry.code
    ElMessage.success('作品已导入并预览，保存主题后可随时查看')
  } catch (e) { ElMessage.error(`导入失败：${(e as Error).message}`) }
  finally { readingFile.value = false }
}

async function copyText(value: string) {
  try { await navigator.clipboard.writeText(value); ElMessage.success('已复制') }
  catch { ElMessage.warning('复制失败，请打开源码手动复制') }
}

function previewDoc(entry: ComparisonEntry): string {
  const code = (previewCodes.value[entry.id] ?? '').replace(/^\s*<\?xml[\s\S]*?\?>\s*/i, '').replace(/^<!doctype\s+svg[^>]*>\s*/i, '')
  return code ? wrapPreviewDoc(code, { padding: 0, maxHeight: '100vh' }) : ''
}

function expand(entry: ComparisonEntry) {
  expandedId.value = entry.id
  expandedVisible.value = true
}

async function initialize() {
  loading.value = true
  const success = await loadTopics()
  loading.value = false
  if (!success) return
  const topic = topics.value.find((item) => item.id === lastTopicId.value) ?? topics.value[0]
  if (topic) await openTopic(topic)
}
onMounted(() => { initialLoad = initialize() })
</script>

<template>
  <div ref="pageEl" class="comparison-page" :class="{ compact }">
    <div class="comparison-head">
      <div><h3>模型作品对比</h3><p>用同一提示词在不同平台生成作品，再把 SVG 或 HTML 汇总到一个主题中。</p></div>
      <div class="head-actions">
        <el-button v-if="compact" :aria-expanded="listVisible" @click="listVisible = !listVisible">{{ listVisible ? '收起主题列表' : '查看已保存主题' }}</el-button>
        <el-button type="primary" :icon="Plus" :disabled="busy" @click="newTopic()">新建主题</el-button>
      </div>
    </div>
    <div class="comparison-workspace">
      <button v-if="compact && listVisible" class="topic-backdrop" aria-label="关闭主题列表" @click="listVisible = false" />
      <aside v-show="!compact || listVisible" class="topic-sidebar">
        <div class="sidebar-label">已保存主题 <span>{{ topics.length }}</span></div>
        <el-input v-model="search" placeholder="搜索主题" aria-label="搜索对比主题" :prefix-icon="Search" clearable />
        <el-alert v-if="loadError" :title="`加载失败：${loadError}`" type="error" :closable="false"><el-button size="small" @click="loadTopics">重试</el-button></el-alert>
        <div class="topic-list" v-loading="loading">
          <button v-for="topic in filteredTopics" :key="topic.id" class="topic-item" :class="{ active: currentId === topic.id }" :disabled="busy" @click="openTopic(topic)">
            <span class="topic-name">{{ topic.name }}</span><span class="topic-meta">{{ topic.modelCount }} 个模型 · {{ topic.updatedAt.slice(0, 10) }}</span>
          </button>
          <el-empty v-if="!loading && !loadError && !filteredTopics.length" :image-size="55" :description="search.trim() ? '没有匹配的主题' : '还没有保存的主题'" />
        </div>
      </aside>
      <main class="comparison-main" v-loading="loading">
        <template v-if="form">
          <div class="topic-toolbar">
            <el-input v-model="form.name" placeholder="主题名称，例如：鹈鹕骑自行车测试" aria-label="主题名称" :disabled="busy" maxlength="120" class="topic-title" />
            <span class="save-status" role="status" :title="saveError">{{ saving ? '正在保存…' : saveError ? '保存失败，可重试' : dirty ? '有未保存修改' : '已保存' }}</span>
            <el-button type="primary" :loading="saving" :disabled="!dirty || loading || readingFile" @click="saveTopic">{{ saveError ? '重试保存' : '保存主题' }}</el-button>
            <el-button v-if="currentId" :icon="Delete" :disabled="busy" @click="removeTopic">删除主题</el-button>
          </div>
          <details class="prompt-details" :open="!!form.prompt">
            <summary>共同提示词 <span>{{ form.prompt ? '已记录' : '选填' }}</span></summary>
            <el-input v-model="form.prompt" type="textarea" :rows="3" :disabled="busy" aria-label="共同提示词" placeholder="记录这次在各平台使用的同一提示词，方便之后复现" />
            <el-button size="small" :disabled="!form.prompt.trim()" @click="copyText(form.prompt)">复制提示词</el-button>
          </details>
          <div class="model-toolbar">
            <span>参与对比</span>
            <el-checkbox-group v-model="selectedIds">
              <el-checkbox v-for="entry in form.entries" :key="entry.id" :value="entry.id">{{ entry.name || '未命名模型' }}</el-checkbox>
            </el-checkbox-group>
            <el-button :icon="Plus" :disabled="busy || form.entries.length >= MAX_COMPARISON_MODELS" @click="addEntry">添加模型</el-button>
          </div>
          <p v-if="visibleEntries.length < 2" class="selection-hint">勾选两个或更多模型，即可并排对比作品。</p>
          <div class="gallery-scroll">
            <div class="comparison-grid" :style="gridStyle">
              <article v-for="entry in visibleEntries" :key="entry.id" class="model-card" :aria-label="`${entry.name} 的作品`">
                <header class="model-card-head">
                  <el-input v-model="entry.name" :aria-label="`${entry.id} 的模型名称`" placeholder="模型名称，例如：DeepSeek V3" :disabled="busy" maxlength="120" />
                  <el-tag v-if="entry.code.trim()" size="small" effect="plain">{{ entry.format.toUpperCase() }}</el-tag>
                  <el-button text :icon="Delete" :disabled="busy || form.entries.length <= 2" aria-label="移除模型" @click="removeEntry(entry)" />
                </header>
                <div class="model-actions">
                  <el-button size="small" :disabled="busy" @click="editCode(entry)">{{ entry.code.trim() ? '编辑源码' : '粘贴代码' }}</el-button>
                  <el-button size="small" :loading="readingFile" :disabled="busy" @click="chooseFile(entry)">选择文件</el-button>
                  <el-button size="small" :disabled="!entry.code.trim()" @click="copyText(entry.code)">复制代码</el-button>
                  <el-button size="small" :disabled="!previewCodes[entry.id]" @click="expand(entry)">放大查看</el-button>
                </div>
                <div class="model-source"><span :title="entry.fileName">{{ entry.fileName || (entry.code.trim() ? '粘贴的代码' : '等待添加作品') }}</span><el-tag v-if="entry.code !== (previewCodes[entry.id] ?? '')" type="warning" size="small">待更新预览</el-tag></div>
                <iframe v-if="previewCodes[entry.id]" :srcdoc="previewDoc(entry)" sandbox="allow-scripts" :title="`${entry.name} 的作品预览`" class="model-preview" />
                <div v-else class="model-empty"><el-empty :image-size="65" description="添加这个模型生成的 SVG 或 HTML"><el-button type="primary" plain size="small" :disabled="busy" @click="editCode(entry)">粘贴代码</el-button></el-empty></div>
              </article>
            </div>
          </div>
        </template>
        <el-empty v-else-if="!loading" description="新建一个主题，把不同模型的作品放在一起比较"><el-button type="primary" :disabled="busy" @click="newTopic()">新建主题</el-button></el-empty>
      </main>
    </div>
    <input ref="fileInput" type="file" accept=".svg,.html,.htm" hidden @change="importFile" />
    <el-drawer v-model="editorVisible" :title="`作品源码 · ${editingEntry?.name || '模型'}`" size="min(680px, 94vw)" :close-on-click-modal="false">
      <template v-if="editingEntry">
        <p class="code-hint">粘贴完整 SVG 或 HTML，也支持包含代码块的模型回复。</p>
        <el-input v-model="editingEntry.code" type="textarea" :rows="23" :disabled="busy" aria-label="作品源码" placeholder="把模型生成的 SVG 或 HTML 粘贴到这里" class="code-input" />
      </template>
      <template #footer>
        <el-button :disabled="busy" @click="editorVisible = false">关闭</el-button>
        <el-button :disabled="busy || !editingEntry" @click="editingEntry && updatePreview(editingEntry)">更新预览</el-button>
        <el-button type="primary" :loading="saving" :disabled="loading || readingFile" @click="saveEditor">保存并关闭</el-button>
      </template>
    </el-drawer>
    <el-dialog v-model="expandedVisible" :title="expandedEntry?.name || '作品预览'" width="92vw" top="3vh" destroy-on-close>
      <iframe v-if="expandedEntry" :srcdoc="previewDoc(expandedEntry)" sandbox="allow-scripts" :title="`${expandedEntry.name} 的放大预览`" class="expanded-preview" />
    </el-dialog>
  </div>
</template>

<style scoped>
.comparison-head, .head-actions, .topic-toolbar, .model-toolbar, .model-card-head, .model-actions, .model-source { display: flex; align-items: center; gap: 10px; }
.comparison-head { justify-content: space-between; flex-wrap: wrap; margin-bottom: 16px; }
.comparison-head h3 { margin: 0 0 6px; font-size: 18px; color: var(--el-text-color-primary); }
.comparison-head p, .code-hint { margin: 0; font-size: 13px; line-height: 1.6; color: var(--el-text-color-secondary); }
.head-actions { flex-wrap: wrap; }
.comparison-workspace { position: relative; display: flex; align-items: flex-start; gap: 18px; min-height: 520px; }
.topic-sidebar { flex: 0 0 210px; box-sizing: border-box; padding: 12px; background: var(--el-bg-color); border: 1px solid var(--el-border-color); border-radius: var(--wb-radius-card); }
.sidebar-label { display: flex; justify-content: space-between; margin-bottom: 12px; font-size: 13px; font-weight: 600; color: var(--el-text-color-primary); }
.sidebar-label span { color: var(--el-text-color-secondary); font-weight: 400; }
.topic-list { max-height: 65vh; overflow: auto; margin-top: 10px; }
.topic-item { display: block; width: 100%; padding: 12px 10px; border: 0; border-radius: var(--wb-radius-base); background: transparent; color: var(--el-text-color-primary); font: inherit; text-align: left; cursor: pointer; }
.topic-item:hover { background: var(--el-fill-color-light); }
.topic-item.active { background: var(--el-color-primary-light-9); color: var(--wb-accent-text); }
.topic-item:disabled { cursor: default; }
.topic-name { display: block; font-size: 13px; overflow-wrap: anywhere; }
.topic-meta { display: block; font-size: 11px; color: var(--el-text-color-secondary); margin-top: 5px; }
.comparison-main { flex: 1; min-width: 0; }
.topic-toolbar { flex-wrap: wrap; margin-bottom: 14px; }
.topic-title { flex: 1; min-width: 220px; }
.save-status { color: var(--el-text-color-secondary); font-size: 12px; }
.prompt-details { padding: 12px; margin-bottom: 14px; background: var(--el-bg-color); border: 1px solid var(--el-border-color); border-radius: var(--wb-radius-card); }
.prompt-details summary { cursor: pointer; font-size: 13px; color: var(--el-text-color-primary); }
.prompt-details summary span { color: var(--el-text-color-secondary); font-size: 12px; margin-left: 8px; }
.prompt-details[open] summary { margin-bottom: 10px; }
.prompt-details .el-button { margin-top: 8px; }
.model-toolbar { flex-wrap: wrap; margin-bottom: 14px; font-size: 13px; color: var(--el-text-color-regular); }
.model-toolbar .el-checkbox-group { display: flex; flex: 1; flex-wrap: wrap; gap: 6px 14px; }
.model-toolbar .el-checkbox { margin-right: 0; }
.selection-hint { font-size: 13px; color: var(--el-text-color-secondary); }
.gallery-scroll { overflow-x: auto; padding-bottom: 8px; }
.comparison-grid { display: grid; gap: 14px; }
.model-card { min-width: 0; overflow: hidden; background: var(--el-bg-color); border: 1px solid var(--el-border-color); border-radius: var(--wb-radius-card); }
.model-card-head { padding: 12px; border-bottom: 1px solid var(--el-border-color-lighter); }
.model-card-head .el-input { flex: 1; min-width: 0; }
.model-actions { flex-wrap: wrap; gap: 6px; padding: 10px 12px 6px; }
.model-actions .el-button + .el-button { margin-left: 0; }
.model-source { justify-content: space-between; min-height: 25px; padding: 0 12px 8px; color: var(--el-text-color-secondary); font-size: 11px; }
.model-source > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.model-preview, .model-empty { display: block; width: 100%; height: 460px; background: #fff; border: 0; border-top: 1px solid var(--el-border-color-lighter); }
.model-empty { display: flex; align-items: center; justify-content: center; background: var(--el-fill-color-lighter); }
.code-input { margin-top: 14px; }
.code-input :deep(textarea) { font-family: var(--wb-font-mono, monospace); font-size: 12px; line-height: 1.65; }
.expanded-preview { width: 100%; height: 78vh; border: 0; background: #fff; }
.compact .topic-sidebar { position: absolute; inset: 0 auto auto 0; z-index: 4; width: min(300px, 90%); box-shadow: var(--el-box-shadow-light); }
.topic-backdrop { position: absolute; inset: 0; z-index: 3; border: 0; background: rgb(0 0 0 / 18%); cursor: pointer; }
</style>
