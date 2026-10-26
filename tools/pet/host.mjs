import { apply } from '../../vendor/dsh-pet/src/host/index.ts'
import { createStandaloneContext } from '../../vendor/dsh-pet/src/standalone/context.ts'

export function mountPetHost(callbacks, port) {
  const runtime = createStandaloneContext({ port, logger: { info: console.log, warn: console.warn, error: console.error, debug() {} } })
  let petState
  const ctx = runtime.ctx
  ctx.agentDefaultModel = { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-flash' }) }
  ctx.credentials = { resolve: async () => ({ value: callbacks.key() }) }
  ctx.get = () => undefined
  const webPort = Number(process.env.WORKBENCH_WEB_PORT ?? process.env.WORKBENCH_HTTP_PORT ?? 5173)
  if (!Number.isInteger(webPort) || webPort < 1 || webPort > 65535) throw new Error('网页端口无效')
  ctx.connection.authenticatedUrl = () => `http://127.0.0.1:${webPort}/?assistant=open`
  ctx.workbench = {
    setState: state => { petState = state },
    pending: callbacks.pending,
    config: callbacks.config,
    review: callbacks.review,
  }
  ctx.llm = {
    listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
    listModels: async () => [{ id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash' }],
    resolveModelInfo: async () => ({ reasoningEfforts: false }),
    async *stream(options) {
      const answer = options.workbenchAction === 'chat'
        ? await callbacks.chat(options.workbenchUserText, options.system, options.messages)
        : await callbacks.whisper(options.system, options.messages)
      yield { type: 'text', text: answer }
    },
  }
  apply(ctx)
  if (runtime.failures.length) throw new Error(runtime.failures.join('；'))
  return {
    routes: runtime.routes,
    dispose: () => runtime.dispose(),
    status(state, task) {
      petState?.writeSection('workStatus', { state, task })
      if (state === 'success' || state === 'error') petState?.writeSection('notify', { type: 'session/event', event: { type: 'turn/end', data: { reason: { kind: state === 'success' ? 'completed' : 'error', ...(state === 'error' ? { error: { message: task } } : {}) } } } })
    },
  }
}
