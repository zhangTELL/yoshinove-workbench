<script setup lang="ts">
import type { MenuInstance } from 'element-plus'
import { ElNotification } from 'element-plus'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { get, post } from '../api/http'
import AppIcon from '../components/AppIcon.vue'
import { t } from '../locales'
import type { IconKey } from '../utils/themeIcons'
import { themedIcon } from '../utils/themeIcons'

const route = useRoute()

interface SubItem {
  key: string
  title: string
  /** 文案字典键（title 保留中文原文作为回退） */
  tKey: string
  /** 逻辑图标名；具体用哪个图标由当前主题决定（见 utils/themeIcons.ts） */
  icon: IconKey
}
interface NavLink {
  kind: 'link'
  path: string
  title: string
  tKey: string
  icon: IconKey
}
interface NavGroup {
  kind: 'group'
  /** el-sub-menu 的 index，仅作标识 */
  index: string
  /** 子项路由的基路径，子项为 `${path}?tab=${key}` */
  path: string
  title: string
  tKey: string
  icon: IconKey
  items: SubItem[]
}

/**
 * 左侧主导航：**有序数组决定显示顺序**。
 * 之前是「分组前 / 分组 / 分组后」三段式，加一个位于中间的分组就得改结构，所以改成联合数组。
 * 加页面/分组只动这里（分组还要在对应 View 里加 TABS 常量）。
 * `icon` 写的是**逻辑图标名**，具体图标按主题解析（见 utils/themeIcons.ts）。
 */
const nav: (NavLink | NavGroup)[] = [
  { kind: 'link', path: '/dashboard', title: '首页', tKey: 'nav.dashboard', icon: 'dashboard' },
  {
    kind: 'group',
    index: 'schedule',
    path: '/schedule',
    title: '课表', tKey: 'nav.schedule',
    icon: 'schedule',
    items: [
      { key: 'grid', title: '课程表', tKey: 'nav.scheduleGrid', icon: 'scheduleGrid' },
      { key: 'remind', title: '上课提醒', tKey: 'nav.scheduleRemind', icon: 'scheduleRemind' },
    ],
  },
  { kind: 'link', path: '/chaoxing', title: '学习通作业', tKey: 'nav.chaoxing', icon: 'chaoxing' },
  { kind: 'link', path: '/notes', title: '笔记', tKey: 'nav.notes', icon: 'notes' },
  { kind: 'link', path: '/projects', title: '项目管理', tKey: 'nav.projects', icon: 'projects' },
  {
    kind: 'group',
    index: 'ai',
    path: '/ai-lab',
    title: 'AI 实验区', tKey: 'nav.ai-lab',
    icon: 'aiLab',
    items: [
      { key: 'balance', title: '账户余额', tKey: 'nav.balance', icon: 'balance' },
      { key: 'prompts', title: 'Prompt 库', tKey: 'nav.prompts', icon: 'prompts' },
      { key: 'compare', title: '模型对比', tKey: 'nav.compare', icon: 'compare' },
      { key: 'sandbox', title: '沙箱渲染', tKey: 'nav.sandbox', icon: 'sandbox' },
    ],
  },
  {
    kind: 'group',
    index: 'tools',
    path: '/tools',
    title: '日常工具', tKey: 'nav.tools',
    icon: 'tools',
    items: [
      { key: 'runs', title: '健康跑', tKey: 'nav.runs', icon: 'runs' },
      { key: 'countdown', title: '倒计日', tKey: 'nav.countdown', icon: 'countdown' },
      { key: 'scores', title: '成绩绩点', tKey: 'nav.scores', icon: 'scores' },
      { key: 'pomodoro', title: '番茄钟', tKey: 'nav.pomodoro', icon: 'pomodoro' },
    ],
  },
  { kind: 'link', path: '/settings', title: '设置', tKey: 'nav.settings', icon: 'settings' },
]

const groups = computed(() => nav.filter((n): n is NavGroup => n.kind === 'group'))

const menuRef = ref<MenuInstance>()
const activeGroup = computed(() => groups.value.find((g) => g.path === route.path) ?? null)

