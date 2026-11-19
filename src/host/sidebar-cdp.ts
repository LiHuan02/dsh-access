/**
 * The sidebar browser over the desktop bridge, without that bridge's own plugin.
 *
 * `dsh-builtin-browser` installs a small TCP server inside the DSH desktop shell.
 * The shell owns the sidebar's browser webviews and speaks CDP to them; the
 * server exposes that as two operations we care about:
 *
 *   ensureSidebar { owner, url } → the webview this conversation's sidebar shows
 *   cdp { owner, id, method, params } → any Chrome DevTools Protocol command
 *
 * Its own tool layer binds a logical view per conversation on top of those, and
 * that binding is the part that stops attaching between restarts — the ops
 * underneath keep working. So dsh-access drives the two ops directly and keeps
 * one tool surface on every carrier:
 *
 *   bridge present → the official sidebar panel, driven over CDP
 *   bridge absent  → DSH's built-in sidebar webview, driven in the renderer
 */

import { connect, type Socket } from 'node:net'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Where the shell publishes its bridge port and token. */
export function bridgeEndpointPath(): string {
  const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, 'dsh-builtin-browser-bridge.json')
}

interface Endpoint {
  port: number
  token: string
}

/**
 * One connection to the shell's bridge.
 *
 * The wire is newline-delimited JSON: the first field of every request is the
 * token, and answers come back in the order they were asked, with no request id
 * of their own. That last detail is why this class keeps a queue instead of a
 * map — matching on ids works only by accident, and misfires as soon as two
 * calls are in flight.
 */
export class BridgeConnection {
  private socket: Socket | undefined
  private buffer = ''
  private readonly waiting: { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }[] = []
  private connecting: Promise<void> | undefined
  private closed = false
  private failures = 0

  constructor(private readonly endpoint: Endpoint) {}

  /** Read the endpoint file and connect; undefined when no bridge is installed. */
  static async open(path = bridgeEndpointPath()): Promise<BridgeConnection | undefined> {
    let raw: string
    try {
      raw = await readFile(path, 'utf8')
    } catch {
      return undefined
    }
    let parsed: any
    try {
      parsed = JSON.parse(raw)
    } catch {
      return undefined
    }
    if (typeof parsed?.port !== 'number' || typeof parsed?.token !== 'string') return undefined
    const connection = new BridgeConnection({ port: parsed.port, token: parsed.token })
    try {
      await connection.ensure()
    } catch {
      return undefined
    }
    return connection
  }

  /** True once the shell answered at least one request on this connection. */
  get alive(): boolean {
    return this.socket !== undefined && !this.closed && this.failures < 3
  }

