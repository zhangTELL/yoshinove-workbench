import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { resolveDataDir } from '../config.js'
import { redactDebugValue, redactSensitiveError } from './outbound.js'
import { profileAddressSecrets } from './profileAddress.js'

const PREFIX = 'wb-secret:v1:'
const SERVICE = 'zhangTELL.yoshinove-workbench'
const require = createRequire(import.meta.url)
const cachedKeys = new Map<string, Buffer>()
export const SECRET_SETTING_KEYS = new Set(['chaoxing.cookie', 'notification.pushplusToken', 'assistant.deepseekKey'])

function credentialError(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 503, code: 'CREDENTIAL_STORE_UNAVAILABLE' })
}

function masterKey(): Buffer {
  const configured = process.env.WORKBENCH_SECRET_KEY?.trim()
  if (configured) {
    const key = Buffer.from(configured, 'base64')
    if (key.length !== 32 || key.toString('base64') !== configured) throw credentialError('WORKBENCH_SECRET_KEY 必须为 32 字节随机密钥的 Base64 编码')
    return key
  }
  const directory = resolveDataDir()
  const cached = cachedKeys.get(directory)
  if (cached) return cached
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const identityFile = join(directory, 'credentials.json')
    if (!existsSync(identityFile)) {
      try { writeFileSync(identityFile, JSON.stringify({ version: 1, id: randomUUID() }), { flag: 'wx', mode: 0o600 }) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    }
    const identity = JSON.parse(readFileSync(identityFile, 'utf8')) as { version?: unknown; id?: unknown }
    if (identity.version !== 1 || typeof identity.id !== 'string' || !/^[0-9a-f-]{36}$/.test(identity.id)) throw new Error('凭据标识无效')
    const { Entry } = require('@napi-rs/keyring') as {
      Entry: new (service: string, user: string, options: { linux: { store: string } }) => { getPassword(): string | null; setPassword(value: string): void }
    }
    // Linux 明确要求 Secret Service，禁止自动退到不持久的内存存储。
    const entry = new Entry(SERVICE, identity.id, { linux: { store: 'secret-service' } })
    let encoded = entry.getPassword()
    if (!encoded) {
      encoded = randomBytes(32).toString('base64')
      entry.setPassword(encoded)
    }
    const key = Buffer.from(encoded, 'base64')
    if (key.length !== 32) throw new Error('系统凭据库中的密钥无效')
    cachedKeys.set(directory, key)
    return key
  } catch {
    throw credentialError('无法访问系统凭据库，请解锁当前账户的凭据库；无桌面环境可配置 WORKBENCH_SECRET_KEY，不会降级为明文保存')
  }
}

export function isEncryptedSecret(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(PREFIX)
}

export function sealSecret(value: string): string {
  if (!value) return value
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', masterKey(), iv)
  cipher.setAAD(Buffer.from(PREFIX))
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64')
}

export function openSecret(value: string): string {
  if (!isEncryptedSecret(value)) {
    if (value.startsWith('wb-secret:')) throw credentialError('凭据加密格式不受支持，请使用兼容版本或重新填写凭据')
    return value
  }
  try {
    const bytes = Buffer.from(value.slice(PREFIX.length), 'base64')
    if (bytes.length <= 28) throw new Error('加密凭据不完整')
    const decipher = createDecipheriv('aes-256-gcm', masterKey(), bytes.subarray(0, 12))
    decipher.setAAD(Buffer.from(PREFIX))
    decipher.setAuthTag(bytes.subarray(12, 28))
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8')
  } catch (error) {
    if ((error as { code?: string }).code === 'CREDENTIAL_STORE_UNAVAILABLE') throw error
    throw credentialError('当前账户无法解密此凭据，请重新填写；复制数据目录不会同时迁移系统凭据库中的密钥')
  }
}

export function maskStoredSecret(value: string): string {
  if (!value) return ''
  try {
    const secret = openSecret(value)
    return secret.length > 8 ? '••••' + secret.slice(-4) : '••••••'
  } catch { return '••••（需重新填写）' }
}

export function parseStoredSetting(raw: string): unknown {
  try { return JSON.parse(raw) } catch { return raw }
}

