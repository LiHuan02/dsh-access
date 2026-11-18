import { findBrowserWebview, hasIframeBrowser, waitForDomReady } from './browser'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function activeWebview(): any {
  const webview = findBrowserWebview()
  if (!webview) {
    throw new Error(hasIframeBrowser()
      ? 'The sidebar browser is running as a sandboxed iframe in this browser; automation requires the DSH desktop app.'
      : 'No built-in sidebar browser is open. Open a Browser tab in the right sidebar first.')
  }
  if (webview.tagName !== 'WEBVIEW') {
    throw new Error('The sidebar browser is not a desktop webview; automation is unavailable here.')
  }
  return webview
}

async function readyWebview(): Promise<any> {
  const webview = activeWebview()
  await waitForDomReady(webview, 12000)
  return webview
}

function run(webview: any, fn: (...args: any[]) => any, ...args: any[]): Promise<any> {
  const source = `(${fn.toString()})(${args.map((value) => JSON.stringify(value)).join(',')})`
  return webview.executeJavaScript(source, true)
}

function snapshotSource(maxNodes: number): any {
  const refs = new Map()
  ;(window as any).__dshAccessRefs = refs
  let next = 0
  const lines: string[] = []
  const clean = (value: any) => String(value ?? '').replace(/\s+/g, ' ').trim()
  const visible = (element: any) => {
    try {
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity || '1') > 0
    } catch {
      return false
    }
  }
  const passwordish = (element: any) => element.tagName === 'INPUT' && (element.type === 'password' || /password|passwd|pwd|secret/i.test(`${element.name || ''} ${element.id || ''} ${element.autocomplete || ''}`))
  const nameOf = (element: any) => clean(element.getAttribute('aria-label') || element.getAttribute('placeholder') || element.getAttribute('title') || element.innerText || element.value || element.name || element.id || '').slice(0, 120)
  const push = (element: any, role: string, extra: string) => {
    if (lines.length >= maxNodes) return
    next += 1
    refs.set(next, element)
    lines.push(`[${next}] ${role} "${nameOf(element)}"${extra ? ` ${extra}` : ''}`)
  }
  const walkDocument = (doc: Document) => {
    const walker = doc.createTreeWalker(doc.body || doc.documentElement, NodeFilter.SHOW_ELEMENT)
    while (walker.nextNode() && lines.length < maxNodes) {
      const element: any = walker.currentNode
      const tag = String(element.tagName || '').toLowerCase()
      if (!visible(element)) continue
      if (['script', 'style', 'noscript', 'template', 'svg', 'path', 'meta', 'link'].includes(tag)) continue
      if (tag === 'a' && element.getAttribute('href')) {
        push(element, 'link', `href="${clean(element.getAttribute('href')).slice(0, 200)}"`)
        continue
      }
      if (tag === 'button' || (tag === 'input' && ['submit', 'button', 'reset'].includes(element.type)) || element.getAttribute('role') === 'button') {
        push(element, 'button', element.disabled ? '[disabled]' : '')
        continue
      }
      if (tag === 'input') {
        if (passwordish(element)) {
          push(element, 'textbox', `value="[redacted]" [password]${element.disabled ? ' [disabled]' : ''}`)
          continue
        }
        if (element.type === 'checkbox' || element.type === 'radio') {
          push(element, element.type, element.checked ? '[checked]' : '')
          continue
        }
        push(element, 'textbox', `value="${clean(element.value).slice(0, 120)}"${element.disabled ? ' [disabled]' : ''}`)
        continue
      }
      if (tag === 'textarea') {
        push(element, 'textbox', `value="${clean(element.value).slice(0, 120)}"`)
        continue
      }
      if (tag === 'select') {
        push(element, 'combobox', `value="${clean(element.value)}"`)
        continue
      }
      if (/^h[1-6]$/.test(tag)) {
        push(element, `heading${tag.slice(1)}`, '')
        continue
      }
      if (tag === 'img' && element.getAttribute('alt') && lines.length < maxNodes) {
        lines.push(`img "${clean(element.getAttribute('alt')).slice(0, 120)}"`)
      }
    }
  }
  walkDocument(document)
  if (lines.length < maxNodes) {
    for (const frame of Array.from(document.querySelectorAll('iframe'))) {
      try {
        const doc = (frame as HTMLIFrameElement).contentDocument
        if (doc) walkDocument(doc)
      } catch {
        // Cross-origin iframe: inaccessible from the top document.
      }
    }
  }
  return { url: location.href, title: document.title, text: lines.join('\n') }
}

