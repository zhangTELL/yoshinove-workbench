import { shallowRef, watch } from 'vue'

/** 记住本机上次选择；存储不可用或旧值无效时使用默认值。 */
export function useRememberedSelection<T extends string | number>(key: string, fallback: T, isValid: (value: unknown) => value is T) {
  const selection = shallowRef<T>(fallback)
  try {
    const raw = localStorage.getItem(key)
    if (raw !== null) {
      const value: unknown = JSON.parse(raw)
      if (isValid(value)) selection.value = value
    }
  } catch { /* 无效的本地记录不影响页面使用 */ }
  watch(selection, (value) => {
    try { localStorage.setItem(key, JSON.stringify(value)) }
    catch { /* 存储受限时仍可正常切换 */ }
  }, { immediate: true, flush: 'sync' })
  return selection
}
