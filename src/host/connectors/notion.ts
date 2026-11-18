import type { ConnectorDefinition } from './types.js'
import { requireField } from './types.js'

const BASE = 'https://api.notion.com/v1'

async function call(secrets: any, method: string, path: string, body?: any): Promise<any> {
  const token = String(secrets?.token ?? '').trim()
  if (token === '') throw new Error('Notion integration token is missing. Connect Notion in Settings → Access.')
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    'notion-version': '2022-06-28',
    'content-type': 'application/json',
  }
  const response = await fetch(BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`Notion ${response.status}: ${text.slice(0, 300)}`)
  return text === '' ? {} : JSON.parse(text)
}

function pageSize(args: any): number {
  return Math.min(Math.max(Number(args?.page_size) || 20, 1), 100)
}

export const notion: ConnectorDefinition = {
  id: 'notion',
  name: 'Notion',
  description: 'Search pages and databases, read pages, query databases and append blocks with an internal integration token.',
  auth: {
    kind: 'api-key',
    fields: [
      { key: 'token', label: 'Internal integration token', secret: true, required: true, placeholder: 'ntn_… or secret_…' },
    ],
  },
  actions: [
    {
      id: 'search',
      name: 'Search',
      description: 'Search pages and databases shared with the integration.',
      mode: 'read',
      parameters: {
        query: { type: 'string' },
        page_size: { type: 'number', description: '1–100, default 20.' },
      },
      run: (secrets, args) => call(secrets, 'POST', '/search', {
        query: typeof args?.query === 'string' ? args.query : '',
        page_size: pageSize(args),
      }),
    },
    {
      id: 'get_page',
      name: 'Get page',
      description: 'Read one page by id.',
      mode: 'read',
      parameters: { page_id: { type: 'string', required: true } },
      run: (secrets, args) => call(secrets, 'GET', `/pages/${encodeURIComponent(requireField(args, 'page_id'))}`),
    },
    {
      id: 'get_database',
      name: 'Get database',
      description: 'Read a database schema by id.',
      mode: 'read',
      parameters: { database_id: { type: 'string', required: true } },
      run: (secrets, args) => call(secrets, 'GET', `/databases/${encodeURIComponent(requireField(args, 'database_id'))}`),
    },
    {
      id: 'query_database',
      name: 'Query database',
      description: 'Query a database, returning up to page_size rows.',
      mode: 'read',
      parameters: {
        database_id: { type: 'string', required: true },
        page_size: { type: 'number' },
      },
      run: (secrets, args) => call(secrets, 'POST', `/databases/${encodeURIComponent(requireField(args, 'database_id'))}/query`, {
        page_size: pageSize(args),
      }),
    },
    {
      id: 'append_blocks',
      name: 'Append blocks',
      description: 'Append Notion block objects to a page or block. This writes and requires user approval.',
      mode: 'write',
      parameters: {
        block_id: { type: 'string', required: true },
        children: { type: 'json', required: true, description: 'Array of Notion block objects.' },
      },
      run: (secrets, args) => {
        const children = args?.children
        if (!Array.isArray(children) || children.length === 0) throw new Error('children must be a non-empty array of Notion blocks.')
        return call(secrets, 'PATCH', `/blocks/${encodeURIComponent(requireField(args, 'block_id'))}/children`, { children })
      },
    },
  ],
  async test(secrets) {
    const result = await call(secrets, 'POST', '/search', { page_size: 1 })
    return { ok: true, detail: `Notion API reachable (${Array.isArray(result?.results) ? result.results.length : 0} result(s)).` }
  },
}
