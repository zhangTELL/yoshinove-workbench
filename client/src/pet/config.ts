import type { FontConfig, ModelSelection, Pet, PhysicsParams } from '../../../vendor/dsh-pet/src/shared/types'

export interface PetSettingsConfig {
  pets: Pet[]
  notificationsEnabled: boolean
  whisperImageEnabled: boolean
  chatImageEnabled: boolean
  confineToScreen: boolean
  font: FontConfig
  physics: PhysicsParams
  whisperModel: ModelSelection
  chatModel: ModelSelection
  chatMemoryRounds: number
  chatImageLimit: number
}
export type PetConfig = Record<string, PetSettingsConfig & Record<string, unknown>>
export interface PetConfigMeta {
  user: string
  default: string
  animations: string
  memes: string
  storage: { key: string; path: string; exists: boolean }[]
}

// 只提交设置页支持的字段，其余动画、提示词等高级配置由后端原样保留。
export function editablePetConfig(main: PetSettingsConfig): PetSettingsConfig {
  return JSON.parse(JSON.stringify({
    pets: main.pets,
    notificationsEnabled: main.notificationsEnabled,
    whisperImageEnabled: main.whisperImageEnabled,
    chatImageEnabled: main.chatImageEnabled,
    confineToScreen: main.confineToScreen,
    font: main.font,
    physics: main.physics,
    whisperModel: main.whisperModel,
    chatModel: main.chatModel,
    chatMemoryRounds: main.chatMemoryRounds,
    chatImageLimit: main.chatImageLimit,
  })) as PetSettingsConfig
}
