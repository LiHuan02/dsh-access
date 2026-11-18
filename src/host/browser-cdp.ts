/**
 * The `access_browser_*` operations, implemented over CDP.
 *
 * The tool definitions in `browser-tools.ts` are carrier-agnostic: they describe
 * what the agent may do to "the browser". This module answers those calls on the
 * desktop bridge carrier (the official sidebar panel), and returns `undefined`
 * for anything it does not implement so the caller can fall back to the renderer
 * webview path.
 *
 * Refs are stamped into the page as `data-dsh-ref`, which keeps a ref meaningful
 * across separate commands without a second registry: the number in the snapshot
 * is the number in the attribute.
 */

import { sidebarBridge, sidebarPage, type SidebarPage } from './sidebar-cdp.js'

const MAX_TEXT = 60_000

/** Elements a snapshot exposes, in document order. */
const SNAPSHOT_SCRIPT = `(() => {
  const visible = (el) => {
    if (!el) return false
    const rect = el.getBoundingClientRect()
    const style = getComputedStyle(el)
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
  }
  const label = (el) => {
    const text = (el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('placeholder') || el.getAttribute('title') || '').replace(/\\s+/g, ' ').trim()
    return text.length > 90 ? text.slice(0, 90) + '…' : text
  }
  const selector = 'a[href],button,input,select,textarea,summary,[role="button"],[role="link"],[role="tab"],[role="checkbox"],[role="menuitem"],[onclick],[contenteditable="true"]'
  const nodes = Array.from(document.querySelectorAll(selector)).filter(visible).slice(0, MAX_NODES)
  document.querySelectorAll('[data-dsh-ref]').forEach((el) => el.removeAttribute('data-dsh-ref'))
  const rows = []
  nodes.forEach((el, index) => {
    const ref = index + 1
    el.setAttribute('data-dsh-ref', String(ref))
    const tag = el.tagName.toLowerCase()
    const kind = tag === 'input' ? (el.getAttribute('type') || 'text') : tag
    const name = label(el)
    const masked = tag === 'input' && (el.getAttribute('type') || '').toLowerCase() === 'password'
    const value = masked ? '[password]' : (tag === 'input' || tag === 'textarea' || tag === 'select') && el.value ? ' = ' + String(el.value).slice(0, 60) : ''
    rows.push('[' + ref + '] ' + kind + (name ? ' "' + name + '"' : '') + value)
  })
  const headings = Array.from(document.querySelectorAll('h1,h2,h3')).filter(visible).slice(0, 20)
    .map((el) => el.tagName.toLowerCase() + ': ' + label(el))
  return JSON.stringify({
    url: location.href,
    title: document.title,
    text: (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n').trim().slice(0, MAX_TEXT),
    rows,
    headings,
  })
})()`

function snapshotScript(maxNodes: number): string {
  return SNAPSHOT_SCRIPT.replaceAll('MAX_NODES', String(maxNodes)).replaceAll('MAX_TEXT', String(MAX_TEXT))
}

function visibleRectScript(ref: number): string {
  return `(() => {
    const el = document.querySelector('[data-dsh-ref="${ref}"]')
    if (!el) return ''
    el.scrollIntoView({ block: 'center', inline: 'center' })
    const rect = el.getBoundingClientRect()
    return JSON.stringify({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })
  })()`
}

async function centre(page: SidebarPage, id: number, ref: number): Promise<{ x: number; y: number } | undefined> {
  const raw = await page.evaluate(id, visibleRectScript(ref))
  if (typeof raw !== 'string' || raw === '') return undefined
  try {
    const parsed = JSON.parse(raw)
    if (typeof parsed?.x === 'number' && typeof parsed?.y === 'number') return parsed
  } catch {
    // fall through: the caller uses the element's own click handler
  }
  return undefined
}

