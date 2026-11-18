export interface ConnectorInfo {
  id: string
  name: string
  description: string
  auth: {
    kind: string
    fields: Array<{ key: string; label: string; secret?: boolean; required?: boolean; placeholder?: string }>
    presets?: Record<string, any>
  }
  actions: Array<{ id: string; name: string; description: string; mode: string }>
  connected: boolean
  permissions: { read: boolean; write: boolean }
  lastUsedAt?: number | null
  locked: boolean
}

async function request(path: string, init?: RequestInit): Promise<any> {
  const response = await fetch(new URL(path, document.baseURI), {
    cache: 'no-store',
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok || data?.ok === false) throw new Error(data?.error ?? `HTTP ${response.status}`)
  return data
}

export async function listConnectors(): Promise<ConnectorInfo[]> {
  const data = await request('dsh-access/api/connectors')
  return Array.isArray(data?.connectors) ? data.connectors : []
}

export async function connectConnector(id: string, fields: Record<string, any>): Promise<any> {
  return request('dsh-access/api/connectors', {
    method: 'POST',
    body: JSON.stringify({ action: 'connect', id, fields }),
  })
}

export async function disconnectConnector(id: string): Promise<any> {
  return request('dsh-access/api/connectors', {
    method: 'POST',
    body: JSON.stringify({ action: 'disconnect', id }),
  })
}

export async function testConnector(id: string): Promise<any> {
  return request('dsh-access/api/connectors', {
    method: 'POST',
    body: JSON.stringify({ action: 'test', id }),
  })
}

export async function startOAuth(id: string, fields: Record<string, any>): Promise<any> {
  return request('dsh-access/api/connectors/oauth/start', {
    method: 'POST',
    body: JSON.stringify({ id, fields }),
  })
}

export async function pollOAuth(flowId: string): Promise<any> {
  return request('dsh-access/api/connectors/oauth/poll', {
    method: 'POST',
    body: JSON.stringify({ flowId }),
  })
}
