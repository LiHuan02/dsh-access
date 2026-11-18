/**
 * Bridge to the community `dsh-builtin-browser` plugin (dsh_browser_* tools).
 *
 * dsh-access deliberately does not ship a second browser engine. When that
 * plugin is installed it owns navigation, CDP, tabs and session lifecycle; we
 * only ask it to open a URL and to run the credential-fill snippet, using the
 * caller's DSH session so the model's own dsh_browser_* calls land in the same
 * browser session.
 */

import { callTool, findTool } from './compat.js'
import { runCdpOp } from './browser-cdp.js'
import { sidebarPage } from './sidebar-cdp.js'

export type BrowserEngine = 'external' | 'builtin'

export function hasExternalBrowser(ctx: any, scope?: any): boolean {
  return findTool(ctx, 'dsh_browser_open', scope) !== undefined && findTool(ctx, 'dsh_browser_execute', scope) !== undefined
}

export function externalToolNames(ctx: any, scope?: any): string[] {
  const names = ['dsh_browser_open', 'dsh_browser_execute', 'dsh_browser_snapshot', 'dsh_browser_fill', 'dsh_browser_type', 'dsh_browser_click']
  return names.filter((name) => findTool(ctx, name, scope) !== undefined)
}

export function toUrl(site: string): string | undefined {
  const raw = String(site ?? '').trim()
  if (raw === '') return undefined
  if (/^https?:\/\//i.test(raw)) {
    try {
      return new URL(raw).href
    } catch {
      return undefined
    }
  }
  try {
    return new URL(`https://${raw}`).href
  } catch {
    return undefined
  }
}

/**
 * Open the target page in the shared browser. Returns false when the plugin is
 * absent or the open failed; the caller then falls back to the built-in
 * sidebar browser instead of failing the login request.
 *
 * The sidebar panel over CDP is tried first, for the same reason the browser
 * tools are: it is the carrier this plugin drives itself, and the third-party
 * tool layer can stop attaching between restarts while the panel itself is fine.
 */
export async function openInExternalBrowser(ctx: any, site: string, exec: any): Promise<boolean> {
  const url = toUrl(site)
  if (url === undefined) return false
  try {
    const viaCdp = await runCdpOp('browser.open', { url }, exec)
    if (viaCdp !== undefined) return viaCdp.ok === true
  } catch {
    // fall through to the third-party tool
  }
  try {
    await callTool(ctx, 'dsh_browser_open', { url }, exec)
    return true
  } catch {
    return false
  }
}

