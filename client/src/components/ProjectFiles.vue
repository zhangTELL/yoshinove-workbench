<!--
  项目文件浏览器（P8-2，P8-2.5 改为 VSCode 式内嵌布局）

  布局：顶栏（返回 + 项目信息）+ 左侧文件树（懒加载）+ 右侧 Monaco / 预览。
  进入时自动打开项目根目录的 README（没有就停在空态，不猜别的文件）。

  安全：所有请求都带项目 id + 项目内相对路径，服务端做 resolve + realpath 双重校验，
  前端拿不到也无法访问项目以外的任何文件。
-->
<template>
  <div class="pf-page">
    <!-- 顶栏：返回 + 项目信息 + 打开方式 / Git / 预览 -->
    <div class="pf-topbar">
      <el-button :icon="Back" size="small" round @click="requestBack">返回列表</el-button>
      <span class="pf-title">{{ project.alias || project.name }}</span>
      <span class="pf-path" :title="project.path">{{ project.path }}</span>
      <div class="pf-topbar-actions">
        <OpenInAppButton :project="project" />
        <el-button size="small" :icon="DataAnalysis" :loading="gitLoading" @click="openGit">Git 详情</el-button>
        <el-tooltip content="在浏览器里打开这个项目的网页（需要项目里有 index.html）" placement="bottom">
          <el-button size="small" :icon="View" @click="openPreview">浏览器预览</el-button>
        </el-tooltip>
      </div>
      <span v-if="dirty" class="pf-topbar-tip warn">有未保存的修改</span>
    </div>

    <div class="pf-body">
      <!-- 左：文件树 -->
      <aside class="pf-side">
        <div class="pf-side-head">
          <span class="pf-side-title">文件</span>
          <div class="pf-side-actions">
            <el-dropdown trigger="click" @command="(k: string) => createIn('', k as 'file' | 'dir')">
              <el-button text size="small" :icon="Plus" title="在项目根目录新建" />
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item command="file">新建文件</el-dropdown-item>
                  <el-dropdown-item command="dir">新建文件夹</el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
            <el-tooltip content="重新读取目录" placement="top">
              <el-button text size="small" :icon="Refresh" @click="reloadTree" />
            </el-tooltip>
          </div>
        </div>
        <el-tree
          :key="treeKeyTick"
          ref="treeRef"
          class="pf-tree"
          :props="treeProps"
          :load="loadNode"
          lazy
          node-key="rel"
          :default-expanded-keys="expandedKeys"
          highlight-current
          :expand-on-click-node="false"
          @node-click="onNodeClick"
          @node-contextmenu="onTreeContextmenu"
          @node-expand="onNodeExpand"
          @node-collapse="onNodeCollapse"
        >
          <template #default="{ data }">
            <span class="pf-node" :class="{ dir: data.isDir }">
              <el-icon class="pf-node-icon">
                <FolderOpened v-if="data.isDir" />
                <Document v-else />
              </el-icon>
              <span class="pf-node-name">{{ data.name }}</span>
              <span v-if="data.isDir && data.looksLikePackage" class="pf-badge" title="这里是一个独立项目">项目</span>
              <span v-else-if="!data.isDir && data.size != null" class="pf-node-size">{{ fmtSize(data.size) }}</span>
            </span>
          </template>
        </el-tree>
        <div v-if="hiddenHint" class="pf-hidden-hint">{{ hiddenHint }}</div>
      </aside>

      <!-- 右：编辑器 / 预览 -->
      <section class="pf-main">
        <template v-if="current">
          <div class="pf-bar">
            <div class="pf-bar-left">
              <span class="pf-file">{{ current.rel }}</span>
              <el-tag size="small" effect="plain" type="info">{{ current.language }}</el-tag>
              <el-tag v-if="dirty" size="small" type="warning" effect="plain">未保存</el-tag>
              <span class="pf-file-meta">{{ fmtSize(current.size) }}</span>
            </div>
            <div class="pf-bar-right">
              <el-radio-group v-model="mode" size="small">
                <el-radio-button v-if="current.preview" value="preview">预览</el-radio-button>
                <el-radio-button value="edit">编辑</el-radio-button>
              </el-radio-group>
              <el-button
                v-if="current.editable"
                type="primary"
                size="small"
                :icon="Check"
                :disabled="!dirty"
                :loading="saving"
                @click="save"
              >
                保存
              </el-button>
            </div>
          </div>

          <!-- 二进制 / 超大文件提示 -->
          <el-alert
            v-if="current.kind === 'binary'"
            class="pf-alert"
            type="info"
            :closable="false"
            show-icon
            title="这是二进制文件，不能在这里预览"
            description="可以用列表卡片上的「打开方式」在 IDE 或资源管理器里查看。"
          />
          <el-alert
            v-else-if="current.kind === 'tooLarge'"
            class="pf-alert"
            type="warning"
            :closable="false"
            show-icon
            :title="`文件太大（${fmtSize(current.size)}），只显示了开头部分`"
            description="为避免卡顿，超过 2 MB 的文件不能在这里编辑，请在 IDE 里打开。"
          />
          <el-alert
            v-else-if="current.ext === 'bak'"
            class="pf-alert"
            type="info"
            :closable="false"
            show-icon
            title="这是保存时自动生成的备份文件"
          />

          <div v-if="mode === 'edit' && current.kind !== 'binary'" class="pf-stage">
            <CodeEditor
              v-model="draft"
              :language="current.language"
              :readonly="!current.editable"
              :theme="theme"
              @save="save"
            />
          </div>

          <!-- 预览：HTML / SVG -->
          <div v-else-if="mode === 'preview' && current.preview !== 'markdown'" class="pf-stage">
            <iframe class="pf-frame" sandbox="allow-scripts" :srcdoc="previewDoc" />
          </div>

          <!-- 预览：Markdown -->
          <div v-else-if="mode === 'preview'" class="pf-stage">
            <div ref="mdHost" class="pf-markdown" />
          </div>
        </template>

        <el-empty v-else :image-size="90" description="从左侧选一个文件打开" />
      </section>
    </div>

    <!-- 文件树右键菜单 -->
    <Teleport to="body">
      <div v-if="ctxMenu.show" class="pf-ctx" :style="{ left: `${ctxMenu.x}px`, top: `${ctxMenu.y}px` }">
        <template v-if="ctxMenu.node?.isDir">
          <div class="pf-ctx-item" @click="createIn(ctxMenu.node.rel, 'file')">新建文件</div>
          <div class="pf-ctx-item" @click="createIn(ctxMenu.node.rel, 'dir')">新建文件夹</div>
          <div class="pf-ctx-sep" />
        </template>
        <div v-if="ctxMenu.node?.rel" class="pf-ctx-item" @click="renameEntry(ctxMenu.node!)">重命名</div>
        <div v-if="ctxMenu.node?.rel" class="pf-ctx-item danger" @click="deleteEntryNode(ctxMenu.node!)">删除</div>
      </div>
    </Teleport>

    <!-- Git 详情抽屉 -->
    <el-drawer v-model="gitDrawer" title="Git 详情" size="460px">
      <div v-loading="gitLoading" class="gd-body">
        <template v-if="gitDetail">
          <template v-if="!gitDetail.hasGit">
            <el-empty :image-size="80" description="这个项目没有 Git 仓库" />
          </template>
          <template v-else>
            <div class="gd-section">
              <div class="gd-row">
                <span class="gd-branch">{{ gitDetail.branch }}</span>
                <el-tag v-if="gitDetail.ahead" size="small" type="warning" effect="plain">领先 {{ gitDetail.ahead }}</el-tag>
                <el-tag v-if="gitDetail.behind" size="small" type="danger" effect="plain">落后 {{ gitDetail.behind }}</el-tag>
                <el-tag v-if="gitDetail.dirtyCount" size="small" type="info" effect="plain">{{ gitDetail.dirtyCount }} 个未提交</el-tag>
                <el-tag v-else size="small" type="success" effect="plain">工作区干净</el-tag>
              </div>
              <div v-if="gitDetail.dirtyFiles.length" class="gd-dirty">
                <div v-for="f in gitDetail.dirtyFiles" :key="f.path" class="gd-dirty-row">
                  <span class="gd-dirty-x" :class="{ untracked: f.x === '?' }">{{ f.x }}</span>
                  <span class="gd-dirty-path">{{ f.path }}</span>
                </div>
              </div>
            </div>
            <div class="gd-section">
              <div class="gd-sub">最近提交</div>
              <div v-for="c in gitDetail.commits" :key="c.hash" class="gd-commit">
                <div class="gd-commit-subject">{{ c.subject }}</div>
                <div class="gd-commit-meta">{{ c.author }} · {{ new Date(c.date).toLocaleString('zh-CN', { hour12: false }) }}</div>
              </div>
            </div>
          </template>
        </template>
      </div>
    </el-drawer>
  </div>
