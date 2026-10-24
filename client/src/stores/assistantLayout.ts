import { reactive } from 'vue'

const storageKey = 'wb.assistant.defaultWidth'
function readDefaultWidth() {
  try {
    const saved = Number(localStorage.getItem(storageKey) ?? localStorage.getItem('wb.assistant.width'))
    if (Number.isFinite(saved) && saved >= 320) return Math.min(1200, saved)
  } catch { /* 使用默认宽度 */ }
  return 420
}

export const assistantLayout = reactive({ defaultWidth: readDefaultWidth(), width: 420 })
export function setAssistantDefaultWidth(value: number | undefined) {
  if (value === undefined || !Number.isFinite(value)) return
  assistantLayout.defaultWidth = Math.round(Math.max(320, Math.min(1200, value)))
  try { localStorage.setItem(storageKey, String(assistantLayout.defaultWidth)) } catch { /* 本次设置仍可生效 */ }
}
