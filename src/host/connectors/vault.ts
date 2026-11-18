import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const DIR = join(HOME, 'dsh-access')
const FILE = join(DIR, 'connectors.enc')
const STATE = join(DIR, 'connectors.json')

interface Envelope {
  version: 1
  iv: string
  tag: string
  ct: string
}

export interface ConnectorState {
  connected: boolean
  permissions: { read: boolean; write: boolean }
  lastUsedAt?: number
}

export interface ConnectorStates {
  version: 1
  connectors: Record<string, ConnectorState>
}

let key: Buffer | undefined

export function setConnectorKey(base64: string): void {
  const raw = Buffer.from(String(base64 ?? ''), 'base64')
  if (raw.length !== 32) throw new Error('Invalid connector key length.')
  key = raw
}

export function clearConnectorKey(): void {
  key = undefined
}

export async function resetConnectors(): Promise<void> {
  clearConnectorKey()
  await rm(FILE, { force: true })
  await writeStates({ version: 1, connectors: {} })
}

export function hasConnectorKey(): boolean {
  return key !== undefined
}

export async function readSecrets(): Promise<Record<string, any>> {
  if (!key) throw new Error('Unlock the Access vault first.')
  try {
    const parsed = JSON.parse(await readFile(FILE, 'utf8')) as Envelope
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(parsed.iv, 'base64'))
    decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'))
    const plaintext = Buffer.concat([decipher.update(Buffer.from(parsed.ct, 'base64')), decipher.final()])
    return JSON.parse(plaintext.toString('utf8'))
  } catch (error: any) {
    if (error?.code === 'ENOENT') return {}
    throw error
  }
}

export async function writeSecrets(secrets: Record<string, any>): Promise<void> {
  if (!key) throw new Error('Unlock the Access vault first.')
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(secrets), 'utf8')), cipher.final()])
  const envelope: Envelope = {
    version: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ct: ciphertext.toString('base64'),
  }
  await mkdir(DIR, { recursive: true })
  const temporary = `${FILE}.tmp`
  await writeFile(temporary, JSON.stringify(envelope), { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, FILE)
}

export async function readStates(): Promise<ConnectorStates> {
  try {
    const parsed = JSON.parse(await readFile(STATE, 'utf8'))
    return { version: 1, connectors: parsed?.connectors ?? {} }
  } catch {
    return { version: 1, connectors: {} }
  }
}

export async function writeStates(states: ConnectorStates): Promise<void> {
  await mkdir(DIR, { recursive: true })
  const temporary = `${STATE}.tmp`
  await writeFile(temporary, JSON.stringify(states), 'utf8')
  await rename(temporary, STATE)
}
