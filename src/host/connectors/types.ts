export interface ConnectorField {
  key: string
  label: string
  secret?: boolean
  required?: boolean
  placeholder?: string
}

export interface ConnectorAction {
  id: string
  name: string
  description: string
  mode: 'read' | 'write'
  parameters: Record<string, any>
  run: (secrets: any, args: any) => Promise<any>
}

export interface ConnectorDefinition {
  id: string
  name: string
  description: string
  auth: {
    kind: 'api-key' | 'email' | 'oauth-device' | 'oauth-loopback'
    fields: ConnectorField[]
    presets?: Record<string, any>
  }
  actions: ConnectorAction[]
  prepare?: (secrets: any) => Promise<any>
  test: (secrets: any) => Promise<{ ok: boolean; detail?: string }>
}

export function requireField(args: any, key: string): any {
  const value = args?.[key]
  if (value === undefined || value === null || value === '') throw new Error(`${key} is required.`)
  return value
}