async function mouse(page: SidebarPage, id: number, type: string, x: number, y: number, extra: Record<string, unknown> = {}): Promise<void> {
  await page.cdp(id, 'Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, ...extra }, 10_000)
}

const KEYS: Record<string, { code: string; keyCode: number }> = {
  Enter: { code: 'Enter', keyCode: 13 },
  Tab: { code: 'Tab', keyCode: 9 },
  Escape: { code: 'Escape', keyCode: 27 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Delete: { code: 'Delete', keyCode: 46 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
  PageUp: { code: 'PageUp', keyCode: 33 },
  PageDown: { code: 'PageDown', keyCode: 34 },
  Space: { code: 'Space', keyCode: 32 },
}

function modifiersOf(list: unknown): number {
  if (!Array.isArray(list)) return 0
  let mask = 0
  for (const raw of list) {
    const name = String(raw).toLowerCase()
    if (name === 'alt') mask |= 1
    if (name === 'control' || name === 'ctrl') mask |= 2
    if (name === 'meta' || name === 'cmd') mask |= 4
    if (name === 'shift') mask |= 8
  }
  return mask
}

async function sessionFor(exec: any): Promise<{ page: SidebarPage; id: number } | undefined> {
  const owner = String(exec?.agent?.id ?? '')
  if (owner === '') return undefined
  const page = await sidebarPage(owner)
  if (page === undefined) return undefined
  const id = await page.ensure()
  return { page, id }
}

/**
 * Answer one `browser.*` operation on the bridge carrier.
 *
 * @returns the tool's result object, or `undefined` when this carrier cannot
 *   serve the operation (the caller then uses the renderer webview instead).
 */
export async function runCdpOp(op: string, args: any, exec: any): Promise<any | undefined> {
  const session = await sessionFor(exec)
  if (session === undefined) return undefined
  const { page, id } = session

  switch (op) {
    case 'browser.open': {
      const url = String(args?.url ?? '')
      if (url === '') return { ok: false, error: 'url is required' }
      await page.ensure(url)
      await page.navigate(id, url, 30_000)
      const current = await page.url(id)
      await page.show(id)
      return { ok: true, url: current !== '' ? current : url, title: await page.title(id) }
    }
    case 'browser.snapshot': {
      const raw = await page.evaluate(id, snapshotScript(Number(args?.maxNodes) || 400), 25_000)
      const data = parseSnapshot(raw)
      const blocks = [
        data.headings.length > 0 ? `Headings:\n${data.headings.join('\n')}` : '',
        data.rows.length > 0 ? `Interactive:\n${data.rows.join('\n')}` : '',
        data.text !== '' ? `Text:\n${data.text}` : '',
      ].filter((part) => part !== '')
      return { ok: true, url: data.url, title: data.title, text: blocks.join('\n\n') }
    }
    case 'browser.read': {
      const maxChars = Math.min(Number(args?.maxChars) || 12_000, MAX_TEXT)
      const raw = await page.evaluate(id, `JSON.stringify({ url: location.href, title: document.title, text: (document.body ? document.body.innerText : '').slice(0, ${maxChars}) })`)
      const data = parseSnapshot(raw)
      return { ok: true, url: data.url, title: data.title, text: data.text }
    }
    case 'browser.click': {
      const ref = Number(args?.ref) || 0
      if (ref > 0) {
        const point = await centre(page, id, ref)
        if (point !== undefined) {
          await mouse(page, id, 'mousePressed', point.x, point.y)
          await mouse(page, id, 'mouseReleased', point.x, point.y)
          return { ok: true, tag: 'element', text: `ref ${ref}` }
        }
      }
      if (typeof args?.x === 'number' && typeof args?.y === 'number') {
        await mouse(page, id, 'mousePressed', args.x, args.y)
        await mouse(page, id, 'mouseReleased', args.x, args.y)
        return { ok: true, tag: 'coordinate', text: `${args.x},${args.y}` }
      }
      return { ok: false, error: ref > 0 ? `ref ${ref} is not on the page any more; take a new snapshot` : 'click needs a ref or x/y' }
    }
    case 'browser.type': {
      const text = String(args?.text ?? '')
      const ref = Number(args?.ref) || 0
      const clear = args?.clear !== false
      const focus = ref > 0
        ? `(() => { const el = document.querySelector('[data-dsh-ref="${ref}"]'); if (!el) return 'missing'; el.focus(); ${clear ? 'if (el.select) el.select();' : ''} return 'ok' })()`
        : `(() => { const el = document.activeElement; if (!el) return 'missing'; ${clear ? 'if (el.select) el.select();' : ''} return 'ok' })()`
      const focused = await page.evaluate(id, focus)
      if (focused === 'missing') return { ok: false, error: `ref ${ref} is not on the page any more; take a new snapshot` }
      if (clear) await page.cdp(id, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Backspace', windowsVirtualKeyCode: 8 }, 10_000)
      await page.cdp(id, 'Input.insertText', { text }, 20_000)
      if (args?.submit === true) {
        await page.cdp(id, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, 10_000)
        await page.cdp(id, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, 10_000)
      }
      return { ok: true }
    }
    case 'browser.key': {
      const key = String(args?.key ?? '')
      const mapped = KEYS[key]
      const modifiers = modifiersOf(args?.modifiers)
      if (mapped === undefined) {
        await page.cdp(id, 'Input.insertText', { text: key }, 10_000)
        return { ok: true }
      }
      for (const type of ['keyDown', 'keyUp']) {
        await page.cdp(id, 'Input.dispatchKeyEvent', { type, key: mapped.code, code: mapped.code, windowsVirtualKeyCode: mapped.keyCode, modifiers }, 10_000)
      }
      return { ok: true }
    }
    case 'browser.scroll': {
      const ref = Number(args?.ref) || 0
      if (ref > 0) {
        const moved = await page.evaluate(id, `(() => { const el = document.querySelector('[data-dsh-ref="${ref}"]'); if (!el) return 'missing'; el.scrollIntoView({ block: 'center' }); return 'ok' })()`)
        if (moved === 'missing') return { ok: false, error: `ref ${ref} is not on the page any more; take a new snapshot` }
        return { ok: true }
      }
      const deltaY = Number(args?.deltaY) || 600
      await page.cdp(id, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: 200, y: 300, deltaX: 0, deltaY }, 10_000)
      return { ok: true }
    }
    case 'browser.action': {
      const action = String(args?.action ?? '')
      if (action === 'hover') {
        const ref = Number(args?.ref) || 0
        const point = ref > 0 ? await centre(page, id, ref) : (typeof args?.x === 'number' && typeof args?.y === 'number' ? { x: args.x, y: args.y } : undefined)
        if (point === undefined) return { ok: false, error: 'hover needs a ref or x/y' }
        await mouse(page, id, 'mouseMoved', point.x, point.y, { button: 'none' })
        return { ok: true }
      }
      if (action === 'select') {
        const ref = Number(args?.ref) || 0
        const wanted = String(args?.value ?? '')
        const applied = await page.evaluate(id, `(() => {
          const el = document.querySelector('[data-dsh-ref="${ref}"]')
          if (!el || el.tagName !== 'SELECT') return 'not-a-select'
          const want = ${JSON.stringify(wanted)}
          const option = Array.from(el.options).find((item) => item.value === want || item.text === want || item.label === want)
          if (!option) return 'no-option'
          el.value = option.value
          el.dispatchEvent(new Event('input', { bubbles: true }))
          el.dispatchEvent(new Event('change', { bubbles: true }))
          return 'ok'
        })()`)
        if (applied !== 'ok') return { ok: false, error: applied === 'no-option' ? `no option matches "${wanted}"` : 'that ref is not a <select>' }
        return { ok: true }
      }
      if (action === 'drag') {
        const from = Number(args?.fromRef) || 0
        const to = Number(args?.toRef) || 0
        const start = from > 0 ? await centre(page, id, from) : (typeof args?.x === 'number' && typeof args?.y === 'number' ? { x: args.x, y: args.y } : undefined)
        const end = to > 0 ? await centre(page, id, to) : (typeof args?.toX === 'number' && typeof args?.toY === 'number' ? { x: args.toX, y: args.toY } : undefined)
        if (start === undefined || end === undefined) return { ok: false, error: 'drag needs source and target refs or coordinates' }
        await mouse(page, id, 'mousePressed', start.x, start.y)
        await page.cdp(id, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: end.x, y: end.y, button: 'left', buttons: 1 }, 10_000)
        await mouse(page, id, 'mouseReleased', end.x, end.y)
        return { ok: true }
      }
      return { ok: false, error: `unsupported action: ${action}` }
    }
    case 'browser.view': {
      const action = String(args?.action ?? '')
      if (action === 'wait') {
        const selector = String(args?.selector ?? '')
        const text = String(args?.text ?? '')
        const ms = Math.min(Number(args?.ms) || 10_000, 60_000)
        const deadline = Date.now() + ms
        const probe = selector !== ''
          ? `document.querySelector(${JSON.stringify(selector)}) !== null`
          : `document.body ? document.body.innerText.includes(${JSON.stringify(text)}) : false`
        while (Date.now() < deadline) {
          try {
            if (await page.evaluate(id, probe, 3_000) === true) {
              return { ok: true, matched: selector !== '' ? selector : text, elapsedMs: ms - (deadline - Date.now()) }
            }
          } catch {
            // a navigation makes the context disappear for a moment
          }
          await new Promise((resolve) => setTimeout(resolve, 250))
        }
        return { ok: false, error: `timed out after ${ms}ms waiting for ${selector !== '' ? selector : `"${text}"`}` }
      }
      if (action === 'find') {
        const text = String(args?.text ?? '')
        const matches = await page.evaluate(id, `(() => { const body = document.body ? document.body.innerText : ''; return ${JSON.stringify(text)} === '' ? 0 : body.split(${JSON.stringify(text)}).length - 1 })()`)
        return { ok: true, matches: Number(matches) || 0, activeMatchOrdinal: Number(matches) > 0 ? 1 : 0 }
      }
      if (action === 'zoom') {
        const factor = Math.min(Math.max(Number(args?.factor) || 1, 0.25), 5)
        await page.cdp(id, 'Emulation.setPageScaleFactor', { pageScaleFactor: factor }, 10_000)
        return { ok: true, factor }
      }
      return { ok: false, error: `unsupported view action: ${action}` }
    }
    case 'browser.tabs': {
      const action = String(args?.action ?? 'list')
      const bridge = await sidebarBridge()
      if (bridge === undefined) return undefined
      if (action === 'open') {
        const url = String(args?.url ?? '')
        await page.ensure(url)
        return { ok: true }
      }
      if (action === 'close') {
        const wanted = Number(String(args?.tabId ?? '').replace(/^tab:/, ''))
        if (!Number.isFinite(wanted) || wanted <= 0) return { ok: false, error: 'tabId is required' }
        const answer = await bridge.call('closePage', { owner: String(exec?.agent?.id ?? ''), id: wanted }, 8_000)
        if (answer?.ok !== true) return { ok: false, error: String(answer?.error ?? 'the sidebar did not close that page') }
        return { ok: true }
      }
      const listed = await bridge.call('list', { owner: String(exec?.agent?.id ?? '') }, 10_000)
      const pages = Array.isArray(listed?.sidebar) ? listed.sidebar.filter((row: any) => row?.type === 'webview') : []
      const tabs = pages.map((row: any) => ({ tabId: `tab:${row.id}`, title: String(row.title ?? ''), url: String(row.url ?? '') }))
      if (action === 'focus') {
        const wanted = Number(String(args?.tabId ?? '').replace(/^tab:/, ''))
        if (Number.isFinite(wanted) && wanted > 0) await bridge.call('showTab', { owner: String(exec?.agent?.id ?? ''), id: wanted }, 8_000)
      }
      return { ok: true, tabs }
    }
    case 'browser.screenshot': {
      const data = await page.screenshot(id)
      return { ok: true, data }
    }
    case 'browser.do': {
      return await runSteps(page, id, Array.isArray(args?.steps) ? args.steps : [], args)
    }
    case 'browser.history': {
      const action = String(args?.action ?? 'reload')
      if (action === 'reload') {
        await page.cdp(id, 'Page.reload', {}, 15_000)
        return { ok: true, url: await page.url(id) }
      }
      if (action === 'back' || action === 'forward') {
        const history = await page.cdp(id, 'Page.getNavigationHistory', {}, 10_000)
        const index = Number(history?.currentIndex ?? 0) + (action === 'back' ? -1 : 1)
        const entry = Array.isArray(history?.entries) ? history.entries[index] : undefined
        if (entry === undefined) return { ok: true, url: await page.url(id) }
        await page.cdp(id, 'Page.navigateToHistoryEntry', { entryId: entry.id }, 15_000)
        return { ok: true, url: String(entry.url ?? '') }
      }
      if (action === 'stop') {
        try {
          await page.cdp(id, 'Page.stopLoading', {}, 5_000)
        } catch {
          // stopping an idle page is a no-op
        }
        return { ok: true, url: await page.url(id) }
      }
      return { ok: false, error: `unsupported history action: ${action}` }
    }
    default:
      // file upload/download and anything new stay on the renderer carrier
      return undefined
  }
}

/**
 * Fill a sign-in form on the sidebar page over CDP.
 *
 * The credential is decrypted in the renderer and handed to this host route for
 * the duration of one call, exactly like the renderer path: nothing is logged,
 * stored or returned, and the model never sees it. Google and Microsoft show the
 * account field first and the password on the next screen, so a missing password
 * field falls back to filling the identifier and waiting for the password page.
 *
 * @returns the fill result, or `undefined` when no bridge is installed and the
 *   caller should use the renderer webview instead.
 */
export async function fillOnSidebar(exec: any, values: { username: string; password: string; submit: boolean }): Promise<any | undefined> {
  const session = await sessionFor(exec)
  if (session === undefined) return undefined
  const { page, id } = session

  const fillScript = `(function (username, password, submitFlag) {
    const visible = (el) => {
      if (!el) return false
      const style = getComputedStyle(el)
      const rect = el.getBoundingClientRect()
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
    }
    const setValue = (el, value) => {
      if (!el) return false
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
      if (setter) setter.call(el, value)
      else el.value = value
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    }
    const passwordField = Array.from(document.querySelectorAll('input[type="password"]')).find(visible)
    if (!passwordField) return JSON.stringify({ ok: false, error: 'no-password-field' })
    const form = passwordField.form
    const scope = form || document
    const candidates = Array.from(scope.querySelectorAll(
      'input[type="email"],input[type="text"],input[autocomplete="username"],input[name*="user" i],input[name*="email" i],input[id*="user" i],input[id*="email" i]'
    )).filter((el) => visible(el) && el !== passwordField)
    const before = candidates.filter((el) => el.compareDocumentPosition(passwordField) & Node.DOCUMENT_POSITION_FOLLOWING)
    const userField = before[0] || candidates[0] || null
    const filledUsername = !!(userField && username)
    if (filledUsername) setValue(userField, username)
    const filledPassword = setValue(passwordField, password)
    let submitted = false
    if (submitFlag === '1') {
      const button = (form || document).querySelector('button[type="submit"],input[type="submit"]')
      if (button) { button.click(); submitted = true }
      else if (form && typeof form.requestSubmit === 'function') { form.requestSubmit(); submitted = true }
      else if (form && typeof form.submit === 'function') { form.submit(); submitted = true }
    }
    return JSON.stringify({ ok: true, filledUsername, filledPassword, submitted })
  })(__USERNAME__, __PASSWORD__, __SUBMIT__)`

  const emailScript = `(function (email) {
    const visible = (el) => {
      if (!el) return false
      const style = getComputedStyle(el)
      const rect = el.getBoundingClientRect()
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
    }
    const setValue = (el, value) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      if (setter) setter.call(el, value)
      else el.value = value
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    }
    const field = Array.from(document.querySelectorAll(
      'input[type="email"],input[autocomplete="username"],input[name="loginfmt"],input[name="email"],input[id="identifierId"],input[type="text"]'
    )).filter(visible)[0]
    if (!field) return JSON.stringify({ ok: false, error: 'no-email-field' })
    setValue(field, email)
    const form = field.form
    const buttons = Array.from((form || document).querySelectorAll('button,input[type="submit"],input[type="button"]')).filter(visible)
    const byText = buttons.find((el) => /^(next|continue|sign in|log in|下一步|继续|登录)$/i.test(String(el.textContent || el.value || '').trim()))
    const bySubmit = buttons.find((el) => el.type === 'submit')
    const button = byText || bySubmit || null
    if (button) button.click()
    else if (form && typeof form.requestSubmit === 'function') form.requestSubmit()
    return JSON.stringify({ ok: true })
  })(__EMAIL__)`

  const render = (script: string, replacements: Record<string, string>): string => {
    let out = script
    for (const [token, value] of Object.entries(replacements)) out = out.replaceAll(token, value)
    return out
  }

  const run = async (script: string): Promise<any> => {
    const raw = await page.evaluate(id, script, 30_000)
    if (typeof raw !== 'string') return { ok: false, error: 'the browser returned no result' }
    try {
      return JSON.parse(raw)
    } catch {
      return { ok: false, error: 'the fill result could not be parsed' }
    }
  }

  let result = await run(render(fillScript, {
    __USERNAME__: JSON.stringify(values.username),
    __PASSWORD__: JSON.stringify(values.password),
    __SUBMIT__: values.submit ? "'1'" : "'0'",
  }))

  if (result.ok !== true && result.error === 'no-password-field' && values.username !== '') {
    const email = await run(render(emailScript, { __EMAIL__: JSON.stringify(values.username) }))
    if (email.ok === true) {
      for (let attempt = 0; attempt < 7; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000))
        result = await run(render(fillScript, {
          __USERNAME__: JSON.stringify(values.username),
          __PASSWORD__: JSON.stringify(values.password),
          __SUBMIT__: values.submit ? "'1'" : "'0'",
        }))
        if (result.ok === true || result.error !== 'no-password-field') break
      }
    } else {
      result = { ok: false, error: email.error === 'no-email-field' ? 'no-password-field' : email.error }
    }
  }

  if (result.ok === true) await page.show(id).catch(() => undefined)
  return result
}

