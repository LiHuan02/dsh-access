import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { ConnectorDefinition } from './types.js'
import { requireField } from './types.js'

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo'
const SCOPES = 'https://mail.google.com/ https://www.googleapis.com/auth/userinfo.email'

/**
 * Built-in Google OAuth client for the packaged build.
 *
 * A Google "Desktop app" client's secret is not confidential — PKCE protects the
 * exchange — but it is still a credential, so it does not live in the public
 * repository. `scripts/build.mjs` injects the pair from a gitignored
 * `secrets.local.json` when one is present, which is how the published package
 * ships a zero-config sign-in. A plain source build leaves both empty and the
 * connector asks for the user's own client instead; both fields stay overridable
 * in the connector form either way.
 */
const BUILTIN_CLIENT_ID = process.env.DSH_ACCESS_GMAIL_CLIENT_ID ?? ''
const BUILTIN_CLIENT_SECRET = process.env.DSH_ACCESS_GMAIL_CLIENT_SECRET ?? ''

export interface GmailFlow {
  flowId: string
  clientId: string
  clientSecret: string
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

function html(res: any, status: number, message: string): void {
  res.statusCode = status
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.end(`<!doctype html><meta charset="utf-8"><title>Gmail</title><body style="font-family:system-ui;padding:32px"><h2>${message}</h2><p>You can close this window and return to DSH.</p></body>`)
}

export async function startGmailFlow(clientId: string, clientSecret: string, emailHint = ''): Promise<GmailFlow> {
  const resolvedId = clientId || BUILTIN_CLIENT_ID
  const resolvedSecret = clientSecret || BUILTIN_CLIENT_SECRET
  if (resolvedId === '' || resolvedSecret === '') throw new Error('Google OAuth client ID and client secret are required.')
  const state = base64url(randomBytes(24))
  const codeVerifier = base64url(randomBytes(48))
  const codeChallenge = base64url(createHash('sha256').update(codeVerifier).digest())

  let flow: GmailFlow
  const server = createServer(async (req: any, res: any) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== '/oauth2callback') {
        html(res, 404, 'Not found')
        return
      }
      if (url.searchParams.get('state') !== flow.state) {
        flow.error = 'Google sign-in state mismatch. Start again.'
        html(res, 400, 'Sign-in failed: state mismatch.')
        return
      }
      const error = url.searchParams.get('error')
      if (error) {
        flow.error = `Google sign-in failed: ${url.searchParams.get('error_description') ?? error}`
        html(res, 400, 'Sign-in was cancelled or failed.')
        return
      }
      const code = url.searchParams.get('code')
      if (!code) {
        flow.error = 'Google did not return an authorization code.'
        html(res, 400, 'Sign-in failed: no code.')
        return
      }
      const { data } = await formRequest(TOKEN_URL, {
        grant_type: 'authorization_code',
        client_id: flow.clientId,
        client_secret: flow.clientSecret,
        code,
        redirect_uri: flow.redirectUri,
        code_verifier: flow.codeVerifier,
      })
      if (!data?.access_token) {
        flow.error = `Google token exchange failed: ${data?.error_description ?? data?.error ?? 'no access token'}`
        html(res, 400, 'Sign-in failed: token exchange.')
        return
      }
      const userinfo = await fetch(USERINFO_URL, {
        headers: { authorization: `Bearer ${data.access_token}` },
        signal: AbortSignal.timeout(15000),
      }).then((response) => response.json()).catch(() => ({}))
      flow.result = {
        clientId: flow.clientId,
        clientSecret: flow.clientSecret,
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000,
        email: String(userinfo?.email ?? emailHint ?? ''),
      }
      html(res, 200, 'Gmail connected.')
    } catch (error) {
      flow.error = error instanceof Error ? error.message : String(error)
      try {
        html(res, 500, 'Sign-in failed.')
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
  const redirectUri = `http://127.0.0.1:${port}/oauth2callback`
  const params = new URLSearchParams({
    client_id: resolvedId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  })
  if (emailHint) params.set('login_hint', emailHint)

  flow = {
    flowId: '',
    clientId: resolvedId,
    clientSecret: resolvedSecret,
    state,
    codeVerifier,
    redirectUri,
    authUrl: `${AUTH_URL}?${params.toString()}`,
    expiresAt: Date.now() + 5 * 60 * 1000,
    server,
  }
  const timer = setTimeout(() => {
    if (!flow.result && !flow.error) flow.error = 'The Google sign-in timed out. Start again.'
    try {
      server.close()
    } catch {
      // ignore
    }
  }, 5 * 60 * 1000)
  server.once('close', () => clearTimeout(timer))
  return flow
}

export async function pollGmailFlow(flow: GmailFlow): Promise<{ pending: boolean; secrets?: any }> {
  if (flow.error) throw new Error(flow.error)
  if (flow.result) return { pending: false, secrets: flow.result }
  if (Date.now() > flow.expiresAt) throw new Error('The Google sign-in expired. Start again.')
  return { pending: true }
}

async function ensureGmailToken(secrets: any): Promise<any> {
  const current = secrets ?? {}
  if (current.accessToken && Number(current.expiresAt) > Date.now() + 60_000) return current
  if (!current.refreshToken || !current.clientId || !current.clientSecret) throw new Error('Gmail is not signed in. Connect it in Settings → Access.')
  const { data } = await formRequest(TOKEN_URL, {
    grant_type: 'refresh_token',
    client_id: current.clientId,
    client_secret: current.clientSecret,
    refresh_token: current.refreshToken,
  })
  if (!data?.access_token) throw new Error(`Gmail token refresh failed: ${data?.error_description ?? data?.error ?? 'no access token'}`)
  return {
    ...current,
    accessToken: data.access_token,
    expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000,
  }
}

async function withGmailImap(secrets: any, fn: (client: any, current: any) => Promise<any>): Promise<any> {
  const current = await ensureGmailToken(secrets)
  const { ImapFlow } = await import('imapflow') as any
  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: current.email, accessToken: current.accessToken },
    logger: false,
    tls: { rejectUnauthorized: true },
    connectionTimeout: 20000,
    greetingTimeout: 15000,
    socketTimeout: 60000,
  })
  try {
    await client.connect()
    return await fn(client, current)
  } finally {
    try {
      await client.logout()
    } catch {
      // ignore
    }
  }
}