</template>

<script setup lang="ts">
import { ElMessage, ElMessageBox } from 'element-plus'
import type { TreeInstance } from 'element-plus'
import { Back, Check, DataAnalysis, Document, FolderOpened, Plus, Refresh, View } from '@element-plus/icons-vue'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import CodeEditor from './CodeEditor.vue'
import OpenInAppButton from './OpenInAppButton.vue'
import { del, get, patch, post, put } from '../api/http'
import { wrapPreviewDoc } from '../utils/previewDoc'

interface ProjectLite {
  id: number
  name: string
  alias: string | null
  path: string
  /** 上次用哪个应用打开的（服务端记录），分体按钮用它做默认项 */
  lastOpenTarget: string | null
}

const props = defineProps<{ project: ProjectLite }>()

const emit = defineEmits<{ back: [] }>()

/**
 * 深浅色自己感知（不通过 props 传）：主题切换时 applyAppearance 会改 html.dark 并广播
 * wb-theme-change，这里跟一下即可，编辑器与 Markdown 预览都能跟着换肤。
 */
const theme = ref<'light' | 'dark'>('light')
function syncTheme() {
  theme.value = document.documentElement.classList.contains('dark') ? 'dark' : 'light'
}

interface TreeNodeData {
  name: string
  rel: string
  isDir: boolean
  size: number | null
  ext: string
  looksLikePackage?: boolean
}

