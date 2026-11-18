import { randomUUID } from 'node:crypto'
import { github } from './github.js'
import { notion } from './notion.js'
import { slack } from './slack.js'
import { email } from './email.js'
import { outlook, pollDeviceFlow, pollOutlookLoopback, startDeviceFlow, startOutlookLoopback, type OutlookFlow, type OutlookLoopbackFlow } from './outlook.js'
import { gmail, pollGmailFlow, startGmailFlow, type GmailFlow } from './gmail.js'
import { customRest } from './custom-rest.js'
import { mcp } from './mcp.js'
import { hasConnectorKey, readSecrets, readStates, writeSecrets, writeStates } from './vault.js'
import { redactSecrets } from './redact.js'
import type { ConnectorAction, ConnectorDefinition } from './types.js'

const DEFINITIONS: ConnectorDefinition[] = [github, notion, slack, email, gmail, outlook, customRest, mcp]
const pendingOAuth = new Map<string, OutlookFlow | GmailFlow | OutlookLoopbackFlow>()

function baseId(id: string): string {
  const index = id.indexOf(':')
  return index >= 0 ? id.slice(0, index) : id
}

function find(id: string): ConnectorDefinition {
  const definition = DEFINITIONS.find((item) => item.id === baseId(id))
  if (!definition) throw new Error(`Unknown connector: ${id}`)
  return definition
}

function validateFields(definition: ConnectorDefinition, fields: any): void {
  for (const field of definition.auth.fields) {
    if (field.required !== true) continue
    const value = fields?.[field.key]
    if (value === undefined || value === null || String(value).trim() === '') {
      throw new Error(`${field.label} is required.`)
    }
  }
}

export async function listConnectors(): Promise<any[]> {
  const states = await readStates()
  const locked = !hasConnectorKey()
  const secrets: any = locked ? {} : await readSecrets()
  const labelOf = (definition: ConnectorDefinition, id: string, state: any): string => {
    const stored = String(state?.label ?? '').trim()
    if (stored !== '') return stored
    if (definition.id === 'email') return String(secrets[id]?.email ?? '').trim()
    return ''
  }
  const item = (definition: ConnectorDefinition, id: string, name: string, state: any): any => ({
    id,
    name,
    label: labelOf(definition, id, state),
    description: definition.description,
    auth: definition.auth,
    actions: definition.actions.map((action) => ({
      id: action.id,
      name: action.name,
      description: action.description,
      mode: action.mode,
    })),
    connected: state?.connected === true,
    permissions: state?.permissions ?? { read: true, write: false },
    lastUsedAt: state?.lastUsedAt ?? null,
    locked,
  })
  const items = DEFINITIONS.map((definition) => item(definition, definition.id, definition.name, states.connectors[definition.id]))
  const basesWithInstances = new Set<string>()
  for (const [id, state] of Object.entries(states.connectors)) {
    if (!id.includes(':')) continue
    const definition = DEFINITIONS.find((candidate) => id.startsWith(`${candidate.id}:`))
    if (!definition) continue
    basesWithInstances.add(definition.id)
    const label = String((state as any)?.label ?? id.slice(definition.id.length + 1))
    items.push(item(definition, id, `${definition.name} · ${label}`, state))
  }
  return items.filter((entry) => !(basesWithInstances.has(entry.id) && entry.connected !== true))
}

export async function connect(id: string, fields: any): Promise<any> {
  const definition = find(id)
  if (!hasConnectorKey()) throw new Error('Unlock the Access vault first.')
  if (definition.auth.kind === 'oauth-device' || definition.auth.kind === 'oauth-loopback') throw new Error('Use the sign-in flow for this connector.')
  validateFields(definition, fields)
  const test = await definition.test(fields)
  const secrets = await readSecrets()
  secrets[id] = fields
  await writeSecrets(secrets)
  const states = await readStates()
  states.connectors[id] = {
    connected: true,
    permissions: states.connectors[id]?.permissions ?? { read: true, write: false },
    lastUsedAt: Date.now(),
    label: String(fields?.label ?? fields?.email ?? fields?.name ?? '').trim(),
  }
  await writeStates(states)
  return { ok: true, test }
}

export async function disconnect(id: string): Promise<any> {
  find(id)
  const secrets = await readSecrets()
  delete secrets[id]
  await writeSecrets(secrets)
  const states = await readStates()
  delete states.connectors[id]
  await writeStates(states)
  return { ok: true }
}

export async function test(id: string): Promise<any> {
  const definition = find(id)
  const secrets = await readSecrets()
  return definition.test(secrets[id] ?? {})
}

