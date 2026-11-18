import { useSyncExternalStore } from 'react'
import {
  changeVaultPassword,
  createVault,
  exportConnectorKey,
  exportKeyRaw,
  importVaultKeys,
  isWebCryptoAvailable,
  openBrowserWithKey,
  randomId,
  sealBrowser,
  unlockVault,
  type Entry,
  type VaultBlob,
} from './crypto'
import { activeBrowserUrl, fillInBuiltinBrowser, fillTotpInBuiltinBrowser } from './browser'
import { hostOf, maskUsername, matchEntries } from './match'
import { generateTotp } from './totp'

export { matchEntries, maskUsername } from './match'

export interface PendingLogin {
  id: string
  site: string
  reason?: string
  status: 'pending' | 'filled' | 'cancelled' | 'expired' | 'error'
  createdAt: number
  expiresAt: number
  entryLabel?: string
  sessionId?: string
  browserEngine?: 'external' | 'builtin'
}

export interface AddCard {
  id: string
  site?: string
  label?: string
  username?: string
  source?: 'tool' | 'composer'
  sessionId?: string
  open?: boolean
}

export interface VaultState {
  status: 'loading' | 'locked' | 'empty' | 'unlocked' | 'error'
  error?: string
  notice?: string
  entries: Entry[]
  revision: number
  blob: VaultBlob | null
  browserKey?: CryptoKey
  connectorKey?: CryptoKey
  pendingLogin?: PendingLogin
  card?: AddCard
  busy?: boolean
  remembered?: boolean
}

let state: VaultState = {
  status: 'loading',
  entries: [],
  revision: 0,
  blob: null,
  remembered: false,
}

let appCtx: any
let initialized = false
let lockTimer: ReturnType<typeof setTimeout> | undefined
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) {
    try {
      listener()
    } catch {
      // a broken subscriber must not break the store
    }
  }
}

function set(patch: Partial<VaultState>): void {
  state = { ...state, ...patch }
  emit()
}

export function getVaultState(): VaultState {
  return state
}

const REMEMBER_KEY = 'dsh-access:remember'
const REMEMBER_COOKIE = 'dsh_access_device'

function readCookie(name: string): string | null {
  try {
    const prefix = `${name}=`
    const match = document.cookie.split('; ').find((row) => row.startsWith(prefix))
    return match ? decodeURIComponent(match.slice(prefix.length)) : null
  } catch {
    return null
  }
}

function writeCookie(name: string, value: string): void {
  try {
    document.cookie = `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=31536000; SameSite=Strict`
  } catch {
    // ignore
  }
}

function clearCookie(name: string): void {
  try {
    document.cookie = `${name}=; Path=/; Max-Age=0; SameSite=Strict`
  } catch {
    // ignore
  }
}

