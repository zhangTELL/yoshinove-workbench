<script setup lang="ts">
import type { Semester } from '@wb/shared'
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, Plus } from '@element-plus/icons-vue'
import Vditor from 'vditor'
import 'vditor/dist/index.css'
import { del, get, post, put } from '../api/http'

interface NoteMeta {
  id: number
  title: string
  courseTag: string
  category: string
  updatedAt: string
  excerpt: string
}
interface NoteFull extends NoteMeta {
  content: string
  createdAt: string
}

// ===== 状态 =====
const loading = ref(true)
const notes = ref<NoteMeta[]>([])
const tags = ref<string[]>([])
const categories = ref<string[]>([])
const courseOptions = ref<string[]>([])
const searchQuery = ref('')
const filterTag = ref('')
const filterCategory = ref('')

const currentId = ref<number | null>(null)
const title = ref('')
const courseTag = ref('')
const category = ref('')
const dirty = ref(false)
const saving = ref(false)

const vditor = ref<Vditor | null>(null)
const editorEl = ref<HTMLDivElement>()
let suppressDirty = false

// ===== 主题 =====
interface ThemeItem {
  name: string
  file: string
}
const themes = ref<ThemeItem[]>([])
const themeName = ref('')
const previewVisible = ref(false)
const previewHtml = ref('')

const filteredNotes = computed(() =>
  notes.value.filter(
    (n) =>
      (!filterTag.value || n.courseTag === filterTag.value) &&
      (!filterCategory.value || n.category === filterCategory.value),
  ),
)

// ===== 初始化 =====
onMounted(async () => {
  await nextTick()
  vditor.value = new Vditor(editorEl.value!, {
    height: '100%',
    mode: 'ir',
    cdn: '/vditor',
    placeholder: '开始记录笔记…（支持 Markdown、公式、代码块、表格）',
    cache: { enable: false },
    after: () => {
      setWriteId()
      void loadInitial()
    },
    input: () => {
      if (!suppressDirty) dirty.value = true
      setWriteId()
    },
    toolbar: [
      'headings', 'bold', 'italic', 'strike', '|',
      'list', 'ordered-list', 'check', 'quote', '|',
      'code', 'inline-code', 'table', 'link', '|',
      'line', 'undo', 'redo', '|',
      'fullscreen', 'edit-mode', 'export',
    ],
  })
})

onBeforeUnmount(() => {
  vditor.value?.destroy()
  // 离开笔记页时移除主题样式，避免影响其他页面
  document.getElementById('typora-theme-style')?.remove()
})

async function loadInitial() {
  loading.value = true
  try {
    await loadList()
    await loadCourseOptions()
    await loadThemes()
  } finally {
    loading.value = false
  }
}

async function loadThemes() {
  try {
    themes.value = (await get<{ themes: ThemeItem[] }>('/api/notes/themes')).themes
    themeName.value = (await get<{ value: string | null }>('/api/settings/notes.theme')).value ?? ''
    await applyEditorTheme()
  } catch (e) {
    ;(window as unknown as { __themeLoadErr?: string }).__themeLoadErr = (e as Error).message
  }
}

async function importThemes() {
  try {
    const r = await post<{ detail: string }>('/api/notes/themes/import', {})
    ElMessage.success(r.detail)
    await loadThemes()
  } catch (e) {
    ElMessage.error((e as Error).message)
  }
}

async function onThemeChange(file: string) {
  await put('/api/settings', { 'notes.theme': file })
  await applyEditorTheme()
}

/**
 * 把 Typora 主题 CSS 限定作用域到编辑器内部：
 * - #write / body / html 选择器 → 映射到编辑区元素（编辑区会挂上 id="write"）
 * - 其余选择器 → 加 #write 前缀，避免污染应用其他部分
 * - @font-face/@keyframes/@media 保留（media 内递归处理）
 */
