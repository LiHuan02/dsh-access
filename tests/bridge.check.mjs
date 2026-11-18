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
  stdin: { contents: "export { BridgeConnection, SidebarPage } from './src/host/sidebar-cdp.ts'", resolveDir: process.cwd(), loader: 'ts' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: join(work, 'bridge.mjs'),
  packages: 'external',
  logLevel: 'silent',
})

const { BridgeConnection, SidebarPage } = await import(`file://${join(work, 'bridge.mjs').replaceAll('\\', '/')}`)

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

await rm(work, { recursive: true, force: true })

if (failed > 0) {
  console.error(`\n${failed} bridge check(s) failed`)
  process.exit(1)
}
console.log('\nall bridge checks passed')