/** Fill a one-time code on the sidebar page over CDP. */
export async function fillTotpOnSidebar(exec: any, values: { code: string; submit: boolean }): Promise<any | undefined> {
  const session = await sessionFor(exec)
  if (session === undefined) return undefined
  const { page, id } = session
  const script = `(function (code, submitFlag) {
    const visible = (el) => {
      if (!el) return false
      const style = getComputedStyle(el)
      const rect = el.getBoundingClientRect()
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
    }
    const setValue = (el, value) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      if (setter) setter.call(el, value)
      else el.value = value
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    }
    const field = Array.from(document.querySelectorAll(
      'input[autocomplete="one-time-code"],input[inputmode="numeric"],input[name*="otp" i],input[name*="code" i],input[id*="otp" i],input[id*="code" i]'
    )).filter(visible)[0]
    if (!field) return JSON.stringify({ ok: false, error: 'no-otp-field' })
    setValue(field, code)
    let submitted = false
    if (submitFlag === '1') {
      const form = field.form
      const button = (form || document).querySelector('button[type="submit"],input[type="submit"]')
      if (button) { button.click(); submitted = true }
      else if (form && typeof form.requestSubmit === 'function') { form.requestSubmit(); submitted = true }
    }
    return JSON.stringify({ ok: true, submitted })
  })(__CODE__, __SUBMIT__)`
  const raw = await page.evaluate(id, script
    .replaceAll('__CODE__', JSON.stringify(values.code))
    .replaceAll('__SUBMIT__', values.submit ? "'1'" : "'0'"), 30_000)
  if (typeof raw !== 'string') return { ok: false, error: 'the browser returned no result' }
  try {
    return JSON.parse(raw)
  } catch {
    return { ok: false, error: 'the fill result could not be parsed' }
  }
}

