import { nextTick, onBeforeUnmount, watch } from 'vue'
import { useRoute } from 'vue-router'

export function useAssistantFocus() {
  const route = useRoute()
  let observer: MutationObserver | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  function stop() { observer?.disconnect(); observer = undefined; if (timer) clearTimeout(timer) }
  watch(() => route.fullPath, async () => {
    stop()
    if (!route.query.aiEntity || !/^\d+$/.test(String(route.query.aiId))) return
    await nextTick()
    const focus = () => {
      const entity = String(route.query.aiEntity)
      if (!/^[a-z]+$/.test(entity)) return
      const element = document.querySelector<HTMLElement>(`[data-ai-entity="${entity}"][data-ai-id="${route.query.aiId}"]`) ?? (entity === 'score' ? document.querySelector<HTMLElement>(`.ai-score-${route.query.aiId}`) : entity === 'run' && /^\d{4}-\d{2}-\d{2}$/.test(String(route.query.aiDate)) ? document.querySelector<HTMLElement>(`[data-ai-date="${route.query.aiDate}"]`) : null)
      if (!element || !element.getClientRects().length) return
      element.classList.add('ai-located')
      element.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'center', inline: 'nearest' })
      stop()
    }
    observer = new MutationObserver(focus)
    observer.observe(document.querySelector('.app-main') ?? document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-ai-id'] })
    focus()
    timer = setTimeout(stop, 15000)
  }, { immediate: true })
  onBeforeUnmount(stop)
}
