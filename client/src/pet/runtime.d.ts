export function mountPet(element: HTMLElement): () => void
export function reloadPetConfig(config: Record<string, Record<string, unknown>>): void
export function requestPetNotificationPermission(): Promise<{ ok: boolean; reason?: string }>
