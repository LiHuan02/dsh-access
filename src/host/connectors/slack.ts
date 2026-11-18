import type { ConnectorDefinition } from './types.js'
import { requireField } from './types.js'

const BASE = 'https://slack.com/api'

async function call(secrets: any, method: string, path: string, body?: any): Promise<any> {
  const token = String(secrets?.token ?? '').trim()
  if (token === '') throw new Error('Slack bot token is missing. Connect Slack in Settings → Access.')
  const response = await fetch(`${BASE}/${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`Slack ${response.status}: ${text.slice(0, 300)}`)
  const data = JSON.parse(text)
  if (data?.ok !== true) throw new Error(`Slack error: ${data?.error ?? 'unknown'}`)
  return data
}

function limit(args: any): number {
  return Math.min(Math.max(Number(args?.limit) || 20, 1), 100)
}

export const slack: ConnectorDefinition = {
  id: 'slack',
  name: 'Slack',
  description: 'List channels and users, read channel history and post messages with a bot token.',
  auth: {
    kind: 'api-key',
    fields: [
      { key: 'token', label: 'Bot token', secret: true, required: true, placeholder: 'xoxb-…' },
    ],
  },
  actions: [
    {
      id: 'list_channels',
      name: 'List channels',
      description: 'List public and private channels the bot can see.',
      mode: 'read',
      parameters: { limit: { type: 'number', description: '1–100, default 20.' } },
      run: (secrets, args) => call(secrets, 'GET', `conversations.list?types=public_channel,private_channel&limit=${limit(args)}`),
    },
    {
      id: 'list_users',
      name: 'List users',
      description: 'List workspace users.',
      mode: 'read',
      parameters: { limit: { type: 'number' } },
      run: (secrets, args) => call(secrets, 'GET', `users.list?limit=${limit(args)}`),
    },
    {
      id: 'read_history',
      name: 'Read channel history',
      description: 'Read the most recent messages in a channel.',
      mode: 'read',
      parameters: {
        channel: { type: 'string', required: true },
        limit: { type: 'number' },
      },
      run: (secrets, args) => call(secrets, 'GET', `conversations.history?channel=${encodeURIComponent(requireField(args, 'channel'))}&limit=${limit(args)}`),
    },
    {
      id: 'post_message',
      name: 'Post message',
      description: 'Post a message to a channel. This writes and requires user approval.',
      mode: 'write',
      parameters: {
        channel: { type: 'string', required: true },
        text: { type: 'string', required: true },
      },
      run: (secrets, args) => call(secrets, 'POST', 'chat.postMessage', {
        channel: requireField(args, 'channel'),
        text: requireField(args, 'text'),
      }),
    },
  ],
  async test(secrets) {
    const result = await call(secrets, 'GET', 'auth.test')
    return { ok: true, detail: `Signed in as ${result?.user ?? 'unknown'}${result?.team ? ` @ ${result.team}` : ''}.` }
  },
}