interface FileContent {
  rel: string
  name: string
  size: number
  ext: string
  language: string
  preview: 'html' | 'svg' | 'markdown' | null
  kind: 'text' | 'binary' | 'tooLarge'
  content: string | null
  truncated: boolean
  mtime: string
  editable: boolean
}

const treeRef = ref<TreeInstance>()
const mdHost = ref<HTMLDivElement | null>(null)
const hiddenCount = ref(0)
const treeKeyTick = ref(0)

const current = ref<FileContent | null>(null)
const draft = ref('')
const mode = ref<'edit' | 'preview'>('edit')
const saving = ref(false)

const dirty = computed(() => !!current.value && current.value.editable && draft.value !== (current.value.content ?? ''))

const hiddenHint = computed(() =>
  hiddenCount.value ? `已隐藏 ${hiddenCount.value} 个依赖 / 产物目录（node_modules、dist 等）` : '',
)

const treeProps = {
  label: 'name',
  isLeaf: (data: TreeNodeData) => !data.isDir,
}

const previewDoc = computed(() => (current.value?.preview && current.value.preview !== 'markdown' ? wrapPreviewDoc(draft.value, { maxHeight: '100%' }) : ''))

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

// ==================== 文件树 ====================

async function listOf(rel: string) {
  return get<{ entries: TreeNodeData[]; ignoredCount: number }>(
    `/api/projects/${props.project.id}/tree${rel ? `?path=${encodeURIComponent(rel)}` : ''}`,
  )
}

