<script setup lang="ts">
import {
  AlarmClock,
  FolderOpened,
  Bell,
  Calendar,
  Collection,
  DataAnalysis,
  Football,
  Histogram,
  MagicStick,
  Menu as MenuIcon,
  Notebook,
  Reading,
  Setting,
  Timer,
  TrendCharts,
  View,
  Wallet,
} from '@element-plus/icons-vue'
import type { MenuInstance } from 'element-plus'
import { ElNotification } from 'element-plus'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import type { Component } from 'vue'
import { useRoute } from 'vue-router'
import { get, post } from '../api/http'
import { t } from '../locales'

const route = useRoute()

interface SubItem {
  key: string
  title: string
  /** 文案字典键（title 保留中文原文作为回退） */
  tKey: string
  icon: Component
}
interface NavLink {
  kind: 'link'
  path: string
  title: string
  tKey: string
  icon: Component
}
interface NavGroup {
  kind: 'group'
  /** el-sub-menu 的 index，仅作标识 */
  index: string
  /** 子项路由的基路径，子项为 `${path}?tab=${key}` */
  path: string
  title: string
  tKey: string
  icon: Component
  items: SubItem[]
}

/**
 * 左侧主导航：**有序数组决定显示顺序**。
 * 之前是「分组前 / 分组 / 分组后」三段式，加一个位于中间的分组就得改结构，所以改成联合数组。
 * 加页面/分组只动这里（分组还要在对应 View 里加 TABS 常量）。
 */
const nav: (NavLink | NavGroup)[] = [
  { kind: 'link', path: '/dashboard', title: '首页', tKey: 'nav.dashboard', icon: MenuIcon },
  {
    kind: 'group',
    index: 'schedule',
    path: '/schedule',
    title: '课表', tKey: 'nav.schedule',
    icon: Calendar,
    items: [
      { key: 'grid', title: '课程表', tKey: 'nav.scheduleGrid', icon: Calendar },
      { key: 'remind', title: '上课提醒', tKey: 'nav.scheduleRemind', icon: Bell },
    ],
  },
  { kind: 'link', path: '/chaoxing', title: '学习通作业', tKey: 'nav.chaoxing', icon: Reading },
  { kind: 'link', path: '/notes', title: '笔记', tKey: 'nav.notes', icon: Notebook },
  { kind: 'link', path: '/projects', title: '项目管理', tKey: 'nav.projects', icon: FolderOpened },
  {
    kind: 'group',
    index: 'ai',
    path: '/ai-lab',
    title: 'AI 实验区', tKey: 'nav.ai-lab',
    icon: MagicStick,
    items: [
      { key: 'balance', title: '账户余额', tKey: 'nav.balance', icon: Wallet },
      { key: 'prompts', title: 'Prompt 库', tKey: 'nav.prompts', icon: Collection },
      { key: 'compare', title: '模型对比', tKey: 'nav.compare', icon: DataAnalysis },
      { key: 'sandbox', title: '沙箱渲染', tKey: 'nav.sandbox', icon: View },
    ],
  },
  {
    kind: 'group',
    index: 'tools',
    path: '/tools',
    title: '日常工具', tKey: 'nav.tools',
    icon: Histogram,
    items: [
      { key: 'runs', title: '健康跑', tKey: 'nav.runs', icon: Football },
      { key: 'countdown', title: '倒计日', tKey: 'nav.countdown', icon: AlarmClock },
      { key: 'scores', title: '成绩绩点', tKey: 'nav.scores', icon: TrendCharts },
      { key: 'pomodoro', title: '番茄钟', tKey: 'nav.pomodoro', icon: Timer },
    ],
  },
  { kind: 'link', path: '/settings', title: '设置', tKey: 'nav.settings', icon: Setting },
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
      <div class="logo">📚 工作台</div>
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
              <el-icon><component :is="n.icon" /></el-icon>
              <span>{{ t(n.tKey) }}</span>
            </template>
            <el-menu-item v-for="it in n.items" :key="it.key" :index="`${n.path}?tab=${it.key}`">
              <el-icon><component :is="it.icon" /></el-icon>
              <span>{{ t(it.tKey) }}</span>
            </el-menu-item>
          </el-sub-menu>

          <el-menu-item v-else :index="n.path">
            <el-icon><component :is="n.icon" /></el-icon>
            <span>{{ t(n.tKey) }}</span>
          </el-menu-item>
        </template>
      </el-menu>
    </el-aside>
    <el-container>
      <el-main class="main">
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
  font-size: 18px;
  font-weight: 600;
  padding: 20px 16px;
  color: var(--el-text-color-primary);
}
.menu {
  border-right: none;
  flex: 1;
}
/* 子栏目比主导航项略紧凑，形成层级感 */
.menu :deep(.el-sub-menu .el-menu-item) {
  height: 42px;
  line-height: 42px;
  font-size: 13px;
}
.main {
  padding: 20px;
  overflow: auto;
}
</style>
