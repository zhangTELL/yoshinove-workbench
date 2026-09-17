import { createRouter, createWebHistory } from 'vue-router'
import { watch } from 'vue'
import { displayName, titleWithName } from '../stores/profile'
import { t } from '../locales'
import { appearance } from '../stores/appearance'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      component: () => import('../layouts/MainLayout.vue'),
      redirect: '/dashboard',
      children: [
        { path: 'dashboard', name: 'dashboard', component: () => import('../views/DashboardView.vue'), meta: { title: '首页' } },
        { path: 'schedule', name: 'schedule', component: () => import('../views/ScheduleView.vue'), meta: { title: '课表' } },
        { path: 'chaoxing', name: 'chaoxing', component: () => import('../views/ChaoxingView.vue'), meta: { title: '学习通作业' } },
        { path: 'notes', name: 'notes', component: () => import('../views/NotesView.vue'), meta: { title: '笔记' } },
        { path: 'projects', name: 'projects', component: () => import('../views/ProjectsView.vue'), meta: { title: '项目管理' } },
        { path: 'ai-lab', name: 'ai-lab', component: () => import('../views/AiLabView.vue'), meta: { title: 'AI 实验区' } },
        { path: 'tools', name: 'tools', component: () => import('../views/ToolsView.vue'), meta: { title: '日常工具' } },
        { path: 'settings', name: 'settings', component: () => import('../views/SettingsView.vue'), meta: { title: '设置' } },
      ],
    },
  ],
})

router.afterEach((to) => {
  applyTitle(pageTitleOf(to))
})

// 改称呼 / 切语言后标签页标题都要立刻跟着变，不等下次路由切换
watch([displayName, () => appearance.language], () => applyTitle(pageTitleOf(router.currentRoute.value)))

/** 页面名走文案字典（跟随界面语言）；字典没有的回落 meta.title */
function pageTitleOf(route: { name?: unknown; query: Record<string, unknown>; meta: { title?: unknown } }): string {
  // 课表的「上课提醒」子板块与课程表共用路由名，靠 tab 区分
  if (route.name === 'schedule' && route.query.tab === 'remind') return t('nav.scheduleRemind')
  if (route.name) {
    const key = `nav.${String(route.name)}`
    const v = t(key)
    if (v !== key) return v
  }
  return (route.meta.title as string) ?? ''
}

function applyTitle(pageTitle?: string): void {
  document.title = pageTitle ? `${pageTitle} · ${titleWithName()}` : titleWithName()
}

export default router