/** One element lookup, as the expression that returns it (or null). */
function targetExpression(target: any): string {
  const by = String(target?.by ?? 'css')
  const value = String(target?.value ?? target?.text ?? '')
  if (by === 'ref') {
    return `document.querySelector('[data-dsh-ref="${Number(target?.ref ?? value) || 0}"]')`
  }
  if (by === 'xpath') {
    return `(() => { try { return document.evaluate(${JSON.stringify(value)}, document, null, 9, null).singleNodeValue } catch { return null } })()`
  }
  if (by === 'text') {
    return `(() => {
      const want = ${JSON.stringify(value)}
      if (want === '') return null
      const nodes = Array.from(document.querySelectorAll('a,button,[role=button],input,select,textarea,label,summary,li,td,h1,h2,h3,span,div'))
      const exact = nodes.find((el) => ((el.innerText || el.value || '') + '').trim() === want)
      if (exact !== undefined) return exact
      const partial = nodes.filter((el) => ((el.innerText || '') + '').trim().includes(want))
      partial.sort((a, b) => ((a.innerText || '') + '').length - ((b.innerText || '') + '').length)
      return partial[0] ?? null
    })()`
  }
  return `document.querySelector(${JSON.stringify(value)})`
}

/** Resolve a step target to viewport coordinates, clicking through the mouse. */
async function tapTarget(page: SidebarPage, id: number, target: any): Promise<boolean> {
  const expression = `(() => {
    const el = ${targetExpression(target)}
    if (el === null || el === undefined) return ''
    el.scrollIntoView({ block: 'center', inline: 'center' })
    const rect = el.getBoundingClientRect()
    return JSON.stringify({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })
  })()`
  const raw = await page.evaluate(id, expression, 15_000)
  if (typeof raw !== 'string' || raw === '') return false
  let point: any
  try {
    point = JSON.parse(raw)
  } catch {
    return false
  }
  if (typeof point?.x !== 'number' || typeof point?.y !== 'number') return false
  await mouse(page, id, 'mousePressed', point.x, point.y)
  await mouse(page, id, 'mouseReleased', point.x, point.y)
  return true
}

