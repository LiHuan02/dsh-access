import { decryptWithPassphrase, encryptWithPassphrase, type Entry } from './crypto'
import { hostOf } from './match'

export interface ImportEntry {
  site: string
  label?: string
  username: string
  password: string
  notes?: string
  totp?: string
}

export async function exportVaultFile(entries: Entry[], passphrase: string): Promise<string> {
  const box = await encryptWithPassphrase({
    version: 1,
    exportedAt: new Date().toISOString(),
    entries,
  }, passphrase)
  return JSON.stringify({ format: 'dsh-access-export', version: 1, ...box }, null, 2)
}

export function isEncryptedExport(text: string): boolean {
  try {
    return JSON.parse(text)?.format === 'dsh-access-export'
  } catch {
    return false
  }
}

export async function importEncryptedVault(text: string, passphrase: string): Promise<ImportEntry[]> {
  const parsed = JSON.parse(text)
  if (parsed?.format !== 'dsh-access-export') throw new Error('This is not a dsh-access export file.')
  const payload = await decryptWithPassphrase<{ entries?: ImportEntry[] }>(parsed, passphrase)
  if (!Array.isArray(payload?.entries)) throw new Error('The export contains no credential entries.')
  return payload.entries
}

export function parseCsv(text: string): ImportEntry[] {
  const rows = parseCsvRows(text)
  if (rows.length === 0) return []
  const header = rows[0].map((value) => value.trim().toLowerCase())
  const find = (names: string[]): number => {
    for (const name of names) {
      const index = header.indexOf(name)
      if (index >= 0) return index
    }
    return -1
  }
  const nameIndex = find(['name', 'title'])
  const urlIndex = find(['url', 'login_uri', 'website'])
  const userIndex = find(['username', 'login_username'])
  const passwordIndex = find(['password', 'login_password'])
  const notesIndex = find(['note', 'notes'])
  const totpIndex = find(['totp', 'login_totp'])
  const entries: ImportEntry[] = []
  for (const row of rows.slice(1)) {
    const password = passwordIndex >= 0 ? (row[passwordIndex] ?? '') : ''
    const url = urlIndex >= 0 ? (row[urlIndex] ?? '') : ''
    if (password === '' || url === '') continue
    entries.push({
      site: hostOf(url),
      label: (nameIndex >= 0 ? (row[nameIndex] ?? '') : '') || hostOf(url),
      username: userIndex >= 0 ? (row[userIndex] ?? '') : '',
      password,
      notes: notesIndex >= 0 ? (row[notesIndex] ?? '') : undefined,
      totp: totpIndex >= 0 ? (row[totpIndex] || undefined) : undefined,
    })
  }
  return entries
}

function parseCsvRows(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"'
          index += 1
        } else {
          quoted = false
        }
      } else {
        field += char
      }
    } else if (char === '"') {
      quoted = true
    } else if (char === ',') {
      row.push(field)
      field = ''
    } else if (char === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else if (char !== '\r') {
      field += char
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((item) => item.length > 1 || (item[0] ?? '').trim() !== '')
}

export function downloadText(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.rel = 'noopener'
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