  async call(op: string, request: Record<string, unknown> = {}, timeoutMs = 20_000): Promise<any> {
    if (this.closed) throw new Error('the desktop bridge connection is closed')
    await this.ensure()
    return await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiting.findIndex((entry) => entry.reject === reject)
        if (index >= 0) this.waiting.splice(index, 1)
        reject(new Error(`${op} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.waiting.push({ resolve, reject, timer })
      this.socket?.write(`${JSON.stringify({ token: this.endpoint.token, op, ...request })}\n`)
    })
  }

  close(): void {
    this.closed = true
    this.fail()
    try {
      this.socket?.destroy()
    } catch {
      // a socket that is already gone is the state we wanted
    }
    this.socket = undefined
  }

  private async ensure(): Promise<void> {
    if (this.socket !== undefined) return
    if (this.connecting !== undefined) return await this.connecting
    this.connecting = new Promise<void>((resolve, reject) => {
      const socket = connect(this.endpoint.port, '127.0.0.1')
      const onError = (error: Error): void => {
        socket.destroy()
        this.socket = undefined
        reject(error)
      }
      socket.once('error', onError)
      socket.once('connect', () => {
        socket.off('error', onError)
        socket.on('error', () => this.fail())
        socket.on('close', () => this.fail())
        socket.on('data', (chunk) => this.drain(chunk))
        this.socket = socket
        resolve()
      })
    })
    try {
      await this.connecting
    } finally {
      this.connecting = undefined
    }
  }

  private drain(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8')
    let newline = this.buffer.indexOf('\n')
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      newline = this.buffer.indexOf('\n')
      if (line === '') continue
      let answer: any
      try {
        answer = JSON.parse(line)
      } catch {
        continue
      }
      const waiter = this.waiting.shift()
      if (waiter === undefined) continue
      clearTimeout(waiter.timer)
      if (answer?.ok === false && answer?.error === 'bad token') {
        // The shell restarted with a new token; this socket can never answer again.
        this.fail()
        waiter.reject(new Error('the desktop bridge rejected the token; restart DSH and retry'))
        continue
      }
      waiter.resolve(answer)
    }
  }

  private fail(): void {
    this.failures += 1
    const pending = this.waiting.splice(0, this.waiting.length)
    for (const waiter of pending) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error('the desktop bridge closed the connection'))
    }
    try {
      this.socket?.destroy()
    } catch {
      // already gone
    }
    this.socket = undefined
  }
}

/**
 * A page handle for one conversation, plus CDP on top of it.
 *
 * Two independent tab systems exist in the shell: the plugin that owns the
 * bridge places its own panel, and DSH itself can open a browser tab through
 * `sidebarRight.openTabIn`. A page from the second one is perfectly driveable
 * over CDP — the bridge addresses guests by id, not by owner — so `ensure`
 * falls back to asking the shell what webviews the conversation actually has
 * instead of insisting the bridge's own panel is the only one.
 */
/** Lower-cased host of a URL or bare host name, for "is this page already there" checks. */
function hostOf(value: string | undefined): string {
  const raw = String(value ?? '').trim()
  if (raw === '') return ''
  try {
    return new URL(raw.includes('://') ? raw : `https://${raw}`).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return ''
  }
}

export type PanelMounter = (owner: string, url?: string) => Promise<void>

let mounter: PanelMounter | undefined

/** Let the host contribute "open the browser tab in this conversation". */
export function setPanelMounter(fn: PanelMounter | undefined): void {
  mounter = fn
}

export class SidebarPage {
  constructor(
    private readonly bridge: BridgeConnection,
    private readonly owner: string,
  ) {}

  /**
   * The conversation's own sidebar page, opened at `url` when given.
   *
   * Order matters: the bridge's own panel first (one round trip), then any
   * webview already in this conversation's sidebar, then — only when there is
   * genuinely no page — ask the renderer to open the tab and wait for it.
   */
  async ensure(url?: string): Promise<number> {
    const placed = await this.askBridge(url)
    if (placed !== undefined) return placed
    const existing = await this.fromList(url)
    if (existing !== undefined) return existing
    if (mounter !== undefined) {
      try {
        await mounter(this.owner, url)
      } catch {
        // the renderer is allowed to refuse; the wait below reports the truth
      }
      for (let attempt = 0; attempt < 25; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 400))
        const found = await this.fromList(url)
        if (found !== undefined) return found
      }
    }
    throw new Error('this conversation has no browser page yet — open the Browser tab in the sidebar once, then retry')
  }

  /** The bridge's own panel op; a refusal is a normal answer, not an error. */
  private async askBridge(url?: string): Promise<number | undefined> {
    try {
      const answer = await this.bridge.call('ensureSidebar', {
        owner: this.owner,
        ...url !== undefined && url !== '' ? { url } : {},
      }, 6_000)
      const id = Number(answer?.id)
      if (answer?.ok === true && Number.isFinite(id) && id > 0) return id
    } catch {
      // the panel may need the renderer half; the list below is the answer
    }
    return undefined
  }