/** el-tree 的懒加载：level 0 是项目根，其余按点击的目录拉取 */
async function loadNode(node: { level: number; data?: TreeNodeData }, resolve: (data: TreeNodeData[]) => void) {
  try {
    const rel = node.level === 0 ? '' : (node.data?.rel ?? '')
    const r = await listOf(rel)
    resolve(r.entries)
  } catch (e) {
    ElMessage.error((e as Error).message)
    resolve([])
  }
}

function reloadTree() {
  // lazy 树没法只刷新一层，整体重建（key 变化触发）；
  // expandedKeys 记住了展开路径，重建后会自动恢复展开并重新懒加载
  treeKeyTick.value++
}

/** 记录展开状态：新建/重命名/删除后树会整体重建，靠它恢复展开层级 */
const expandedKeys = ref<string[]>([])
function onNodeExpand(data: TreeNodeData) {
  if (!expandedKeys.value.includes(data.rel)) expandedKeys.value = [...expandedKeys.value, data.rel]
}
function onNodeCollapse(data: TreeNodeData) {
  expandedKeys.value = expandedKeys.value.filter((k) => k !== data.rel)
}

async function onNodeClick(data: TreeNodeData) {
  if (data.isDir || data.rel === current.value?.rel) return
  await openFile(data.rel)
}

// ==================== 文件管理（新建 / 重命名 / 删除，P8-3） ====================

const ctxMenu = ref<{ show: boolean; x: number; y: number; node: TreeNodeData | null }>({ show: false, x: 0, y: 0, node: null })

function onTreeContextmenu(e: MouseEvent, data: TreeNodeData) {
  ctxMenu.value = { show: true, x: e.clientX, y: e.clientY, node: data }
  window.addEventListener('click', closeCtxMenu, { once: true })
}
function closeCtxMenu() {
  ctxMenu.value.show = false
}

async function createIn(dirRel: string, kind: 'file' | 'dir') {
  let name: string
  try {
    const { value } = await ElMessageBox.prompt(kind === 'dir' ? '新文件夹的名称' : '新文件的名称', `在「${dirRel || '项目根'}」中新建`, {
      confirmButtonText: '创建',
      cancelButtonText: '取消',
      inputPattern: /\S/,
      inputErrorMessage: '名称不能为空',
    })
    name = value.trim()
  } catch {
    return // 用户取消了输入
  }
  try {
    const r = await post<{ rel: string }>(`/api/projects/${props.project.id}/entry`, { dir: dirRel, name, kind })
    ElMessage.success(`已创建「${r.rel}」`)
    reloadTree()
  } catch (e) {
    ElMessage.error((e as Error).message)
  }
}

async function renameEntry(node: TreeNodeData) {
  let name: string
  try {
    const { value } = await ElMessageBox.prompt('新的名称', `重命名「${node.name}」`, {
      confirmButtonText: '重命名',
      cancelButtonText: '取消',
      inputValue: node.name,
      inputPattern: /\S/,
      inputErrorMessage: '名称不能为空',
    })
    name = value.trim()
  } catch {
    return
  }
  try {
    const r = await patch<{ rel: string }>(`/api/projects/${props.project.id}/entry`, { path: node.rel, name })
    // 当前打开的文件被改名：同步它的路径（内容不变，不用重新拉）
    if (current.value?.rel === node.rel) current.value.rel = r.rel
    ElMessage.success('已重命名')
    reloadTree()
  } catch (e) {
    ElMessage.error((e as Error).message)
  }
}

async function deleteEntryNode(node: TreeNodeData) {
  const isDir = node.isDir
  try {
    await ElMessageBox.confirm(
      isDir ? `「${node.name}」是一个文件夹，**它里面的所有内容都会被一起删除**，且不会进回收站。确定删除吗？` : `确定删除「${node.name}」吗？删除后不会进回收站。`,
      '删除',
      { confirmButtonText: '永久删除', cancelButtonText: '取消', type: 'warning', dangerouslyUseHTMLString: false },
    )
  } catch {
    return
  }
  try {
    const r = await del<{ deletedDirs: number; deletedFiles: number }>(`/api/projects/${props.project.id}/entry?path=${encodeURIComponent(node.rel)}`)
    // 当前打开的文件在被删目录下：关掉它
    if (current.value && (current.value.rel === node.rel || current.value.rel.startsWith(`${node.rel}/`))) {
      current.value = null
      draft.value = ''
    }
    ElMessage.success(`已删除 ${r.deletedFiles} 个文件${r.deletedDirs > 1 ? `（含 ${r.deletedDirs - 1} 个子文件夹）` : ''}`)
    reloadTree()
  } catch (e) {
    ElMessage.error((e as Error).message)
  }
}

