import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { ConnectorDefinition } from './types.js'
import { requireField } from './types.js'

const GRAPH = 'https://graph.microsoft.com/v1.0'
const SCOPE = 'openid profile offline_access User.Read Mail.ReadWrite Mail.Send'

/** Built-in public client (device code, no secret) for dsh-access. */
const BUILTIN_CLIENT_ID = '0bfc6548-4f0f-40ff-aa18-eed77d5400b9'
// "common" accepts both personal Microsoft accounts and work/school accounts.
// The app's own directory id would reject a personal account at sign-in with
// "You don't have access to this" (AADSTS50020: the user is not in that tenant).
const BUILTIN_TENANT = 'common'

function tokenUrl(tenant: string): string {
  return `https://login.microsoftonline.com/${encodeURIComponent(tenant || 'common')}/oauth2/v2.0/token`
}

function deviceCodeUrl(tenant: string): string {
  return `https://login.microsoftonline.com/${encodeURIComponent(tenant || 'common')}/oauth2/v2.0/devicecode`
}

async function formRequest(url: string, body: Record<string, string>): Promise<{ status: number; data: any }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(25000),
  })
  const data = await response.json().catch(() => ({}))
  return { status: response.status, data }
}

export interface OutlookFlow {
  flowId: string
  clientId: string
  tenant: string
  deviceCode: string
  userCode: string
  verificationUri: string
  expiresAt: number
  interval: number
}

/**
 * Authorization-code + PKCE over a loopback redirect. The device-code flow is
 * still offered for work accounts, but a personal Microsoft account is served by
 * the MSA front end there, which hands back an opaque MSA ticket instead of an
 * AAD JWT — Graph rejects it. The interactive code flow produces a real Graph
 * token for both account kinds.
 */
export interface OutlookLoopbackFlow {
  flowId: string
  clientId: string
  tenant: string
  state: string
  codeVerifier: string
  redirectUri: string
  authUrl: string
  expiresAt: number
  server: any
  result?: any
  error?: string
}

function base64url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function callbackHtml(res: any, status: number, message: string): void {
  res.statusCode = status
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.end(`<!doctype html><meta charset="utf-8"><title>Outlook</title><body style="font-family:system-ui;padding:32px"><h2>${message}</h2><p>You can close this window and return to DSH.</p></body>`)
}

