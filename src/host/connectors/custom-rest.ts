import type { ConnectorDefinition } from './types.js'
import { requireField } from './types.js'

function baseUrl(secrets: any): string {
  const value = String(secrets?.baseUrl ?? '').trim()
  if (!/^https?:\/\//i.test(value)) throw new Error('Base URL must be an absolute http(s) URL.')
  return value.replace(/\/+$/, '')
}

function authHeaders(secrets: any): Record<string, string> {
  const name = String(secrets?.headerName ?? '').trim() || 'Authorization'
  const value = String(secrets?.headerValue ?? '')
  return value === '' ? {} : { [name]: value }
}

async function request(secrets: any, method: string, path: string, body?: any): Promise<any> {
  const url = baseUrl(secrets) + (String(path ?? '').startsWith('/') ? String(path) : `/${String(path ?? '')}`)
  const headers: Record<string, string> = { ...authHeaders(secrets), accept: 'application/json' }
  if (body !== undefined) headers['content-type'] = 'application/json'
  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(25000),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`)
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text.slice(0, 8000) }
  }
}

export const customRest: ConnectorDefinition = {
  id: 'custom-rest',
  name: 'Custom REST',
  description: 'Call any HTTP API with a base URL and one auth header. GET is a read action; other methods require user approval.',
  auth: {
    kind: 'api-key',
    fields: [
      { key: 'baseUrl', label: 'Base URL', required: true, placeholder: 'https://api.example.com' },
      { key: 'headerName', label: 'Auth header name', placeholder: 'Authorization' },
      { key: 'headerValue', label: 'Auth header value', secret: true, required: true, placeholder: 'Bearer …' },
    ],
  },
  actions: [
    {
      id: 'get',
      name: 'GET request',
      description: 'Send a GET request to a path under the base URL.',
      mode: 'read',
      parameters: { path: { type: 'string', required: true, description: 'Path such as /v1/items?limit=10.' } },
      run: (secrets, args) => request(secrets, 'GET', requireField(args, 'path')),
    },
    {
      id: 'request',
      name: 'HTTP request',
      description: 'Send a non-GET request to a path under the base URL. This writes and requires user approval.',
      mode: 'write',
      parameters: {
        method: { type: 'string', required: true, description: 'POST, PUT, PATCH, or DELETE.' },
        path: { type: 'string', required: true },
        body: { type: 'json', description: 'JSON request body.' },
      },
      run: (secrets, args) => request(secrets, String(requireField(args, 'method')).toUpperCase(), requireField(args, 'path'), args?.body),
    },
  ],
  async test(secrets) {
    const response = await fetch(baseUrl(secrets), {
      method: 'GET',
      headers: authHeaders(secrets),
      signal: AbortSignal.timeout(15000),
    })
    if (response.status === 401 || response.status === 403) throw new Error(`Authentication failed (HTTP ${response.status}).`)
    return { ok: true, detail: `Reachable (HTTP ${response.status}).` }
  },
}
