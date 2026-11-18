import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { registerTool } from './compat.js'
import { runCdpOp } from './browser-cdp.js'

type Request = (op: string, args: any, waitMs?: number) => Promise<any>

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024

function mimeFor(name: string): string {
  const extension = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  const table: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    pdf: 'application/pdf',
    txt: 'text/plain',
    csv: 'text/csv',
    json: 'application/json',
    zip: 'application/zip',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  }
  return table[extension] ?? 'application/octet-stream'
}

export function registerBrowserTools(
  ctx: any,
  request: Request,
  textRender: (fn: (value: any) => string) => any,
): void {
  /**
   * One browser operation on whichever carrier can serve it.
   *
   * The desktop bridge is tried first: it drives the same page the user sees in
   * the official sidebar, and Chrome DevTools Protocol is a far better fit for
   * automation than a webview round trip. Anything it cannot do — file upload,
   * a host without the bridge — falls through to the renderer implementation.
   */
  const dispatch = async (op: string, args: any, exec: any, timeoutMs?: number): Promise<any> => {
    try {
      const viaCdp = await runCdpOp(op, args, exec)
      if (viaCdp !== undefined) return viaCdp
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    return await request(op, args, timeoutMs)
  }

  const register = (definition: any, label: string): void => {
    // One toolset, whatever carrier answers underneath: the desktop bridge
    // drives the official sidebar panel, and the renderer webview takes over
    // when no bridge is installed. Registering unconditionally is deliberate —
    // gating these behind "no other browser plugin" left the model holding a
    // third-party stack whose own view binding could stop attaching.
    registerTool(ctx, defineTool(definition), `dsh-access: ${label}`)
  }

  register({
    name: 'access_browser_open',
    description: 'Open or navigate the sidebar browser of the DSH desktop app. Use action "open" with a URL, or "back"/"forward"/"reload"/"stop" to drive the current page. The Browser tab is opened or focused automatically. Only http(s) is accepted; if the Harness page runs in a plain web browser, automation is unavailable and the tool reports that.',
    parameters: {
      action: { type: 'string', description: 'open (default), back, forward, reload, or stop.' },
      url: { type: 'string', description: 'Absolute http:// or https:// URL for action "open".' },
      newTab: { type: 'boolean', description: 'Open a new sidebar browser tab when possible.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          url: { type: 'string' },
          title: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: textRender((value) => value?.ok === true
        ? `Browser: ${value.url ?? ''}${value.title ? ` — ${value.title}` : ''}`
        : `Browser action failed: ${value?.error ?? 'unknown error'}`),
    },
    execute: async (args: any, exec: any) => {
      exec.signal.throwIfAborted()
      const action = String(args?.action ?? 'open')
      if (['back', 'forward', 'reload', 'stop'].includes(action)) {
        try {
          const result = await dispatch('browser.history', { action }, exec)
          return { ok: true, url: String(result?.url ?? '') }
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) }
        }
      }
      const url = typeof args?.url === 'string' ? args.url.trim() : ''
      if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'Only absolute http(s) URLs are supported.' }
      try {
        return await dispatch('browser.open', { url, newTab: args?.newTab === true, sessionId: String(exec.agent?.id ?? '') }, exec)
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  }, 'access_browser_open')

  register({
    name: 'access_browser_snapshot',
    description: 'Return an actionable snapshot of the current sidebar browser page: interactive elements with stable refs, headings, links, inputs and buttons. Take a snapshot before clicking or typing, and take a new one after the page changes. Password fields appear as [password] with their value redacted; never type into them with access_browser_type — use access_login instead.',
    parameters: {
      maxNodes: { type: 'number', description: 'Maximum nodes to include (default 400, max 2000).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          url: { type: 'string' },
          title: { type: 'string' },
          text: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: textRender((value) => value?.ok === true
        ? `URL: ${value.url ?? ''}\nTitle: ${value.title ?? ''}\n${value.text ?? ''}`
        : `Snapshot failed: ${value?.error ?? 'unknown error'}`),
    },
    execute: async (args: any, exec: any) => {
      exec.signal.throwIfAborted()
      try {
        return await dispatch('browser.snapshot', { maxNodes: Number(args?.maxNodes) || 400 }, exec)
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  }, 'access_browser_snapshot')

  register({
    name: 'access_browser_read',
    description: 'Return the visible text of the current sidebar browser page (trimmed and length-capped). Use it to read articles, documentation or search results; use access_browser_snapshot when you need to click or type.',
    parameters: {
      maxChars: { type: 'number', description: 'Maximum characters (default 12000, max 60000).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          url: { type: 'string' },
          title: { type: 'string' },
          text: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: textRender((value) => value?.ok === true
        ? `URL: ${value.url ?? ''}\nTitle: ${value.title ?? ''}\n\n${value.text ?? ''}`
        : `Read failed: ${value?.error ?? 'unknown error'}`),
    },
    execute: async (args: any, exec: any) => {
      exec.signal.throwIfAborted()
      try {
        return await dispatch('browser.read', { maxChars: Number(args?.maxChars) || 12000 }, exec)
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  }, 'access_browser_read')

  register({
    name: 'access_browser_click',
    description: 'Click an element in the sidebar browser by its snapshot ref, or by viewport coordinates (x/y) for canvas and cross-origin iframes. Prefer refs from the latest snapshot; a stale ref returns an error and you should snapshot again.',
    parameters: {
      ref: { type: 'number', description: 'Ref number from the latest access_browser_snapshot.' },
      x: { type: 'number', description: 'Viewport x coordinate when no ref is used.' },
      y: { type: 'number', description: 'Viewport y coordinate when no ref is used.' },
      button: { type: 'number', description: '0 left, 1 middle, 2 right (default 0).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          tag: { type: 'string' },
          text: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: textRender((value) => value?.ok === true
        ? `Clicked ${value.tag ?? 'element'}${value.text ? ` "${value.text}"` : ''}.`
        : `Click failed: ${value?.error ?? 'unknown error'}`),
    },
    execute: async (args: any, exec: any) => {
      exec.signal.throwIfAborted()
      try {
        return await dispatch('browser.click', {
          ref: Number(args?.ref) || 0,
          x: args?.x,
          y: args?.y,
          button: Number(args?.button) || 0,
        }, exec)
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  }, 'access_browser_click')

  register({
    name: 'access_browser_type',
    description: 'Type into a text field in the sidebar browser by snapshot ref (or the focused element when ref is omitted). This refuses password fields: use access_login for sign-in forms. Set submit=true to submit the surrounding form, and clear=false to append instead of replace.',
    parameters: {
      ref: { type: 'number', description: 'Ref number from the latest snapshot; omit to use the focused element.' },
      text: { type: 'string', required: true, description: 'Text to type.' },
      submit: { type: 'boolean', description: 'Submit the surrounding form after typing.' },
      clear: { type: 'boolean', description: 'Replace the current value (default true); false appends.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          error: { type: 'string' },
        },
      },
      render: textRender((value) => value?.ok === true ? 'Typed.' : `Type failed: ${value?.error ?? 'unknown error'}`),
    },
    execute: async (args: any, exec: any) => {
      exec.signal.throwIfAborted()
      try {
        return await dispatch('browser.type', {
          ref: Number(args?.ref) || 0,
          text: String(args?.text ?? ''),
          submit: args?.submit === true,
          clear: args?.clear !== false,
        }, exec)
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  }, 'access_browser_type')

  register({
    name: 'access_browser_key',
    description: 'Press a key or shortcut in the sidebar browser, such as Enter, Tab, Escape, ArrowDown, or a letter with modifiers. Use it after focusing a field or to drive keyboard-only interfaces.',
    parameters: {
      key: { type: 'string', required: true, description: 'Electron key name: Enter, Tab, Escape, Backspace, ArrowUp/Down/Left/Right, or a single character.' },
      modifiers: { type: 'array', items: { type: 'string' }, description: 'Modifiers: control, shift, alt, meta.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          error: { type: 'string' },
        },
      },
      render: textRender((value) => value?.ok === true ? 'Key pressed.' : `Key failed: ${value?.error ?? 'unknown error'}`),
    },
    execute: async (args: any, exec: any) => {
      exec.signal.throwIfAborted()
      try {
        return await dispatch('browser.key', {
          key: String(args?.key ?? ''),
          modifiers: Array.isArray(args?.modifiers) ? args.modifiers.map(String) : [],
        }, exec)
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  }, 'access_browser_key')

  register({
    name: 'access_browser_scroll',
    description: 'Scroll the sidebar browser page. Positive deltaY scrolls down, negative scrolls up; pass a ref to bring a specific element into view instead.',
    parameters: {
      deltaY: { type: 'number', description: 'Pixels to scroll (default 600).' },
      ref: { type: 'number', description: 'Optional snapshot ref to scroll into view.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          error: { type: 'string' },
        },
      },
      render: textRender((value) => value?.ok === true ? 'Scrolled.' : `Scroll failed: ${value?.error ?? 'unknown error'}`),
    },
    execute: async (args: any, exec: any) => {
      exec.signal.throwIfAborted()
      try {
        return await dispatch('browser.scroll', { deltaY: Number(args?.deltaY) || 600, ref: Number(args?.ref) || 0 }, exec)
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  }, 'access_browser_scroll')

  register({
    name: 'access_browser_action',
    description: 'Perform hover, select or drag in the sidebar browser. hover uses a ref or x/y; select sets a <select> value by ref; drag moves from a ref/coordinate to another ref/coordinate.',
    parameters: {
      action: { type: 'string', required: true, description: 'hover, select, or drag.' },
      ref: { type: 'number', description: 'Target ref for hover/select.' },
      value: { type: 'string', description: 'Option value or label for select.' },
      fromRef: { type: 'number', description: 'Drag source ref.' },
      toRef: { type: 'number', description: 'Drag target ref.' },
      x: { type: 'number', description: 'Hover/drag source x when no ref.' },
      y: { type: 'number', description: 'Hover/drag source y when no ref.' },
      toX: { type: 'number', description: 'Drag target x when no toRef.' },
      toY: { type: 'number', description: 'Drag target y when no toRef.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          value: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: textRender((value) => value?.ok === true ? 'Action completed.' : `Action failed: ${value?.error ?? 'unknown error'}`),
    },
    execute: async (args: any, exec: any) => {
      exec.signal.throwIfAborted()
      try {
        return await dispatch('browser.action', {
          action: String(args?.action ?? ''),
          ref: Number(args?.ref) || 0,
          value: String(args?.value ?? ''),
          fromRef: Number(args?.fromRef) || 0,
          toRef: Number(args?.toRef) || 0,
          x: args?.x,
          y: args?.y,
          toX: args?.toX,
          toY: args?.toY,
        }, exec)
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  }, 'access_browser_action')

  register({
    name: 'access_browser_file',
    description: 'Upload a local file into a file input in the sidebar browser (action upload, with the snapshot ref of the input and an absolute local path), or start a download from a URL or a download link ref (action download). Uploads are capped at 25 MB. Page-initiated downloads may show the system save dialog.',
    parameters: {
      action: { type: 'string', required: true, description: 'upload or download.' },
      ref: { type: 'number', description: 'File input ref for upload, or link ref for download.' },
      path: { type: 'string', description: 'Absolute local file path for upload.' },
      url: { type: 'string', description: 'http(s) URL for download.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          name: { type: 'string' },
          size: { type: 'number' },
          started: { type: 'boolean' },
          error: { type: 'string' },
        },
      },
      render: textRender((value) => value?.ok === true
        ? (value.started ? 'Download started.' : `Uploaded ${value.name ?? 'file'} (${value.size ?? 0} bytes).`)
        : `File action failed: ${value?.error ?? 'unknown error'}`),
    },
    execute: async (args: any, exec: any) => {
      exec.signal.throwIfAborted()
      const action = String(args?.action ?? '')
      try {
        if (action === 'upload') {
          const path = String(args?.path ?? '')
          if (path === '') return { ok: false, error: 'path is required for upload' }
          const bytes = await readFile(path)
          if (bytes.length > MAX_UPLOAD_BYTES) return { ok: false, error: 'File is larger than the 25 MB upload limit.' }
          const name = basename(path)
          return await dispatch('browser.file', {
            action: 'upload',
            ref: Number(args?.ref) || 0,
            name,
            mime: mimeFor(name),
            data: bytes.toString('base64'),
          }, exec, 60000)
        }
        if (action === 'download') {
          return await dispatch('browser.file', {
            action: 'download',
            url: String(args?.url ?? ''),
            ref: Number(args?.ref) || 0,
          }, exec)
        }
        return { ok: false, error: `Unknown file action: ${action}` }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  }, 'access_browser_file')

  register({
    name: 'access_browser_view',
    description: 'Find text in the sidebar browser page (action find), change zoom (action zoom, factor 0.25–5), or wait until a selector/text appears (action wait). Wait is useful after navigation or a click that triggers async content.',
    parameters: {
      action: { type: 'string', required: true, description: 'find, zoom, or wait.' },
      text: { type: 'string', description: 'Text to find or wait for.' },
      selector: { type: 'string', description: 'CSS selector to wait for.' },
      factor: { type: 'number', description: 'Zoom factor for action zoom.' },
      ms: { type: 'number', description: 'Wait timeout in milliseconds (default 10000, max 60000).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          matches: { type: 'number' },
          activeMatchOrdinal: { type: 'number' },
          factor: { type: 'number' },
          matched: { type: 'string' },
          elapsedMs: { type: 'number' },
          error: { type: 'string' },
        },
      },
      render: textRender((value) => {
        if (value?.ok !== true) return `View action failed: ${value?.error ?? 'unknown error'}`
        if (typeof value.factor === 'number') return `Zoom set to ${value.factor}.`
        if (typeof value.matches === 'number') return `Found ${value.matches} match(es); active match ${value.activeMatchOrdinal}.`
        return `Matched ${value.matched ?? 'condition'} after ${value.elapsedMs ?? 0}ms.`
      }),
    },
    execute: async (args: any, exec: any) => {
      exec.signal.throwIfAborted()
      try {
        return await dispatch('browser.view', {
          action: String(args?.action ?? ''),
          text: String(args?.text ?? ''),
          selector: String(args?.selector ?? ''),
          factor: Number(args?.factor) || 1,
          ms: Number(args?.ms) || 10000,
        }, exec, 70000)
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  }, 'access_browser_view')

  register({
    name: 'access_browser_tabs',
    description: 'List, open, focus or close sidebar browser tabs. Use it when a link opened a new tab or when you need a fresh tab for a different site.',
    parameters: {
      action: { type: 'string', required: true, description: 'list, open, focus, or close.' },
      tabId: { type: 'string', description: 'Tab id for focus/close.' },
      url: { type: 'string', description: 'URL for action open.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          tabs: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                tabId: { type: 'string' },
                title: { type: 'string' },
                url: { type: 'string' },
              },
            },
          },
          error: { type: 'string' },
        },
      },
      render: textRender((value) => {
        if (value?.ok !== true) return `Tabs failed: ${value?.error ?? 'unknown error'}`
        if (!Array.isArray(value.tabs)) return 'Tab action completed.'
        if (value.tabs.length === 0) return 'No browser tabs are open.'
        return value.tabs.map((tab: any) => `${tab.tabId} — ${tab.title || tab.url || '(untitled)'}`).join('\n')
      }),
    },
    execute: async (args: any, exec: any) => {
      exec.signal.throwIfAborted()
      try {
        return await dispatch('browser.tabs', {
          action: String(args?.action ?? 'list'),
          tabId: String(args?.tabId ?? ''),
          url: String(args?.url ?? ''),
        }, exec)
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  }, 'access_browser_tabs')

  register({
    name: 'access_browser_do',
    description: 'Run a whole browser flow in ONE call: a list of steps executed in order, stopping at the first that cannot proceed. Use this instead of one tool call per click — every separate call costs a model turn and a settle probe, while these steps cost one DevTools round trip each. Step keys: {"open":"https://…"}, {"tap":{"by":"text","value":"Sign in"}}, {"field":{"target":{"by":"css","value":"#email"},"text":"a@b.c","submit":true}}, {"type":"text into the focused element"}, {"key":"Enter"}, {"scroll":600}, {"sleep_ms":500}, {"wait_text":"Done"}, {"wait_gone":"Loading"}, {"wait_url":"/account"}, {"wait_idle":{}}, {"eval":"(() => …)()"} (return value comes back in steps[]), {"check":{"text":"…"|"selector":"…"|"url":"…"}}. Targets may be {"by":"css"|"text"|"xpath"|"ref"}. Needs the desktop bridge; without it use the individual access_browser_* tools.',
    parameters: {
      steps: {
        type: 'array',
        items: { type: 'object', additionalProperties: true },
        description: 'Steps to run in order. See the description for the accepted keys.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          url: { type: 'string' },
          value: { type: 'string' },
          error: { type: 'string' },
          steps: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
      },
      render: textRender((value) => {
        if (value?.ok !== true) return `Flow failed: ${value?.error ?? 'unknown error'}`
        const text = typeof value.value === 'string' && value.value !== '' ? ` Value: ${value.value}` : ''
        return `Flow completed (${Array.isArray(value.steps) ? value.steps.length : 0} result step(s)).${text}`
      }),
    },
    execute: async (args: any, exec: any) => {
      exec.signal.throwIfAborted()
      try {
        // Batching is a CDP affordance: it needs the desktop bridge. The renderer
        // webview carrier has no step runner, and pretending otherwise would turn
        // one clear message into a stack of half-run flows.
        const result = await runCdpOp('browser.do', { steps: Array.isArray(args?.steps) ? args.steps : [] }, exec)
        if (result === undefined) {
          return {
            ok: false,
            error: 'Batching needs the desktop bridge (the dsh-builtin-browser bridge must be installed and running). Without it, call the individual access_browser_* tools step by step.',
          }
        }
        return result
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  }, 'access_browser_do')

  register({
    name: 'access_browser_screenshot',
    description: 'Capture a PNG screenshot of the visible sidebar browser page and save it to a temporary file. Password fields are blurred before capture. Use read_image with the returned path to view it.',
    parameters: {
      fullPage: { type: 'boolean', description: 'Reserved; the sidebar browser captures the visible viewport.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          path: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: textRender((value) => value?.ok === true
        ? `Screenshot saved to ${value.path}. Use read_image to view it.`
        : `Screenshot failed: ${value?.error ?? 'unknown error'}`),
    },
    execute: async (_args: any, exec: any) => {
      exec.signal.throwIfAborted()
      try {
        const result = await dispatch('browser.screenshot', {}, exec, 30000)
        if (!result?.ok || typeof result.data !== 'string') return { ok: false, error: result?.error ?? 'No image data.' }
        const directory = join(tmpdir(), 'dsh-access')
        await mkdir(directory, { recursive: true })
        const path = join(directory, `shot-${Date.now()}.png`)
        await writeFile(path, Buffer.from(result.data, 'base64'))
        return { ok: true, path }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  }, 'access_browser_screenshot')
}
