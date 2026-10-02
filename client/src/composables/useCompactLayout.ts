import { onBeforeUnmount, onMounted, ref, type Ref } from 'vue'

/** 依据容器实际可用宽度切换，字号缩放后同样有效。 */
export function useCompactLayout(element: Ref<HTMLElement | undefined>, threshold: number) {
  const compact = ref(false)
  let observer: ResizeObserver | undefined
  onMounted(() => {
    observer = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width > 0) compact.value = entry.contentRect.width < threshold
    })
    if (element.value) observer.observe(element.value)
  })
  onBeforeUnmount(() => observer?.disconnect())
  return compact
}
