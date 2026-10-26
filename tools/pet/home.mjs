import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const here = dirname(fileURLToPath(import.meta.url))
// 源文件位于 tools/pet；构建后此 shim 被合并到 vendor/dsh-pet/lib。
const sourceLayout = basename(here) === 'pet' && basename(dirname(here)) === 'tools'
const root = resolve(here, sourceLayout ? '../..' : '../../..')
export function resolveDshHome() {
  return process.env.WORKBENCH_PET_HOME || resolve(root, 'server', process.env.WORKBENCH_DATA_DIR?.trim() || 'data', 'pet')
}