/** The current http(s) page of the shared browser, when there is one. */
export async function currentExternalUrl(ctx: any, exec: any): Promise<string | undefined> {
  try {
    const page = await sidebarPage(String(exec?.agent?.id ?? ''))
    if (page !== undefined) {
      const id = await page.ensure()
      const href = await page.url(id)
      if (/^https?:\/\//i.test(href)) return href
    }
  } catch {
    // no bridge, or no page yet: the third-party tool may still know better
  }
  try {
    const result = await callTool(ctx, 'dsh_browser_execute', { script: 'return location.href', args: [] }, exec)
    const value = result?.ok === true ? result.value : undefined
    if (typeof value === 'string' && /^https?:\/\//i.test(value)) return value
  } catch {
    // no session, blank page, or the tool moved; the caller falls back
  }
  return undefined
}

export interface FillResult {
  ok: boolean
  filledUsername?: boolean
  filledPassword?: boolean
  submitted?: boolean
  error?: string
}

const FILL_SCRIPT = `return (function (username, password, submitFlag) {
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
  if (!passwordField) return { ok: false, error: 'no-password-field' }
  const form = passwordField.form
  const scope = form || document
  const userCandidates = Array.from(scope.querySelectorAll(
    'input[type="email"],input[type="text"],input[autocomplete="username"],input[name*="user" i],input[name*="email" i],input[id*="user" i],input[id*="email" i]'
  )).filter((el) => visible(el) && el !== passwordField)
  const before = userCandidates.filter((el) => el.compareDocumentPosition(passwordField) & Node.DOCUMENT_POSITION_FOLLOWING)
  const userField = before[0] || userCandidates[0] || null
  const filledUsername = !!(userField && username)
  if (filledUsername) setValue(userField, username)
  const filledPassword = setValue(passwordField, password)
  let submitted = false
  if (submitFlag === '1') {
    const button = (form || document).querySelector('button[type="submit"],input[type="submit"]')
    if (button) {
      button.click()
      submitted = true
    } else if (form && typeof form.requestSubmit === 'function') {
      form.requestSubmit()
      submitted = true
    } else if (form && typeof form.submit === 'function') {
      form.submit()
      submitted = true
    }
  }
  return { ok: true, filledUsername, filledPassword, submitted }
})(arguments[0], arguments[1], arguments[2])`

const TOTP_SCRIPT = `return (function (code, submitFlag) {
  const visible = (el) => {
    if (!el) return false
    const style = getComputedStyle(el)
    const rect = el.getBoundingClientRect()
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
  }
  const setValue = (el, value) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
    if (setter) setter.call(el, value)
    else el.value = value
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }
  const candidates = Array.from(document.querySelectorAll(
    'input[autocomplete="one-time-code"],input[inputmode="numeric"],input[name*="otp" i],input[name*="code" i],input[id*="otp" i],input[id*="code" i]'
  )).filter(visible)
  const field = candidates[0]
  if (!field) return { ok: false, error: 'no-otp-field' }
  setValue(field, code)
  let submitted = false
  if (submitFlag === '1') {
    const form = field.form
    const button = (form || document).querySelector('button[type="submit"],input[type="submit"]')
    if (button) {
      button.click()
      submitted = true
    } else if (form && typeof form.requestSubmit === 'function') {
      form.requestSubmit()
      submitted = true
    } else if (form && typeof form.submit === 'function') {
      form.submit()
      submitted = true
    }
  }
  return { ok: true, submitted }
})(arguments[0], arguments[1])`

const EMAIL_SCRIPT = `return (function (email) {
  const visible = (el) => {
    if (!el) return false
    const style = getComputedStyle(el)
    const rect = el.getBoundingClientRect()
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
  }
  const setValue = (el, value) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
    if (setter) setter.call(el, value)
    else el.value = value
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }
  const candidates = Array.from(document.querySelectorAll(
    'input[type="email"],input[autocomplete="username"],input[name="loginfmt"],input[name="email"],input[id="identifierId"],input[type="text"]'
  )).filter(visible)
  const field = candidates[0]
  if (!field) return { ok: false, error: 'no-email-field' }
  setValue(field, email)
  const form = field.form
  const buttons = Array.from((form || document).querySelectorAll('button,input[type="submit"],input[type="button"]')).filter(visible)
  const byText = buttons.find((el) => /^(next|continue|sign in|log in|下一步|继续|登录)$/i.test(String(el.textContent || el.value || '').trim()))
  const bySubmit = buttons.find((el) => el.type === 'submit')
  const button = byText || bySubmit || null
  if (button) button.click()
  else if (form && typeof form.requestSubmit === 'function') form.requestSubmit()
  else if (form && typeof form.submit === 'function') form.submit()
  return { ok: true, filled: true }
})(arguments[0])`

function parseExecuteResult(result: any): FillResult {
  if (result?.ok !== true) {
    return { ok: false, error: typeof result?.exception === 'string' ? result.exception : 'the browser refused the fill script' }
  }
  const raw = result?.value
  if (typeof raw !== 'string') return { ok: false, error: 'the browser returned no result' }
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') return parsed as FillResult
    return { ok: false, error: 'the fill script returned an unexpected value' }
  } catch {
    return { ok: false, error: 'the fill script result could not be parsed' }
  }
}

export async function fillInExternalBrowser(
  ctx: any,
  values: { username: string; password: string; submit: boolean },
  exec: any,
): Promise<FillResult> {
  try {
    let result = await callTool(ctx, 'dsh_browser_execute', {
      script: FILL_SCRIPT,
      args: [values.username, values.password, values.submit ? '1' : '0'],
    }, exec).then(parseExecuteResult)
    // Google/Microsoft sign-in often shows the account field first and the
    // password on the next screen. Fill the account and continue once.
    if (!result.ok && result.error === 'no-password-field' && values.username !== '') {
      const email = await callTool(ctx, 'dsh_browser_execute', {
        script: EMAIL_SCRIPT,
        args: [values.username],
      }, exec).then(parseExecuteResult)
      if (email.ok) {
        for (let attempt = 0; attempt < 7; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000))
          result = await callTool(ctx, 'dsh_browser_execute', {
            script: FILL_SCRIPT,
            args: [values.username, values.password, values.submit ? '1' : '0'],
          }, exec).then(parseExecuteResult)
          if (result.ok || result.error !== 'no-password-field') break
        }
      } else {
        result = { ok: false, error: email.error === 'no-email-field' ? 'no-password-field' : email.error }
      }
    }
    return result
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function fillTotpInExternalBrowser(
  ctx: any,
  values: { code: string; submit: boolean },
  exec: any,
): Promise<FillResult> {
  try {
    const result = await callTool(ctx, 'dsh_browser_execute', {
      script: TOTP_SCRIPT,
      args: [values.code, values.submit ? '1' : '0'],
    }, exec)
    return parseExecuteResult(result)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
