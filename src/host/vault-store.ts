import { appendFile, copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const DIR = join(HOME, 'dsh-access')
const FILE = join(DIR, 'vault.json')
const BACKUP = join(DIR, 'vault.json.bak')
const AUDIT = join(DIR, 'audit.jsonl')

export interface StoredVault {
  revision: number
  updatedAt: number
  blob: unknown
}

let chain: Promise<unknown> = Promise.resolve()

export async function readVault(): Promise<StoredVault> {
  try {
    const parsed = JSON.parse(await readFile(FILE, 'utf8'))
    return {
      revision: Number(parsed?.revision) || 0,
      updatedAt: Number(parsed?.updatedAt) || 0,
      blob: parsed?.blob ?? null,
    }
  } catch {
    return { revision: 0, updatedAt: 0, blob: null }
  }
}

export function writeVault(blob: unknown, baseRevision: number): Promise<
  { ok: true; revision: number } | { ok: false; conflict: true; revision: number }
> {
  const run = chain.then(async () => {
    const current = await readVault()
    if (current.revision !== baseRevision) {
      return { ok: false as const, conflict: true as const, revision: current.revision }
    }
    const next: StoredVault = { revision: current.revision + 1, updatedAt: Date.now(), blob }
    await mkdir(DIR, { recursive: true })
    const temporary = `${FILE}.tmp`
    await writeFile(temporary, JSON.stringify(next), { encoding: 'utf8', mode: 0o600 })
    try {
      await copyFile(FILE, BACKUP)
    } catch {
      // No previous file on the first write.
    }
    await rename(temporary, FILE)
    return { ok: true as const, revision: next.revision }
  })
  chain = run.catch(() => undefined)
  return run
}

export async function appendAudit(event: Record<string, unknown>): Promise<void> {
  await mkdir(DIR, { recursive: true })
  await appendFile(AUDIT, `${JSON.stringify({ ts: Date.now(), ...event })}\n`, 'utf8')
}

export function vaultPath(): string {
  return FILE
}
