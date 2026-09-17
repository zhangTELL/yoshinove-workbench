<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, Document, Edit, FolderAdd, FolderOpened, More, Plus, Refresh, Search, Star, StarFilled } from '@element-plus/icons-vue'
import { del, get, patch, post, put } from '../api/http'
import ProjectFiles from '../components/ProjectFiles.vue'

interface Project {
  id: number
  path: string
  name: string
  alias: string | null
  source: string
  score: number
  markers: string
  stack: string
  hasGit: number
  parentPath: string | null
  categoryId: number | null
  gitBranch: string | null
  gitLastCommit: string | null
  gitLastAuthor: string | null
  gitLastSubject: string | null
  gitDirty: number | null
  readmeExcerpt: string | null
  favorite: number
  hidden: number
  tags: string
  note: string
  lastOpenedAt: string | null
  lastOpenTarget: string | null
  firstSeenAt: string
  updatedAt: string
}

interface Category {
  id: number
  name: string
  parentId: number | null
  count: number
}

interface Candidate {
  dir: string
  name: string
  score: number
  markers: string[]
  stack: string[]
  hasGit: boolean
  parentPath: string | null
  imported: boolean
  gitBranch?: string | null
  gitLastCommit?: string | null
  gitLastSubject?: string | null
  readmeExcerpt?: string | null
}

interface ListResp {
  total: number
  all: number
  weakCount: number
  nestedCount: number
  stacks: string[]
  list: Project[]
}

interface ScanStatus {
  running: boolean
  dirsScanned: number
  hits: number
  current: string
  error: string | null
  candidates: Candidate[]
  lastResult: { at: string; ms: number; dirsScanned: number; candidates: number } | null
  config: { roots: string[]; depth: number }
}

const data = ref<ListResp | null>(null)
const categories = ref<Category[]>([])
const uncategorized = ref(0)
const loading = ref(false)
const scanStatus = ref<ScanStatus | null>(null)

// 筛选
const q = ref('')
const activeCategory = ref<'all' | 'none' | number>('all')
const favOnly = ref(false)
const gitOnly = ref(false)
const aiOnly = ref(false)
const stackFilter = ref('')
const sort = ref<'lastCommit' | 'name' | 'score' | 'lastOpened'>('name')
const showNested = ref(false)
const weakOnly = ref(false)

// 扫描对话框
const scanVisible = ref(false)
const scanRoot = ref('')
const scanDepth = ref(3)
const picked = ref<Set<string>>(new Set())
const importCategoryId = ref<number | null>(null)

// 其他弹窗
const addVisible = ref(false)
const addForm = ref({ path: '', name: '', categoryId: null as number | null })
const metaVisible = ref(false)
const metaForm = ref({ id: 0, alias: '', note: '', tags: '', categoryId: null as number | null })
const catVisible = ref(false)
const catForm = ref({ id: 0, name: '', parentId: null as number | null, isNew: true })

// 文件浏览（P8-2.5：VSCode 式内嵌布局，替代原先的弹窗）
const browsing = ref<Project | null>(null)
function openFiles(p: Project) {
  browsing.value = p
}

let pollTimer: number | undefined

// 应用内目录选择器（不依赖桌面权限，任何环境都能用）
interface DirEntry {
  name: string
  path: string
  looksLikeProject: boolean
}
interface DirListing {
  current: string
  parent: string | null
  entries: DirEntry[]
  roots: { name: string; path: string }[]
}
const pickerVisible = ref(false)
const pickerTarget = ref<'add' | 'scan'>('add')
const picker = ref<DirListing | null>(null)
const pickerLoading = ref(false)

async function browse(path?: string) {
  pickerLoading.value = true
  try {
    picker.value = await get<DirListing>(`/api/fs/list${path ? `?path=${encodeURIComponent(path)}` : ''}`)
  } catch (e) {
    ElMessage.error(`打开目录失败：${(e as Error).message}`)
  } finally {
    pickerLoading.value = false
  }
}

function openPicker(target: 'add' | 'scan') {
  pickerTarget.value = target
  const start = target === 'add' ? addForm.value.path : scanRoot.value
  pickerVisible.value = true
  void browse(start || undefined)
}

function confirmPick() {
  if (!picker.value) return
  const p = picker.value.current
  fillPicked(p)
}

/** 选中路径后回填并关掉相关弹窗 */
function fillPicked(p: string) {
  if (pickerTarget.value === 'add') addForm.value.path = p
  else scanRoot.value = p
  pickerVisible.value = false
  locateVisible.value = false
  ElMessage.success(`已选择：${p}`)
}

// ==================== 系统目录框（由浏览器弹，与课程表选 PDF 同一个原生对话框体系） ====================

interface DirPickerHandle {
  name: string
  entries: () => AsyncIterableIterator<[string, unknown]>
}
interface PickerWindow {
  showDirectoryPicker?: (opts?: { mode?: 'read' | 'readwrite' }) => Promise<DirPickerHandle>
}

const locating = ref(false)
const locateVisible = ref(false)
const locateCandidates = ref<{ path: string; name: string; matched: number; total: number }[]>([])

/**
 * 用**浏览器**弹系统目录框。
 * 为什么这条路可行：对话框是浏览器进程弹的（有桌面、有前台权限），不像服务端进程那样弹不出来。
 * 代价：浏览器出于安全**不给绝对路径**，所以把「目录名 + 第一层子项名」当指纹传给服务端反查真实路径。
 */
