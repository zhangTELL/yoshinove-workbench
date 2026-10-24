import { Readable } from 'node:stream'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { FastifyPluginAsync } from 'fastify'
import type { createAssistant } from '../services/assistant.js'

type Assistant = ReturnType<typeof createAssistant>
interface PetRuntime {
  routes: { path: string; handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> }[]
  dispose(): Promise<void>
  status(state: string | null, task: string | null): void
}

/**
 * 桌宠是纯附加能力，不能让它的加载过程拖住后端监听。
 * 2026-10-24 故障：`await import(vendor/dsh-pet/lib/workbench-host.mjs)` 在
 * pnpm dev（concurrently + tsx watch）下偶发不返回，后端卡在注册路由阶段，
 * 5175 永不监听，启动器只能报“等待前后端就绪超时”。
 * 这里给加载 + 挂载整体加时限：超时只失去桌宠，后端照常提供服务。
 */
const MOUNT_TIMEOUT_MS = Number(process.env.WORKBENCH_PET_MOUNT_TIMEOUT_MS ?? 15000)

function withTimeout<T>(task: Promise<T>, ms: number, label: string): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return task
  return new Promise<T>((resolveTask, rejectTask) => {
    const timer = setTimeout(() => rejectTask(new Error(`${label}超过 ${ms}ms 未完成`)), ms)
    timer.unref?.()
    task.then(
      value => { clearTimeout(timer); resolveTask(value) },
      error => { clearTimeout(timer); rejectTask(error) },
    )
  })
}
export const petRoutes: FastifyPluginAsync<{ assistant: Assistant; port: number }> = async (app, { assistant, port }) => {
  if (process.env.WORKBENCH_DISABLE_PET === '1') return
  const home = process.env.WORKBENCH_DATA_DIR || resolve(dirname(fileURLToPath(import.meta.url)), '../../data')
  process.env.WORKBENCH_PET_HOME = join(home, 'pet')
  const existingElectron = join(homedir(), '.dsh/electron', process.platform === 'win32' ? 'electron.exe' : 'electron')
  if (!process.env.DSH_PET_ELECTRON_PATH && existsSync(existingElectron)) process.env.DSH_PET_ELECTRON_PATH = existingElectron
  const loadRuntime = async (): Promise<PetRuntime> => {
    const { mountPetHost } = await import(new URL('../../../vendor/dsh-pet/lib/workbench-host.mjs', import.meta.url).href)
    const runtime = mountPetHost({
      key: assistant.readKey,
      config: assistant.config,
      chat: async (text: string, persona: string, messages: { role: string; content: { type: string; text: string }[] }[]) => {
        const history = messages.slice(0, -1).map(message => ({ role: message.role, content: message.content.filter(block => block.type === 'text').map(block => block.text).join('') }))
        const imageGuide = messages.at(-1)?.content.filter(block => block.type === 'text').map(block => block.text).join('').slice(text.length) ?? ''
        return (await assistant.chat(text, { path: '/desktop-pet' }, persona + imageGuide, history)).answer
      },
      whisper: assistant.whisper,
      pending: () => { const turn = assistant.state().pending; return turn ? { id: turn.id, answer: turn.answer } : null },
      review: assistant.finish,
    }, port)
    return runtime
  }

  let runtime: PetRuntime
  try {
    runtime = await withTimeout(loadRuntime(), MOUNT_TIMEOUT_MS, '桌宠运行时挂载')
  } catch (error) {
    console.warn(`[pet] 桌宠未启动，后端继续启动：${(error as Error).message}。（WORKBENCH_DISABLE_PET=1 可关闭桌宠，WORKBENCH_PET_MOUNT_TIMEOUT_MS 可调时限）`)
    return
  }

  assistant.setStatusListener(runtime.status)
  if (assistant.state().pending) runtime.status('waiting', '有一批修改待确认')
  app.addHook('onClose', async () => { assistant.setStatusListener(() => {}); await runtime.dispose() })
  app.route({
    method: ['GET', 'POST', 'PUT', 'DELETE'], url: '/dsh-pet-7340/*',
    handler: async (req, reply) => {
      const route = runtime.routes.find(route => req.url.startsWith(route.path))
      if (!route) return reply.code(404).send({ message: '桌宠接口不存在' })
      const body = req.body === undefined ? undefined : Buffer.from(JSON.stringify(req.body))
      const raw = Object.assign(Readable.from(body ? [body] : []), { url: req.url, method: req.method, headers: req.headers }) as IncomingMessage
      reply.hijack()
      await route.handler(raw, reply.raw)
    },
  })
}