export async function startOutlookLoopback(clientId: string, tenant: string, emailHint = ''): Promise<OutlookLoopbackFlow> {
  const resolvedId = clientId || BUILTIN_CLIENT_ID
  const resolvedTenant = tenant || BUILTIN_TENANT
  const state = base64url(randomBytes(24))
  const codeVerifier = base64url(randomBytes(48))
  const codeChallenge = base64url(createHash('sha256').update(codeVerifier).digest())

  let flow: OutlookLoopbackFlow
  const server = createServer(async (req: any, res: any) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (url.pathname !== '/' && url.pathname !== '/oauth2callback') {
        callbackHtml(res, 404, 'Not found')
        return
      }
      if (url.searchParams.get('state') !== flow.state) {
        flow.error = 'Microsoft sign-in state mismatch. Start again.'
        callbackHtml(res, 400, 'Sign-in failed: state mismatch.')
        return
      }
      const error = url.searchParams.get('error')
      if (error) {
        flow.error = `Microsoft sign-in failed: ${url.searchParams.get('error_description') ?? error}`
        callbackHtml(res, 400, 'Sign-in was cancelled or failed.')
        return
      }
      const code = url.searchParams.get('code')
      if (!code) {
        flow.error = 'Microsoft did not return an authorization code.'
        callbackHtml(res, 400, 'Sign-in failed: no code.')
        return
      }
      const { data } = await formRequest(tokenUrl(flow.tenant), {
        grant_type: 'authorization_code',
        client_id: flow.clientId,
        code,
        redirect_uri: flow.redirectUri,
        code_verifier: flow.codeVerifier,
        scope: SCOPE,
      })
      if (!data?.access_token) {
        flow.error = `Microsoft token exchange failed: ${data?.error_description ?? data?.error ?? 'no access token'}`
        callbackHtml(res, 400, 'Sign-in failed: token exchange.')
        return
      }
      flow.result = {
        clientId: flow.clientId,
        tenant: flow.tenant,
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000,
      }
      callbackHtml(res, 200, 'Outlook connected.')
    } catch (err) {
      flow.error = err instanceof Error ? err.message : String(err)
      try {
        callbackHtml(res, 500, 'Sign-in failed.')
      } catch {
        // ignore
      }
    } finally {
      try {
        server.close()
      } catch {
        // ignore
      }
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const port = Number((server.address() as any)?.port)
  // Azure matches a public client's loopback redirect by host alone: the
  // registration is http://localhost, and any port is accepted, but a path is
  // not. So the callback arrives at the bare origin.
  const redirectUri = `http://localhost:${port}`
  const params = new URLSearchParams({
    client_id: resolvedId,
    response_type: 'code',
    redirect_uri: redirectUri,
    response_mode: 'query',
    scope: SCOPE,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  })
  if (emailHint) params.set('login_hint', emailHint)

  flow = {
    flowId: '',
    clientId: resolvedId,
    tenant: resolvedTenant,
    state,
    codeVerifier,
    redirectUri,
    authUrl: `https://login.microsoftonline.com/${encodeURIComponent(resolvedTenant)}/oauth2/v2.0/authorize?${params.toString()}`,
    expiresAt: Date.now() + 10 * 60 * 1000,
    server,
  }
  const timer = setTimeout(() => {
    if (!flow.result && !flow.error) flow.error = 'The Microsoft sign-in timed out. Start again.'
    try {
      server.close()
    } catch {
      // ignore
    }
  }, 10 * 60 * 1000)
  server.once('close', () => clearTimeout(timer))
  return flow
}

export async function pollOutlookLoopback(flow: OutlookLoopbackFlow): Promise<{ pending: boolean; secrets?: any }> {
  if (flow.error) throw new Error(flow.error)
  if (flow.result) return { pending: false, secrets: flow.result }
  if (Date.now() > flow.expiresAt) throw new Error('The Microsoft sign-in expired. Start again.')
  return { pending: true }
}

export async function startDeviceFlow(clientId: string, tenant: string): Promise<Omit<OutlookFlow, 'flowId'>> {
  const resolvedId = clientId || BUILTIN_CLIENT_ID
  const resolvedTenant = tenant || BUILTIN_TENANT
  const { data } = await formRequest(deviceCodeUrl(resolvedTenant), { client_id: resolvedId, scope: SCOPE })
  if (!data?.device_code) throw new Error(`Microsoft device sign-in failed: ${data?.error_description ?? data?.error ?? 'no device code'}`)
  return {
    clientId: resolvedId,
    tenant: resolvedTenant,
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri ?? 'https://microsoft.com/devicelogin',
    expiresAt: Date.now() + Number(data.expires_in || 900) * 1000,
    interval: Math.max(Number(data.interval) || 5, 5),
  }
}

export async function pollDeviceFlow(flow: OutlookFlow): Promise<{ pending: boolean; interval?: number; secrets?: any }> {
  if (Date.now() > flow.expiresAt) throw new Error('The Microsoft sign-in code expired. Start again.')
  const { data } = await formRequest(tokenUrl(flow.tenant), {
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    client_id: flow.clientId,
    device_code: flow.deviceCode,
    // Personal (MSA) accounts take the resource from the token request too; without
    // it the access token is minted for the app itself and Graph rejects it.
    scope: SCOPE,
  })
  if (data?.error === 'authorization_pending') return { pending: true }
  if (data?.error === 'slow_down') return { pending: true, interval: flow.interval + 5 }
  if (data?.error) throw new Error(`Microsoft sign-in failed: ${data?.error_description ?? data.error}`)
  if (!data?.access_token) throw new Error('Microsoft did not return an access token.')
  return {
    pending: false,
    secrets: {
      clientId: flow.clientId,
      tenant: flow.tenant,
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000,
    },
  }
}

async function ensureAccessToken(secrets: any): Promise<any> {
  const current = secrets ?? {}
  if (current.accessToken && Number(current.expiresAt) > Date.now() + 60_000) return current
  if (!current.refreshToken || !current.clientId) throw new Error('Outlook is not signed in. Connect it in Settings → Access.')
  const { data } = await formRequest(tokenUrl(current.tenant), {
    grant_type: 'refresh_token',
    client_id: current.clientId,
    refresh_token: current.refreshToken,
    scope: SCOPE,
  })
  if (!data?.access_token) throw new Error(`Outlook token refresh failed: ${data?.error_description ?? data?.error ?? 'no access token'}`)
  return {
    ...current,
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? current.refreshToken,
    expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000,
  }
}

async function graph(secrets: any, method: string, path: string, body?: any): Promise<any> {
  const response = await fetch(GRAPH + path, {
    method,
    headers: {
      authorization: `Bearer ${secrets.accessToken}`,
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(25000),
  })
  const text = await response.text()
  if (!response.ok) {
    // The token itself is never echoed; its claims are what make a 401 diagnosable.
    const summary = describeToken(secrets?.accessToken)
    if (response.status === 401 && summary === 'opaque-token') {
      throw new Error(
        'Microsoft returned an opaque MSA ticket instead of a Graph token. That happens when the app registration lives in a personal-account directory; Microsoft Graph only accepts tokens from an app registered in a work/school Azure AD tenant. Register the app there and connect with tenant "common".',
      )
    }
    throw new Error(`Graph ${response.status}: ${text.slice(0, 300)}${response.status === 401 ? ` [${summary}]` : ''}`)
  }
  return text === '' ? {} : JSON.parse(text)
}

/** Summarise a JWT's audience/scope so a rejected token explains itself. */
function describeToken(token: unknown): string {
  if (typeof token !== 'string' || token === '') return 'no-token'
  const part = token.split('.')[1]
  if (!part) return 'opaque-token'
  try {
    const json = JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
    const expiresIn = Number(json.exp) * 1000 - Date.now()
    return `aud=${json.aud ?? '?'} scp=${json.scp ?? '?'} tid=${String(json.tid ?? '').slice(0, 8)} exp=${Math.round(expiresIn / 1000)}s`
  } catch {
    return 'unreadable-token'
  }
}

function top(args: any): number {
  return Math.min(Math.max(Number(args?.top) || 20, 1), 50)
}

export const outlook: ConnectorDefinition = {
  id: 'outlook',
  name: 'Outlook / Microsoft 365',
  description: 'Read and send Outlook mail over Microsoft Graph with device-code OAuth. The built-in public client is used by default; no Azure setup is required.',
  auth: {
    kind: 'oauth-loopback',
    fields: [
      { key: 'clientId', label: 'Azure application (client) ID (optional override)', required: false, placeholder: 'built-in client is used when empty' },
      { key: 'tenant', label: 'Tenant: common, consumers, organizations or a directory ID', placeholder: 'common' },
      { key: 'email', label: 'Microsoft account (optional login hint)', placeholder: 'you@outlook.com' },
    ],
  },
  prepare: ensureAccessToken,
  actions: [
    {
      id: 'get_me',
      name: 'Get signed-in user',
      description: 'Return the Microsoft account that owns the token.',
      mode: 'read',
      parameters: {},
      run: (secrets) => graph(secrets, 'GET', '/me'),
    },
    {
      id: 'list_mailboxes',
      name: 'List mail folders',
      description: 'List Outlook mail folders.',
      mode: 'read',
      parameters: {},
      run: (secrets) => graph(secrets, 'GET', '/me/mailFolders?$top=50'),
    },
    {
      id: 'list_messages',
      name: 'List recent messages',
      description: 'List the most recent messages in the mailbox.',
      mode: 'read',
      parameters: { top: { type: 'number', description: '1–50, default 20.' } },
      run: (secrets, args) => graph(secrets, 'GET', `/me/messages?$top=${top(args)}&$select=subject,from,receivedDateTime,isRead,bodyPreview`),
    },
    {
      id: 'read_message',
      name: 'Read a message',
      description: 'Read one message by id.',
      mode: 'read',
      parameters: { id: { type: 'string', required: true } },
      run: (secrets, args) => graph(secrets, 'GET', `/me/messages/${encodeURIComponent(requireField(args, 'id'))}?$select=subject,from,toRecipients,receivedDateTime,body`),
    },
    {
      id: 'send_email',
      name: 'Send email',
      description: 'Send a plain-text email. This writes and requires user approval.',
      mode: 'write',
      parameters: {
        to: { type: 'string', required: true },
        subject: { type: 'string', required: true },
        text: { type: 'string', required: true },
        cc: { type: 'string' },
      },
      run: (secrets, args) => {
        const to = String(requireField(args, 'to')).split(',').map((address) => address.trim()).filter(Boolean)
        const cc = typeof args?.cc === 'string' ? args.cc.split(',').map((address) => address.trim()).filter(Boolean) : []
        return graph(secrets, 'POST', '/me/sendMail', {
          message: {
            subject: requireField(args, 'subject'),
            body: { contentType: 'Text', content: String(args?.text ?? '') },
            toRecipients: to.map((address) => ({ emailAddress: { address } })),
            ccRecipients: cc.map((address) => ({ emailAddress: { address } })),
          },
          saveToSentItems: true,
        })
      },
    },
  ],
  async test(secrets) {
    const prepared = await ensureAccessToken(secrets)
    const me = await graph(prepared, 'GET', '/me')
    return { ok: true, detail: `Signed in as ${me?.userPrincipalName ?? me?.mail ?? 'unknown'}.` }
  },
}


