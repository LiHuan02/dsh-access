import { hostOf } from './match'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function hiddenByAncestor(element: any): boolean {
  let node: any = element
  while (node && node !== document.body) {
    try {
      if (typeof node.hasAttribute === 'function' && (node.hasAttribute('hidden') || node.getAttribute('aria-hidden') === 'true')) return true
    } catch {
      // ignore
    }
    node = node.parentElement
  }
  return false
}

export function findBrowserWebview(): any {
  const webviews = Array.from(document.querySelectorAll('webview[data-sidebar-browser-frame="webview"]')) as any[]
  const usable = webviews.filter((element) => element.isConnected && !hiddenByAncestor(element))
  const visible = usable.find((element) => {
    try {
      const rect = element.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return false
      if (typeof element.checkVisibility === 'function') {
        return element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
      }
      return true
    } catch {
      return false
    }
  })
  return visible ?? usable[0] ?? webviews[0] ?? null
}

export function hasIframeBrowser(): boolean {
  return document.querySelector('iframe[data-sidebar-browser-frame="iframe"]') !== null
}

export function activeBrowserUrl(): string {
  try {
    const webview = findBrowserWebview()
    return webview && typeof webview.getURL === 'function' ? String(webview.getURL() ?? '') : ''
  } catch {
    return ''
  }
}

export function waitForBrowserWebview(timeoutMs: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = () => {
      const element = findBrowserWebview()
      if (element) {
        resolve(element)
        return
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error(hasIframeBrowser()
          ? 'The sidebar browser is running as a sandboxed iframe in this browser; browser automation requires the DSH desktop app.'
          : 'The built-in sidebar browser did not appear. Open a Browser tab in the right sidebar and try again.'))
        return
      }
      setTimeout(tick, 100)
    }
    tick()
  })
}

export function waitForDomReady(webview: any, timeoutMs: number): Promise<void> {
  try {
    const current = typeof webview.getURL === 'function' ? webview.getURL() : ''
    if (typeof current === 'string' && current !== '') return Promise.resolve()
  } catch {
    // fall through to the event
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('The built-in sidebar browser did not become ready in time.'))
    }, timeoutMs)
    const onReady = () => {
      cleanup()
      resolve()
    }
    const cleanup = () => {
      clearTimeout(timer)
      try {
        webview.removeEventListener('dom-ready', onReady)
      } catch {
        // ignore
      }
    }
    try {
      webview.addEventListener('dom-ready', onReady)
    } catch (error) {
      cleanup()
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

export function waitForLoad(webview: any, timeoutMs: number): Promise<void> {
  try {
    if (typeof webview.isLoading === 'function' && !webview.isLoading()) return Promise.resolve()
  } catch {
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, timeoutMs)
    const finish = () => {
      cleanup()
      resolve()
    }
    const cleanup = () => {
      clearTimeout(timer)
      try {
        webview.removeEventListener('did-finish-load', finish)
        webview.removeEventListener('did-fail-load', finish)
      } catch {
        // ignore
      }
    }
    try {
      webview.addEventListener('did-finish-load', finish)
      webview.addEventListener('did-fail-load', finish)
    } catch {
      cleanup()
      resolve()
    }
  })
}

