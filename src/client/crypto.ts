export interface Entry {
  id: string
  site: string
  origins?: string[]
  label: string
  username: string
  password: string
  totp?: string
  notes?: string
  tags?: string[]
  createdAt: number
  updatedAt: number
  lastUsedAt?: number
  useCount: number
  /** The account used by default for this site unless the user names another. */
  primary?: boolean
}

export interface Box {
  iv: string
  ct: string
}

export interface VaultBlob {
  version: 1
  kdf: { salt: string; iterations: number; hash: string }
  keyring: Box
  browser: Box
}

export interface Keyring {
  browserKey: string
  connectorKey: string
}

export interface UnlockedVault {
  blob: VaultBlob
  browserKey: CryptoKey
  connectorKey: CryptoKey
  keyring: Keyring
  entries: Entry[]
}

const ITERATIONS = 600000
const encoder = new TextEncoder()
const decoder = new TextDecoder()

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index])
  return btoa(binary)
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  return bytes
}

export function randomId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `id-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`
  }
}

async function deriveMasterKey(password: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

async function importAesKey(raw: Uint8Array, extractable = false): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', extractable, ['encrypt', 'decrypt'])
}

async function encryptJson(key: CryptoKey, value: unknown): Promise<Box> {
  const iv = randomBytes(12)
  const plaintext = encoder.encode(JSON.stringify(value))
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext)
  return { iv: toBase64(iv), ct: toBase64(new Uint8Array(ciphertext)) }
}

async function decryptJson<T>(key: CryptoKey, box: Box): Promise<T> {
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(box.iv) },
    key,
    fromBase64(box.ct),
  )
  return JSON.parse(decoder.decode(plaintext)) as T
}

export function isWebCryptoAvailable(): boolean {
  return typeof crypto !== 'undefined' && typeof crypto.subtle !== 'undefined'
}

export async function createVault(password: string): Promise<UnlockedVault> {
  const salt = randomBytes(16)
  const masterKey = await deriveMasterKey(password, salt, ITERATIONS)
  const browserRaw = randomBytes(32)
  const connectorRaw = randomBytes(32)
  const browserKey = await importAesKey(browserRaw, true)
  const connectorKey = await importAesKey(connectorRaw, true)
  const keyring: Keyring = {
    browserKey: toBase64(browserRaw),
    connectorKey: toBase64(connectorRaw),
  }
  const blob: VaultBlob = {
    version: 1,
    kdf: { salt: toBase64(salt), iterations: ITERATIONS, hash: 'SHA-256' },
    keyring: await encryptJson(masterKey, keyring),
    browser: await encryptJson(browserKey, { version: 1, entries: [] }),
  }
  return { blob, browserKey, connectorKey, keyring, entries: [] }
}

export async function unlockVault(blob: VaultBlob, password: string): Promise<UnlockedVault> {
  const masterKey = await deriveMasterKey(password, fromBase64(blob.kdf.salt), blob.kdf.iterations || ITERATIONS)
  const keyring = await decryptJson<Keyring>(masterKey, blob.keyring)
  const browserKey = await importAesKey(fromBase64(keyring.browserKey), true)
  const connectorKey = await importAesKey(fromBase64(keyring.connectorKey), true)
  const payload = await decryptJson<{ version: number; entries: Entry[] }>(browserKey, blob.browser)
  return { blob, browserKey, connectorKey, keyring, entries: Array.isArray(payload.entries) ? payload.entries : [] }
}

export async function sealBrowser(browserKey: CryptoKey, entries: Entry[]): Promise<Box> {
  return encryptJson(browserKey, { version: 1, entries })
}

export async function exportConnectorKey(connectorKey: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey('raw', connectorKey)
  return toBase64(new Uint8Array(raw))
}

export interface PassphraseBox {
  kdf: { salt: string; iterations: number; hash: string }
  iv: string
  ct: string
}

export async function encryptWithPassphrase(value: unknown, passphrase: string): Promise<PassphraseBox> {
  const salt = randomBytes(16)
  const key = await deriveMasterKey(passphrase, salt, ITERATIONS)
  const box = await encryptJson(key, value)
  return {
    kdf: { salt: toBase64(salt), iterations: ITERATIONS, hash: 'SHA-256' },
    ...box,
  }
}

export async function decryptWithPassphrase<T>(box: PassphraseBox, passphrase: string): Promise<T> {
  const key = await deriveMasterKey(passphrase, fromBase64(box.kdf.salt), box.kdf.iterations || ITERATIONS)
  return decryptJson<T>(key, { iv: box.iv, ct: box.ct })
}

export async function changeVaultPassword(blob: VaultBlob, oldPassword: string, newPassword: string): Promise<VaultBlob> {
  const oldKey = await deriveMasterKey(oldPassword, fromBase64(blob.kdf.salt), blob.kdf.iterations || ITERATIONS)
  const keyring = await decryptJson<Keyring>(oldKey, blob.keyring)
  const salt = randomBytes(16)
  const newKey = await deriveMasterKey(newPassword, salt, ITERATIONS)
  return {
    ...blob,
    kdf: { salt: toBase64(salt), iterations: ITERATIONS, hash: 'SHA-256' },
    keyring: await encryptJson(newKey, keyring),
  }
}

export async function exportKeyRaw(key: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey('raw', key)
  return toBase64(new Uint8Array(raw))
}

export async function importVaultKeys(browserKey: string, connectorKey: string): Promise<{ browserKey: CryptoKey; connectorKey: CryptoKey }> {
  return {
    browserKey: await importAesKey(fromBase64(browserKey), false),
    connectorKey: await importAesKey(fromBase64(connectorKey), true),
  }
}

export async function openBrowserWithKey(blob: VaultBlob, browserKey: CryptoKey): Promise<Entry[]> {
  const payload = await decryptJson<{ version: number; entries: Entry[] }>(browserKey, blob.browser)
  return Array.isArray(payload.entries) ? payload.entries : []
}