function readRemembered(): { browserKey: string; connectorKey: string } | null {
  try {
    const raw = readCookie(REMEMBER_COOKIE) ?? localStorage.getItem(REMEMBER_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (typeof parsed?.browserKey === 'string' && typeof parsed?.connectorKey === 'string') return parsed
  } catch {
    // ignore corrupt storage
  }
  return null
}

function writeRemembered(browserKey: string, connectorKey: string): void {
  const raw = JSON.stringify({ browserKey, connectorKey })
  writeCookie(REMEMBER_COOKIE, raw)
  try {
    localStorage.setItem(REMEMBER_KEY, raw)
  } catch {
    // storage can be unavailable in private windows
  }
}

function clearRemembered(): void {
  clearCookie(REMEMBER_COOKIE)
  try {
    localStorage.removeItem(REMEMBER_KEY)
  } catch {
    // ignore
  }
}

async function rememberKeys(browserKey: CryptoKey, connectorKey: CryptoKey): Promise<void> {
  try {
    writeRemembered(await exportKeyRaw(browserKey), await exportKeyRaw(connectorKey))
    set({ remembered: true })
  } catch {
    // remember is best-effort
  }
}

export function isRemembered(): boolean {
  return readRemembered() !== null
}

export function forgetDevice(): void {
  clearRemembered()
  set({ remembered: false })
}

export async function rememberCurrentDevice(): Promise<boolean> {
  if (!state.browserKey || !state.connectorKey) return false
  await rememberKeys(state.browserKey, state.connectorKey)
  return true
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useVault(): VaultState {
  return useSyncExternalStore(subscribe, getVaultState, getVaultState)
}

function route(path: string): string {
  return new URL(path, document.baseURI).href
}

async function getJson(path: string): Promise<any> {
  const response = await fetch(route(path), { cache: 'no-store' })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}

async function postJson(path: string, body: unknown): Promise<any> {
  const response = await fetch(route(path), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json().catch(() => ({}))
}

export async function postEvent(type: string, payload: Record<string, unknown>): Promise<void> {
  try {
    await postJson('dsh-access/api/event', { type, ...payload })
  } catch {
    // The host may be restarting; the next event retries.
  }
}

/**
 * Re-hand the connector key to the host after a restart. The key itself may also
 * be gone — a renderer reload or an idle auto-lock clears it from memory — so fall
 * back to the remembered keyring instead of telling the host the vault is locked.
 */
export async function resendConnectorKey(): Promise<boolean> {
  if (state.connectorKey) {
    await sendConnectorKey(state.connectorKey)
    return true
  }
  const stored = readRemembered()
  if (!stored) return false
  try {
    const keys = await importVaultKeys(stored.browserKey, stored.connectorKey)
    const entries = state.blob === null ? state.entries : await openBrowserWithKey(state.blob, keys.browserKey)
    set({
      browserKey: keys.browserKey,
      connectorKey: keys.connectorKey,
      entries,
      status: 'unlocked',
      remembered: true,
      busy: false,
      error: undefined,
    })
    await sendConnectorKey(keys.connectorKey)
    scheduleLock()
    return true
  } catch {
    return false
  }
}

/** POST that keeps the JSON error body (a 400 from the fill route is meaningful). */
async function postJsonResult(path: string, body: unknown): Promise<{ ok: boolean; status: number; data: any }> {
  const response = await fetch(route(path), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  })
  const data = await response.json().catch(() => ({}))
  return { ok: response.ok, status: response.status, data }
}

function audit(kind: string, extra: Record<string, unknown> = {}): void {
  void postEvent('audit', { kind, ...extra })
}

function scheduleLock(): void {
  if (lockTimer) clearTimeout(lockTimer)
  lockTimer = setTimeout(() => {
    if (state.status === 'unlocked') lock()
  }, 15 * 60 * 1000)
}

async function sendConnectorKey(key: CryptoKey | undefined): Promise<void> {
  if (!key) return
  try {
    await postEvent('connector.key', { key: await exportConnectorKey(key) })
  } catch {
    // the host may be restarting
  }
}

export async function initStore(ctx: any): Promise<void> {
  appCtx = ctx
  if (initialized) return
  initialized = true
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const data = await getJson('dsh-access/api/vault')
      const remembered = readRemembered() !== null
      set({
        blob: data?.blob ?? null,
        revision: Number(data?.revision) || 0,
        status: data?.blob ? 'locked' : 'empty',
        remembered,
      })
      if (data?.blob && remembered) await tryAutoUnlock()
      return
    } catch (error) {
      if (attempt < 5) {
        await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)))
        continue
      }
      set({ status: 'error', error: error instanceof Error ? error.message : String(error) })
    }
  }
}

export async function retryStore(): Promise<void> {
  initialized = false
  set({ status: 'loading', error: undefined })
  await initStore(appCtx)
}