function scopeTyporaCss(css: string): string {
  css = css.replace(/@import[^;]+;/g, '')
  let out = ''
  let i = 0
  const len = css.length
  while (i < len) {
    const brace = css.indexOf('{', i)
    if (brace === -1) break
    const sel = css.slice(i, brace).trim()
    let depth = 1
    let j = brace + 1
    while (j < len && depth > 0) {
      if (css[j] === '{') depth++
      else if (css[j] === '}') depth--
      j++
    }
    const body = css.slice(brace + 1, j - 1)
    if (/^@(media|supports|layer)\b/.test(sel)) {
      out += sel + '{' + scopeTyporaCss(body) + '}'
    } else if (sel.startsWith('@')) {
      out += sel + '{' + body + '}'
    } else if (sel === ':root' || sel.startsWith(':root')) {
      out += sel + '{' + body + '}'
    } else {
      const scoped = sel
        .split(',')
        .map((raw) => {
          let s = raw.trim()
          if (!s) return s
          s = s.replace(/#write\b/g, '§TGT§').replace(/\bbody\b/g, '§TGT§').replace(/\bhtml\b/g, '§TGT§')
          if (s.includes('§TGT§')) return s.replace(/§TGT§/g, '#write')
          return '#write ' + s
        })
        .join(', ')
      out += scoped + '{' + body + '}'
    }
    i = j
  }
  return out
}

/** 注入/更换编辑器主题样式 */
async function applyEditorTheme() {
  document.getElementById('typora-theme-style')?.remove()
  if (!themeName.value) return
  try {
    const [baseRes, themeRes] = await Promise.all([fetch('/themes/base.user.css'), fetch(`/themes/${themeName.value}`)])
    const base = baseRes.ok ? scopeTyporaCss(await baseRes.text()) : ''
    const theme = themeRes.ok ? scopeTyporaCss(await themeRes.text()) : ''
    const style = document.createElement('style')
    style.id = 'typora-theme-style'
    style.textContent = base + '\n' + theme
    document.head.appendChild(style)
    setWriteId()
  } catch (e) {
    ;(window as unknown as { __themeErr?: string }).__themeErr = (e as Error).message
  }
}

function setWriteId() {
  const el = document.querySelector('.vditor-ir .vditor-reset')
  if (el) el.setAttribute('id', 'write')
}

/** 用 Typora 主题渲染笔记 HTML（iframe 预览与导出共用） */
function buildThemedHtml(): string {
  const html = vditor.value?.getHTML() ?? ''
  const cssLink = themeName.value ? `<link rel="stylesheet" href="/themes/${themeName.value}">` : ''
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${title.value}</title>
${cssLink}
<style>
  body { margin: 0 auto; max-width: 820px; padding: 24px 32px; }
  #write { min-height: 60vh; }
</style></head><body>
<div id="write"><h1>${title.value}</h1>
${html}
</div>
</body></html>`
}

function openPreview() {
  previewHtml.value = buildThemedHtml()
  previewVisible.value = true
}

/** 导出 PDF：按主题渲染后调起打印 */
function exportPdf() {
  if (currentId.value === null) return
  const themed = buildThemedHtml()
  const printable = themeName.value
    ? themed.replace('</body>', '<script>window.onload = () => setTimeout(() => window.print(), 400)<\/script></body>')
    : themed.replace('</body>', '<script>window.onload = () => setTimeout(() => window.print(), 300)<\/script></body>')
  const w = window.open('', '_blank')
  if (!w) {
    ElMessage.error('浏览器拦截了新窗口，请允许弹窗后重试')
    return
  }
  w.document.write(printable)
  w.document.close()
}

async function loadList() {
  const params = new URLSearchParams()
  if (searchQuery.value.trim()) params.set('query', searchQuery.value.trim())
  notes.value = await get<NoteMeta[]>(`/api/notes?${params.toString()}`)
  const meta = await get<{ tags: string[]; categories: string[] }>('/api/notes/meta')
  tags.value = meta.tags
  categories.value = meta.categories
}

async function loadCourseOptions() {
  try {
    const sems = await get<Semester[]>('/api/semesters')
    const cur = sems.find((s) => s.isCurrent) ?? sems[0]
    if (cur) {
      const sched = await get<{ courses: { name: string }[] }>(`/api/schedule?semesterId=${cur.id}`)
      courseOptions.value = sched.courses.map((c) => c.name)
    }
  } catch { /* 课表未配置不影响笔记 */ }
}

// ===== 笔记操作 =====
async function openNote(n: NoteMeta) {
  if (dirty.value && !(await confirmSave())) return
  const full = await get<NoteFull>(`/api/notes/${n.id}`)
  if (!full) return
  suppressDirty = true
  currentId.value = full.id
  title.value = full.title
  courseTag.value = full.courseTag
  category.value = full.category
  vditor.value?.setValue(full.content)
  dirty.value = false
  setTimeout(() => (suppressDirty = false), 50)
}

async function confirmSave(): Promise<boolean> {
  try {
    await ElMessageBox.confirm('当前笔记有未保存的修改，确定离开？', '提示', {
      confirmButtonText: '不保存离开',
      cancelButtonText: '留在这',
      type: 'warning',
    })
    dirty.value = false
    return true
  } catch {
    return false
  }
}

async function createNote() {
  if (dirty.value && !(await confirmSave())) return
  const r = await post<{ id: number }>('/api/notes', {
    title: '未命名笔记',
    content: '',
    courseTag: courseTag.value,
    category: category.value,
  })
  currentId.value = r.id
  title.value = '未命名笔记'
  courseTag.value = courseTag.value
  suppressDirty = true
  vditor.value?.setValue('')
  dirty.value = false
  setTimeout(() => (suppressDirty = false), 50)
  await loadList()
  ElMessage.success('已创建，开始编辑吧')
}

async function saveNote() {
  if (currentId.value === null) return
  saving.value = true
  try {
    await put(`/api/notes/${currentId.value}`, {
      title: title.value,
      content: vditor.value?.getValue() ?? '',
      courseTag: courseTag.value,
      category: category.value,
    })
    dirty.value = false
    await loadList()
    ElMessage.success('已保存')
  } finally {
    saving.value = false
  }
}

async function removeNote() {
  if (currentId.value === null) return
  await ElMessageBox.confirm(`删除笔记「${title.value}」？不可恢复。`, '确认', { type: 'warning' })
  await del(`/api/notes/${currentId.value}`)
  currentId.value = null
  title.value = ''
  suppressDirty = true
  vditor.value?.setValue('')
  await loadList()
  ElMessage.success('已删除')
}

/** 从资源管理器导入 .md 文件（按钮多选 / 拖拽） */
const fileInput = ref<HTMLInputElement>()

async function importFiles(files: Iterable<File>) {
  let imported = 0
  let skipped = 0
  for (const f of Array.from(files)) {
    if (!/\.(md|markdown|txt)$/i.test(f.name)) {
      skipped++
      continue
    }
    const text = await f.text()
    await post('/api/notes', {
      title: f.name.replace(/\.(md|markdown|txt)$/i, ''),
      content: text,
      courseTag: courseTag.value,
      category: category.value,
    })
    imported++
  }
  await loadList()
  if (imported) ElMessage.success(`已导入 ${imported} 篇笔记${skipped ? `（跳过 ${skipped} 个非 Markdown 文件）` : ''}`)
  else ElMessage.warning('没有可导入的 .md 文件')
}

function onFilePick(e: Event) {
  const input = e.target as HTMLInputElement
  if (input.files?.length) void importFiles(input.files)
  input.value = ''
}

function onDrop(e: DragEvent) {
  e.preventDefault()
  if (e.dataTransfer?.files.length) void importFiles(e.dataTransfer.files)
}

/** Ctrl+S 保存 */
function onKeydown(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault()
    if (currentId.value !== null) void saveNote()
  }
}
onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div class="notes-page" @dragover.prevent @drop.prevent="onDrop">
    <!-- 左侧：搜索 + 筛选 + 列表 -->
    <aside class="sidebar">
      <el-button type="primary" :icon="Plus" style="width: 100%" @click="createNote">新建笔记</el-button>
      <el-button style="width: 100%; margin: 8px 0 0" @click="fileInput?.click()">导入 MD 文件</el-button>
      <input ref="fileInput" type="file" accept=".md,.markdown,.txt" multiple hidden @change="onFilePick" />
      <div class="drop-hint">把 .md 文件拖到这一页就能导入</div>
      <el-input v-model="searchQuery" placeholder="搜索标题/内容…" clearable style="margin-top: 10px" @input="loadList" />
      <div class="filter-group">
        <div class="filter-title">课程标签</div>
        <div class="filter-item" :class="{ active: !filterTag }" @click="filterTag = ''">全部</div>
        <div v-for="t in tags" :key="t" class="filter-item" :class="{ active: filterTag === t }" @click="filterTag = t">
          {{ t }}
        </div>
      </div>
      <div class="filter-group">
        <div class="filter-title">分类</div>
        <div class="filter-item" :class="{ active: !filterCategory }" @click="filterCategory = ''">全部</div>
        <div v-for="c in categories" :key="c" class="filter-item" :class="{ active: filterCategory === c }" @click="filterCategory = c">
          {{ c }}
        </div>
      </div>
      <div class="note-list">
        <div
          v-for="n in filteredNotes"
          :key="n.id"
          class="note-item"
          :class="{ current: n.id === currentId }"
          @click="openNote(n)"
        >
          <div class="note-title">{{ n.title }}</div>
          <div class="note-meta">
            <el-tag v-if="n.courseTag" size="small" type="info">{{ n.courseTag }}</el-tag>
            <span>{{ n.updatedAt.slice(0, 16).replace('T', ' ') }}</span>
          </div>
          <div class="note-excerpt">{{ n.excerpt }}</div>
        </div>
        <el-empty v-if="!filteredNotes.length" :image-size="60" description="没有笔记" />
      </div>
    </aside>

    <!-- 右侧：编辑器 -->
    <main class="editor-pane" v-loading="loading">
      <div v-show="currentId !== null" class="editor-wrap">
        <div class="editor-toolbar">
          <el-input v-model="title" placeholder="笔记标题" style="max-width: 320px" size="default">
            <template #append>
              <el-select
                v-model="courseTag"
                placeholder="课程标签"
                style="width: 140px"
                filterable
                allow-create
                default-first-option
                clearable
              >
                <el-option v-for="t in [...new Set([...courseOptions, ...tags])]" :key="t" :value="t" :label="t" />
              </el-select>
            </template>
          </el-input>
          <el-select
            v-model="category"
            placeholder="分类"
            style="width: 120px"
            filterable
            allow-create
            default-first-option
            clearable
          >
            <el-option v-for="c in [...new Set(['课堂笔记', '复习', ...categories])]" :key="c" :value="c" :label="c" />
          </el-select>
          <div style="flex: 1" />
          <el-select
            v-model="themeName"
            placeholder="主题（默认）"
            size="default"
            clearable
            style="width: 140px"
            @change="onThemeChange"
          >
            <el-option v-for="t in themes" :key="t.file" :value="t.file" :label="t.name" />
          </el-select>
          <el-tooltip content="从 Typora 的主题文件夹导入配色">
            <el-button @click="importThemes">导入主题</el-button>
          </el-tooltip>
          <el-button @click="openPreview">预览</el-button>
          <el-button :icon="Delete" text type="danger" @click="removeNote">删除</el-button>
          <el-button @click="exportPdf">导出 PDF</el-button>
          <el-button type="primary" :loading="saving" :disabled="!dirty" @click="saveNote">
            {{ dirty ? '保存' : '已保存' }}
          </el-button>
        </div>
        <div ref="editorEl" class="editor" />
      </div>
      <el-empty v-if="currentId === null" description="从左侧选择笔记，或新建一篇" style="margin-top: 20vh" />
    </main>

    <!-- 主题预览 -->
    <el-dialog v-model="previewVisible" :title="`预览：${title || '未命名'}（${themeName || '默认样式'}）`" width="80%" top="3vh" destroy-on-close>
      <iframe
        :srcdoc="previewHtml"
        style="width: 100%; height: 76vh; border: 1px solid var(--el-border-color); border-radius: 6px; background: var(--el-bg-color)"
      />
    </el-dialog>
  </div>
</template>

<style scoped>
.notes-page {
  display: flex;
  gap: 14px;
  height: calc(100vh - 60px);
}
.sidebar {
  width: 280px;
  flex-shrink: 0;
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color);
  border-radius: var(--wb-radius-card);
  padding: 12px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.filter-group {
  margin-top: 10px;
}
.drop-hint {
  font-size: 11px;
  color: var(--el-text-color-disabled);
  text-align: center;
  margin-top: 6px;
}
.filter-title {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin-bottom: 4px;
}
.filter-item {
  font-size: 13px;
  color: var(--el-text-color-regular);
  padding: 4px 8px;
  border-radius: var(--wb-radius-small);
  cursor: pointer;
}
.filter-item:hover {
  background: var(--el-fill-color-light);
}
.filter-item.active {
  background: var(--el-color-primary-light-9);
  color: var(--el-color-primary);
  font-weight: 600;
}
.note-list {
  flex: 1;
  overflow-y: auto;
  margin-top: 10px;
  border-top: 1px solid var(--el-fill-color);
  padding-top: 8px;
}
.note-item {
  padding: 8px;
  border-radius: var(--wb-radius-base);
  cursor: pointer;
}
.note-item:hover {
  background: var(--el-fill-color-light);
}
.note-item.current {
  background: var(--el-color-primary-light-9);
}
.note-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.note-meta {
  display: flex;
  gap: 8px;
  align-items: center;
  font-size: 11px;
  color: var(--el-text-color-disabled);
  margin-top: 2px;
}
.note-excerpt {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.editor-pane {
  flex: 1;
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color);
  border-radius: var(--wb-radius-card);
  padding: 12px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.editor-wrap {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.editor-toolbar {
  display: flex;
  gap: 10px;
  align-items: center;
  margin-bottom: 10px;
  flex-wrap: wrap;
}
.editor {
  flex: 1;
}
.editor :deep(.vditor) {
  border-radius: var(--wb-radius-base);
}
</style>