function readSource(maxChars: number): any {
  const text = (document.body?.innerText || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { url: location.href, title: document.title, text: text.slice(0, maxChars) }
}

function clickSource(ref: number, x: number | null, y: number | null, button: number): any {
  const refs = (window as any).__dshAccessRefs
  let target: any = ref ? refs?.get(ref) : null
  if (!target && x !== null && y !== null) target = document.elementFromPoint(x, y)
  if (!target) return { ok: false, error: 'no-target' }
  try {
    target.scrollIntoView({ block: 'center', inline: 'center' })
  } catch {
    // ignore
  }
  const rect = target.getBoundingClientRect()
  const clientX = x !== null ? x : rect.left + rect.width / 2
  const clientY = y !== null ? y : rect.top + rect.height / 2
  const options = { bubbles: true, cancelable: true, clientX, clientY, button, buttons: 1, view: window }
  const tag = String(target.tagName || '').toLowerCase()
  const native = tag === 'a' || tag === 'button' || (tag === 'input' && ['submit', 'button', 'reset', 'checkbox', 'radio'].includes(target.type)) || target.getAttribute('role') === 'button'
  if (native && typeof target.click === 'function') {
    target.click()
    return { ok: true, tag, text: String(target.innerText || '').slice(0, 80) }
  }
  try {
    target.dispatchEvent(new PointerEvent('pointerdown', options))
  } catch {
    // ignore
  }
  target.dispatchEvent(new MouseEvent('mousedown', options))
  try {
    target.dispatchEvent(new PointerEvent('pointerup', options))
  } catch {
    // ignore
  }
  target.dispatchEvent(new MouseEvent('mouseup', { ...options, buttons: 0 }))
  target.dispatchEvent(new MouseEvent('click', { ...options, buttons: 0 }))
  return { ok: true, tag, text: String(target.innerText || '').slice(0, 80) }
}

function typeSource(ref: number, text: string, submit: boolean, clear: boolean): any {
  const refs = (window as any).__dshAccessRefs
  const target: any = ref ? refs?.get(ref) : document.activeElement
  if (!target) return { ok: false, error: 'no-target' }
  const tag = String(target.tagName || '').toLowerCase()
  const passwordish = tag === 'input' && (target.type === 'password' || /password|passwd|pwd|secret/i.test(`${target.name || ''} ${target.id || ''} ${target.autocomplete || ''}`))
  if (passwordish) return { ok: false, error: 'password-field' }
  target.focus()
  if (target.isContentEditable) {
    target.textContent = clear ? String(text) : `${target.textContent || ''}${text}`
    target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: String(text) }))
  } else {
    const proto = tag === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
    const next = clear ? String(text) : `${target.value ?? ''}${text}`
    if (setter) setter.call(target, next)
    else target.value = next
    target.dispatchEvent(new Event('input', { bubbles: true }))
    target.dispatchEvent(new Event('change', { bubbles: true }))
  }
  if (submit) {
    const form = target.form
    const button = form && form.querySelector('button[type="submit"], input[type="submit"]')
    if (button) button.click()
    else if (form && typeof form.requestSubmit === 'function') form.requestSubmit()
  }
  return { ok: true }
}

function scrollSource(deltaY: number, ref: number): any {
  const target = ref ? (window as any).__dshAccessRefs?.get(ref) : null
  if (target) {
    target.scrollIntoView({ block: 'center', inline: 'nearest' })
    return { ok: true }
  }
  window.scrollBy(0, deltaY)
  return { ok: true }
}

function selectSource(ref: number, value: string): any {
  const target = (window as any).__dshAccessRefs?.get(ref)
  if (!target || String(target.tagName || '').toLowerCase() !== 'select') return { ok: false, error: 'not-a-select' }
  const option = Array.from(target.options as HTMLOptionsCollection).find((item) => item.value === value || String(item.textContent || '').trim() === value)
  if (!option) return { ok: false, error: 'option-not-found', options: Array.from(target.options as HTMLOptionsCollection).slice(0, 50).map((item) => ({ value: item.value, label: String(item.textContent || '').trim() })) }
  target.value = option.value
  target.dispatchEvent(new Event('input', { bubbles: true }))
  target.dispatchEvent(new Event('change', { bubbles: true }))
  return { ok: true, value: option.value }
}

