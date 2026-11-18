// Verifies the connector write gate end to end: read actions run without asking,
// a rejected approval blocks the write, and an approved write really executes.
// Everything runs against a throwaway DSH_HOME so the real connector vault is
// never touched.
// Run: node tests/approval.check.mjs

import { build } from 'esbuild'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'

const root = path.resolve(import.meta.dirname, '..')
const failures = []
const home = await mkdtemp(path.join(tmpdir(), 'dsh-access-approval-'))
process.env.DSH_HOME = home

function check(name, condition, detail = '') {
  if (condition) {
    console.log(`ok   ${name}`)
    return
  }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
  console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`)
}

async function loadRuntime() {
  const dir = await mkdtemp(path.join(root, '.tmp-approval-'))
  const outfile = path.join(dir, 'runtime.mjs')
  const entry = [
    "import * as vault from './src/host/connectors/vault.ts'",
    "import * as runtime from './src/host/connectors/runtime.ts'",
    'export { vault, runtime }',
  ].join('\n')
  await build({
    stdin: { contents: entry, resolveDir: root, loader: 'ts', sourcefile: 'approval-entry.ts' },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    outfile,
    packages: 'external',
    logLevel: 'silent',
  })
  const mod = await import(new URL(`file://${outfile.replaceAll('\\', '/')}`).href)
  return { mod, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

const { mod, cleanup } = await loadRuntime()
const { vault, runtime } = mod

const restSecrets = {
  baseUrl: 'https://postman-echo.com',
  headerName: 'X-Test-Auth',
  headerValue: 'Bearer test-123',
}

const mcpSecrets = {
  transport: 'stdio',
  command: process.execPath,
  args: path.join(root, 'tests', 'fixtures', 'mcp-echo-server.mjs'),
}

try {
  check('a fresh vault starts locked', vault.hasConnectorKey() === false)
  vault.setConnectorKey(randomBytes(32).toString('base64'))
  check('setConnectorKey unlocks the vault', vault.hasConnectorKey() === true)

  const secrets = await vault.readSecrets()
  secrets['custom-rest'] = restSecrets
  secrets.mcp = mcpSecrets
  await vault.writeSecrets(secrets)

  const states = await vault.readStates()
  states.connectors['custom-rest'] = { connected: true, permissions: { read: true, write: false } }
  states.connectors.mcp = { connected: true, permissions: { read: true, write: false } }
  await vault.writeStates(states)

  let approveCalls = 0
  const allow = async () => {
    approveCalls += 1
    return true
  }
  const deny = async () => {
    approveCalls += 1
    return false
  }

  // Read action: no approval prompt at all.
  approveCalls = 0
  const read = await runtime.callConnector('custom-rest', 'get', { path: '/get?probe=approval' }, allow)
  check('read action runs without asking for approval', approveCalls === 0 && read?.result?.args?.probe === 'approval', JSON.stringify(read?.result?.args ?? null))

  // Write action, rejected.
  approveCalls = 0
  let denied = ''
  try {
    await runtime.callConnector('custom-rest', 'request', { method: 'POST', path: '/post', body: { ping: 1 } }, deny)
  } catch (error) {
    denied = error instanceof Error ? error.message : String(error)
  }
  check('a rejected approval blocks the write', approveCalls === 1 && /did not approve/i.test(denied), denied)

  // Write action, approved: it must actually execute.
  approveCalls = 0
  const written = await runtime.callConnector('custom-rest', 'request', { method: 'POST', path: '/post', body: { ping: 'approved' } }, allow)
  check('an approved write executes the request', approveCalls === 1 && written?.result?.json?.ping === 'approved', JSON.stringify(written?.result?.json ?? null))

  // MCP tool calls go through the same gate.
  approveCalls = 0
  const echoed = await runtime.callConnector('mcp', 'call_tool', { name: 'echo', arguments: { text: 'gated' } }, allow)
  check('an approved MCP tool call executes', approveCalls === 1 && echoed?.result?.content?.[0]?.text === 'gated', JSON.stringify(echoed?.result?.content ?? null))

  // Unknown action and disconnected connector both fail loudly.
  let unknown = ''
  try {
    await runtime.callConnector('custom-rest', 'nope', {}, allow)
  } catch (error) {
    unknown = error instanceof Error ? error.message : String(error)
  }
  check('an unknown action names the available ones', /available/i.test(unknown), unknown)

  const states2 = await vault.readStates()
  delete states2.connectors.mcp
  await vault.writeStates(states2)
  let offline = ''
  try {
    await runtime.callConnector('mcp', 'list_tools', {}, allow)
  } catch (error) {
    offline = error instanceof Error ? error.message : String(error)
  }
  check('a disconnected connector is refused', /not connected/i.test(offline), offline)
} finally {
  await cleanup()
  await rm(home, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed`)
  process.exit(1)
}
console.log('\nall approval checks passed')
