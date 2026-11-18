/**
 * The plugin entry, loaded the way the Harness loads it.
 *
 * Every other suite exercises a piece in isolation; this one runs `apply` with a
 * stand-in context and checks what actually reaches the Harness: the tool names,
 * their schemas, the prompt section, and that a missing service degrades instead
 * of throwing. It is the check that fails when a tool definition or a slot
 * registration is malformed — the class of bug that takes the whole plugin down
 * on activation.
 *
 *   node tests/plugin-load.check.mjs
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'

// Built inside the project so @deepseek-ai/* resolves from its node_modules.
const work = '.tmp-plugin-load'
await rm(work, { recursive: true, force: true })
await mkdir(work, { recursive: true })

// A throwaway DSH_HOME: activation touches the audit log and the connector vault.
process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'dsh-access-load-home-'))

await build({
  entryPoints: ['src/host/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: '.tmp-plugin-load/host.mjs',
  external: ['@deepseek-ai/*', 'node:*', 'imapflow', 'nodemailer', 'mailparser', '@modelcontextprotocol/sdk', '@modelcontextprotocol/sdk/*'],
  logLevel: 'silent',
})

const plugin = await import('../.tmp-plugin-load/host.mjs')

let failed = 0
function check(ok, label, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && detail !== '' ? ` — ${detail}` : ''}`)
  if (!ok) failed += 1
}

/** Just enough Harness to activate: a tools service and an effect registrar. */
function fakeContext() {
  const tools = new Map()
  const promptSections = []
  const disposers = []
  const service = {
    register(definition) {
      if (typeof definition?.name !== 'string' || definition.name === '') throw new Error('a tool without a name')
      if (tools.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`)
      tools.set(definition.name, definition)
      return () => tools.delete(definition.name)
    },
    get(name) {
      return tools.get(name)
    },
    list() {
      return [...tools.values()]
    },
  }
  const ctx = {
    effect(body, label) {
      const disposer = typeof body === 'function' ? body() : undefined
      if (typeof disposer === 'function') disposers.push(disposer)
      return () => {
        if (typeof disposer === 'function') disposer()
      }
    },
    on() {
      return () => undefined
    },
    inject(names, callback) {
      // The web server is the only injection target; leaving it out is exactly
      // the "service missing" case the compatibility layer has to survive.
      return () => undefined
    },
    get(name) {
      if (name === 'tools') return service
      if (name === 'systemPrompt') {
        return { section: (section) => { promptSections.push(section); return () => undefined } }
      }
      return undefined
    },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  }
  return { ctx, service, promptSections, disposers }
}

const { ctx, service, promptSections } = fakeContext()
let activationError
try {
  plugin.apply(ctx, {})
} catch (error) {
  activationError = error
}
check(activationError === undefined, 'apply completes without a missing service taking the plugin down', activationError instanceof Error ? activationError.message : String(activationError ?? ''))

const names = service.list().map((tool) => tool.name)
const expected = [
  'access_status',
  'access_sites',
  'access_page_state',
  'access_credential_card',
  'access_login',
  'access_request_status',
  'access_autofill',
  'access_connectors',
  'access_connector_call',
  'access_install_browser_bridge',
  'access_browser_open',
  'access_browser_snapshot',
  'access_browser_read',
  'access_browser_click',
  'access_browser_type',
  'access_browser_key',
  'access_browser_scroll',
  'access_browser_action',
  'access_browser_file',
  'access_browser_view',
  'access_browser_tabs',
  'access_browser_screenshot',
  'access_browser_do',
]
const missing = expected.filter((name) => !names.includes(name))
check(missing.length === 0, 'every documented tool is registered', missing.join(', '))
const extras = names.filter((name) => !expected.includes(name))
check(extras.length === 0, 'no undocumented tool is registered', `extra: ${extras.join(', ')}`)

// Every tool must describe its input and its output: a malformed schema fails
// activation in a real Harness, and an undeclared output field breaks the reply.
const malformed = []
for (const tool of service.list()) {
  if (typeof tool.description !== 'string' || tool.description.length < 20) malformed.push(`${tool.name}: description`)
  if (typeof tool.execute !== 'function') malformed.push(`${tool.name}: execute`)
  if (tool.parameters !== undefined && typeof tool.parameters !== 'object') malformed.push(`${tool.name}: parameters`)
  const schema = tool.output?.schema
  if (schema === undefined) malformed.push(`${tool.name}: output schema`)
  else if (schema.type !== 'object' || schema.additionalProperties !== false) malformed.push(`${tool.name}: output schema shape`)
}
check(malformed.length === 0, 'every tool has a description, an executor and a closed output schema', malformed.join('; '))

const prompt = promptSections.find((section) => section?.name === 'access:browser-and-credentials')
check(prompt !== undefined, 'the browser/credential prompt section is registered')
const promptText = typeof prompt?.text === 'function' ? prompt.text({}) : ''
check(typeof promptText === 'string' && promptText.includes('access_browser_do'), 'the prompt tells the model to batch a flow')
check(typeof promptText === 'string' && !/dsh_browser_\*/.test(promptText.replace(/third-party dsh_browser_\*/, '')), 'the prompt no longer sends the model to the third-party toolset')

await rm(work, { recursive: true, force: true })

if (failed > 0) {
  console.error(`\n${failed} plugin load check(s) failed`)
  process.exit(1)
}
console.log('\nall plugin load checks passed')