  /** Any webview this conversation's sidebar is showing, preferring the asked host. */
  private async fromList(url?: string): Promise<number | undefined> {
    try {
      const listed = await this.bridge.call('list', { owner: this.owner }, 8_000)
      const pages = Array.isArray(listed?.sidebar)
        ? listed.sidebar.filter((row: any) => row?.type === 'webview' && Number(row?.id) > 0)
        : []
      if (pages.length === 0) return undefined
      const wanted = hostOf(url)
      const matching = wanted === ''
        ? undefined
        : pages.find((row: any) => hostOf(String(row?.url ?? '')) === wanted)
      const chosen = matching ?? pages[0]
      return Number(chosen.id)
    } catch {
      return undefined
    }
  }

  /** Run one CDP command against this conversation's page. */
  async cdp(id: number, method: string, params: Record<string, unknown> = {}, timeoutMs = 20_000): Promise<any> {
    const answer = await this.bridge.call('cdp', { owner: this.owner, id, method, params }, timeoutMs)
    if (answer?.ok !== true) throw new Error(String(answer?.error ?? `CDP ${method} failed`))
    return answer.result
  }

  /** Evaluate an expression in the page and return its value. */
  async evaluate(id: number, expression: string, timeoutMs = 20_000): Promise<any> {
    const result = await this.cdp(id, 'Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    }, timeoutMs)
    if (result?.exceptionDetails !== undefined) {
      const detail = result.exceptionDetails
      const text = detail?.exception?.description ?? detail?.text ?? 'the page raised an exception'
      throw new Error(String(text))
    }
    return result?.result?.value
  }

  /** Navigate, then wait for the document to settle (or the budget to run out). */
  async navigate(id: number, url: string, timeoutMs = 25_000): Promise<void> {
    await this.cdp(id, 'Page.navigate', { url }, timeoutMs)
    const deadline = Date.now() + Math.min(timeoutMs, 20_000)
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 120))
      try {
        const state = await this.evaluate(id, 'document.readyState', 3_000)
        if (state === 'complete') return
      } catch {
        // a document swap makes the context disappear for a moment
      }
    }
  }

  async title(id: number): Promise<string> {
    try {
      return String(await this.evaluate(id, 'document.title', 5_000) ?? '')
    } catch {
      return ''
    }
  }

  async url(id: number): Promise<string> {
    try {
      return String(await this.evaluate(id, 'location.href', 5_000) ?? '')
    } catch {
      return ''
    }
  }

  async screenshot(id: number): Promise<string> {
    const result = await this.cdp(id, 'Page.captureScreenshot', { format: 'png' }, 25_000)
    const data = result?.data
    if (typeof data !== 'string' || data === '') throw new Error('the browser returned no image data')
    return data
  }

  /** Bring this page to the front of the sidebar. */
  async show(id: number): Promise<void> {
    try {
      await this.bridge.call('showTab', { owner: this.owner, id }, 5_000)
    } catch {
      // showing is a convenience; the page is driveable either way
    }
  }

  /** Release this conversation's sidebar pages. */
  async close(): Promise<void> {
    try {
      await this.bridge.call('closePage', { owner: this.owner, id: 0 }, 5_000)
    } catch {
      // closing is best-effort: a page that is already gone is the goal
    }
  }
}

/** Sessions live for one agent turn chain; the socket is worth reusing. */
let shared: { bridge: BridgeConnection; at: number } | undefined

/**
 * The bridge for this host process, connecting on first use.
 *
 * A failed connection is not cached: a user who installs the bridge while DSH
 * runs gets it on the next call instead of on the next restart.
 */
export async function sidebarBridge(): Promise<BridgeConnection | undefined> {
  if (shared !== undefined && shared.bridge.alive) return shared.bridge
  shared?.bridge.close()
  shared = undefined
  const bridge = await BridgeConnection.open()
  if (bridge !== undefined) shared = { bridge, at: Date.now() }
  return bridge
}

/** A page handle for one conversation, or undefined when no bridge is installed. */
export async function sidebarPage(owner: string): Promise<SidebarPage | undefined> {
  const trimmed = String(owner ?? '').trim()
  if (trimmed === '') return undefined
  const bridge = await sidebarBridge()
  if (bridge === undefined) return undefined
  return new SidebarPage(bridge, trimmed)
}