/** Fill one field the way a framework-controlled input expects. */
async function fillTarget(page: SidebarPage, id: number, target: any, text: string, submit: boolean): Promise<boolean> {
  const expression = `(() => {
    const el = ${targetExpression(target)}
    if (el === null || el === undefined) return false
    el.focus()
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
    if (setter) setter.call(el, ${JSON.stringify(text)})
    else el.value = ${JSON.stringify(text)}
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    ${submit ? `if (el.form && typeof el.form.requestSubmit === 'function') el.form.requestSubmit()` : ''}
    return true
  })()`
  return (await page.evaluate(id, expression, 15_000)) === true
}

/**
 * A whole flow in one call.
 *
 * Every step costs one CDP round trip, and a tool call costs a model turn, so a
 * batch is what turns "twenty calls and forty seconds" into one call. The steps
 * are the same vocabulary the old dsh_browser_do used, which is what made that
 * pattern portable in the first place.
 */
async function runSteps(page: SidebarPage, id: number, steps: any[], args: any): Promise<any> {
  const results: { step: number; value: any }[] = []
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index]
    if (step === null || typeof step !== 'object') continue
    const key = Object.keys(step)[0]
    const value = (step as any)[key]
    try {
      if (key === 'open') {
        await page.navigate(id, String(value ?? ''), 30_000)
      } else if (key === 'tap' || key === 'click') {
        const ok = await tapTarget(page, id, value)
        if (!ok) return { ok: false, error: `step ${index + 1}: no element matched ${JSON.stringify(value)}`, steps: results }
      } else if (key === 'field' || key === 'fill') {
        const ok = await fillTarget(page, id, value?.target ?? value, String(value?.text ?? ''), value?.submit === true)
        if (!ok) return { ok: false, error: `step ${index + 1}: no field matched ${JSON.stringify(value?.target ?? value)}`, steps: results }
      } else if (key === 'type') {
        await page.cdp(id, 'Input.insertText', { text: String(value ?? '') }, 15_000)
      } else if (key === 'key') {
        const mapped = KEYS[String(value)]
        if (mapped === undefined) {
          await page.cdp(id, 'Input.insertText', { text: String(value ?? '') }, 10_000)
        } else {
          for (const type of ['keyDown', 'keyUp']) {
            await page.cdp(id, 'Input.dispatchKeyEvent', { type, key: mapped.code, code: mapped.code, windowsVirtualKeyCode: mapped.keyCode }, 10_000)
          }
        }
      } else if (key === 'scroll') {
        await page.cdp(id, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: 200, y: 300, deltaX: 0, deltaY: Number(value) || 600 }, 10_000)
      } else if (key === 'sleep_ms') {
        await new Promise((resolve) => setTimeout(resolve, Math.min(Number(value) || 0, 30_000)))
      } else if (key === 'eval') {
        const evaluated = await page.evaluate(id, String(value ?? ''), 25_000)
        results.push({ step: index + 1, value: evaluated })
        if (typeof evaluated === 'string' && evaluated.startsWith('[JSON]')) {
          results.push({ step: index + 1, value: evaluated.slice(6) })
        }
      } else if (key === 'wait_text' || key === 'wait_gone') {
        const text = String(value ?? '')
        const want = key === 'wait_text'
        const deadline = Date.now() + 15_000
        let seen = false
        while (Date.now() < deadline) {
          seen = (await page.evaluate(id, `document.body ? document.body.innerText.includes(${JSON.stringify(text)}) : false`, 5_000)) === true
          if (seen === want) break
          await new Promise((resolve) => setTimeout(resolve, 200))
        }
        if (seen !== want) return { ok: false, error: `step ${index + 1}: "${text}" never ${want ? 'appeared' : 'disappeared'}`, steps: results }
      } else if (key === 'wait_url') {
        const wanted = String(value ?? '')
        const deadline = Date.now() + 15_000
        let current = ''
        while (Date.now() < deadline) {
          current = await page.url(id)
          if (current.includes(wanted)) break
          await new Promise((resolve) => setTimeout(resolve, 200))
        }
        if (!current.includes(wanted)) return { ok: false, error: `step ${index + 1}: the page never reached ${wanted} (at ${current})`, steps: results }
      } else if (key === 'wait_idle') {
        await page.evaluate(id, `new Promise((resolve) => { if (document.readyState === 'complete') resolve(true); else window.addEventListener('load', () => resolve(true), { once: true }) })`, 20_000)
      } else if (key === 'check') {
        const spec = value ?? {}
        const expression = spec.selector !== undefined
          ? `document.querySelector(${JSON.stringify(String(spec.selector))}) !== null`
          : spec.url !== undefined
            ? `location.href.includes(${JSON.stringify(String(spec.url))})`
            : `(document.body ? document.body.innerText.includes(${JSON.stringify(String(spec.text ?? ''))}) : false)`
        const ok = (await page.evaluate(id, expression, 10_000)) === true
        if (!ok) return { ok: false, error: `step ${index + 1}: check failed ${JSON.stringify(spec)}`, steps: results }
      }
    } catch (error) {
      return { ok: false, error: `step ${index + 1} (${key}): ${error instanceof Error ? error.message : String(error)}`, steps: results }
    }
  }
  const primary = results.length > 0 ? results[results.length - 1].value : undefined
  return { ok: true, steps: results, value: typeof primary === 'string' ? primary : undefined, url: await page.url(id) }
}

function parseSnapshot(raw: unknown): { url: string; title: string; text: string; rows: string[]; headings: string[] } {
  if (typeof raw !== 'string') return { url: '', title: '', text: '', rows: [], headings: [] }
  try {
    const parsed = JSON.parse(raw)
    return {
      url: String(parsed?.url ?? ''),
      title: String(parsed?.title ?? ''),
      text: String(parsed?.text ?? ''),
      rows: Array.isArray(parsed?.rows) ? parsed.rows.map(String) : [],
      headings: Array.isArray(parsed?.headings) ? parsed.headings.map(String) : [],
    }
  } catch {
    return { url: '', title: '', text: '', rows: [], headings: [] }
  }
}