export async function startOAuth(id: string, fields: any): Promise<any> {
  const definition = find(id)
  if (definition.auth.kind !== 'oauth-device' && definition.auth.kind !== 'oauth-loopback') throw new Error('This connector does not use a sign-in flow.')
  if (!hasConnectorKey()) throw new Error('Unlock the Access vault first.')
  const clientId = String(fields?.clientId ?? '').trim()
  const tenant = String(fields?.tenant ?? '').trim()
  const emailHint = String(fields?.email ?? '').trim()
  if (definition.id === 'outlook') {
    // Interactive code flow: the device-code flow returns an opaque MSA ticket
    // for personal accounts, which Graph rejects. See outlook.ts.
    const flow = await startOutlookLoopback(clientId, tenant, emailHint)
    const flowId = randomUUID()
    flow.flowId = flowId
    pendingOAuth.set(flowId, flow)
    return { ok: true, flowId, authUrl: flow.authUrl, interval: 2 }
  }
  if (definition.auth.kind === 'oauth-loopback') {
    const flow = await startGmailFlow(clientId, String(fields?.clientSecret ?? '').trim(), emailHint)
    const flowId = randomUUID()
    flow.flowId = flowId
    pendingOAuth.set(flowId, flow)
    return {
      ok: true,
      flowId,
      authUrl: flow.authUrl,
      interval: 2,
    }
  }
  const flow = await startDeviceFlow(clientId, tenant)
  const flowId = randomUUID()
  pendingOAuth.set(flowId, { flowId, ...flow })
  return {
    ok: true,
    flowId,
    userCode: flow.userCode,
    verificationUri: flow.verificationUri,
    expiresAt: flow.expiresAt,
    interval: flow.interval,
  }
}

export async function pollOAuth(flowId: string): Promise<any> {
  const flow = pendingOAuth.get(flowId)
  if (!flow) throw new Error('The sign-in flow expired. Start again.')
  if ('authUrl' in flow && 'tenant' in flow && !('clientSecret' in flow)) {
    const result = await pollOutlookLoopback(flow as OutlookLoopbackFlow)
    if (result.pending) return { ok: true, pending: true, interval: 2 }
    const secrets = await readSecrets()
    secrets.outlook = result.secrets
    await writeSecrets(secrets)
    const states = await readStates()
    states.connectors.outlook = {
      connected: true,
      permissions: { read: true, write: false },
      lastUsedAt: Date.now(),
    }
    await writeStates(states)
    pendingOAuth.delete(flowId)
    return { ok: true, pending: false, detail: 'Outlook connected.' }
  }
  if ('authUrl' in flow) {
    const result = await pollGmailFlow(flow as GmailFlow)
    if (result.pending) return { ok: true, pending: true, interval: 2 }
    const secrets = await readSecrets()
    secrets.gmail = result.secrets
    await writeSecrets(secrets)
    const states = await readStates()
    states.connectors.gmail = {
      connected: true,
      permissions: { read: true, write: false },
      lastUsedAt: Date.now(),
      label: String(result.secrets?.email ?? ''),
    }
    await writeStates(states)
    pendingOAuth.delete(flowId)
    return { ok: true, pending: false, detail: 'Gmail connected.' }
  }
  const result = await pollDeviceFlow(flow as OutlookFlow)
  if (result.pending) {
    if (typeof result.interval === 'number') (flow as OutlookFlow).interval = result.interval
    return { ok: true, pending: true, interval: (flow as OutlookFlow).interval }
  }
  const secrets = await readSecrets()
  secrets.outlook = result.secrets
  await writeSecrets(secrets)
  const states = await readStates()
  states.connectors.outlook = {
    connected: true,
    permissions: { read: true, write: false },
    lastUsedAt: Date.now(),
  }
  await writeStates(states)
  pendingOAuth.delete(flowId)
  return { ok: true, pending: false, detail: 'Outlook connected.' }
}

export async function callConnector(
  id: string,
  actionId: string,
  args: any,
  approve: (action: ConnectorAction, args: any) => Promise<boolean>,
): Promise<any> {
  const definition = find(id)
  const states = await readStates()
  if (states.connectors[id]?.connected !== true) throw new Error(`The ${definition.name} connector is not connected. Add it in Settings → Access.`)
  const action = definition.actions.find((item) => item.id === actionId)
  if (!action) throw new Error(`Unknown action "${actionId}" for ${definition.name}. Available: ${definition.actions.map((item) => item.id).join(', ')}`)
  if (action.mode === 'write') {
    const allowed = await approve(action, args)
    if (!allowed) throw new Error('The user did not approve this write action.')
  }
  const secrets = await readSecrets()
  let current = secrets[id] ?? {}
  if (definition.prepare) {
    const prepared = await definition.prepare(current)
    if (prepared !== current) {
      secrets[id] = prepared
      await writeSecrets(secrets)
    }
    current = prepared
  }
  const result = await action.run(current, args ?? {})
  const nextStates = await readStates()
  nextStates.connectors[id] = {
    connected: true,
    permissions: nextStates.connectors[id]?.permissions ?? { read: true, write: false },
    lastUsedAt: Date.now(),
  }
  await writeStates(nextStates)
  return { ok: true, connector: id, action: actionId, result: redactSecrets(result) }
}

export function connectorDefinitions(): Array<Pick<ConnectorDefinition, 'id' | 'name' | 'description'>> {
  return DEFINITIONS.map((definition) => ({ id: definition.id, name: definition.name, description: definition.description }))
}
