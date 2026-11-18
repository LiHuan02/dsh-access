import type { ConnectorDefinition } from './types.js'
import { requireField } from './types.js'

function parseJson(value: any, label: string): Record<string, string> {
  const text = String(value ?? '').trim()
  if (text === '') return {}
  try {
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    return parsed
  } catch {
    throw new Error(`${label} must be a JSON object.`)
  }
}

async function withClient(secrets: any, fn: (client: any) => Promise<any>): Promise<any> {
  const transportKind = String(secrets?.transport ?? 'stdio').trim().toLowerCase()
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js') as any
  let transport: any
  if (transportKind === 'http' || transportKind === 'streamable-http' || transportKind === 'streamablehttp') {
    const url = String(secrets?.url ?? '').trim()
    if (!/^https?:\/\//i.test(url)) throw new Error('MCP HTTP URL must be an absolute http(s) URL.')
    const headers = parseJson(secrets?.headers, 'HTTP headers')
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js') as any
    transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } })
  } else {
    const command = String(secrets?.command ?? '').trim()
    if (command === '') throw new Error('MCP stdio command is required.')
    const args = String(secrets?.args ?? '').trim() === '' ? [] : String(secrets.args).split(/\s+/).filter(Boolean)
    const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)) as Record<string, string>
    const env = { ...baseEnv, ...parseJson(secrets?.env, 'Stdio env') }
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js') as any
    transport = new StdioClientTransport({ command, args, env })
  }
  const client = new Client({ name: 'dsh-access', version: '0.1.0' }, { capabilities: {} })
  await client.connect(transport)
  try {
    return await fn(client)
  } finally {
    try {
      await client.close()
    } catch {
      // ignore
    }
  }
}

export const mcp: ConnectorDefinition = {
  id: 'mcp',
  name: 'MCP server',
  description: 'Connect any Model Context Protocol server over stdio or Streamable HTTP and list/call its tools.',
  auth: {
    kind: 'api-key',
    fields: [
      { key: 'transport', label: 'Transport (stdio or http)', required: true, placeholder: 'stdio' },
      { key: 'command', label: 'Stdio command', placeholder: 'npx' },
      { key: 'args', label: 'Stdio args', placeholder: '-y @modelcontextprotocol/server-filesystem /path' },
      { key: 'url', label: 'HTTP MCP URL', placeholder: 'https://example.com/mcp' },
      { key: 'headers', label: 'HTTP headers (JSON)', secret: true, placeholder: '{"Authorization":"Bearer …"}' },
      { key: 'env', label: 'Stdio env (JSON)', secret: true, placeholder: '{"TOKEN":"…"}' },
    ],
  },
  actions: [
    {
      id: 'list_tools',
      name: 'List MCP tools',
      description: 'Connect to the MCP server and list its tools.',
      mode: 'read',
      parameters: {},
      run: (secrets) => withClient(secrets, async (client) => {
        const result = await client.listTools()
        return (result?.tools ?? []).map((tool: any) => ({
          name: tool.name,
          description: tool.description ?? '',
          inputSchema: tool.inputSchema,
        }))
      }),
    },
    {
      id: 'call_tool',
      name: 'Call MCP tool',
      description: 'Call one MCP tool by name. This writes and requires user approval.',
      mode: 'write',
      parameters: {
        name: { type: 'string', required: true },
        arguments: { type: 'json', description: 'Tool arguments object.' },
      },
      run: (secrets, args) => withClient(secrets, (client) => client.callTool({
        name: requireField(args, 'name'),
        arguments: args?.arguments ?? {},
      })),
    },
  ],
  async test(secrets) {
    const result = await withClient(secrets, (client) => client.listTools())
    return { ok: true, detail: `${result?.tools?.length ?? 0} tool(s) available.` }
  },
}
