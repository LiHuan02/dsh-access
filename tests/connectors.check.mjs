// Exercises the connector definitions directly, including the write actions that
// the agent-facing tool cannot reach while write approval is auto-rejected.
// Run: node tests/connectors.check.mjs

import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'

const root = path.resolve(import.meta.dirname, '..')
const failures = []

function check(name, condition, detail = '') {
  if (condition) {
    console.log(`ok   ${name}`)
    return
  }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
  console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`)
}

async function loadConnectors() {
  // The bundle has to live inside the project so that external packages such as
  // @modelcontextprotocol/sdk still resolve to node_modules from the output path.
  const dir = await mkdtemp(path.join(root, '.tmp-connectors-'))
  const outfile = path.join(dir, 'connectors.mjs')
  const entry = [
    "import { customRest } from './src/host/connectors/custom-rest.ts'",
    "import { mcp } from './src/host/connectors/mcp.ts'",
    'export { customRest, mcp }',
  ].join('\n')
  await build({
    stdin: { contents: entry, resolveDir: root, loader: 'ts', sourcefile: 'connectors-entry.ts' },
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

const { mod, cleanup } = await loadConnectors()
const { customRest, mcp } = mod

function action(connector, id) {
  const found = connector.actions.find((entry) => entry.id === id)
  if (!found) throw new Error(`missing action ${connector.id}.${id}`)
  return found
}

try {
  // Custom REST — read and write both go through the same request() helper.
  const read = await action(customRest, 'get').run(restSecrets, { path: '/get?probe=write-test' })
  check('custom-rest GET returns the echoed query', read?.args?.probe === 'write-test', JSON.stringify(read?.args ?? null))
  check(
    'custom-rest GET sends the configured auth header',
    read?.headers?.['x-test-auth'] === 'Bearer test-123',
    JSON.stringify(read?.headers ?? null),
  )

  const write = await action(customRest, 'request').run(restSecrets, {
    method: 'post',
    path: '/post',
    body: { ping: 'dsh-access', nested: { ok: true } },
  })
  check('custom-rest POST serializes the JSON body', write?.json?.ping === 'dsh-access', JSON.stringify(write?.json ?? null))
  check('custom-rest normalizes the method to upper case', write?.json?.nested?.ok === true)

  let restError = ''
  try {
    await action(customRest, 'get').run(restSecrets, { path: '/status/404' })
  } catch (error) {
    restError = error instanceof Error ? error.message : String(error)
  }
  check('custom-rest surfaces a non-2xx status', restError.startsWith('HTTP 404'), restError)

  // MCP — list/call against the local stdio fixture server.
  const tools = await action(mcp, 'list_tools').run(mcpSecrets, {})
  check('mcp lists the fixture tools', Array.isArray(tools) && tools.length === 2, JSON.stringify(tools?.map?.((t) => t.name)))

  const echoed = await action(mcp, 'call_tool').run(mcpSecrets, { name: 'echo', arguments: { text: 'round-trip' } })
  check('mcp call_tool round-trips arguments', echoed?.content?.[0]?.text === 'round-trip', JSON.stringify(echoed?.content ?? null))

  const summed = await action(mcp, 'call_tool').run(mcpSecrets, { name: 'add', arguments: { a: 2, b: 40 } })
  check('mcp call_tool returns computed content', summed?.content?.[0]?.text === '42', JSON.stringify(summed?.content ?? null))

  const mcpTest = await mcp.test(mcpSecrets)
  check('mcp test() connects and counts tools', mcpTest?.ok === true && /2 tool/.test(mcpTest?.detail ?? ''), JSON.stringify(mcpTest))

  let mcpError = ''
  try {
    await mcp.test({ transport: 'stdio', command: path.join(root, 'tests', 'fixtures', 'does-not-exist.mjs') })
  } catch (error) {
    mcpError = error instanceof Error ? error.message : String(error)
  }
  check('mcp reports a failed stdio launch', mcpError.length > 0, mcpError)
} finally {
  await cleanup()
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed`)
  process.exit(1)
}
console.log('\nall connector checks passed')