function uploadSource(ref: number, name: string, mime: string, data: string): any {
  const target = (window as any).__dshAccessRefs?.get(ref)
  if (!target || String(target.tagName || '').toLowerCase() !== 'input' || target.type !== 'file') return { ok: false, error: 'not-a-file-input' }
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  const file = new File([bytes], name, { type: mime })
  const transfer = new DataTransfer()
  transfer.items.add(file)
  target.files = transfer.files
  target.dispatchEvent(new Event('input', { bubbles: true }))
  target.dispatchEvent(new Event('change', { bubbles: true }))
  return { ok: true, name, size: bytes.length }
}

function waitSource(selector: string, text: string): any {
  if (selector) {
    try {
      if (document.querySelector(selector)) return { ok: true, matched: 'selector' }
    } catch {
      // invalid selector; fall through to text
    }
  }
  if (text) {
    const body = document.body?.innerText || ''
    if (body.includes(text)) return { ok: true, matched: 'text' }
  }
  return { ok: false }
}

function rectSource(ref: number): any {
  const target = (window as any).__dshAccessRefs?.get(ref)
  if (!target) return { ok: false }
  try {
    target.scrollIntoView({ block: 'center', inline: 'center' })
  } catch {
    // ignore
  }
  const rect = target.getBoundingClientRect()
  return { ok: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, width: rect.width, height: rect.height }
}

function keySource(key: string, modifiers: string[]): any {
  const target: any = document.activeElement || document.body
  const init = {
    key,
    code: key,
    bubbles: true,
    cancelable: true,
    ctrlKey: modifiers.includes('control'),
    shiftKey: modifiers.includes('shift'),
    altKey: modifiers.includes('alt'),
    metaKey: modifiers.includes('meta'),
  }
  target.dispatchEvent(new KeyboardEvent('keydown', init))
  target.dispatchEvent(new KeyboardEvent('keyup', init))
  return { ok: true }
}

function findSource(text: string): any {
  try {
    return { ok: true, found: (window as any).find(text, false, false, true) === true }
  } catch {
    return { ok: false, found: false }
  }
}

export async function browserSnapshot(args: any): Promise<any> {
  const webview = await readyWebview()
  const maxNodes = Math.min(Math.max(Number(args?.maxNodes) || 400, 20), 2000)
  return { ok: true, ...(await run(webview, snapshotSource, maxNodes)) }
}

export async function browserRead(args: any): Promise<any> {
  const webview = await readyWebview()
  const maxChars = Math.min(Math.max(Number(args?.maxChars) || 12000, 500), 60000)
  return { ok: true, ...(await run(webview, readSource, maxChars)) }
}

export async function browserClick(args: any): Promise<any> {
  const webview = await readyWebview()
  const ref = Number(args?.ref) || 0
  const x = args?.x === undefined || args?.x === null ? null : Number(args.x)
  const y = args?.y === undefined || args?.y === null ? null : Number(args.y)
  if (ref === 0 && (x === null || y === null)) return { ok: false, error: 'Provide ref or x/y.' }
  return run(webview, clickSource, ref, x, y, Number(args?.button) || 0)
}

export async function browserType(args: any): Promise<any> {
  const webview = await readyWebview()
  const text = String(args?.text ?? '')
  if (text === '') return { ok: false, error: 'text is required' }
  return run(webview, typeSource, Number(args?.ref) || 0, text, args?.submit === true, args?.clear !== false)
}

export async function browserKey(args: any): Promise<any> {
  const webview = await readyWebview()
  const key = String(args?.key ?? '')
  if (key === '') return { ok: false, error: 'key is required' }
  const modifiers = Array.isArray(args?.modifiers) ? args.modifiers.map(String) : []
  if (typeof webview.sendInputEvent === 'function') {
    try {
      webview.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers })
      webview.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers })
      return { ok: true }
    } catch {
      // fall through to DOM events
    }
  }
  return run(webview, keySource, key, modifiers)
}

export async function browserScroll(args: any): Promise<any> {
  const webview = await readyWebview()
  return run(webview, scrollSource, Number(args?.deltaY) || 600, Number(args?.ref) || 0)
}

