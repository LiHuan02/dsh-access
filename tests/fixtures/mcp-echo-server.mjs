#!/usr/bin/env node
// Minimal Model Context Protocol stdio server used by the connector tests.
// Speaks newline-delimited JSON-RPC 2.0 on stdin/stdout, no SDK required.

import process from 'node:process'

const TOOLS = [
  {
    name: 'echo',
    description: 'Return the given text unchanged.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Text to echo back.' } },
      required: ['text'],
    },
  },
  {
    name: 'add',
    description: 'Add two numbers.',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
    },
  },
]

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function fail(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

process.stdin.setEncoding('utf8')
let buffer = ''
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index = buffer.indexOf('\n')
  while (index >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (line !== '') handle(line)
    index = buffer.indexOf('\n')
  }
})
process.stdin.on('end', () => process.exit(0))

function handle(line) {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  const { id, method, params } = message
  if (id === undefined || id === null) return // notification
  switch (method) {
    case 'initialize':
      reply(id, {
        protocolVersion: params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'dsh-access-echo', version: '1.0.0' },
      })
      return
    case 'ping':
      reply(id, {})
      return
    case 'tools/list':
      reply(id, { tools: TOOLS })
      return
    case 'tools/call': {
      const name = params?.name
      const args = params?.arguments ?? {}
      if (name === 'echo') {
        reply(id, { content: [{ type: 'text', text: String(args.text ?? '') }] })
        return
      }
      if (name === 'add') {
        reply(id, { content: [{ type: 'text', text: String(Number(args.a) + Number(args.b)) }] })
        return
      }
      reply(id, { content: [{ type: 'text', text: `unknown tool: ${String(name)}` }], isError: true })
      return
    }
    default:
      fail(id, -32601, `Method not found: ${String(method)}`)
  }
}