// ==================== Git 详情（P8-4） ====================

interface GitDetail {
  hasGit: boolean
  branch: string | null
  ahead: number | null
  behind: number | null
  commits: { hash: string; short: string; author: string; date: string; subject: string }[]
  dirtyFiles: { x: string; path: string }[]
  dirtyCount: number
}

const gitDrawer = ref(false)
const gitLoading = ref(false)
const gitDetail = ref<GitDetail | null>(null)

async function openGit() {
  gitDrawer.value = true
  gitLoading.value = true
  try {
    gitDetail.value = await get<GitDetail>(`/api/projects/${props.project.id}/git`)
  } catch (e) {
    ElMessage.error((e as Error).message)
    gitDrawer.value = false
  } finally {
    gitLoading.value = false
  }
}

// ==================== 浏览器预览（P8-4） ====================

async function openPreview() {
  try {
    const r = await post<{ running: boolean; url: string | null }>(`/api/projects/${props.project.id}/preview`)
    if (r.url) {
      window.open(r.url, '_blank')
      ElMessage.success(`预览已启动：${r.url}（关闭软件时自动停止）`)
    }
  } catch (e) {
    ElMessage.error((e as Error).message)
  }
}

// ==================== 打开 / 保存 ====================

async function openFile(rel: string) {
  try {
    const f = await get<FileContent>(`/api/projects/${props.project.id}/file?path=${encodeURIComponent(rel)}`)
    current.value = f
    draft.value = f.content ?? ''
    // 能预览的类型默认给预览（看效果更常见），代码默认给编辑
    mode.value = f.preview && f.kind === 'text' ? 'preview' : 'edit'
    if (mode.value === 'preview' && f.preview === 'markdown') await nextTick().then(renderMarkdown)
  } catch (e) {
    ElMessage.error((e as Error).message)
  }
}

async function save() {
  if (!current.value || !dirty.value || saving.value) return
  saving.value = true
  try {
    const r = await put<{ backup: string; size: number; mtime: string }>(`/api/projects/${props.project.id}/file`, {
      path: current.value.rel,
      content: draft.value,
    })
    current.value = { ...current.value, content: draft.value, size: r.size, mtime: r.mtime }
    ElMessage.success(`已保存（旧内容备份为 ${r.backup}）`)
    if (mode.value === 'preview' && current.value.preview === 'markdown') await renderMarkdown()
  } catch (e) {
    ElMessage.error((e as Error).message)
  } finally {
    saving.value = false
  }
}

/** Markdown 预览：复用项目里已内置的 vditor 静态渲染 */
let vditorMod: typeof import('vditor') | null = null
async function renderMarkdown() {
  if (!mdHost.value) return
  // ⚠️ **必须自己引入 vditor 的基础样式表**：`Vditor.preview()` 只会按需加载代码高亮与内容主题样式，
  // 基础样式（`dist/index.css`）它一概不管。缺了它的后果很具体、也很容易被当成"渲染坏了"：
  // 代码块里的「复制」按钮会露馅 —— 用于剪贴板兜底的 `<textarea>` 直接显示出来（还带右下角拖拽柄），
  // 图标 `<svg>` 退回默认尺寸 300×150，看起来就是一个巨大的黑色文档图标。
  // 笔记页（NotesView）引了这句，所以那边一直正常；这里是照抄时漏掉的。
  // 与 vditor 一起动态引入，保持「不进首屏」。
  if (!vditorMod) {
    await import('vditor/dist/index.css')
    vditorMod = await import('vditor')
  }
  const { default: Vditor } = vditorMod
  await Vditor.preview(mdHost.value, draft.value, {
    cdn: '/vditor',
    mode: theme.value === 'dark' ? 'dark' : 'light',
    anchor: 0,
  })
}