export async function unlock(password: string, remember = false): Promise<boolean> {
  const value = String(password ?? '')
  if (value.length < 8) {
    set({ error: 'The master password must be at least 8 characters.' })
    return false
  }
  if (!isWebCryptoAvailable()) {
    set({ error: 'WebCrypto is unavailable in this page, so the vault cannot be unlocked.' })
    return false
  }
  set({ busy: true, error: undefined, notice: undefined })
  try {
    if (state.blob === null) {
      const created = await createVault(value)
      set({
        blob: created.blob,
        browserKey: created.browserKey,
        connectorKey: created.connectorKey,
        entries: [],
        status: 'unlocked',
        busy: false,
        notice: 'Vault created.',
      })
      const saved = await putVault(created.blob, state.revision)
      if (!saved.ok) {
        set({ error: 'The vault changed in another window. Reload the page and try again.', status: 'locked' })
        return false
      }
      set({ revision: saved.revision ?? state.revision })
      void postEvent('vault.status', { locked: false, count: 0 })
      await sendConnectorKey(created.connectorKey)
      if (remember) await rememberKeys(created.browserKey, created.connectorKey)
      scheduleLock()
      return true
    }
    const unlocked = await unlockVault(state.blob, value)
    set({
      browserKey: unlocked.browserKey,
      connectorKey: unlocked.connectorKey,
      entries: unlocked.entries,
      status: 'unlocked',
      busy: false,
      error: undefined,
      notice: undefined,
    })
    void postEvent('vault.status', { locked: false, count: unlocked.entries.length })
    await sendConnectorKey(unlocked.connectorKey)
    if (remember) await rememberKeys(unlocked.browserKey, unlocked.connectorKey)
    scheduleLock()
    return true
  } catch (error) {
    set({
      busy: false,
      status: state.blob === null ? 'empty' : 'locked',
      error: 'Wrong master password, or the vault is damaged.',
    })
    return false
  }
}

export async function tryAutoUnlock(): Promise<boolean> {
  const stored = readRemembered()
  if (!stored || state.blob === null) return false
  try {
    const keys = await importVaultKeys(stored.browserKey, stored.connectorKey)
    const entries = await openBrowserWithKey(state.blob, keys.browserKey)
    set({
      browserKey: keys.browserKey,
      connectorKey: keys.connectorKey,
      entries,
      status: 'unlocked',
      busy: false,
      error: undefined,
      notice: undefined,
      remembered: true,
    })
    void postEvent('vault.status', { locked: false, count: entries.length })
    await sendConnectorKey(keys.connectorKey)
    scheduleLock()
    return true
  } catch {
    clearRemembered()
    set({ remembered: false })
    return false
  }
}

export function lock(): void {
  if (lockTimer) clearTimeout(lockTimer)
  lockTimer = undefined
  set({
    status: state.blob === null ? 'empty' : 'locked',
    browserKey: undefined,
    connectorKey: undefined,
    entries: [],
    pendingLogin: undefined,
    card: undefined,
    error: undefined,
    notice: undefined,
  })
  void postEvent('vault.status', { locked: true, count: 0 })
  void postEvent('connector.lock', {})
  audit('lock', { ok: true })
}

export async function resetVault(): Promise<boolean> {
  try {
    const response = await fetch(route('dsh-access/api/vault'), { method: 'DELETE' })
    if (!response.ok) {
      set({ error: 'HTTP ' + response.status })
      return false
    }
    clearRemembered()
    set({
      blob: null,
      entries: [],
      revision: 0,
      status: 'empty',
      browserKey: undefined,
      connectorKey: undefined,
      remembered: false,
      error: undefined,
      notice: 'Vault reset.',
    })
    void postEvent('vault.status', { locked: true, count: 0 })
    return true
  } catch (error) {
    set({ error: error instanceof Error ? error.message : String(error) })
    return false
  }
}