export async function browserAction(args: any): Promise<any> {
  const webview = await readyWebview()
  const action = String(args?.action ?? '')
  if (action === 'select') return run(webview, selectSource, Number(args?.ref) || 0, String(args?.value ?? ''))
  if (action === 'hover') {
    const ref = Number(args?.ref) || 0
    const rect = ref ? await run(webview, rectSource, ref) : { ok: true, x: Number(args?.x) || 0, y: Number(args?.y) || 0 }
    if (!rect?.ok) return { ok: false, error: 'no-target' }
    if (typeof webview.sendInputEvent === 'function') {
      webview.sendInputEvent({ type: 'mouseMove', x: Math.round(rect.x), y: Math.round(rect.y) })
      return { ok: true }
    }
    return { ok: false, error: 'hover is unavailable in this runtime' }
  }
  if (action === 'drag') {
    const fromRef = Number(args?.fromRef) || 0
    const toRef = Number(args?.toRef) || 0
    const from = fromRef ? await run(webview, rectSource, fromRef) : { ok: true, x: Number(args?.x) || 0, y: Number(args?.y) || 0 }
    const to = toRef ? await run(webview, rectSource, toRef) : { ok: true, x: Number(args?.toX) || 0, y: Number(args?.toY) || 0 }
    if (!from?.ok || !to?.ok) return { ok: false, error: 'no-target' }
    if (typeof webview.sendInputEvent !== 'function') return { ok: false, error: 'drag is unavailable in this runtime' }
    const steps = 8
    webview.sendInputEvent({ type: 'mouseDown', x: Math.round(from.x), y: Math.round(from.y), button: 'left', clickCount: 1 })
    for (let index = 1; index <= steps; index += 1) {
      const ratio = index / steps
      webview.sendInputEvent({
        type: 'mouseMove',
        x: Math.round(from.x + (to.x - from.x) * ratio),
        y: Math.round(from.y + (to.y - from.y) * ratio),
        button: 'left',
      })
    }
    webview.sendInputEvent({ type: 'mouseUp', x: Math.round(to.x), y: Math.round(to.y), button: 'left', clickCount: 1 })
    return { ok: true }
  }
  return { ok: false, error: `Unknown action: ${action}` }
}

export async function browserFile(args: any): Promise<any> {
  const webview = await readyWebview()
  const action = String(args?.action ?? '')
  if (action === 'upload') {
    const ref = Number(args?.ref) || 0
    if (ref === 0) return { ok: false, error: 'ref is required for upload' }
    return run(webview, uploadSource, ref, String(args?.name ?? 'file'), String(args?.mime ?? 'application/octet-stream'), String(args?.data ?? ''))
  }
  if (action === 'download') {
    const url = String(args?.url ?? '')
    if (url !== '' && typeof webview.downloadURL === 'function') {
      webview.downloadURL(url)
      return { ok: true, started: true }
    }
    const ref = Number(args?.ref) || 0
    if (ref === 0) return { ok: false, error: 'url or ref is required for download' }
    return run(webview, clickSource, ref, null, null, 0)
  }
  return { ok: false, error: `Unknown file action: ${action}` }
}

export async function browserView(args: any): Promise<any> {
  const webview = await readyWebview()
  const action = String(args?.action ?? '')
  if (action === 'find') {
    const text = String(args?.text ?? '')
    if (text === '') return { ok: false, error: 'text is required' }
    let latest: any
    const onFound = (event: any) => {
      if (event?.finalUpdate === true) latest = event
    }
    try {
      if (typeof webview.focus === 'function') webview.focus()
    } catch {
      // ignore
    }
    try {
      webview.addEventListener('found-in-page', onFound)
    } catch {
      // ignore
    }
    try {
      const initial = await webview.findInPage(text, { forward: args?.forward !== false })
      latest = initial ?? latest
      if (!latest || !latest.matches) await sleep(600)
      if (!latest || !latest.matches) {
        const fallback = await run(webview, findSource, text)
        if (fallback?.found === true) return { ok: true, matches: 1, activeMatchOrdinal: 1, matched: 'window.find' }
      }
      return { ok: true, matches: latest?.matches ?? 0, activeMatchOrdinal: latest?.activeMatchOrdinal ?? 0 }
    } finally {
      try {
        webview.removeEventListener('found-in-page', onFound)
      } catch {
        // ignore
      }
    }
  }
  if (action === 'zoom') {
    const factor = Math.min(Math.max(Number(args?.factor) || 1, 0.25), 5)
    webview.setZoomFactor(factor)
    return { ok: true, factor }
  }
  if (action === 'wait') {
    const timeout = Math.min(Math.max(Number(args?.ms) || 10000, 200), 60000)
    const selector = String(args?.selector ?? '')
    const text = String(args?.text ?? '')
    if (selector === '' && text === '') return { ok: false, error: 'selector or text is required' }
    const started = Date.now()
    while (Date.now() - started < timeout) {
      const result = await run(webview, waitSource, selector, text)
      if (result?.ok === true) return { ok: true, matched: result.matched, elapsedMs: Date.now() - started }
      await sleep(250)
    }
    return { ok: false, error: 'timed out' }
  }
  return { ok: false, error: `Unknown view action: ${action}` }
}