async function useSystemPicker() {
  const w = window as unknown as PickerWindow
  if (typeof w.showDirectoryPicker !== 'function') {
    ElMessage.warning('当前浏览器不支持系统目录框，请点上面的「选择目录」')
    return
  }
  locating.value = true
  try {
    // ⚠️ 必须在用户手势里直接调用，前面不能有 await
    const handle = await w.showDirectoryPicker({ mode: 'read' })
    const children: string[] = []
    try {
      for await (const [cn] of handle.entries()) {
        children.push(cn)
        if (children.length >= 60) break // 超大目录只取前 60 个当指纹，够用了
      }
    } catch {
      /* 枚举失败就只按名字匹配，交给候选确认 */
    }
    const r = await post<{ candidates: { path: string; name: string; matched: number; total: number }[] }>(
      '/api/projects/locate-folder',
      { name: handle.name, children },
    )
    if (!r.candidates.length) {
      ElMessage.warning('没能在本机找到这个目录（只查了用户目录与各盘符 4 层内），请点「选择目录」手动定位')
    } else if (r.candidates.length === 1) {
      fillPicked(r.candidates[0].path)
    } else {
      locateCandidates.value = r.candidates
      locateVisible.value = true
    }
  } catch (e) {
    // 用户在系统框里点了取消：不提示
    if ((e as Error).name !== 'AbortError') ElMessage.error((e as Error).message || '系统目录框出错')
  } finally {
    locating.value = false
  }
}

const markersOf = (p: Project): string[] => {
  try {
    return JSON.parse(p.markers) as string[]
  } catch {
    return []
  }
}
const stackOf = (p: Project): string[] => {
  try {
    return JSON.parse(p.stack) as string[]
  } catch {
    return []
  }
}
const markerLabel = (m: string) =>
  m === 'git' ? 'Git' : m === 'doc' ? 'README' : m === 'ai' ? 'AI 辅助' : m === 'manual' ? '手动添加' : m.startsWith('build:') ? `构建文件 ×${m.split(':')[1]}` : m

function relTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return '—'
  const diff = Date.now() - t
  if (diff < 3600000) return `${Math.max(1, Math.round(diff / 60000))} 分钟前`
  if (diff < 86400000) return `${Math.round(diff / 3600000)} 小时前`
  if (diff < 86400000 * 30) return `${Math.round(diff / 86400000)} 天前`
  if (diff < 86400000 * 365) return `${Math.round(diff / (86400000 * 30))} 个月前`
  return `${Math.round(diff / (86400000 * 365))} 年前`
}

// ===== 分类树 =====
interface CatNode extends Category {
  children: CatNode[]
}
const catTree = computed<CatNode[]>(() => {
  const map = new Map<number, CatNode>()
  for (const c of categories.value) map.set(c.id, { ...c, children: [] })
  const roots: CatNode[] = []
  for (const node of map.values()) {
    if (node.parentId != null && map.has(node.parentId)) map.get(node.parentId)!.children.push(node)
    else roots.push(node)
  }
  return roots
})

function categoryName(id: number | null): string {
  if (id == null) return '未分类'
  return categories.value.find((c) => c.id === id)?.name ?? '未分类'
}

async function loadCategories() {
  try {
    const r = await get<{ list: Category[]; uncategorized: number }>('/api/projects/categories')
    categories.value = r.list
    uncategorized.value = r.uncategorized
  } catch {
    categories.value = []
  }
}

async function loadList() {
  loading.value = true
  const p = new URLSearchParams()
  p.set('sort', sort.value)
  p.set('level', weakOnly.value ? 'weak' : 'all')
  if (activeCategory.value === 'none') p.set('categoryId', 'none')
  else if (typeof activeCategory.value === 'number') p.set('categoryId', String(activeCategory.value))
  if (q.value.trim()) p.set('q', q.value.trim())
  if (favOnly.value) p.set('favorite', '1')
  if (gitOnly.value) p.set('git', '1')
  if (aiOnly.value) p.set('ai', '1')
  if (stackFilter.value) p.set('stack', stackFilter.value)
  if (showNested.value) p.set('nested', '1')
  try {
    data.value = await get<ListResp>(`/api/projects?${p.toString()}`)
  } catch (e) {
    ElMessage.error(`加载失败：${(e as Error).message}`)
  } finally {
    loading.value = false
  }
}

async function refresh() {
  await Promise.all([loadCategories(), loadList()])
}

async function loadScanStatus() {
  try {
    scanStatus.value = await get<ScanStatus>('/api/projects/scan/status')
  } catch {
    scanStatus.value = null
  }
}

// ===== 手动扫描（先预览再导入）=====
function openScan() {
  scanRoot.value = scanStatus.value?.config.roots?.[0] ?? ''
  scanDepth.value = scanStatus.value?.config.depth ?? 3
  picked.value = new Set()
  importCategoryId.value = typeof activeCategory.value === 'number' ? activeCategory.value : null
  scanVisible.value = true
  void loadScanStatus()
}

async function startScanNow() {
  if (!scanRoot.value.trim()) {
    ElMessage.warning('请填写要扫描的目录')
    return
  }
  try {
    await post('/api/projects/scan', { roots: [scanRoot.value.trim()], depth: scanDepth.value })
    picked.value = new Set()
    ElMessage.info('开始扫描…')
    await loadScanStatus()
    startPolling()
  } catch (e) {
    ElMessage.error(`扫描启动失败：${(e as Error).message}`)
  }
}

function startPolling() {
  if (pollTimer) return
  pollTimer = window.setInterval(async () => {
    await loadScanStatus()
    if (!scanStatus.value?.running) {
      window.clearInterval(pollTimer)
      pollTimer = undefined
    }
  }, 700)
}

async function cancelScan() {
  await post('/api/projects/scan/cancel', {})
  ElMessage.info('已请求取消')
}

const candidateList = computed(() => {
  const all = scanStatus.value?.candidates ?? []
  return showNested.value ? all : all.filter((c) => !c.parentPath)
})

function togglePick(c: Candidate, on: boolean) {
  const s = new Set(picked.value)
  if (on) s.add(c.dir)
  else s.delete(c.dir)
  picked.value = s
}