async function putVault(blob: VaultBlob, baseRevision: number): Promise<{ ok: boolean; revision?: number; conflict?: boolean }> {
  const response = await fetch(route('dsh-access/api/vault'), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ baseRevision, blob }),
  })
  const data = await response.json().catch(() => ({}))
  if (response.status === 409) return { ok: false, conflict: true, revision: Number(data?.revision) || 0 }
  if (!response.ok) throw new Error(data?.error ?? `HTTP ${response.status}`)
  return { ok: true, revision: Number(data?.revision) || 0 }
}

export async function changePassword(oldPassword: string, newPassword: string): Promise<boolean> {
  if (state.status !== 'unlocked' || !state.blob) return false
  if (newPassword.length < 8) {
    set({ error: 'The new master password must be at least 8 characters.' })
    return false
  }
  set({ busy: true, error: undefined, notice: undefined })
  try {
    const nextBlob = await changeVaultPassword(state.blob, oldPassword, newPassword)
    const saved = await putVault(nextBlob, state.revision)
    if (!saved.ok) {
      set({ busy: false, error: 'The vault changed in another window. Reload the page and try again.' })
      return false
    }
    set({ blob: nextBlob, revision: saved.revision ?? state.revision, busy: false, notice: 'Master password changed.' })
    return true
  } catch {
    set({ busy: false, error: 'The current master password is incorrect.' })
    return false
  }
}

export async function save(): Promise<boolean> {  if (state.status !== 'unlocked' || !state.browserKey || !state.blob) return false
  set({ busy: true, error: undefined })
  try {
    const box = await sealBrowser(state.browserKey, state.entries)
    const nextBlob: VaultBlob = { ...state.blob, browser: box }
    const saved = await putVault(nextBlob, state.revision)
    if (!saved.ok) {
      set({ busy: false, error: 'The vault changed in another window. Reload the page and try again.' })
      return false
    }
    set({ blob: nextBlob, revision: saved.revision ?? state.revision, busy: false })
    void postEvent('vault.status', { locked: false, count: state.entries.length })
    scheduleLock()
    return true
  } catch (error) {
    set({ busy: false, error: error instanceof Error ? error.message : String(error) })
    return false
  }
}

export async function addEntry(input: {
  site: string
  label?: string
  username: string
  password: string
  notes?: string
  totp?: string
}): Promise<Entry | undefined> {
  if (state.status !== 'unlocked') return undefined
  const site = hostOf(input.site) || input.site.trim()
  if (site === '' || input.password === '') {
    set({ error: 'Site and password are required.' })
    return undefined
  }
  const now = Date.now()
  // The first account saved for a site becomes its primary account; later ones
  // need an explicit choice (or the user names the account in the request).
  const firstForSite = matchEntries(state.entries, site).length === 0
  const entry: Entry = {
    id: randomId(),
    site,
    label: (input.label ?? '').trim() || site,
    username: input.username ?? '',
    password: input.password,
    notes: input.notes,
    totp: input.totp?.trim() || undefined,
    createdAt: now,
    updatedAt: now,
    useCount: 0,
    primary: firstForSite || undefined,
  }
  // Do NOT clear the card here: the caller reports the save back to the host,
  // and that report needs state.card to still exist. Clearing it first is what
  // left the tool spinning after a successful save.
  set({ entries: [...state.entries, entry], notice: 'Saved encrypted.' })
  await save()
  audit('save', { site: entry.site, entryLabel: entry.label, ok: true })
  return entry
}

export async function addEntries(inputs: Array<{
  site: string
  label?: string
  username: string
  password: string
  notes?: string
  totp?: string
}>): Promise<number> {
  if (state.status !== 'unlocked') return 0
  const now = Date.now()
  const entries: Entry[] = []
  for (const input of inputs) {
    const site = hostOf(input.site) || String(input.site ?? '').trim()
    if (site === '' || input.password === '') continue
    entries.push({
      id: randomId(),
      site,
      label: (input.label ?? '').trim() || site,
      username: input.username ?? '',
      password: input.password,
      notes: input.notes,
      totp: input.totp?.trim() || undefined,
      createdAt: now,
      updatedAt: now,
      useCount: 0,
    })
  }
  if (entries.length === 0) return 0
  set({ entries: [...state.entries, ...entries] })
  await save()
  audit('import', { ok: true })
  return entries.length
}