/** 带 query 的完整路径才能让子菜单项高亮；直接访问分组页时回落到第一个子项 */
const activeMenu = computed(() => {
  const g = activeGroup.value
  if (!g) return route.path
  const tab = typeof route.query.tab === 'string' ? route.query.tab : g.items[0].key
  return `${g.path}?tab=${tab}`
})

// el-menu 的 default-openeds 只在初始化时生效，跨页／后退进入分组时要手动展开
watch(
  () => activeGroup.value?.index,
  (index) => {
    if (!index) return
    void nextTick().then(() => menuRef.value?.open(index))
  },
)

// ===== 通知轮询：拉取服务端待投递的浏览器通知 =====
interface PendingNotif {
  id: number
  title: string
  body: string
}

let pollTimer: number | undefined

async function pollNotifications() {
  try {
    const list = await get<PendingNotif[]>('/api/notifications/pending')
    if (!list.length) return
    for (const n of list) {
      if ('Notification' in window && Notification.permission === 'granted') {
        new Notification(n.title, { body: n.body })
      }
      ElNotification({ title: n.title, message: n.body, type: 'info', duration: 10000 })
    }
    await post('/api/notifications/mark-delivered', { ids: list.map((n) => n.id) })
  } catch {
    /* 后台轮询失败静默忽略 */
  }
}

onMounted(() => {
  void pollNotifications()
  pollTimer = window.setInterval(pollNotifications, 30000)
})
onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer)
})
</script>

<template>
  <el-container class="layout">
    <el-aside width="200px" class="aside">
      <div class="logo">
        <AppIcon :icon="themedIcon('logo')" :size="26" />
        <span class="logo-text">工作台</span>
      </div>
      <el-menu
        ref="menuRef"
        :default-active="activeMenu"
        :default-openeds="activeGroup ? [activeGroup.index] : []"
        router
        class="menu"
      >
        <template v-for="n in nav" :key="n.kind === 'group' ? n.index : n.path">
          <el-sub-menu v-if="n.kind === 'group'" :index="n.index">
            <template #title>
              <el-icon><component :is="themedIcon(n.icon)" /></el-icon>
              <span>{{ t(n.tKey) }}</span>
            </template>
            <el-menu-item v-for="it in n.items" :key="it.key" :index="`${n.path}?tab=${it.key}`">
              <el-icon><component :is="themedIcon(it.icon)" /></el-icon>
              <span>{{ t(it.tKey) }}</span>
            </el-menu-item>
          </el-sub-menu>

          <el-menu-item v-else :index="n.path">
            <el-icon><component :is="themedIcon(n.icon)" /></el-icon>
            <span>{{ t(n.tKey) }}</span>
          </el-menu-item>
        </template>
      </el-menu>
    </el-aside>
    <el-container>
      <el-main class="main app-main">
        <router-view />
      </el-main>
    </el-container>
  </el-container>
</template>

<style scoped>
.layout {
  height: 100vh;
}
.aside {
  background: var(--el-bg-color);
  border-right: 1px solid var(--el-border-color-light);
  display: flex;
  flex-direction: column;
}
.logo {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 18px 14px 16px;
  color: var(--el-text-color-primary);
}
.logo-text {
  font-size: 16px;
  font-weight: 600;
  letter-spacing: 0.2px;
}
.menu {
  border-right: none;
  flex: 1;
}
/* 导航图标：macOS 侧栏里图标的分量比文字大一点，且要和文字有明显呼吸感 */
.menu :deep(.el-menu-item > .el-icon),
.menu :deep(.el-sub-menu__title > .el-icon) {
  font-size: 17px;
  margin-right: 9px;
  width: 17px;
}
/* 未选中项：图标压到次级灰（macOS 侧栏未选中是 secondaryLabel），选中才给强调色 */
.menu :deep(.el-menu-item:not(.is-active) > .el-icon),
.menu :deep(.el-sub-menu__title > .el-icon) {
  color: var(--el-text-color-secondary);
}
/* 子栏目比主导航项略紧凑，形成层级感 */
.menu :deep(.el-sub-menu .el-menu-item) {
  height: 42px;
  line-height: 42px;
  font-size: 13px;
}
.menu :deep(.el-sub-menu .el-menu-item > .el-icon) {
  font-size: 15px;
  width: 15px;
  margin-right: 8px;
}
.main {
  padding: 20px;
  overflow: auto;
}
</style>
