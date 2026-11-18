import { setLocale, t } from './i18n'
import { autoFill, closeCardIf, initStore, openAddCard, openLogin, resendConnectorKey, siteList, statusPayload } from './store'
import { ensureBrowserForSite, openInBuiltinBrowser } from './browser'
import {
  browserAction,
  browserClick,
  browserFile,
  browserHistory,
  browserKey,
  browserRead,
  browserScreenshot,
  browserScroll,
  browserSnapshot,
  browserTabs,
  browserType,
  browserView,
} from './automation'
import { AccessCardOverlay, AccessComposerButton, AccessIcon, BrowserMenuAdd, CredentialToolView, LoginToolView, SettingsPage, installStyles } from './ui'

const PAGE_STORAGE_KEY = 'dsh-access:page'

function getPageId(): string {
  try {
    const existing = sessionStorage.getItem(PAGE_STORAGE_KEY)
    if (existing) return existing
    const id = `page-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`
    sessionStorage.setItem(PAGE_STORAGE_KEY, id)
    return id
  } catch {
    return `page-${Math.random().toString(36).slice(2)}`
  }
}

function route(path: string): string {
  return new URL(path, document.baseURI).href
}

async function post(path: string, body: unknown): Promise<any> {
  const response = await fetch(route(path), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json().catch(() => ({}))
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

type Handler = (args: any) => Promise<any>

async function pollLoop(handlers: Map<string, Handler>, signal: AbortSignal): Promise<void> {
  const page = getPageId()
  while (!signal.aborted) {
    try {
      const response = await fetch(route(`dsh-access/api/poll?page=${encodeURIComponent(page)}`), {
        cache: 'no-store',
        signal,
      })
      if (signal.aborted) return
      if (response.status === 204) continue
      if (!response.ok) throw new Error(`poll HTTP ${response.status}`)
      const message = await response.json()
      const command = message?.command
      if (!command) continue
      let result: any
      try {
        const handler = handlers.get(String(command.op))
        if (!handler) throw new Error(`Unknown command: ${command.op}`)
        // A handler that never settles used to strand the whole page: the host
        // waited for a result that could not arrive. Surface it as an error — but
        // browser work legitimately takes tens of seconds, so only fast ops get the
        // short budget.
        const slow = /^(browser\.|login\.auto$)/.test(String(command.op))
        const budget = slow ? 120000 : 15000
        const value = await Promise.race([
          handler(command.args),
          new Promise((_resolve, reject) => {
            setTimeout(() => reject(new Error(`The renderer did not finish ${command.op} within ${Math.round(budget / 1000)}s.`)), budget)
          }),
        ])
        result = { id: command.id, ok: true, value }
      } catch (error) {
        result = { id: command.id, ok: false, error: error instanceof Error ? error.message : String(error) }
      }
      await post('dsh-access/api/result', result)
    } catch (error) {
      if (signal.aborted) return
      await sleep(1000)
    }
  }
}

export const inject = ['slots', 'locale', 'sidebarRight']

function tryInject(ctx: any, slot: string, register: () => void): void {
  try {
    ctx.slots.inject(slot, register)
  } catch (error) {
    // A slot that moved between DSH releases must not take the whole client
    // half down; the remaining surfaces (cards, settings) still load.
    console.warn(`[dsh-access] slot ${slot} is unavailable:`, error)
  }
}

export function apply(ctx: any): void {
  try {
    setLocale(ctx)
  } catch (error) {
    console.warn('[dsh-access] locale setup failed:', error)
  }
  ctx.effect(() => installStyles(), 'dsh-access: styles')
  void initStore(ctx).catch((error) => console.warn('[dsh-access] store init failed:', error))

  const handlers = new Map<string, Handler>([
    ['browser.open', (args) => openInBuiltinBrowser(ctx, args)],
    ['browser.history', (args) => browserHistory(args)],
    ['browser.snapshot', (args) => browserSnapshot(args)],
    ['browser.read', (args) => browserRead(args)],
    ['browser.click', (args) => browserClick(args)],
    ['browser.type', (args) => browserType(args)],
    ['browser.key', (args) => browserKey(args)],
    ['browser.scroll', (args) => browserScroll(args)],
    ['browser.action', (args) => browserAction(args)],
    ['browser.file', (args) => browserFile(args)],
    ['browser.view', (args) => browserView(args)],
    ['browser.tabs', (args) => browserTabs(ctx, args)],
    ['browser.screenshot', (args) => browserScreenshot(args)],
    ['vault.status', async () => statusPayload()],
    ['vault.sites', async () => siteList()],
    ['connector.key.request', async () => ({ ok: await resendConnectorKey() })],
    ['login.auto', async (args) => autoFill(
      String(args?.site ?? ''),
      args?.submit === true,
      typeof args?.requestId === 'string' ? args.requestId : undefined,
      args?.engine === 'external' ? 'external' : 'builtin',
      typeof args?.account === 'string' ? args.account : undefined,
    )],
    ['browser.ensure', async (args) => {
      const sessionId = String(args?.sessionId ?? '')
      if (sessionId !== '') {
        try {
          await ensureBrowserForSite(ctx, String(args?.site ?? ''), sessionId)
        } catch {
          // The panel may already be mounted; never fail the caller here.
        }
      }
      return { ok: true }
    }],
    ['bridge.install', async () => {
      // The desktop renderer is same-origin with the host and carries the
      // authenticated session cookie, so this call can start the maintenance
      // route that the missing settings button would have called.
      const locale = String(navigator.language ?? '').toLowerCase().startsWith('zh') ? 'zh' : 'en'
      const response = await fetch(new URL('dsh-builtin-browser/bridge-maintenance', document.baseURI).href, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'install', locale }),
      })
      const data = await response.json().catch(() => ({}))
      return {
        ok: response.ok,
        status: response.status,
        accepted: data?.accepted === true,
        error: typeof data?.error === 'string' ? data.error : undefined,
      }
    }],
    ['card.add', async (args) => openAddCard(args ?? {}, 'tool')],
    ['card.close', async (args) => { closeCardIf(String(args?.requestId ?? '')) }],
    ['login.request', async (args) => {
      const info = openLogin(args ?? {})
      if (info.site && args?.browserEngine !== 'external') {
        void ensureBrowserForSite(ctx, info.site, String(args?.sessionId ?? '')).catch(() => undefined)
      }
      return info
    }],
  ])

  tryInject(ctx, 'tool.call.toolview', () => {
    const disposeLogin = ctx.slots.register({ name: 'tool.call.toolview', key: 'access_login' }, LoginToolView)
    const disposeAdd = ctx.slots.register({ name: 'tool.call.toolview', key: 'access_credential_card' }, CredentialToolView)
    return () => {
      disposeLogin()
      disposeAdd()
    }
  })

  tryInject(ctx, 'settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'access',
    order: 60,
    label: () => t('settings.title'),
  }, SettingsPage))

  tryInject(ctx, 'settings.section.icon', () => ctx.slots.register({
    name: 'settings.section.icon',
    id: 'access',
    order: 60,
    label: () => t('settings.title'),
  }, AccessIcon))

  tryInject(ctx, 'conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'dsh-access',
    order: 20,
  }, AccessComposerButton))

  tryInject(ctx, 'shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'dsh-access-card',
    order: 100,
  }, AccessCardOverlay))

  tryInject(ctx, 'sidebar.right.tab.menu.item', () => ctx.slots.register({
    name: 'sidebar.right.tab.menu.item',
    id: 'dsh-access',
    order: 50,
  }, BrowserMenuAdd))

  const controller = new AbortController()
  ctx.effect(() => () => controller.abort(), 'dsh-access: bridge')
  void pollLoop(handlers, controller.signal)
}