export async function updateEntry(id: string, patch: Partial<Entry>): Promise<Entry | undefined> {
  if (state.status !== 'unlocked') return undefined
  const now = Date.now()
  let updated: Entry | undefined
  const entries = state.entries.map((entry) => {
    if (entry.id !== id) return entry
    updated = { ...entry, ...patch, updatedAt: now }
    return updated
  })
  set({ entries })
  await save()
  audit('update', { site: updated?.site, entryLabel: updated?.label, ok: true })
  return updated
}

export async function deleteEntry(id: string): Promise<void> {
  if (state.status !== 'unlocked') return
  const entry = state.entries.find((item) => item.id === id)
  set({ entries: state.entries.filter((item) => item.id !== id) })
  await save()
  audit('delete', { site: entry?.site, entryLabel: entry?.label, ok: true })
}

/** Make one account the default for its site; the other accounts of that site lose the flag. */
export async function setPrimary(id: string): Promise<void> {
  if (state.status !== 'unlocked') return
  const target = state.entries.find((item) => item.id === id)
  if (!target) return
  const siblingIds = new Set(matchEntries(state.entries, target.site).map((item) => item.id))
  set({
    entries: state.entries.map((item) => (
      siblingIds.has(item.id)
        ? { ...item, primary: item.id === id ? true : undefined, updatedAt: item.id === id ? Date.now() : item.updatedAt }
        : item
    )),
    notice: `${target.label} is now the default account for ${target.site}.`,
  })
  await save()
}

export function openAddCard(info: { site?: string; label?: string; username?: string; sessionId?: string } = {}, source: 'tool' | 'composer' = 'tool'): { requestId: string; site: string } {
  const site = hostOf(info.site ?? '') || hostOf(activeBrowserUrl())
  const id = randomId()
  // Open the floating card straight away. A tool-sourced card used to stay
  // "closed" and rely on a chip inside the tool row, which is collapsed inside
  // the reasoning block — the user saw no card at all.
  set({ card: { id, site, label: info.label, username: info.username, source, sessionId: info.sessionId, open: true }, pendingLogin: undefined, error: undefined })
  return { requestId: id, site }
}

/** The host aborted its tool call: close our card if it belongs to that request. */
export function closeCardIf(requestId: string): void {
  if (state.card && state.card.id === requestId) set({ card: undefined })
}

export function openCardModal(): void {
  if (state.card) set({ card: { ...state.card, open: true } })
}

export function completeCard(status: 'saved' | 'cancelled', entryLabel?: string): void {
  const card = state.card
  if (!card) return
  if (card.source === 'tool') {
    void postEvent('card.completed', { requestId: card.id, status, entryLabel })
  }
  set({ card: undefined })
}

export function closeCard(): void {
  set({ card: undefined })
}

export function openLogin(info: { site?: string; reason?: string; sessionId?: string; browserEngine?: 'external' | 'builtin' } = {}): { requestId: string; site: string } {
  const site = hostOf(info.site ?? '') || hostOf(activeBrowserUrl())
  const id = randomId()
  const now = Date.now()
  set({
    pendingLogin: {
      id,
      site,
      reason: info.reason,
      status: 'pending',
      createdAt: now,
      expiresAt: now + 10 * 60 * 1000,
      sessionId: info.sessionId,
      browserEngine: info.browserEngine === 'external' ? 'external' : 'builtin',
    },
    card: undefined,
    error: undefined,
  })
  return { requestId: id, site }
}