export async function browserHistory(args: any): Promise<any> {
  const webview = await readyWebview()
  const action = String(args?.action ?? '')
  if (action === 'back') webview.goBack()
  else if (action === 'forward') webview.goForward()
  else if (action === 'reload') webview.reload()
  else if (action === 'stop') webview.stop()
  else return { ok: false, error: `Unknown history action: ${action}` }
  return { ok: true, url: typeof webview.getURL === 'function' ? webview.getURL() : '' }
}

function tabWebview(tabId: string): any {
  try {
    const container = document.querySelector(`[data-sidebar-right-tab="${CSS.escape(tabId)}"]`)
    return container ? container.querySelector('webview[data-sidebar-browser-frame="webview"]') : null
  } catch {
    return null
  }
}

export async function browserTabs(ctx: any, args: any): Promise<any> {
  const sidebar = ctx.get('sidebarRight')
  if (!sidebar) return { ok: false, error: 'The right sidebar service is unavailable.' }
  const store = sidebar.openTabs
  const snapshot = typeof store?.getSnapshot === 'function' ? store.getSnapshot() : []
  const tabs = (Array.isArray(snapshot) ? snapshot : []).filter((tab: any) => tab?.kind === 'browser')
  let activeTab: any
  try {
    activeTab = typeof sidebar.active === 'function' ? sidebar.active() : undefined
  } catch {
    activeTab = undefined
  }
  const activeEntry = tabs.find((tab: any) => tab.tabId === activeTab?.id)
  const sessionId = activeEntry?.sessionId
  const scoped = sessionId === undefined ? tabs : tabs.filter((tab: any) => tab.sessionId === sessionId)
  const action = String(args?.action ?? 'list')
  if (action === 'list') {
    return {
      ok: true,
      tabs: scoped.map((tab: any) => {
        const webview = tabWebview(tab.tabId)
        const title = webview && typeof webview.getTitle === 'function' ? String(webview.getTitle() ?? '') : ''
        const url = webview && typeof webview.getURL === 'function'
          ? String(webview.getURL() ?? '')
          : String(tab.address ?? tab.url ?? '')
        return {
          tabId: tab.tabId,
          title: title || tab.title || url,
          url,
        }
      }),
    }
  }
  if (action === 'open') {
    sidebar.openTab('browser', { params: { url: String(args?.url ?? '') } })
    return { ok: true }
  }
  if (action === 'focus') {
    const tabId = String(args?.tabId ?? '')
    if (tabId === '') return { ok: false, error: 'tabId is required' }
    if (sessionId !== undefined && !scoped.some((tab: any) => tab.tabId === tabId)) {
      return { ok: false, error: 'That tab belongs to another conversation.' }
    }
    sidebar.focus(tabId)
    return { ok: true }
  }
  if (action === 'close') {
    const tabId = String(args?.tabId ?? '')
    if (tabId === '') return { ok: false, error: 'tabId is required' }
    if (sessionId !== undefined && !scoped.some((tab: any) => tab.tabId === tabId)) {
      return { ok: false, error: 'That tab belongs to another conversation.' }
    }
    sidebar.close(tabId)
    return { ok: true }
  }
  return { ok: false, error: `Unknown tabs action: ${action}` }
}

export async function browserScreenshot(_args: any): Promise<any> {
  const webview = await readyWebview()
  let cssKey: string | undefined
  try {
    if (typeof webview.insertCSS === 'function') {
      cssKey = await webview.insertCSS('input[type="password"], input[autocomplete*="password"] { filter: blur(8px) !important; }')
    }
  } catch {
    // best-effort blur
  }
  try {
    const image = await webview.capturePage()
    const dataUrl = typeof image?.toDataURL === 'function' ? image.toDataURL() : ''
    if (dataUrl === '') return { ok: false, error: 'capturePage returned no image' }
    return { ok: true, data: dataUrl.split(',')[1] ?? '' }
  } finally {
    if (cssKey && typeof webview.removeInsertedCSS === 'function') {
      try {
        await webview.removeInsertedCSS(cssKey)
      } catch {
        // ignore
      }
    }
  }
}
