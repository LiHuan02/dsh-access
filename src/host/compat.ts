/**
 * Small compatibility layer for the DSH host plugin API.
 *
 * DSH ships frequently and its service surface is not frozen. A plugin must
 * never take the whole Harness down (or fail to activate) because one optional
 * service, one registration option, or one prompt hook moved. Everything here
 * is deliberately best-effort: a missing capability degrades that capability,
 * not the plugin.
 */

export function getService(ctx: any, name: string): any {
  try {
    return typeof ctx?.get === 'function' ? ctx.get(name) : undefined
  } catch {
    return undefined
  }
}

export function warn(label: string, error: unknown): void {
  try {
    const message = error instanceof Error ? error.message : String(error)
    // eslint-disable-next-line no-console
    console.warn(`[dsh-access] ${label}: ${message}`)
  } catch {
    // logging must never throw
  }
}

/**
 * Register a Cordis effect whose setup cannot break plugin activation.
 * If the body throws, the effect still returns a disposer so the rest of the
 * plugin keeps loading.
 */
export function safeEffect(ctx: any, body: () => any, label: string): void {
  if (typeof ctx?.effect !== 'function') {
    warn(label, new Error('ctx.effect is unavailable'))
    return
  }
  try {
    ctx.effect(() => {
      try {
        const disposer = body()
        return typeof disposer === 'function' ? disposer : () => undefined
      } catch (error) {
        warn(label, error)
        return () => undefined
      }
    }, label)
  } catch (error) {
    warn(label, error)
  }
}

/**
 * Register one tool. `options.when` is new in DSH 0.2.2; older hosts ignore
 * options entirely, so retry without them instead of losing the tool.
 */
export function registerTool(ctx: any, definition: any, label: string, options?: any): boolean {
  const tools = getService(ctx, 'tools')
  if (!tools || typeof tools.register !== 'function') {
    warn(label, new Error('the tools service is unavailable'))
    return false
  }
  safeEffect(ctx, () => {
    if (options !== undefined) {
      try {
        return tools.register(definition, options)
      } catch (error) {
        warn(`${label} (registration options)`, error)
      }
    }
    return tools.register(definition)
  }, label)
  return true
}

export function hasTool(ctx: any, name: string, scope?: any): boolean {
  const tools = getService(ctx, 'tools')
  try {
    if (!tools || typeof tools.get !== 'function') return false
    return tools.get(name, scope) !== undefined
  } catch {
    return false
  }
}

export function findTool(ctx: any, name: string, scope?: any): any {
  const tools = getService(ctx, 'tools')
  try {
    if (!tools || typeof tools.get !== 'function') return undefined
    return tools.get(name, scope)
  } catch {
    return undefined
  }
}

/**
 * Invoke another plugin's tool definition in-process. This is how dsh-access
 * reuses dsh-builtin-browser instead of maintaining a second browser engine.
 * The nested call shares the caller's agent and cancellation signal, so the
 * browser session mapping is the same one the model's later dsh_browser_*
 * calls resolve.
 */
export async function callTool(ctx: any, name: string, args: any, exec: any): Promise<any> {
  const definition = findTool(ctx, name, exec?.agent)
  if (!definition || typeof definition.execute !== 'function') {
    throw new Error(`${name} is not available`)
  }
  return definition.execute(args, exec)
}

export function addPromptSection(ctx: any, section: any): void {
  const systemPrompt = getService(ctx, 'systemPrompt')
  if (!systemPrompt || typeof systemPrompt.section !== 'function') return
  safeEffect(ctx, () => systemPrompt.section(section), 'dsh-access: prompt')
}
