export type AssistantEntity = 'countdown' | 'note' | 'homework' | 'prompt' | 'score' | 'run' | 'course' | 'session'
export interface AssistantChange {
  entity: AssistantEntity
  action: 'create' | 'update' | 'delete'
  id?: number
  values?: Record<string, unknown>
}
export interface AssistantTarget {
  entity: AssistantEntity
  id: number
  label: string
  path: string
  query: Record<string, string>
}
export interface AssistantAppliedChange {
  entity: AssistantEntity
  action: AssistantChange['action']
  id: number
  label: string
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
  target: AssistantTarget
}
export interface AssistantTurn {
  id: string
  sessionId: string
  prompt: string
  answer: string
  status: 'pending' | 'confirmed' | 'undone' | 'chat'
  changes: AssistantAppliedChange[]
  createdAt: string
}
export interface AssistantState {
  sessionId: string
  sessions: AssistantSession[]
  turns: AssistantTurn[]
  pending: AssistantTurn | null
  busy: boolean
}
export interface AssistantSession {
  id: string
  title: string
  createdAt: string
}
export interface AssistantConfig {
  configured: boolean
  keyMask: string
  model: string
  modelLabel: string
  name: string
  petDoubleClick: 'dialog' | 'sidebar'
}
