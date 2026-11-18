import type { ConnectorDefinition } from './types.js'
import { requireField } from './types.js'

const BASE = 'https://api.github.com'

async function call(secrets: any, method: string, path: string, body?: any): Promise<any> {
  const token = String(secrets?.token ?? '').trim()
  if (token === '') throw new Error('GitHub token is missing. Connect GitHub in Settings → Access.')
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'dsh-access',
  }
  if (body !== undefined) headers['content-type'] = 'application/json'
  const response = await fetch(BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`GitHub ${response.status}: ${text.slice(0, 300)}`)
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text.slice(0, 4000) }
  }
}

function pageSize(args: any): number {
  return Math.min(Math.max(Number(args?.per_page) || 30, 1), 100)
}

export const github: ConnectorDefinition = {
  id: 'github',
  name: 'GitHub',
  description: 'Read repositories, issues and pull requests, and create issues with a personal access token.',
  auth: {
    kind: 'api-key',
    fields: [
      { key: 'token', label: 'Personal access token', secret: true, required: true, placeholder: 'ghp_… or github_pat_…' },
    ],
  },
  actions: [
    {
      id: 'get_user',
      name: 'Get authenticated user',
      description: 'Return the GitHub user that owns the token.',
      mode: 'read',
      parameters: {},
      run: (secrets) => call(secrets, 'GET', '/user'),
    },
    {
      id: 'list_repos',
      name: 'List repositories',
      description: 'List repositories the user can access, most recently updated first.',
      mode: 'read',
      parameters: { per_page: { type: 'number', description: '1–100, default 30.' } },
      run: (secrets, args) => call(secrets, 'GET', `/user/repos?per_page=${pageSize(args)}&sort=updated`),
    },
    {
      id: 'list_issues',
      name: 'List issues',
      description: 'List issues in a repository.',
      mode: 'read',
      parameters: {
        owner: { type: 'string', required: true },
        repo: { type: 'string', required: true },
        state: { type: 'string', description: 'open, closed, or all.' },
        per_page: { type: 'number' },
      },
      run: (secrets, args) => call(secrets, 'GET', `/repos/${requireField(args, 'owner')}/${requireField(args, 'repo')}/issues?state=${encodeURIComponent(String(args?.state ?? 'open'))}&per_page=${pageSize(args)}`),
    },
    {
      id: 'get_issue',
      name: 'Get issue',
      description: 'Read one issue by number.',
      mode: 'read',
      parameters: {
        owner: { type: 'string', required: true },
        repo: { type: 'string', required: true },
        number: { type: 'number', required: true },
      },
      run: (secrets, args) => call(secrets, 'GET', `/repos/${requireField(args, 'owner')}/${requireField(args, 'repo')}/issues/${requireField(args, 'number')}`),
    },
    {
      id: 'list_pulls',
      name: 'List pull requests',
      description: 'List pull requests in a repository.',
      mode: 'read',
      parameters: {
        owner: { type: 'string', required: true },
        repo: { type: 'string', required: true },
        state: { type: 'string', description: 'open, closed, or all.' },
        per_page: { type: 'number' },
      },
      run: (secrets, args) => call(secrets, 'GET', `/repos/${requireField(args, 'owner')}/${requireField(args, 'repo')}/pulls?state=${encodeURIComponent(String(args?.state ?? 'open'))}&per_page=${pageSize(args)}`),
    },
    {
      id: 'get_pull',
      name: 'Get pull request',
      description: 'Read one pull request by number.',
      mode: 'read',
      parameters: {
        owner: { type: 'string', required: true },
        repo: { type: 'string', required: true },
        number: { type: 'number', required: true },
      },
      run: (secrets, args) => call(secrets, 'GET', `/repos/${requireField(args, 'owner')}/${requireField(args, 'repo')}/pulls/${requireField(args, 'number')}`),
    },
    {
      id: 'create_issue',
      name: 'Create issue',
      description: 'Create an issue in a repository. This writes to GitHub and requires user approval.',
      mode: 'write',
      parameters: {
        owner: { type: 'string', required: true },
        repo: { type: 'string', required: true },
        title: { type: 'string', required: true },
        body: { type: 'string' },
      },
      run: (secrets, args) => call(secrets, 'POST', `/repos/${requireField(args, 'owner')}/${requireField(args, 'repo')}/issues`, {
        title: requireField(args, 'title'),
        body: typeof args?.body === 'string' ? args.body : '',
      }),
    },
  ],
  async test(secrets) {
    const user = await call(secrets, 'GET', '/user')
    return { ok: true, detail: `Signed in as ${user?.login ?? 'unknown'}` }
  },
}
