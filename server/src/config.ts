import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 默认数据目录与源码/构建目录关联，不随启动时的工作目录改变。 */
export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(serverDir, env.WORKBENCH_DATA_DIR?.trim() || 'data')
}

export function resolveTyporaThemesDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, userHome = homedir()): string {
  if (env.WORKBENCH_TYPORA_THEMES_DIR?.trim()) return path.resolve(env.WORKBENCH_TYPORA_THEMES_DIR.trim())
  const paths = platform === 'win32' ? path.win32 : path.posix
  if (platform === 'win32') return paths.join(env.APPDATA || paths.join(userHome, 'AppData', 'Roaming'), 'Typora', 'themes')
  if (platform === 'darwin') return paths.join(userHome, 'Library', 'Application Support', 'abnerworks.Typora', 'themes')
  return paths.join(env.XDG_CONFIG_HOME || paths.join(userHome, '.config'), 'Typora', 'themes')
}

export function configuredPort(value: string | undefined, fallback: number): number {
  const port = value === undefined || value === '' ? fallback : Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('服务端口必须是 1 到 65535 之间的整数')
  return port
}

export const webPort = configuredPort(process.env.WORKBENCH_WEB_PORT ?? process.env.WORKBENCH_HTTP_PORT, 5173)
export const apiPort = configuredPort(process.env.PORT, 5175)
