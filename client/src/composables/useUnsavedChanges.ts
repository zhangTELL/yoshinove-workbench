import { onBeforeUnmount, onMounted, ref, type Ref } from 'vue'
import { onBeforeRouteLeave, onBeforeRouteUpdate } from 'vue-router'
import { ElMessage } from 'element-plus'

export const leaveDialog = {
  visible: ref(false),
  saving: ref(false),
  label: ref(''),
}
let resolveChoice: ((choice: 'save' | 'discard' | 'stay') => void) | undefined

export function chooseLeave(choice: 'save' | 'discard' | 'stay') {
  if (leaveDialog.saving.value) return
  resolveChoice?.(choice)
  resolveChoice = undefined
}

export function useUnsavedChanges(dirty: Ref<boolean>, save: () => Promise<boolean>, label: string, guardUpdate = false) {
  async function confirmLeave(): Promise<boolean> {
    if (!dirty.value) return true
    if (leaveDialog.visible.value) return false
    leaveDialog.label.value = label
    leaveDialog.visible.value = true
    try {
      const choice = await new Promise<'save' | 'discard' | 'stay'>((resolve) => { resolveChoice = resolve })
      if (choice === 'discard') return true
      if (choice === 'stay') return false
      leaveDialog.saving.value = true
      if (!(await save())) return false
      if (dirty.value) {
        ElMessage.warning('保存期间又有修改，请保存最新内容后再离开')
        return false
      }
      return true
    } finally {
      leaveDialog.saving.value = false
      leaveDialog.visible.value = false
    }
  }
  function beforeUnload(event: BeforeUnloadEvent) {
    if (!dirty.value) return
    event.preventDefault()
    event.returnValue = ''
  }
  onBeforeRouteLeave(confirmLeave)
  if (guardUpdate) onBeforeRouteUpdate((to, from) => to.fullPath === from.fullPath || confirmLeave())
  onMounted(() => window.addEventListener('beforeunload', beforeUnload))
  onBeforeUnmount(() => window.removeEventListener('beforeunload', beforeUnload))
  return confirmLeave
}