export async function openInBuiltinBrowser(ctx: any, args: any): Promise<any> {
  const url = String(args?.url ?? '').trim()
  if (!/^https?:\/\//i.test(url)) throw new Error('Only absolute http(s) URLs are supported.')

  const sessionId = String(args?.sessionId ?? '')
  const sidebar = ctx.get('sidebarRight')
  if (sessionId && sidebar && typeof sidebar.openTabIn === 'function') {
    sidebar.openTabIn(sessionId, 'browser', { params: { url } })
    await new Promise((resolve) => setTimeout(resolve, 1200))
    return { ok: true, url, title: '' }
  }

  let webview = findBrowserWebview()
  if (webview && args?.newTab === true && sidebar && typeof sidebar.openTab === 'function') {
    sidebar.openTab('browser', { params: { url } })
    webview = await waitForBrowserWebview(12000)
  }
  if (!webview) {
    if (!sidebar || typeof sidebar.openTab !== 'function') {
      throw new Error('The right sidebar service is unavailable in this page.')
    }
    sidebar.openTab('browser', { params: { url } })
    webview = await waitForBrowserWebview(12000)
  }

  if (webview.tagName !== 'WEBVIEW') {
    throw new Error('The sidebar browser is not a desktop webview; browser automation is unavailable here.')
  }

  await waitForDomReady(webview, 12000)
  try {
    await webview.loadURL(url)
  } catch (error: any) {
    const code = error?.code ?? error?.errno
    if (code !== 'ERR_ABORTED' && code !== -3) throw error
  }
  await waitForLoad(webview, 15000)

  const finalUrl = typeof webview.getURL === 'function' ? webview.getURL() : url
  const title = typeof webview.getTitle === 'function' ? webview.getTitle() : ''
  return { ok: true, url: finalUrl || url, title: title || '' }
}

export async function ensureBrowserForSite(ctx: any, site: string, sessionId = ''): Promise<any> {
  const host = hostOf(site)
  if (host === '') throw new Error('A site host is required to fill credentials.')
  const sidebar = ctx.get('sidebarRight')
  if (sessionId && sidebar && typeof sidebar.openTabIn === 'function') {
    sidebar.openTabIn(sessionId, 'browser', { params: { url: `https://${host}` } })
    return { ok: true, site: host, sessionId }
  }
  let webview = findBrowserWebview()
  if (!webview) {
    if (!sidebar || typeof sidebar.openTab !== 'function') {
      throw new Error('The right sidebar service is unavailable in this page.')
    }
    sidebar.openTab('browser', { params: { url: `https://${host}` } })
    webview = await waitForBrowserWebview(12000)
  }
  if (webview.tagName !== 'WEBVIEW') {
    throw new Error('The sidebar browser is not a desktop webview; automatic filling is unavailable here.')
  }
  await waitForDomReady(webview, 12000)
  const current = typeof webview.getURL === 'function' ? String(webview.getURL() ?? '') : ''
  if (hostOf(current) !== host) {
    try {
      await webview.loadURL(`https://${host}`)
    } catch (error: any) {
      const code = error?.code ?? error?.errno
      if (code !== 'ERR_ABORTED' && code !== -3) throw error
    }
    await waitForLoad(webview, 15000)
  }
  return webview
}

export async function fillInBuiltinBrowser(ctx: any, input: {
  site: string
  username: string
  password: string
  submit: boolean
}): Promise<{ ok: boolean; submitted?: boolean; user?: boolean; error?: string }> {
  const webview = await ensureBrowserForSite(ctx, input.site)
  const username = JSON.stringify(String(input.username ?? ''))
  const password = JSON.stringify(String(input.password ?? ''))
  const submit = input.submit === true
  const script = `(() => {
    const USERNAME = ${username};
    const PASSWORD = ${password};
    const SUBMIT = ${submit};
    const visible = (element) => {
      try {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      } catch { return false; }
    };
    const setValue = (element, value) => {
      const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value') && Object.getOwnPropertyDescriptor(proto, 'value').set;
      if (setter) setter.call(element, value);
      else element.value = value;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const passwordField = [...document.querySelectorAll('input[type="password"]')].find(visible);
    if (!passwordField) return { ok: false, error: 'no-password-field' };
    const candidates = [...document.querySelectorAll('input[autocomplete="username"], input[type="email"], input[type="text"], input[name*="user" i], input[id*="user" i], input[name*="email" i], input[id*="email" i]')];
    const userField = candidates.find((element) => element !== passwordField && visible(element)) || null;
    if (userField) setValue(userField, USERNAME);
    setValue(passwordField, PASSWORD);
    passwordField.focus();
    if (SUBMIT) {
      const form = passwordField.form;
      const button = (form && form.querySelector('button[type="submit"], input[type="submit"]'))
        || [...document.querySelectorAll('button, [role="button"]')].find((element) => /sign\\s*in|log\\s*in|登录|登陆/i.test(element.textContent || ''));
      if (button) { button.click(); return { ok: true, submitted: true, user: !!userField }; }
      if (form && typeof form.requestSubmit === 'function') { form.requestSubmit(); return { ok: true, submitted: true, user: !!userField }; }
    }
    return { ok: true, submitted: false, user: !!userField };
  })()`
  try {
    const result = await webview.executeJavaScript(script, true)
    if (!result || result.ok !== true) return { ok: false, error: String(result?.error ?? 'no-password-field') }
    return { ok: true, submitted: result.submitted === true, user: result.user === true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function fillTotpInBuiltinBrowser(ctx: any, input: {
  site: string
  code: string
}): Promise<{ ok: boolean; submitted?: boolean; error?: string }> {
  const webview = await ensureBrowserForSite(ctx, input.site)
  const code = JSON.stringify(String(input.code ?? ''))
  const script = `(() => {
    const CODE = ${code};
    const visible = (element) => {
      try {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      } catch { return false; }
    };
    const setValue = (element, value) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value') && Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      if (setter) setter.call(element, value);
      else element.value = value;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const field = [...document.querySelectorAll('input[autocomplete="one-time-code"], input[inputmode="numeric"], input[name*="otp" i], input[id*="otp" i], input[name*="code" i], input[id*="code" i]')].find(visible);
    if (!field) return { ok: false, error: 'no-otp-field' };
    setValue(field, CODE);
    field.focus();
    const form = field.form;
    const button = form && form.querySelector('button[type="submit"], input[type="submit"]');
    if (button) button.click();
    else if (form && typeof form.requestSubmit === 'function') form.requestSubmit();
    return { ok: true, submitted: true };
  })()`
  try {
    const result = await webview.executeJavaScript(script, true)
    if (!result || result.ok !== true) return { ok: false, error: String(result?.error ?? 'no-otp-field') }
    return { ok: true, submitted: result.submitted === true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
