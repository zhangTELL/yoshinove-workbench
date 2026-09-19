<!--
  「在本地应用中打开」分体按钮（仿 deepseek-harness 的 open-in-app 会话头部按钮）

  主按钮：用**记住的那个应用**打开当前项目目录（显示应用真实图标）
  箭头：展开本机已验证安装的全部应用，记住的条目整行高亮
  记忆顺序：该项目上次用的（服务端记录）→ 浏览器里全局记着的 → 列表第一项
-->
<template>
  <div v-if="apps.length" class="oia" :class="{ busy }">
    <button
      class="oia-main"
      :class="{ error: errorState }"
      :disabled="busy"
      :title="`在 ${currentLabel} 中打开工作目录`"
      @click="launch(current)"
    >
      <img
        v-if="current && !failedIcons.has(current)"
        class="oia-icon"
        :src="iconUrl(current)"
        alt=""
        @error="failedIcons.add(current)"
      />
      <span v-else class="oia-icon oia-fallback">{{ shortOf(current) }}</span>
      <span class="oia-text">在 {{ currentLabel }} 中打开</span>
    </button>

    <el-dropdown trigger="click" placement="bottom-end" @command="launch">
      <button class="oia-chevron" title="选择打开方式" aria-label="选择打开方式">
        <el-icon><ArrowDown /></el-icon>
      </button>
      <template #dropdown>
        <el-dropdown-menu>
          <el-dropdown-item v-for="a in apps" :key="a.id" :command="a.id" :class="{ 'oia-active': a.id === current }">
            <img v-if="!failedIcons.has(a.id)" class="oia-menu-icon" :src="iconUrl(a.id)" alt="" @error="failedIcons.add(a.id)" />
            <span v-else class="oia-menu-icon oia-fallback">{{ shortOf(a.id) }}</span>
            <span>{{ a.label }}</span>
          </el-dropdown-item>
        </el-dropdown-menu>
      </template>
    </el-dropdown>
  </div>
</template>

<script setup lang="ts">
import { ElMessage } from 'element-plus'
import { ArrowDown } from '@element-plus/icons-vue'
import { computed, onMounted, ref } from 'vue'
import { get, post } from '../api/http'

const props = defineProps<{
  project: { id: number; name: string; alias: string | null; path: string; lastOpenTarget: string | null }
}>()

interface AppEntry {
  id: string
  label: string
}

const KEY = 'workbench.openInApp.choice'

const apps = ref<AppEntry[]>([])
const choice = ref('')
const busy = ref(false)
const errorState = ref(false)
const failedIcons = ref<Set<string>>(new Set())

const current = computed(() => choice.value || apps.value[0]?.id || '')
const currentLabel = computed(() => apps.value.find((a) => a.id === current.value)?.label ?? '默认应用')

const iconUrl = (id: string) => `/api/projects/open-in-app/icon/${id}`

/** 图标提取不到时的占位字形：取标签首字母 */
function shortOf(id: string): string {
  const label = apps.value.find((a) => a.id === id)?.label ?? id
  return label.slice(0, 1).toUpperCase()
}

async function load() {
  try {
    const r = await get<{ apps: AppEntry[] }>('/api/projects/open-in-app/apps')
    apps.value = r.apps
    const stored = localStorage.getItem(KEY) ?? ''
    const prefer = props.project.lastOpenTarget ?? ''
    choice.value = [prefer, stored].find((id) => id && r.apps.some((a) => a.id === id)) ?? r.apps[0]?.id ?? ''
  } catch (e) {
    ElMessage.error((e as Error).message)
  }
}

async function launch(id: string) {
  if (busy.value || !id) return
  busy.value = true
  errorState.value = false
  try {
    const r = await post<{ ok: boolean; outcome: string; label: string }>('/api/projects/open-in-app/open', {
      app: id,
      path: props.project.path,
    })
    if (r.ok) {
      choice.value = id
      localStorage.setItem(KEY, id)
      ElMessage.success(`已在「${r.label}」中打开`)
    } else {
      throw new Error('启动失败，可以试试别的打开方式')
    }
  } catch (e) {
    errorState.value = true
    window.setTimeout(() => (errorState.value = false), 2000)
    ElMessage.error((e as Error).message)
  } finally {
    busy.value = false
  }
}

onMounted(load)
</script>

<style scoped>
.oia {
  display: inline-flex;
  align-items: stretch;
  height: 28px;
  border: 1px solid var(--el-border-color);
  border-radius: var(--wb-radius-pill);
  overflow: hidden;
  background: var(--el-bg-color);
}
.oia-main,
.oia-chevron {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0 10px;
  border: 0;
  background: transparent;
  color: var(--el-text-color-primary);
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  white-space: nowrap;
}
.oia-main:hover:not(:disabled),
.oia-chevron:hover {
  background: var(--el-fill-color-light);
}
.oia-main:disabled {
  color: var(--el-text-color-placeholder);
  cursor: wait;
}
.oia-main.error {
  color: var(--el-color-danger);
  box-shadow: inset 0 0 0 1px var(--el-color-danger);
}
.oia-chevron {
  padding: 0 8px 0 7px;
  border-left: 1px solid var(--el-border-color);
  color: var(--el-text-color-secondary);
}
.oia-icon {
  width: 16px;
  height: 16px;
  flex: none;
  object-fit: contain;
}
.oia-fallback {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--wb-radius-small);
  background: var(--el-fill-color-dark);
  color: var(--el-text-color-regular);
  font-size: 10px;
  font-weight: 700;
}
.oia-menu-icon {
  width: 16px;
  height: 16px;
  margin-right: 8px;
  flex: none;
  object-fit: contain;
  vertical-align: -3px;
}
.oia :deep(.el-dropdown) {
  display: inline-flex;
}
.oia :deep(.oia-active) {
  background: var(--el-color-primary-light-9);
  color: var(--el-color-primary);
  font-weight: 600;
}
</style>
