/**
 * The desktop bridge client, against a fake bridge.
 *
 * The real thing lives in the DSH desktop shell, so this test speaks the wire
 * protocol to a socket of its own: token on every request, newline-delimited
 * JSON, answers in the order the questions were asked. The parts worth pinning
 * down are the ones a live bridge cannot show on demand — ordering under two
 * calls in flight, a refusal, a timeout, and a dead socket.
 *
 *   node tests/bridge.check.mjs
 */

import { createServer } from 'node:net'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'

const work = await mkdtemp(join(tmpdir(), 'dsh-access-bridge-'))

await build({
  stdin: { contents: "export { BridgeConnection, SidebarPage, setPanelMounter } from './src/host/sidebar-cdp.ts'", resolveDir: process.cwd(), loader: 'ts' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: join(work, 'bridge.mjs'),
  packages: 'external',
  logLevel: 'silent',
})

const { BridgeConnection, SidebarPage, setPanelMounter } = await import(`file://${join(work, 'bridge.mjs').replaceAll('\\', '/')}`)

let failed = 0
function check(ok, label) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`)
  if (!ok) failed += 1
}

/** A bridge that answers with `handler`, recording what it received. */
async function fakeBridge(handler) {
  const received = []
  const server = createServer((socket) => {
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
        if (line.trim() === '') continue
        const request = JSON.parse(line)
        received.push(request)
        const answer = handler(request, received.length)
        if (answer !== undefined) socket.write(`${JSON.stringify(answer)}\n`)
      }
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const endpoint = join(work, `bridge-${server.address().port}.json`)
  await writeFile(endpoint, JSON.stringify({ port: server.address().port, token: 'test-token', pid: process.pid }))
  return { endpoint, received, close: () => new Promise((resolve) => server.close(resolve)) }
}

// 1. A missing endpoint file is "no bridge", not an error.
check(await BridgeConnection.open(join(work, 'absent.json')) === undefined, 'a missing endpoint file means no bridge')

// 2. Every request carries the token, and answers arrive in order.
{
  const bridge = await fakeBridge((request, index) => (request.op === 'version' ? { ok: true, protocol: 3, seq: index } : { ok: true, echo: request.url }))
  const connection = await BridgeConnection.open(bridge.endpoint)
  check(connection !== undefined, 'the client connects to a published endpoint')
  const first = await connection.call('version', {})
  const second = await connection.call('ensureSidebar', { url: 'https://example.com' })
  check(first?.protocol === 3 && first?.seq === 1, 'the first answer belongs to the first request')
  check(second?.echo === 'https://example.com', 'the second answer carries the second request')
  check(bridge.received.every((request) => request.token === 'test-token'), 'every request carries the token')
  connection.close()
  await bridge.close()
}

// 3. Two calls in flight keep their own answers.
{
  const bridge = await fakeBridge((request) => ({ ok: true, echo: request.op }))
  const connection = await BridgeConnection.open(bridge.endpoint)
  const answers = await Promise.all([connection.call('list', {}), connection.call('cdp', {}), connection.call('closePage', {})])
  check(answers[0]?.echo === 'list' && answers[1]?.echo === 'cdp' && answers[2]?.echo === 'closePage', 'concurrent calls are matched by order, not by id')
  connection.close()
  await bridge.close()
}

// 4. A bad token is a restart, said plainly.
{
  const bridge = await fakeBridge(() => ({ ok: false, error: 'bad token' }))
  const connection = await BridgeConnection.open(bridge.endpoint)
  let message = ''
  try {
    await connection.call('version', {})
  } catch (error) {
    message = error instanceof Error ? error.message : String(error)
  }
  check(/token/.test(message), 'a refused token reports a restart instead of hanging')
  check(connection.alive === false, 'a refused token marks the connection dead')
  connection.close()
  await bridge.close()
}

// 5. No answer within the budget is a timeout, not a hang.
{
  const bridge = await fakeBridge(() => undefined)
  const connection = await BridgeConnection.open(bridge.endpoint)
  const started = Date.now()
  let message = ''
  try {
    await connection.call('list', {}, 300)
  } catch (error) {
    message = error instanceof Error ? error.message : String(error)
  }
  check(/timed out/.test(message), 'a silent bridge times out with the operation named')
  check(Date.now() - started < 3000, 'the timeout fires close to its budget')
  connection.close()
  await bridge.close()
}

// 6. A page needs an id, and says so when the bridge answers without one.
{
  const bridge = await fakeBridge(() => ({ ok: true }))
  const connection = await BridgeConnection.open(bridge.endpoint)
  const page = new SidebarPage(connection, 'session-test')
  let message = ''
  try {
    await page.ensure()
  } catch (error) {
    message = error instanceof Error ? error.message : String(error)
  }
  check(/no browser page/.test(message), 'a page-less answer is an error the caller can read')
  connection.close()
  await bridge.close()
}

// 7. A page the plugin's own panel refuses is still driveable when the shell
//    already shows one: the conversation's webviews are found through `list`.
{
  const bridge = await fakeBridge((request) => (request.op === 'ensureSidebar'
    ? { ok: false, error: 'this conversation\'s browser panel produced no page within its budget' }
    : { ok: true, sidebar: [{ id: 9, type: 'webview', url: 'https://example.org/' }] }))
  const connection = await BridgeConnection.open(bridge.endpoint)
  const page = new SidebarPage(connection, 'session-test')
  let message = ''
  let id
  try {
    id = await page.ensure('https://example.org')
  } catch (error) {
    message = error instanceof Error ? error.message : String(error)
  }
  check(id === 9, 'a refused panel falls back to the conversation\'s existing page', message)
  connection.close()
  await bridge.close()
}

// 8. With nothing on screen, the renderer is asked to open the tab, then the
//    page is picked up on the next look.
{
  let listed = 0
  let mounted = ''
  setPanelMounter(async (owner, url) => {
    mounted = `${owner} ${url}`
  })
  const bridge = await fakeBridge((request) => {
    if (request.op === 'ensureSidebar') return { ok: false, error: 'not displayed' }
    listed += 1
    return listed < 2 ? { ok: true, sidebar: [] } : { ok: true, sidebar: [{ id: 4, type: 'webview', url: 'https://example.net/' }] }
  })
  const connection = await BridgeConnection.open(bridge.endpoint)
  const page = new SidebarPage(connection, 'session-abc')
  let message = ''
  let id
  try {
    id = await page.ensure('https://example.net')
  } catch (error) {
    message = error instanceof Error ? error.message : String(error)
  }
  check(id === 4, 'an empty sidebar is filled by asking the renderer, then picked up', message)
  check(mounted === 'session-abc https://example.net', 'the mounter is told which conversation and address to open', mounted)
  setPanelMounter(undefined)
  connection.close()
  await bridge.close()
}

// 9. A conversation with no page and no mounter says what to do, not just "failed".
{
  const bridge = await fakeBridge((request) => (request.op === 'ensureSidebar'
    ? { ok: false, error: 'not displayed' }
    : { ok: true, sidebar: [] }))
  const connection = await BridgeConnection.open(bridge.endpoint)
  const page = new SidebarPage(connection, 'session-empty')
  let message = ''
  try {
    await page.ensure()
  } catch (error) {
    message = error instanceof Error ? error.message : String(error)
  }
  check(/Browser tab/.test(message), 'an empty conversation names the Browser tab as the fix', message)
  connection.close()
  await bridge.close()
}

// 10. A page the shell stopped rendering keeps answering `list` while every CDP
//     command hangs; it must be closed and replaced instead of timing the tool out.
{
  let closed = 0
  let fresh = false
  const bridge = await fakeBridge((request) => {
    if (request.op === 'ensureSidebar') return fresh ? { ok: true, id: 7, created: true } : { ok: false, error: 'not displayed' }
    if (request.op === 'list') return { ok: true, sidebar: [{ id: 5, type: 'webview', url: 'https://example.org/' }] }
    if (request.op === 'closePage') {
      closed += 1
      fresh = true
      return { ok: true, closed: 1 }
    }
    // The frozen page never answers; the fresh one does.
    if (request.op === 'cdp') return request.id === 5 ? undefined : { ok: true, result: { result: { value: 1 } } }
    return { ok: true }
  })
  const connection = await BridgeConnection.open(bridge.endpoint)
  const page = new SidebarPage(connection, 'session-frozen')
  let message = ''
  let id
  try {
    id = await page.ensure('https://example.org')
  } catch (error) {
    message = error instanceof Error ? error.message : String(error)
  }
  check(id === 7, 'a frozen page is replaced by a fresh one', message)
  check(closed === 1, 'the frozen page is closed before the replacement', String(closed))
  connection.close()
  await bridge.close()
}

await rm(work, { recursive: true, force: true })

if (failed > 0) {
  console.error(`\n${failed} bridge check(s) failed`)
  process.exit(1)
}
console.log('\nall bridge checks passed')
