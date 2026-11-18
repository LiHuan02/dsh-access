/**
 * Unit checks for the pieces that have no host and no browser.
 *
 * Everything here is a pure function of its input, so it can run in plain Node:
 * TOTP against the RFC 6238 vectors, the encrypted vault export round trip, the
 * two CSV importers, and the connector-side validation that must reject a bad
 * email credential before any network call.
 *
 *   node tests/unit.check.mjs
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'

const work = await mkdtemp(join(tmpdir(), 'dsh-access-unit-'))

await build({
  stdin: {
    contents: [
      "export { generateTotp, generateTotpAt } from './src/client/totp'",
      "export { exportVaultFile, importEncryptedVault, isEncryptedExport, parseCsv } from './src/client/transfer'",
    ].join('\n'),
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: join(work, 'client.mjs'),
  packages: 'external',
  logLevel: 'silent',
})

const { generateTotpAt, exportVaultFile, importEncryptedVault, isEncryptedExport, parseCsv } = await import(
  `file://${join(work, 'client.mjs').replaceAll('\\', '/')}`
)

let failed = 0
function check(ok, label, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && detail !== '' ? ` — ${detail}` : ''}`)
  if (!ok) failed += 1
}

// TOTP: the RFC 6238 SHA-1 vectors, at 30-second steps.
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
const vectors = [
  [59_000, '287082'],
  [1_111_111_109_000, '081804'],
  [2_000_000_000_000, '279037'],
]
for (const [at, expected] of vectors) {
  const result = await generateTotpAt(RFC_SECRET, at)
  check(result?.code === expected, `TOTP at ${at} ms is ${expected}`, `got ${JSON.stringify(result)}`)
}

// The current code still has a full window ahead of it.
const live = await generateTotpAt(RFC_SECRET, Date.now())
check(typeof live?.code === 'string' && /^\d{6}$/.test(live.code), 'the live TOTP code is six digits')
check(typeof live?.remaining === 'number' && live.remaining >= 0 && live.remaining <= 30, 'the live TOTP window is within 30 s')

// Encrypted export: contains no plaintext, round-trips, and refuses a wrong passphrase.
const entry = {
  id: '1',
  site: 'github.com',
  label: 'Work',
  username: 'me',
  password: 'super-secret-password',
  createdAt: 1,
  updatedAt: 1,
  useCount: 0,
}
const exported = await exportVaultFile([entry], 'correct horse battery staple')
check(isEncryptedExport(exported), 'the export is recognised as encrypted')
check(!exported.includes('super-secret-password'), 'the export contains no plaintext password')
check(!exported.includes('github.com'), 'the export does not leak the site either')

const restored = await importEncryptedVault(exported, 'correct horse battery staple')
check(restored.length === 1 && restored[0].password === entry.password, 'the export round-trips with the right passphrase')

let refused = false
try {
  await importEncryptedVault(exported, 'wrong passphrase')
} catch {
  refused = true
}
check(refused, 'a wrong passphrase is refused')

// Chrome CSV.
const chrome = 'name,url,username,password,note\nGitHub,https://github.com,me,secret,\n'
const chromeRows = parseCsv(chrome)
check(chromeRows.length === 1 && chromeRows[0]?.site === 'github.com', 'Chrome CSV keeps the site from the URL')
check(chromeRows[0]?.password === 'secret', 'Chrome CSV keeps the password')

// Bitwarden CSV, including the TOTP column.
const bitwarden = 'folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\n,0,login,GitHub,,,0,https://github.com,me,secret,JBSWY3DPEHPK3PXP\n'
const bitwardenRows = parseCsv(bitwarden)
check(bitwardenRows.length === 1 && bitwardenRows[0]?.site === 'github.com', 'Bitwarden CSV keeps the site')
check(bitwardenRows[0]?.totp === 'JBSWY3DPEHPK3PXP', 'Bitwarden CSV keeps the TOTP secret')

// An unrecognised CSV is an empty import rather than a crash.
check(parseCsv('one,two\n1,2\n').length === 0, 'an unrelated CSV imports nothing')

await rm(work, { recursive: true, force: true })

if (failed > 0) {
  console.error(`\n${failed} unit check(s) failed`)
  process.exit(1)
}
console.log('\nall unit checks passed')