export function completeLogin(status: PendingLogin['status'], entryLabel?: string): void {
  const pending = state.pendingLogin
  if (!pending) return
  set({ pendingLogin: { ...pending, status, entryLabel } })
  void postEvent('login.completed', {
    requestId: pending.id,
    site: pending.site,
    status,
    entryLabel,
  })
}

export async function fill(entryId: string, submit: boolean): Promise<boolean> {
  if (state.status !== 'unlocked') return false
  const entry = state.entries.find((item) => item.id === entryId)
  if (!entry) {
    set({ error: 'That credential no longer exists.' })
    return false
  }
  set({ busy: true, error: undefined })
  const pending = state.pendingLogin
  const external = pending?.status === 'pending' && pending.browserEngine === 'external'
  try {
    let result: { ok: boolean; submitted?: boolean; error?: string }
    if (external && pending) {
      // The password never goes to the host for storage; this one request hands
      // it to the shared browser and the host discards it.
      const response = await postJsonResult('dsh-access/api/login/fill', {
        requestId: pending.id,
        username: entry.username,
        password: entry.password,
        submit,
      })
      result = {
        ok: response.data?.ok === true,
        submitted: response.data?.submitted === true,
        error: typeof response.data?.error === 'string' ? response.data.error : `HTTP ${response.status}`,
      }
    } else {
      result = await fillInBuiltinBrowser(appCtx, {
        site: entry.site,
        username: entry.username,
        password: entry.password,
        submit,
      })
    }
    if (!result.ok) {
      set({
        busy: false,
        error: result.error === 'no-password-field'
          ? 'No password field found; open the sign-in page first.'
          : (result.error ?? 'The page could not be filled.'),
      })
      return false
    }
    const updated: Entry = {
      ...entry,
      lastUsedAt: Date.now(),
      useCount: entry.useCount + 1,
      updatedAt: Date.now(),
    }
    set({
      entries: state.entries.map((item) => item.id === entry.id ? updated : item),
      busy: false,
      notice: result.submitted ? 'Filled and submitted.' : 'Filled.',
    })
    await save()
    completeLogin('filled', entry.label)
    audit('fill', { site: entry.site, entryLabel: entry.label, ok: true })
    return true
  } catch (error) {
    set({ busy: false, error: error instanceof Error ? error.message : String(error) })
    return false
  }
}

export function cancelLogin(): void {
  completeLogin('cancelled')
}

export async function fillTotp(entryId: string): Promise<boolean> {
  if (state.status !== 'unlocked') return false
  const entry = state.entries.find((item) => item.id === entryId)
  if (!entry) {
    set({ error: 'That credential no longer exists.' })
    return false
  }
  if (!entry.totp) {
    set({ error: 'No TOTP secret on this credential.' })
    return false
  }
  set({ busy: true, error: undefined })
  const pending = state.pendingLogin
  const external = pending?.status === 'pending' && pending.browserEngine === 'external'
  try {
    const code = (await generateTotp(entry.totp)).code
    let result: { ok: boolean; error?: string }
    if (external && pending) {
      const response = await postJsonResult('dsh-access/api/login/fill-totp', {
        requestId: pending.id,
        code,
        submit: true,
      })
      result = {
        ok: response.data?.ok === true,
        error: typeof response.data?.error === 'string' ? response.data.error : `HTTP ${response.status}`,
      }
    } else {
      result = await fillTotpInBuiltinBrowser(appCtx, { site: entry.site, code })
    }
    if (!result.ok) {
      set({
        busy: false,
        error: result.error === 'no-otp-field'
          ? 'No one-time-code field found; open the verification page first.'
          : (result.error ?? 'TOTP fill failed.'),
      })
      return false
    }
    set({ busy: false, notice: 'TOTP filled.' })
    return true
  } catch (error) {
    set({ busy: false, error: error instanceof Error ? error.message : String(error) })
    return false
  }
}

export function dismissLogin(): void {
  set({ pendingLogin: undefined })
}

