import { ref } from 'vue'
import { get, put } from '../api/http'
import { t } from '../locales'

/**
 * 用户称呼：首页问候语（`DashboardView`）与浏览器标签页标题（`router/index.ts`）共用。
 *
 * 用模块级 `ref` 而不是 Pinia store：只有一个字符串、两处读一处写，上 `defineStore`
 * 只是多一层注册与解构样板（本项目目前也没有别的 store）。模块级 ref 天然是单例，
 * 任何地方 import 进来拿到的都是同一份状态，改动会自动同步到所有使用者。
 */

/** 用户没设置过称呼时的兜底 */
export const DEFAULT_NAME = '同学'
export const NAME_MAX = 16

/** 空串 = 未设置 */
export const displayName = ref('')

/** 标签页标题里的主体。未设置称呼时沿用项目名；后缀跟随界面语言（的工作台 / 's Workspace …） */
export function titleWithName(): string {
  return `${displayName.value || 'Yoshinove'}${t('app.suffix')}`
}

export async function loadDisplayName(): Promise<void> {
  try {
    // 刻意只取这一个键：`GET /api/settings` 会把 PushPlus Token、企业微信 Secret
    // 一并返回，这两个位置（首页 / 标题）都不需要碰凭据。
    const res = await get<{ value: string | null }>('/api/settings/ui.displayName')
    displayName.value = typeof res?.value === 'string' ? res.value : ''
  } catch {
    // 取不到就当没设置，不要让首页因为一个称呼而报错
    displayName.value = ''
  }
}

/** 保存称呼。乐观更新，失败回滚并把错误抛给调用方去决定怎么提示 */
export async function saveDisplayName(next: string): Promise<void> {
  const cleaned = next.trim().slice(0, NAME_MAX)
  if (cleaned === displayName.value) return

  const prev = displayName.value
  displayName.value = cleaned
  try {
    await put('/api/settings', { 'ui.displayName': cleaned })
  } catch (e) {
    displayName.value = prev
    throw e
  }
}