export function encodeSettingValue(key: string, value: unknown, preserveStoredCiphertext = false): string {
  const protect = (secret: string) => preserveStoredCiphertext && isEncryptedSecret(secret) ? secret : sealSecret(secret)
  if (SECRET_SETTING_KEYS.has(key)) {
    if (typeof value !== 'string') throw Object.assign(new Error('凭据设置必须是字符串'), { statusCode: 400 })
    return JSON.stringify(protect(value))
  }
  if (key === 'notification.wecom') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Object.assign(new Error('企业微信设置格式无效'), { statusCode: 400 })
    const copy = { ...(value as Record<string, unknown>) }
    if (Object.keys(copy).some(field => ['__proto__', 'constructor', 'prototype'].includes(field))) throw Object.assign(new Error('企业微信设置包含不允许的字段'), { statusCode: 400 })
    if (copy.secret !== undefined) {
      if (typeof copy.secret !== 'string') throw Object.assign(new Error('企业微信 Secret 必须是字符串'), { statusCode: 400 })
      copy.secret = protect(copy.secret)
    }
    return JSON.stringify(copy)
  }
  return JSON.stringify(value)
}

export function decodeSettingValue(key: string, raw: string): unknown {
  const value = parseStoredSetting(raw)
  if (SECRET_SETTING_KEYS.has(key) && typeof value === 'string') return openSecret(value)
  if (key === 'notification.wecom' && value && typeof value === 'object' && !Array.isArray(value)) {
    const copy = { ...(value as Record<string, unknown>) }
    if (typeof copy.secret === 'string') copy.secret = openSecret(copy.secret)
    return copy
  }
  return value
}

export function readSetting<T>(database: Database.Database, key: string, fallback: T): T {
  const row = database.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
  if (!row) return fallback
  return decodeSettingValue(key, row.value) as T
}

/** 只迁移已登记的凭据列；不创建明文备份，也不更改业务记录。 */
export function migrateCredentials(database: Database.Database): number {
  database.pragma('secure_delete = ON')
  let changed = 0
  database.transaction(() => {
    const settings = database.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[]
    const updateSetting = database.prepare('UPDATE settings SET value = ? WHERE key = ?')
    for (const row of settings) {
      if (!SECRET_SETTING_KEYS.has(row.key) && row.key !== 'notification.wecom') continue
      let value = parseStoredSetting(row.value)
      // 旧版通用设置允许空值或无效类型，迁移时按未配置处理，不能阻断启动。
      if (SECRET_SETTING_KEYS.has(row.key) && typeof value !== 'string') value = ''
      if (row.key === 'notification.wecom') {
        if (!value || typeof value !== 'object' || Array.isArray(value)) value = {}
        else {
          value = { ...(value as Record<string, unknown>) }
          const item = value as Record<string, unknown>
          if (item.secret !== undefined && typeof item.secret !== 'string') item.secret = ''
        }
      }
      const next = encodeSettingValue(row.key, value, true)
      if (next !== row.value) { updateSetting.run(next, row.key); changed++ }
    }
    const profiles = database.prepare('SELECT id, api_key, api_secret, base_url, balance_path FROM model_profiles').all() as { id: number; api_key: string; api_secret: string; base_url: string; balance_path: string }[]
    const updateProfile = database.prepare('UPDATE model_profiles SET api_key = ?, api_secret = ?, base_url = ?, balance_path = ? WHERE id = ?')
    for (const row of profiles) {
      const legacySecrets = [row.api_key, row.api_secret, ...profileAddressSecrets(row.base_url), ...profileAddressSecrets(row.balance_path)].filter(value => value && !isEncryptedSecret(value))
      const key = isEncryptedSecret(row.api_key) ? row.api_key : sealSecret(row.api_key)
      const secret = isEncryptedSecret(row.api_secret) ? row.api_secret : sealSecret(row.api_secret)
      const base = profileAddressSecrets(row.base_url).length ? sealSecret(row.base_url) : row.base_url
      const balancePath = profileAddressSecrets(row.balance_path).length ? sealSecret(row.balance_path) : row.balance_path
      if (key !== row.api_key || secret !== row.api_secret || base !== row.base_url || balancePath !== row.balance_path) { updateProfile.run(key, secret, base, balancePath, row.id); changed++ }
      if (legacySecrets.length && database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'balance_snapshots'").get()) {
        const snapshots = database.prepare('SELECT id, raw, error FROM balance_snapshots WHERE profile_id = ?').all(row.id) as { id: number; raw: string; error: string }[]
        const updateSnapshot = database.prepare('UPDATE balance_snapshots SET raw = ?, error = ? WHERE id = ?')
        for (const snapshot of snapshots) {
          let raw: string
          try { raw = redactDebugValue(JSON.parse(snapshot.raw), legacySecrets) }
          catch { raw = redactSensitiveError(snapshot.raw, legacySecrets) }
          const error = redactSensitiveError(snapshot.error, legacySecrets)
          if (raw !== snapshot.raw || error !== snapshot.error) updateSnapshot.run(raw, error, snapshot.id)
        }
      }
    }
  })()
  // 将旧 WAL 帧尽可能截断；其它连接仍占用时不宣称历史副本已擦除。
  if (changed) database.pragma('wal_checkpoint(TRUNCATE)')
  return changed
}