/**
 * Fill the current page from the vault without a card or a click. Used by the
 * host tool access_autofill: the renderer matches the site, decrypts the entry
 * in memory, and either fills the built-in browser directly or posts the pair
 * to the one-shot host endpoint for the shared browser. No secret is returned.
 */
export async function autoFill(
  site: string,
  submit: boolean,
  requestId?: string,
  engine: 'external' | 'builtin' = 'builtin',
  account?: string,
): Promise<{ ok: boolean; status: 'filled' | 'no-credential' | 'locked' | 'error'; entryLabel?: string; error?: string }> {
  // The idle lock may have fired while the page sat still; the remembered keyring
  // lets us unlock on demand instead of asking the user for the master password.
  if (state.status !== 'unlocked' && readRemembered() !== null) {
    await tryAutoUnlock().catch(() => false)
  }
  if (state.status !== 'unlocked') return { ok: false, status: 'locked' }
  const matches = matchEntries(state.entries, site)
  if (matches.length === 0) return { ok: false, status: 'no-credential' }
  const wanted = String(account ?? '').trim().toLowerCase()
  const pool = wanted === ''
    ? matches
    : matches.filter((item) => `${item.label} ${item.username}`.toLowerCase().includes(wanted))
  if (pool.length === 0) return { ok: false, status: 'no-credential' }
  // The primary account wins by default. When nothing is flagged yet (entries
  // saved before the flag existed), the first account saved for the site is the
  // primary one, which is what a user means by "the main account".
  const hasPrimary = pool.some((item) => item.primary === true)
  const entry = pool.slice().sort((a, b) => (
    hasPrimary
      ? (Number(b.primary === true) - Number(a.primary === true)) || ((b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))
      : (a.createdAt ?? 0) - (b.createdAt ?? 0)
  ))[0]
  set({ busy: true, error: undefined })
  try {
    let result: { ok: boolean; submitted?: boolean; error?: string }
    if (engine === 'external' && requestId) {
      const response = await postJsonResult('dsh-access/api/login/fill', {
        requestId,
        username: entry.username,
        password: entry.password,
        submit,
      })
      result = {
        ok: response.data?.ok === true,
        submitted: response.data?.submitted === true,
        error: typeof response.data?.error === 'string' ? response.data.error : `HTTP ${response.status}`,
      }
    } else {
      result = await fillInBuiltinBrowser(appCtx, {
        site: entry.site,
        username: entry.username,
        password: entry.password,
        submit,
      })
    }
    if (!result.ok) {
      const error = result.error === 'no-password-field'
        ? 'No password field found; open the sign-in page first.'
        : (result.error ?? 'The page could not be filled.')
      set({ busy: false, error })
      return { ok: false, status: 'error', error }
    }
    const updated: Entry = {
      ...entry,
      lastUsedAt: Date.now(),
      useCount: entry.useCount + 1,
      updatedAt: Date.now(),
    }
    set({
      entries: state.entries.map((item) => item.id === entry.id ? updated : item),
      busy: false,
      notice: result.submitted ? 'Filled and submitted.' : 'Filled.',
    })
    await save()
    audit('fill', { site: entry.site, entryLabel: entry.label, ok: true })
    return { ok: true, status: 'filled', entryLabel: entry.label }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    set({ busy: false, error: message })
    return { ok: false, status: 'error', error: message }
  }
}

export function statusPayload(): { locked: boolean; count: number } {
  return { locked: state.status !== 'unlocked', count: state.entries.length }
}

/** Site/label/username metadata only; never a password or TOTP secret. */
export function siteList(): { locked: boolean; sites: Array<{ site: string; label: string; username: string }> } {
  if (state.status !== 'unlocked') return { locked: true, sites: [] }
  return {
    locked: false,
    sites: state.entries.map((entry) => ({
      site: entry.site,
      label: entry.label,
      username: maskUsername(entry.username),
    })),
  }
}