// ==================== 进入 / 返回 ====================

/**
 * 进入时：拉一次根目录（顺带拿忽略计数），有 README 就自动打开。
 * ⚠️ el-tree 的懒加载是它自己发的请求，这里单独拉一次只是为了「默认打开 README」
 * 和拿 ignoredCount——本地请求很便宜，不做请求去重。
 */
async function init() {
  syncTheme()
  try {
    const r = await listOf('')
    hiddenCount.value = r.ignoredCount
    const readme = r.entries.find((e) => !e.isDir && /^readme(\.md|\.markdown)?$/i.test(e.name))
    if (readme) await openFile(readme.rel)
  } catch (e) {
    ElMessage.error((e as Error).message)
  }
}

/**
 * 返回列表。⚠️ 这里必须走确认：内嵌视图没有 el-dialog 的 before-close 兜底，
 * 自己的返回按钮是唯一的关闭入口，丢了确认就是无声丢改动。
 */
async function requestBack() {
  if (!dirty.value) {
    emit('back')
    return
  }
  try {
    await ElMessageBox.confirm('有未保存的修改，确定返回吗？', '未保存', {
      confirmButtonText: '放弃修改并返回',
      cancelButtonText: '继续编辑',
      type: 'warning',
    })
    emit('back')
  } catch {
    /* 用户取消 */
  }
}

onMounted(() => {
  window.addEventListener('wb-theme-change', syncTheme)
  void init()
})
onBeforeUnmount(() => window.removeEventListener('wb-theme-change', syncTheme))

// 切到预览时渲染 Markdown
watch([mode, () => current.value?.rel], async () => {
  if (mode.value === 'preview' && current.value?.preview === 'markdown') {
    await nextTick()
    await renderMarkdown()
  }
})
</script>

<style scoped>
.pf-page {
  height: calc(100vh - 40px); /* el-main 上下各 20px padding，占满剩余可视区 */
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.pf-topbar {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}
.pf-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--el-text-color-primary);
  flex: none;
}
.pf-path {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pf-topbar-tip {
  margin-left: auto;
  flex: none;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.pf-topbar-tip.warn {
  color: var(--el-color-warning);
}
.pf-body {
  flex: 1;
  min-height: 0;
  display: flex;
  gap: 12px;
}
.pf-side {
  width: 260px;
  flex: 0 0 260px;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--el-border-color);
  border-radius: 8px;
  overflow: hidden;
  background: var(--el-bg-color);
}
.pf-side-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 6px 4px 10px;
  border-bottom: 1px solid var(--el-border-color-lighter);
  background: var(--el-fill-color-light);
}
.pf-side-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-regular);
}
.pf-tree {
  flex: 1;
  overflow: auto;
  padding: 4px;
  background: transparent;
}
.pf-tree :deep(.el-tree-node__content) {
  height: 26px;
}
.pf-node {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 13px;
  width: 100%;
  min-width: 0;
}
.pf-node-icon {
  color: var(--el-text-color-secondary);
  flex: none;
}
.pf-node.dir .pf-node-icon {
  color: var(--el-color-primary);
}
.pf-node-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pf-node-size {
  margin-left: auto;
  padding-left: 6px;
  font-size: 11px;
  color: var(--el-text-color-placeholder);
  flex: none;
}
.pf-badge {
  margin-left: 4px;
  font-size: 10px;
  line-height: 14px;
  padding: 0 4px;
  border-radius: 3px;
  color: var(--el-color-success);
  border: 1px solid var(--el-color-success-light-5);
  flex: none;
}
.pf-hidden-hint {
  padding: 5px 10px;
  font-size: 11px;
  line-height: 15px;
  color: var(--el-text-color-placeholder);
  border-top: 1px solid var(--el-border-color-lighter);
  background: var(--el-fill-color-lighter);
}
.pf-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.pf-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.pf-bar-left {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.pf-file {
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pf-file-meta {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.pf-bar-right {
  display: flex;
  align-items: center;
  gap: 8px;
}
.pf-alert {
  margin: 0;
}
.pf-stage {
  flex: 1;
  min-height: 0;
  border: 1px solid var(--el-border-color);
  border-radius: 8px;
  overflow: hidden;
  background: var(--el-bg-color);
}
.pf-stage > :deep(*) {
  width: 100%;
  height: 100%;
}
.pf-frame {
  border: 0;
  display: block;
  background: #fff;
}
.pf-markdown {
  overflow: auto;
  padding: 18px 22px;
  background: var(--el-bg-color);
}
/*
 * Vditor 对「预览」里的代码块只给了 `margin`（`.vditor-reset pre { margin: 1em 0 }`），
 * 底色是留给编辑器里的 pre 的（`.vditor-ir pre.vditor-reset { background-color: ... }`）。
 * 于是预览里代码块和正文一样是白底，读起来分不出块。这里补个底色与圆角，
 * 只作用于本组件的预览宿主，不动笔记页那个真正的编辑器。
 */
.pf-markdown :deep(pre) {
  background: var(--el-fill-color-light);
  border: 1px solid var(--el-border-color-extra-light);
  border-radius: 6px;
  padding: 12px 14px;
  overflow: auto;
}
.pf-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--el-text-color-secondary);
  font-size: 13px;
}

/* ===== 顶栏操作区 / 树头部 ===== */
.pf-topbar-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
  flex: none;
}
.pf-topbar .pf-topbar-tip {
  margin-left: 0;
}
.pf-side-actions {
  display: flex;
  align-items: center;
  gap: 2px;
}

