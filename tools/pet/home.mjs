import { resolve } from 'node:path'
export function resolveDshHome() {
  return process.env.WORKBENCH_PET_HOME || resolve('server/data/pet')
}