function pickStrong() {
  picked.value = new Set(candidateList.value.filter((c) => !c.imported && c.score >= 50).map((c) => c.dir))
}

async function doImport() {
  const paths = [...picked.value]
  if (!paths.length) {
    ElMessage.warning('请先勾选要导入的项目')
    return
  }
  try {
    const r = await post<{ added: number; existed: number; skipped: string[] }>('/api/projects/import', {
      paths,
      categoryId: importCategoryId.value,
    })
    ElMessage.success(`已导入 ${r.added} 个${r.existed ? `，更新 ${r.existed} 个` : ''}${r.skipped.length ? `，跳过 ${r.skipped.length} 个` : ''}`)
    picked.value = new Set()
    scanVisible.value = false
    await refresh()
  } catch (e) {
    ElMessage.error(`导入失败：${(e as Error).message}`)
  }
}

// ===== 项目操作 =====
async function toggleFavorite(p: Project) {
  await patch(`/api/projects/${p.id}`, { favorite: !p.favorite })
  await loadList()
}

async function hideProject(p: Project) {
  await patch(`/api/projects/${p.id}`, { hidden: true })
  ElMessage.success('已从列表隐藏')
  await refresh()
}

async function removeRecord(p: Project) {
  try {
    await ElMessageBox.confirm(`只移除这条记录，磁盘上的目录不会被动到。\n${p.path}`, '移除记录', { type: 'warning' })
  } catch {
    return
  }
  await del(`/api/projects/${p.id}`)
  await refresh()
}

async function moveTo(p: Project, categoryId: number | null) {
  await patch(`/api/projects/${p.id}`, { categoryId })
  await refresh()
}

// ==================== 批量移动 + 拖拽到分类（P8-3） ====================

const selected = ref<Set<number>>(new Set())
const draggingId = ref<number | null>(null)
const dragOverCat = ref<number | 'none' | null>(null)

function toggleSelect(p: Project, v: boolean) {
  const next = new Set(selected.value)
  if (v) next.add(p.id)
  else next.delete(p.id)
  selected.value = next
}

async function moveSelected(categoryId: number | null) {
  const ids = [...selected.value]
  if (!ids.length) return
  await post('/api/projects/move', { ids, categoryId })
  ElMessage.success(`已移动 ${ids.length} 个项目`)
  selected.value = new Set()
  await loadList()
}

function onCardDragStart(e: DragEvent, p: Project) {
  draggingId.value = p.id
  e.dataTransfer?.setData('text/plain', String(p.id))
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
}

async function onDropToCat(categoryId: number | null) {
  const id = draggingId.value
  dragOverCat.value = null
  if (!id) return
  draggingId.value = null
  await post('/api/projects/move', { ids: [id], categoryId })
  ElMessage.success('已移动')
  await loadList()
}

// ==================== 排除规则管理（P8-3） ====================

interface ExcludeRule {
  id: number
  kind: string
  pattern: string
  builtin: number
}

const rulesVisible = ref(false)
const rules = ref<ExcludeRule[]>([])
const ruleForm = ref({ kind: 'name', pattern: '' })

const KIND_LABEL: Record<string, string> = { name: '目录名', 'path-prefix': '路径前缀', 'path-regex': '路径正则' }

async function openRules() {
  rulesVisible.value = true
  rules.value = await get('/api/projects/excludes')
}

async function addRule() {
  const pattern = ruleForm.value.pattern.trim()
  if (!pattern) return
  try {
    await post('/api/projects/excludes', { kind: ruleForm.value.kind, pattern })
    ruleForm.value.pattern = ''
    rules.value = await get('/api/projects/excludes')
    ElMessage.success('已添加，下次扫描生效')
  } catch (e) {
    ElMessage.error((e as Error).message)
  }
}

async function removeRule(r: ExcludeRule) {
  await del(`/api/projects/excludes/${r.id}`)
  rules.value = await get('/api/projects/excludes')
}

// ==================== 浏览器预览（P8-4） ====================

async function previewInBrowser(p: Project) {
  try {
    const r = await post<{ running: boolean; url: string | null }>(`/api/projects/${p.id}/preview`)
    if (r.url) {
      window.open(r.url, '_blank')
      ElMessage.success(`预览已启动：${r.url}`)
    }
  } catch (e) {
    ElMessage.error((e as Error).message)
  }
}

function openMeta(p: Project) {
  let tags: string[] = []
  try {
    tags = JSON.parse(p.tags) as string[]
  } catch {
    tags = []
  }
  metaForm.value = {
    id: p.id,
    alias: p.alias ?? '',
    note: p.note ?? '',
    tags: tags.join(', '),
    categoryId: p.categoryId,
  }
  metaVisible.value = true
}

async function saveMeta() {
  await patch(`/api/projects/${metaForm.value.id}`, {
    alias: metaForm.value.alias,
    note: metaForm.value.note,
    categoryId: metaForm.value.categoryId,
    tags: metaForm.value.tags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean),
  })
  metaVisible.value = false
  ElMessage.success('已保存')
  await refresh()
}

async function submitAdd() {
  if (!addForm.value.path.trim()) {
    ElMessage.warning('请填写项目目录')
    return
  }
  try {
    await post('/api/projects', {
      path: addForm.value.path,
      name: addForm.value.name,
      categoryId: addForm.value.categoryId,
    })
    addVisible.value = false
    addForm.value = { path: '', name: '', categoryId: null }
    ElMessage.success('已添加')
    await refresh()
  } catch (e) {
    ElMessage.error(`添加失败：${(e as Error).message}`)
  }
}

// ===== 分类操作 =====
function newCategory(parentId: number | null = null) {
  catForm.value = { id: 0, name: '', parentId, isNew: true }
  catVisible.value = true
}