/* ===== 右键菜单 ===== */
.pf-ctx {
  position: fixed;
  z-index: 3000;
  min-width: 140px;
  padding: 5px;
  background: var(--el-bg-color-overlay);
  border: 1px solid var(--el-border-color-light);
  border-radius: 8px;
  box-shadow: var(--el-box-shadow-light);
}
.pf-ctx-item {
  padding: 6px 12px;
  font-size: 13px;
  border-radius: 5px;
  color: var(--el-text-color-primary);
  cursor: pointer;
  user-select: none;
}
.pf-ctx-item:hover {
  background: var(--el-fill-color);
}
.pf-ctx-item.danger {
  color: var(--el-color-danger);
}
.pf-ctx-sep {
  height: 1px;
  margin: 4px 8px;
  background: var(--el-border-color-lighter);
}

/* ===== Git 抽屉 ===== */
.gd-body {
  min-height: 200px;
}
.gd-section {
  margin-bottom: 22px;
}
.gd-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}
.gd-branch {
  font-size: 15px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.gd-sub {
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-regular);
  margin-bottom: 8px;
}
.gd-dirty {
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  overflow: hidden;
  max-height: 260px;
  overflow-y: auto;
}
.gd-dirty-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 10px;
  font-size: 12px;
  border-bottom: 1px solid var(--el-border-color-extra-light);
}
.gd-dirty-row:last-child {
  border-bottom: 0;
}
.gd-dirty-x {
  flex: none;
  width: 20px;
  text-align: center;
  font-family: Consolas, monospace;
  font-weight: 700;
  color: var(--el-color-warning);
}
.gd-dirty-x.untracked {
  color: var(--el-text-color-placeholder);
}
.gd-dirty-path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--el-text-color-regular);
}
.gd-commit {
  padding: 8px 0;
  border-bottom: 1px solid var(--el-border-color-extra-light);
}
.gd-commit:last-child {
  border-bottom: 0;
}
.gd-commit-subject {
  font-size: 13px;
  color: var(--el-text-color-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.gd-commit-meta {
  margin-top: 2px;
  font-size: 11px;
  color: var(--el-text-color-secondary);
}
</style>
