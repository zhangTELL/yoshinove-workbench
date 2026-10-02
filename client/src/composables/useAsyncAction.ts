import { ref } from 'vue'
import { ElMessage } from 'element-plus'

export function useAsyncAction() {
  const pending = ref(false)
  const error = ref('')
  async function run(action: () => Promise<void>) {
    if (pending.value) return false
    pending.value = true
    error.value = ''
    try {
      await action()
      return true
    } catch (e) {
      error.value = (e as Error).message
      ElMessage.error(`操作失败：${error.value}`)
      return false
    } finally { pending.value = false }
  }
  return { pending, error, run }
}