function editCategory(c: Category) {
  catForm.value = { id: c.id, name: c.name, parentId: c.parentId, isNew: false }
  catVisible.value = true
}

async function saveCategory() {
  const name = catForm.value.name.trim()
  if (!name) {
    ElMessage.warning('请填写分类名称')
    return
  }
  if (catForm.value.isNew) {
    await post('/api/projects/categories', { name, parentId: catForm.value.parentId })
  } else {
    await patch(`/api/projects/categories/${catForm.value.id}`, { name })
  }
  catVisible.value = false
  ElMessage.success('已保存')
  await refresh()
}

async function removeCategory(c: Category) {
  try {
    await ElMessageBox.confirm(
      `删除分类「${c.name}」？里面的项目会回到上一层（不会删除项目和磁盘文件）。`,
      '删除分类',
      { type: 'warning' },
    )
  } catch {
    return
  }
  await del(`/api/projects/categories/${c.id}`)
  if (activeCategory.value === c.id) activeCategory.value = 'all'
  await refresh()
}

onMounted(async () => {
  await loadScanStatus()
  await refresh()
  if (scanStatus.value?.running) startPolling()
})

onUnmounted(() => {
  if (pollTimer) window.clearInterval(pollTimer)
})
</script>

<template>
  <div class="page">
    <!-- 浏览模式（VSCode 式：左树右编辑，占满内容区） -->
    <ProjectFiles v-if="browsing" :key="browsing.id" :project="browsing" @back="browsing = null" />

    <div v-else class="layout">
      <!-- 左：分类树 -->
      <aside class="side">
        <div class="side-head">
          <span>分类</span>
          <el-button size="small" text :icon="FolderAdd" @click="newCategory(null)">新建</el-button>
        </div>
        <div class="cat-item" :class="{ active: activeCategory === 'all' }" @click="activeCategory = 'all'; loadList()">
          <span>全部项目</span><span class="cat-count">{{ data?.all ?? 0 }}</span>
        </div>
        <div
          class="cat-item"
          :class="{ active: activeCategory === 'none', 'drag-over': dragOverCat === 'none' }"
          title="把项目卡片拖到这里可移到「未分类」"
          @click="activeCategory = 'none'; loadList()"
          @dragover.prevent="dragOverCat = 'none'"
          @dragleave="dragOverCat === 'none' && (dragOverCat = null)"
          @drop.prevent="onDropToCat(null)"
        >
          <span>未分类</span><span class="cat-count">{{ uncategorized }}</span>
        </div>
        <div v-for="c in catTree" :key="c.id" class="cat-node">
          <div
            class="cat-item"
            :class="{ active: activeCategory === c.id, 'drag-over': dragOverCat === c.id }"
            title="把项目卡片拖到这里可移动分类"
            @click="activeCategory = c.id; loadList()"
            @dragover.prevent="dragOverCat = c.id"
            @dragleave="dragOverCat === c.id && (dragOverCat = null)"
            @drop.prevent="onDropToCat(c.id)"
          >
            <span class="cat-name">{{ c.name }}</span>
            <span class="cat-count">{{ c.count }}</span>
            <span class="cat-actions" @click.stop>
              <el-icon title="新建子分类" @click="newCategory(c.id)"><FolderAdd /></el-icon>
              <el-icon title="重命名" @click="editCategory(c)"><Edit /></el-icon>
              <el-icon title="删除分类" @click="removeCategory(c)"><Delete /></el-icon>
            </span>
          </div>
          <div v-for="ch in c.children" :key="ch.id" class="cat-child">
            <div
              class="cat-item"
              :class="{ active: activeCategory === ch.id, 'drag-over': dragOverCat === ch.id }"
              title="把项目卡片拖到这里可移动分类"
              @click="activeCategory = ch.id; loadList()"
              @dragover.prevent="dragOverCat = ch.id"
              @dragleave="dragOverCat === ch.id && (dragOverCat = null)"
              @drop.prevent="onDropToCat(ch.id)"
            >
              <span class="cat-name">{{ ch.name }}</span>
              <span class="cat-count">{{ ch.count }}</span>
              <span class="cat-actions" @click.stop>
                <el-icon title="重命名" @click="editCategory(ch)"><Edit /></el-icon>
                <el-icon title="删除分类" @click="removeCategory(ch)"><Delete /></el-icon>
              </span>
            </div>
          </div>
        </div>
        <div class="side-tip">分类只在软件内生效，不会改动磁盘目录结构</div>
      </aside>

      <!-- 右：项目列表 -->
      <main class="main">
        <div class="page-head">
          <div class="head-text">
            <h3>项目管理</h3>
            <p class="sub">
              <template v-if="scanStatus?.lastResult">
                上次扫描 {{ relTime(scanStatus.lastResult.at) }} · {{ scanStatus.lastResult.dirsScanned }} 个目录 ·
                {{ (scanStatus.lastResult.ms / 1000).toFixed(1) }}s · 命中 {{ scanStatus.lastResult.candidates }} 个
              </template>
              <template v-else>导入方式：扫描一个目录后勾选导入，或直接手动添加单个目录</template>
            </p>
          </div>
          <div class="head-actions">
            <el-button type="primary" :icon="Refresh" @click="openScan">扫描目录</el-button>
            <el-button :icon="Plus" @click="addVisible = true">添加项目</el-button>
          </div>
        </div>

        <div class="filter-bar">
          <el-input v-model="q" placeholder="搜索名称 / 路径 / 备注" clearable :prefix-icon="Search" class="search" @input="loadList" />
          <el-checkbox v-model="favOnly" @change="loadList">收藏</el-checkbox>
          <el-checkbox v-model="gitOnly" @change="loadList">有 Git</el-checkbox>
          <el-checkbox v-model="aiOnly" @change="loadList">AI 标记</el-checkbox>
          <el-checkbox v-model="weakOnly" @change="loadList">仅弱信号</el-checkbox>
          <el-select v-if="data?.stacks.length" v-model="stackFilter" placeholder="技术栈" clearable size="small" style="width: 130px" @change="loadList">
            <el-option v-for="s in data.stacks" :key="s" :label="s" :value="s" />
          </el-select>
          <el-select v-model="sort" size="small" style="width: 140px" @change="loadList">
            <el-option label="按名称" value="name" />
            <el-option label="按最近提交" value="lastCommit" />
            <el-option label="按匹配度" value="score" />
            <el-option label="按最近打开" value="lastOpened" />
          </el-select>
          <el-checkbox v-model="showNested" @change="loadList">
            展开嵌套子项目<template v-if="data?.nestedCount">（{{ data.nestedCount }}）</template>
          </el-checkbox>
        </div>

        <!-- 批量操作条（勾选卡片后出现） -->
        <div v-if="selected.size" class="bulk-bar">
          <span>已选 {{ selected.size }} 个项目</span>
          <el-select placeholder="移到分类…" size="small" style="width: 180px" value-key="" @change="(v: number | null) => moveSelected(v ?? null)">
            <el-option label="移到「未分类」" :value="0" />
            <el-option v-for="c in categories" :key="c.id" :label="`移到「${c.name}」`" :value="c.id" />
          </el-select>
          <el-button size="small" text @click="selected = new Set()">取消选择</el-button>
        </div>

        <el-empty
          v-if="!loading && !data?.list.length"
          description="这里还没有项目：点「扫描目录」导入，或「添加项目」手动加一个"
        />
        <div v-else v-loading="loading" class="proj-list">
          <div v-for="p in data?.list ?? []" :key="p.id" class="proj-card" draggable="true" @dragstart="onCardDragStart($event, p)" @dblclick="openFiles(p)">
            <el-checkbox
              class="pc-check"
              :model-value="selected.has(p.id)"
              title="勾选后可批量移动到分类"
              @change="(v: boolean) => toggleSelect(p, v)"
              @click.stop
            />
            <div class="pc-main">
              <div class="pc-title-row">
                <span class="pc-name">{{ p.alias || p.name }}</span>
                <el-icon v-if="p.favorite" class="pc-star" @click="toggleFavorite(p)"><StarFilled /></el-icon>
                <el-icon v-else class="pc-star dim" @click="toggleFavorite(p)"><Star /></el-icon>
                <el-tag size="small" effect="plain" type="info">{{ categoryName(p.categoryId) }}</el-tag>
                <span v-if="p.hasGit && p.gitDirty" class="pc-dirty" :title="`${p.gitDirty} 个未提交改动`">● 未提交</span>
              </div>
              <div class="pc-path" :title="p.path">{{ p.path }}</div>
              <div class="pc-badges">
                <el-tag v-for="m in markersOf(p)" :key="m" size="small" effect="plain" :type="m === 'git' ? 'success' : m === 'ai' ? 'warning' : 'info'">
                  {{ markerLabel(m) }}
                </el-tag>
                <el-tag v-for="s in stackOf(p)" :key="s" size="small" effect="plain">{{ s }}</el-tag>
                <el-tag v-if="p.score < 50" size="small" type="warning" effect="plain">弱信号 {{ p.score }}</el-tag>
              </div>
              <div v-if="p.readmeExcerpt" class="pc-excerpt">{{ p.readmeExcerpt }}</div>
              <div class="pc-meta">
                <span v-if="p.hasGit">最近提交：{{ relTime(p.gitLastCommit) }}<template v-if="p.gitLastAuthor"> · {{ p.gitLastAuthor }}</template></span>
                <span v-else>没有 Git 历史</span>
                <span v-if="p.gitBranch" class="pc-branch">{{ p.gitBranch }}</span>
                <span v-if="p.lastOpenedAt">上次打开于 {{ relTime(p.lastOpenedAt) }}</span>
              </div>
            </div>

            <div class="pc-actions">
              <el-tooltip content="在应用内浏览、编辑这个项目的文件（双击卡片同样打开）" placement="top">
                <el-button :icon="Document" @click="openFiles(p)">文件</el-button>
              </el-tooltip>
              <el-dropdown>
                <el-button text :icon="More" />
                <template #dropdown>
                  <el-dropdown-menu>
                    <el-dropdown-item @click="openFiles(p)">浏览文件</el-dropdown-item>
                    <el-dropdown-item divided @click="previewInBrowser(p)">在浏览器中预览</el-dropdown-item>
                    <el-dropdown-item @click="openMeta(p)">名称 / 分类 / 备注</el-dropdown-item>
                    <el-dropdown-item v-for="c in categories" :key="c.id" @click="moveTo(p, c.id)">
                      移到「{{ c.name }}」
                    </el-dropdown-item>
                    <el-dropdown-item v-if="p.categoryId != null" @click="moveTo(p, null)">移到「未分类」</el-dropdown-item>
                    <el-dropdown-item divided @click="hideProject(p)">从列表隐藏</el-dropdown-item>
                    <el-dropdown-item @click="removeRecord(p)">
                      <el-icon><Delete /></el-icon> 移除记录
                    </el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>
            </div>
          </div>
        </div>
      </main>
    </div>

    <!-- 扫描目录（先预览再导入） -->
    <el-dialog v-model="scanVisible" title="扫描目录" width="900px" top="6vh">
      <div class="scan-form">
        <el-input v-model="scanRoot" placeholder="要扫描的目录" class="scan-root">
          <template #append>
            <el-button :icon="FolderOpened" @click="openPicker('scan')">选择目录</el-button>
          </template>
        </el-input>
        <span class="scan-label">往下扫</span>
        <el-input-number v-model="scanDepth" :min="1" :max="8" size="small" controls-position="right" style="width: 100px" />
        <span class="scan-label">层</span>
        <el-button type="primary" :disabled="scanStatus?.running" @click="startScanNow">开始扫描</el-button>
        <el-button v-if="scanStatus?.running" @click="cancelScan">取消</el-button>
      </div>
      <div v-if="scanStatus?.running" class="scan-progress">
        <span>已遍历 {{ scanStatus.dirsScanned }} 个目录，命中 {{ scanStatus.hits }} 个候选</span>
        <span class="scan-current">{{ scanStatus.current }}</span>
        <el-progress :percentage="100" :indeterminate="true" :show-text="false" :stroke-width="5" />
      </div>
      <div v-if="scanStatus?.error" class="scan-error">扫描出错：{{ scanStatus.error }}</div>

      <template v-if="candidateList.length && !scanStatus?.running">
        <div class="scan-toolbar">
          <span>找到 {{ candidateList.length }} 个候选，已选 {{ picked.size }} 个</span>
          <el-button size="small" text @click="pickStrong">勾选全部强信号</el-button>
          <el-button size="small" text @click="picked = new Set()">清空选择</el-button>
          <span class="spacer" />
          <span class="scan-label">导入到</span>
          <el-select v-model="importCategoryId" size="small" clearable placeholder="未分类" style="width: 150px">
            <el-option v-for="c in categories" :key="c.id" :label="c.name" :value="c.id" />
          </el-select>
        </div>
        <div class="cand-list">
          <label v-for="c in candidateList" :key="c.dir" class="cand-row" :class="{ imported: c.imported }">
            <el-checkbox :model-value="picked.has(c.dir)" :disabled="c.imported" @change="(v: boolean) => togglePick(c, v)" />
            <div class="cand-main">
              <div class="cand-title">
                <span class="cand-name">{{ c.name }}</span>
                <el-tag v-if="c.imported" size="small" type="info" effect="plain">已在列表</el-tag>
                <el-tag v-for="m in c.markers" :key="m" size="small" effect="plain" :type="m === 'git' ? 'success' : m === 'ai' ? 'warning' : 'info'">
                  {{ markerLabel(m) }}
                </el-tag>
                <el-tag v-for="s in c.stack" :key="s" size="small" effect="plain">{{ s }}</el-tag>
                <span class="cand-score" :class="{ weak: c.score < 50 }">{{ c.score }} 分</span>
              </div>
              <div class="cand-path">{{ c.dir }}</div>
              <div v-if="c.gitLastCommit" class="cand-git">最近提交 {{ relTime(c.gitLastCommit) }}<template v-if="c.gitLastSubject"> · {{ c.gitLastSubject }}</template></div>
            </div>
          </label>
        </div>
      </template>
      <el-empty v-else-if="!scanStatus?.running && scanStatus?.lastResult" description="这个目录下没找到像项目的子目录（换个目录或加大扫描层数试试）" />

      <template #footer>
        <el-button text @click="openRules">忽略规则</el-button>
        <el-button @click="scanVisible = false">关闭</el-button>
        <el-button type="primary" :disabled="!picked.size" @click="doImport">导入选中（{{ picked.size }}）</el-button>
      </template>
    </el-dialog>

    <!-- 忽略规则管理（P8-3） -->
    <el-dialog v-model="rulesVisible" title="扫描忽略规则" width="560px">
      <div class="rules-tip">命中这些规则的目录在扫描时会被跳过。改完点「开始扫描」才生效。</div>
      <div class="rule-add">
        <el-select v-model="ruleForm.kind" size="small" style="width: 120px">
          <el-option label="目录名" value="name" />
          <el-option label="路径前缀" value="path-prefix" />
          <el-option label="路径正则" value="path-regex" />
        </el-select>
        <el-input
          v-model="ruleForm.pattern"
          class="rule-input"
          size="small"
          :placeholder="ruleForm.kind === 'name' ? '如：examples' : ruleForm.kind === 'path-prefix' ? '如：D:\\下载' : '如：.*\\\\playground\\\\.*'"
          @keyup.enter="addRule"
        />
        <el-button type="primary" size="small" @click="addRule">添加</el-button>
      </div>
      <div class="rule-list">
        <div v-for="r in rules" :key="r.id" class="rule-row">
          <el-tag size="small" effect="plain" :type="r.builtin ? 'info' : 'warning'">{{ KIND_LABEL[r.kind] ?? r.kind }}</el-tag>
          <span class="rule-pattern" :title="r.pattern">{{ r.pattern }}</span>
          <el-button text size="small" :icon="Delete" class="rule-del" @click="removeRule(r)" />
        </div>
        <div v-if="!rules.length" class="rule-empty">还没有规则</div>
      </div>
    </el-dialog>

    <!-- 目录选择器（应用内浏览，不依赖桌面权限） -->
    <el-dialog v-model="pickerVisible" title="选择目录" width="640px">
      <div class="pk-bar">
        <el-button size="small" :disabled="!picker?.parent" @click="browse(picker?.parent ?? undefined)">↑ 上一级</el-button>
        <span class="pk-current" :title="picker?.current">{{ picker?.current }}</span>
      </div>
      <div class="pk-roots">
        <el-tag v-for="r in picker?.roots ?? []" :key="r.path" size="small" effect="plain" class="pk-root" @click="browse(r.path)">
          {{ r.name }}
        </el-tag>
      </div>
      <div v-loading="pickerLoading" class="pk-list">
        <div v-if="!picker?.entries.length" class="pk-empty">这个目录下没有子文件夹</div>
        <div v-for="d in picker?.entries ?? []" :key="d.path" class="pk-item" @click="browse(d.path)">
          <el-icon class="pk-icon"><FolderOpened /></el-icon>
          <span class="pk-name">{{ d.name }}</span>
          <el-tag v-if="d.looksLikeProject" size="small" type="success" effect="plain">像项目</el-tag>
          <span class="pk-enter">进入 ›</span>
        </div>
      </div>
      <template #footer>
        <el-button text :loading="locating" @click="useSystemPicker">用系统选择框</el-button>
        <span class="pk-footer-tip">当前目录：{{ picker?.current }}</span>
        <el-button @click="pickerVisible = false">取消</el-button>
        <el-button type="primary" :disabled="!picker" @click="confirmPick">选择这个目录</el-button>
      </template>
    </el-dialog>

    <!-- 系统目录框的候选确认（同名目录多处存在时才出现） -->
    <el-dialog v-model="locateVisible" title="找到多个同名目录" width="620px">
      <div class="loc-tip">系统选择框不提供绝对路径，这里是按「目录名 + 里面的内容」在本机反查出来的结果，选一个：</div>
      <div class="loc-list">
        <div v-for="c in locateCandidates" :key="c.path" class="loc-row" @click="fillPicked(c.path)">
          <span class="loc-path" :title="c.path">{{ c.path }}</span>
          <span class="loc-score">{{ c.total ? `${c.matched}/${c.total} 项吻合` : '仅名称匹配' }}</span>
        </div>
      </div>
      <template #footer>
        <el-button @click="locateVisible = false">取消</el-button>
      </template>
    </el-dialog>

    <!-- 手动添加 -->
    <el-dialog v-model="addVisible" title="添加项目" width="540px">
      <el-form label-width="80px">
        <el-form-item label="项目目录">
          <el-input v-model="addForm.path" placeholder="点右侧「选择目录」挑一个文件夹，或直接粘贴路径">
            <template #append>
              <el-button :icon="FolderOpened" @click="openPicker('add')">选择目录</el-button>
            </template>
          </el-input>
        </el-form-item>
        <el-form-item label="显示名称">
          <el-input v-model="addForm.name" placeholder="可选，软件内的名字，留空用目录名" />
        </el-form-item>
        <el-form-item label="分类">
          <el-select v-model="addForm.categoryId" clearable placeholder="未分类" style="width: 100%">
            <el-option v-for="c in categories" :key="c.id" :label="c.name" :value="c.id" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="addVisible = false">取消</el-button>
        <el-button type="primary" @click="submitAdd">添加</el-button>
      </template>
    </el-dialog>

    <!-- 名称 / 分类 / 备注 -->
    <el-dialog v-model="metaVisible" title="编辑项目" width="540px">
      <el-form label-width="80px">
        <el-form-item label="显示名称">
          <el-input v-model="metaForm.alias" placeholder="软件内显示的名字，留空用目录名" />
        </el-form-item>
        <el-form-item label="分类">
          <el-select v-model="metaForm.categoryId" clearable placeholder="未分类" style="width: 100%">
            <el-option v-for="c in categories" :key="c.id" :label="c.name" :value="c.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="标签">
          <el-input v-model="metaForm.tags" placeholder="逗号分隔，如：课程作业, 结课报告" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="metaForm.note" type="textarea" :rows="3" placeholder="随便记点什么" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="metaVisible = false">取消</el-button>
        <el-button type="primary" @click="saveMeta">保存</el-button>
      </template>
    </el-dialog>

    <!-- 新建 / 重命名分类 -->
    <el-dialog v-model="catVisible" :title="catForm.isNew ? '新建分类' : '重命名分类'" width="420px">
      <el-form label-width="80px">
        <el-form-item label="名称">
          <el-input v-model="catForm.name" placeholder="如：课程 / 插件 / 启动器" @keyup.enter="saveCategory" />
        </el-form-item>
        <el-form-item v-if="catForm.isNew" label="上级">
          <span class="form-static">{{ catForm.parentId == null ? '顶层' : categoryName(catForm.parentId) }}</span>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="catVisible = false">取消</el-button>
        <el-button type="primary" @click="saveCategory">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.page {
  max-width: 1400px;
}
.layout {
  display: flex;
  gap: 16px;
  align-items: flex-start;
}
.side {
  width: 220px;
  flex: 0 0 220px;
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color);
  border-radius: 10px;
  padding: 12px 8px;
}
.side-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-weight: 600;
  font-size: 14px;
  color: var(--el-text-color-primary);
  padding: 0 8px 8px;
}
.cat-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 10px;
  border-radius: 7px;
  font-size: 13px;
  color: var(--el-text-color-regular);
  cursor: pointer;
}
.cat-item:hover {
  background: var(--el-fill-color-light);
}
.cat-item.active {
  background: var(--el-color-primary-light-9);
  color: var(--el-color-primary);
  font-weight: 600;
}
.cat-child .cat-item {
  padding-left: 26px;
}
.cat-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cat-count {
  margin-left: auto;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.cat-actions {
  display: none;
  gap: 4px;
  margin-left: 4px;
  color: var(--el-text-color-secondary);
}
.cat-item:hover .cat-actions {
  display: inline-flex;
}
.cat-actions .el-icon:hover {
  color: var(--el-color-primary);
}
.side-tip {
  margin-top: 10px;
  padding: 0 8px;
  font-size: 11px;
  line-height: 1.5;
  color: var(--el-text-color-placeholder);
}
.main {
  flex: 1;
  min-width: 0;
}
.page-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}
.head-text h3 {
  margin: 0 0 4px;
}
.sub {
  margin: 0;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.head-actions {
  display: flex;
  gap: 8px;
}
.filter-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 14px;
}
.search {
  width: 220px;
}
.proj-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 160px;
}
.proj-card {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 16px;
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color);
  border-radius: 10px;
}
.pc-main {
  min-width: 0;
  flex: 1;
}
.pc-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.pc-name {
  font-size: 16px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.pc-star {
  cursor: pointer;
  color: var(--el-color-warning);
}
.pc-star.dim {
  color: var(--el-text-color-placeholder);
}
.pc-dirty {
  font-size: 12px;
  color: var(--el-color-warning);
}
.pc-path {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin: 4px 0 8px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pc-badges {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}
.pc-excerpt {
  font-size: 13px;
  color: var(--el-text-color-regular);
  line-height: 1.5;
  margin-bottom: 8px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.pc-meta {
  display: flex;
  gap: 14px;
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.pc-branch {
  font-family: ui-monospace, Consolas, monospace;
}
.pc-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
/* 扫描对话框 */
.scan-form {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}
.scan-root {
  width: 380px;
}
.scan-label {
  font-size: 13px;
  color: var(--el-text-color-secondary);
}
.scan-progress {
  font-size: 12px;
  color: var(--el-text-color-regular);
  margin-bottom: 10px;
}
.scan-current {
  display: block;
  margin: 2px 0 6px;
  color: var(--el-text-color-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.scan-error {
  color: var(--el-color-danger);
  font-size: 13px;
  margin-bottom: 8px;
}
.scan-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 0;
  border-top: 1px solid var(--el-border-color-lighter);
}
.spacer {
  flex: 1;
}
.cand-list {
  max-height: 46vh;
  overflow-y: auto;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
}
.cand-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--el-border-color-lighter);
  cursor: pointer;
}
.cand-row:last-child {
  border-bottom: none;
}
.cand-row:hover {
  background: var(--el-fill-color-light);
}
.cand-row.imported {
  opacity: 0.6;
}
.cand-main {
  min-width: 0;
  flex: 1;
}
.cand-title {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.cand-name {
  font-weight: 600;
  font-size: 14px;
  color: var(--el-text-color-primary);
}
.cand-score {
  font-size: 12px;
  color: var(--el-color-success);
}
.cand-score.weak {
  color: var(--el-color-warning);
}
.cand-path {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin-top: 3px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cand-git {
  font-size: 12px;
  color: var(--el-text-color-placeholder);
  margin-top: 2px;
}
.form-static {
  font-size: 13px;
  color: var(--el-text-color-regular);
}
/* 目录选择器 */
.pk-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}
.pk-current {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pk-roots {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}
.pk-root {
  cursor: pointer;
}
.pk-list {
  max-height: 46vh;
  min-height: 120px;
  overflow-y: auto;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
}
.pk-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--el-border-color-lighter);
  cursor: pointer;
  font-size: 13px;
}
.pk-item:last-child {
  border-bottom: none;
}
.pk-item:hover {
  background: var(--el-fill-color-light);
}
.pk-icon {
  color: var(--el-color-warning);
}
.pk-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pk-enter {
  margin-left: auto;
  font-size: 12px;
  color: var(--el-text-color-placeholder);
}
.pk-empty {
  padding: 24px;
  text-align: center;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}
.pk-footer-tip {
  font-size: 12px;
  color: var(--el-text-color-placeholder);
  margin: 0 10px;
}
@media (max-width: 1000px) {
  .layout {
    flex-direction: column;
  }
  .side {
    width: 100%;
    flex: 1 1 auto;
  }
  .proj-card {
    flex-direction: column;
  }
}
/* ===== 批量操作条（P8-3） ===== */
.bulk-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 14px;
  margin-bottom: 12px;
  font-size: 13px;
  color: var(--el-text-color-regular);
  background: var(--el-color-primary-light-9);
  border: 1px solid var(--el-color-primary-light-7);
  border-radius: 8px;
}

/* ===== 卡片多选框 ===== */
.pc-check {
  position: absolute;
  top: 10px;
  right: 12px;
}
.proj-card {
  position: relative;
}
.proj-card:hover .pc-check {
  opacity: 1;
}
.pc-check {
  opacity: 0.25;
  transition: opacity 0.15s;
}

/* ===== 分类节点接收拖拽 ===== */
.cat-item.drag-over {
  outline: 2px dashed var(--el-color-primary);
  outline-offset: -2px;
  background: var(--el-color-primary-light-9);
}

/* ===== 忽略规则管理（P8-3） ===== */
.rules-tip {
  margin-bottom: 12px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.rule-add {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}
.rule-add .el-input {
  flex: 1;
}
.rule-list {
  max-height: 300px;
  overflow-y: auto;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
}
.rule-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--el-border-color-extra-light);
}
.rule-row:last-child {
  border-bottom: 0;
}
.rule-pattern {
  flex: 1;
  font-size: 13px;
  font-family: Consolas, monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--el-text-color-regular);
}
.rule-del {
  color: var(--el-text-color-placeholder);
}
.rule-del:hover {
  color: var(--el-color-danger);
}
.rule-empty {
  padding: 20px;
  text-align: center;
  font-size: 12px;
  color: var(--el-text-color-placeholder);
}

/* ===== 系统目录框的候选确认 ===== */
.loc-tip {
  margin-bottom: 12px;
  font-size: 12px;
  line-height: 18px;
  color: var(--el-text-color-secondary);
}
.loc-list {
  max-height: 340px;
  overflow-y: auto;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
}
.loc-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 9px 14px;
  cursor: pointer;
  border-bottom: 1px solid var(--el-border-color-extra-light);
}
.loc-row:last-child {
  border-bottom: 0;
}
.loc-row:hover {
  background: var(--el-color-primary-light-9);
}
.loc-path {
  flex: 1;
  font-size: 13px;
  font-family: Consolas, monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--el-text-color-primary);
}
.loc-score {
  flex: none;
  font-size: 11px;
  color: var(--el-color-success);
}
</style>