async function recentMessages(client: any, mailbox: string, limit: number): Promise<any[]> {
  await client.mailboxOpen(mailbox)
  const exists = Number(client.mailbox?.exists ?? 0)
  if (exists === 0) return []
  const start = Math.max(1, exists - limit + 1)
  const messages: any[] = []
  for await (const message of client.fetch(`${start}:*`, { envelope: true, flags: true, uid: true })) {
    messages.push({
      uid: message.uid,
      subject: message.envelope?.subject ?? '',
      from: (message.envelope?.from ?? []).map((item: any) => item.address).filter(Boolean).join(', '),
      date: message.envelope?.date?.toISOString?.() ?? '',
      seen: message.flags?.has?.('\\Seen') === true,
    })
  }
  return messages.reverse()
}

export const gmail: ConnectorDefinition = {
  id: 'gmail',
  name: 'Gmail',
  description: 'Sign in with Google OAuth and read/send Gmail. No app password.',
  auth: {
    kind: 'oauth-loopback',
    fields: [
      { key: 'clientId', label: 'Google OAuth client ID (optional override)', required: false, placeholder: 'built-in client is used when empty' },
      { key: 'clientSecret', label: 'Google OAuth client secret (optional override)', secret: true, required: false },
      { key: 'email', label: 'Gmail address (optional login hint)', placeholder: 'you@gmail.com' },
    ],
  },
  actions: [
    {
      id: 'list_mailboxes',
      name: 'List mailboxes',
      description: 'List folders in the mailbox.',
      mode: 'read',
      parameters: {},
      run: (secrets) => withGmailImap(secrets, async (client) => {
        const list = await client.list()
        return list.map((item: any) => ({ path: item.path, name: item.name, specialUse: item.specialUse ?? null }))
      }),
    },
    {
      id: 'list_messages',
      name: 'List recent messages',
      description: 'List the most recent messages in a mailbox (newest first).',
      mode: 'read',
      parameters: {
        mailbox: { type: 'string', description: 'Mailbox path, default INBOX.' },
        limit: { type: 'number', description: '1–50, default 20.' },
      },
      run: (secrets, args) => withGmailImap(secrets, async (client) => {
        const mailbox = String(args?.mailbox || 'INBOX')
        const limit = Math.min(Math.max(Number(args?.limit) || 20, 1), 50)
        return { mailbox, messages: await recentMessages(client, mailbox, limit) }
      }),
    },
    {
      id: 'search_messages',
      name: 'Search messages',
      description: 'Search the most recent 100 messages by subject or sender.',
      mode: 'read',
      parameters: {
        query: { type: 'string', required: true },
        mailbox: { type: 'string' },
        limit: { type: 'number' },
      },
      run: (secrets, args) => withGmailImap(secrets, async (client) => {
        const mailbox = String(args?.mailbox || 'INBOX')
        const query = String(requireField(args, 'query')).toLowerCase()
        const limit = Math.min(Math.max(Number(args?.limit) || 20, 1), 50)
        const messages = await recentMessages(client, mailbox, 100)
        return {
          mailbox,
          messages: messages.filter((message) => message.subject.toLowerCase().includes(query) || message.from.toLowerCase().includes(query)).slice(0, limit),
        }
      }),
    },
    {
      id: 'read_message',
      name: 'Read a message',
      description: 'Read one message by UID, returning its text and attachment metadata.',
      mode: 'read',
      parameters: {
        uid: { type: 'number', required: true },
        mailbox: { type: 'string' },
      },
      run: (secrets, args) => withGmailImap(secrets, async (client) => {
        const mailbox = String(args?.mailbox || 'INBOX')
        const uid = requireField(args, 'uid')
        await client.mailboxOpen(mailbox)
        const message = await client.fetchOne(String(uid), { source: true, envelope: true }, { uid: true })
        if (!message?.source) throw new Error('Message not found.')
        const { simpleParser } = await import('mailparser') as any
        const parsed = await simpleParser(message.source)
        return {
          uid,
          subject: parsed.subject ?? '',
          from: parsed.from?.text ?? '',
          to: parsed.to?.text ?? '',
          date: parsed.date?.toISOString?.() ?? '',
          text: String(parsed.text ?? '').slice(0, 20000),
          attachments: (parsed.attachments ?? []).map((item: any) => ({
            filename: item.filename ?? '',
            contentType: item.contentType ?? '',
            size: item.size ?? 0,
          })),
        }
      }),
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
        bcc: { type: 'string' },
      },
      run: async (secrets, args) => {
        const current = await ensureGmailToken(secrets)
        const nodemailer = (await import('nodemailer') as any).default
        const transport = nodemailer.createTransport({
          host: 'smtp.gmail.com',
          port: 465,
          secure: true,
          auth: {
            type: 'OAuth2',
            user: current.email,
            clientId: current.clientId,
            clientSecret: current.clientSecret,
            refreshToken: current.refreshToken,
            accessToken: current.accessToken,
          },
          connectionTimeout: 20000,
          greetingTimeout: 15000,
          socketTimeout: 60000,
        })
        const info = await transport.sendMail({
          from: current.email,
          to: requireField(args, 'to'),
          cc: typeof args?.cc === 'string' ? args.cc : undefined,
          bcc: typeof args?.bcc === 'string' ? args.bcc : undefined,
          subject: requireField(args, 'subject'),
          text: String(args?.text ?? ''),
        })
        return { messageId: info.messageId, accepted: info.accepted, rejected: info.rejected }
      },
    },
  ],
  prepare: ensureGmailToken,
  async test(secrets) {
    const list = await withGmailImap(secrets, async (client) => client.list())
    return { ok: true, detail: `${list.length} folder(s) available.` }
  },
}
