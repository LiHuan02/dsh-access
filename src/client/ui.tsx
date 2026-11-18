import { useEffect, useState } from 'react'
import type { Entry } from './crypto'
import { connectConnector, disconnectConnector, listConnectors, pollOAuth, startOAuth, testConnector } from './connectors'
import { t, tOptional } from './i18n'
import { generateTotp } from './totp'
import {
  addEntries,
  addEntry,
  cancelLogin,
  changePassword,
  closeCard,
  completeCard,
  deleteEntry,
  setPrimary,
  dismissLogin,
  fill,
  fillTotp,
  forgetDevice,
  lock,
  matchEntries,
  maskUsername,
  openAddCard,
  openCardModal,
  rememberCurrentDevice,
  resetVault,
  retryStore,
  unlock,
  updateEntry,
  useVault,
} from './store'
import { downloadText, exportVaultFile, importEncryptedVault, isEncryptedExport, parseCsv } from './transfer'
import { activeBrowserUrl } from './browser'
import { hostOf } from './match'

export function installStyles(): () => void {
  const existing = document.querySelector('style[data-dsh-access="styles"]')
  if (existing) existing.remove()
  const style = document.createElement('style')
  style.dataset.dshAccess = 'styles'
  style.textContent = `
.dsh-access-page { padding: 16px 20px 32px; max-width: 760px; color: var(--dsw-alias-label-primary); font-size: 13px; }
.dsh-access-page-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 12px; }
.dsh-access-page-title { font-size: 16px; font-weight: 600; }
.dsh-access-card { border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); border-radius: 10px; padding: 12px; margin: 8px 0; color: var(--dsw-alias-label-primary); font-size: 13px; display: flex; flex-direction: column; gap: 8px; }
.dsh-access-title { font-weight: 600; font-size: 13px; }
.dsh-access-muted { color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 1.45; }
.dsh-access-hint { color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 1.45; }
.dsh-access-error { color: var(--dsw-alias-state-error-primary); font-size: 12px; }
.dsh-access-notice { color: var(--dsw-alias-state-success-primary); font-size: 12px; }
.dsh-access-label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dsh-access-input { box-sizing: border-box; width: 100%; height: 30px; padding: 0 8px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-size: 13px; outline: none; }
.dsh-access-input:focus { border-color: var(--dsw-alias-brand-primary); }
.dsh-access-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.dsh-access-button { height: 28px; padding: 0 10px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); cursor: pointer; font-size: 12px; }
.dsh-access-button:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-1); }
.dsh-access-button.primary { background: var(--dsw-alias-brand-primary); border-color: transparent; color: var(--dsw-alias-bg-base); }
.dsh-access-button.primary:hover:not(:disabled) { background: var(--dsw-alias-brand-primary); filter: brightness(1.08); }
.dsh-access-button.danger { color: var(--dsw-alias-state-error-primary); }
.dsh-access-button:disabled { opacity: .5; cursor: default; }
.dsh-access-list { display: flex; flex-direction: column; gap: 6px; }
.dsh-access-item { display: flex; justify-content: space-between; align-items: center; gap: 10px; padding: 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-base); }
.dsh-access-item-label { font-size: 13px; font-weight: 500; }
.dsh-access-badge { display: inline-block; margin-left: 6px; padding: 0 6px; border-radius: 999px; font-size: 10px; line-height: 16px; color: var(--dsw-alias-state-success-primary); border: 1px solid var(--dsw-alias-state-success-primary); }
.dsh-access-section-title { margin-top: 20px; font-size: 14px; font-weight: 600; }
.dsh-access-select { box-sizing: border-box; width: 100%; height: 30px; padding: 0 6px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-size: 13px; }
.dsh-access-oauthCode { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 22px; letter-spacing: 3px; font-weight: 600; padding: 8px 0; }
.dsh-access-totp { display: inline-block; margin-top: 2px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; letter-spacing: 1px; color: var(--dsw-alias-brand-primary); }
.dsh-access-link { color: var(--dsw-alias-brand-primary); font-size: 12px; text-decoration: none; }
.dsh-access-link:hover { text-decoration: underline; }
.dsh-access-backdrop { position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center; background: rgba(0, 0, 0, .35); pointer-events: auto; }
.dsh-access-modal { position: relative; width: min(420px, calc(100vw - 32px)); max-height: calc(100vh - 64px); overflow: auto; }
.dsh-access-modal-close { position: absolute; top: 6px; right: 6px; z-index: 1; }
.dsh-access-modal .dsh-access-card { margin: 0; background: var(--dsw-alias-bg-overlay); box-shadow: 0 20px 60px rgba(0, 0, 0, .35); }
.dsh-access-account-list { display: flex; flex-direction: column; gap: 4px; margin-top: 6px; }
.dsh-access-account { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding-top: 4px; border-top: 1px solid var(--dsw-alias-border-l1); }
.dsh-access-account-label { font-size: 12px; color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-access-account-actions { display: flex; gap: 6px; flex-shrink: 0; }
.dsh-access-check { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dsh-access-check input { accent-color: var(--dsw-alias-brand-primary); }
.dsh-access-composer-button { width: 28px; height: 28px; padding: 0; display: inline-flex; align-items: center; justify-content: center; }
.dsh-access-file { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dsh-access-menu-item { display: flex; width: 100%; align-items: center; gap: 8px; padding: 6px 10px; border: 0; background: transparent; color: var(--dsw-alias-label-primary); font-size: 12px; cursor: pointer; text-align: left; border-radius: 6px; }
.dsh-access-menu-item:hover { background: var(--dsw-alias-bg-layer-2); }
`
  document.head.appendChild(style)
  return () => style.remove()
}

function generatePassword(length = 20): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*()-_=+'
  const bytes = new Uint32Array(length)
  crypto.getRandomValues(bytes)
  let value = ''
  for (let index = 0; index < length; index += 1) value += alphabet[bytes[index] % alphabet.length]
  return value
}

function useTotp(secret: string | undefined): { code: string; remaining: number } {
  const [state, setState] = useState<{ code: string; remaining: number }>({ code: '', remaining: 0 })
  useEffect(() => {
    if (!secret) {
      setState({ code: '', remaining: 0 })
      return
    }
    let cancelled = false
    const tick = async () => {
      try {
        const next = await generateTotp(secret)
        if (!cancelled) setState(next)
      } catch {
        if (!cancelled) setState({ code: '', remaining: 0 })
      }
    }
    void tick()
    const timer = setInterval(() => { void tick() }, 1000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [secret])
  return state
}

function TotpBadge(props: { secret?: string }): any {
  const { code, remaining } = useTotp(props.secret)
  if (code === '') return null
  return (
    <span className="dsh-access-totp" title={`${remaining}s`}>
      {code.slice(0, 3)} {code.slice(3)}
    </span>
  )
}

function connectorBase(id: string): string {
  return String(id).split(':')[0]
}

function connectorName(connector: any): string {
  const base = connectorBase(connector.id)
  const name = tOptional(`connector.${base}.name`) ?? connector.name
  if (!String(connector.id).includes(':')) return name
  const suffixIndex = String(connector.name).indexOf(' · ')
  return suffixIndex >= 0 ? name + String(connector.name).slice(suffixIndex) : name
}

function connectorBaseName(connector: any): string {
  const base = connectorBase(connector.id)
  return tOptional(`connector.${base}.name`) ?? String(connector.name ?? '').split(' · ')[0]
}

function accountLabel(connector: any): string {
  const label = String(connector.label ?? '').trim()
  if (label !== '') return label
  const name = String(connector.name ?? '')
  const index = name.indexOf(' · ')
  return index >= 0 ? name.slice(index + 3) : connectorBaseName(connector)
}

function connectorDescription(connector: any): string {
  return tOptional(`connector.${connectorBase(connector.id)}.desc`) ?? connector.description
}

function connectorActionName(connector: any, action: any): string {
  return tOptional(`connector.${connectorBase(connector.id)}.action.${action.id}`) ?? action.name
}

function connectorFieldLabel(connector: any, field: any): string {
  return tOptional(`connector.${connectorBase(connector.id)}.field.${field.key}`) ?? field.label
}

const ERROR_KEYS: Record<string, string> = {
  'The master password must be at least 8 characters.': 'error.shortPassword',
  'Wrong master password, or the vault is damaged.': 'error.wrongPassword',
  'The new master password must be at least 8 characters.': 'error.shortPassword',
  'The current master password is incorrect.': 'error.wrongPassword',
  'The vault changed in another window. Reload the page and try again.': 'error.vaultChanged',
  'WebCrypto is unavailable in this page, so the vault cannot be unlocked.': 'error.noWebCrypto',
  'No TOTP secret on this credential.': 'error.noTotp',
  'No one-time-code field found; open the verification page first.': 'error.noOtpField',
}

function errorText(message?: string): string {
  if (!message) return ''
  const key = ERROR_KEYS[message]
  return key ? t(key) : message
}

function UnlockForm(): any {
  const vault = useVault()
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(true)
  const [confirmReset, setConfirmReset] = useState(false)
  const [busy, setBusy] = useState(false)
  const first = vault.blob === null
  const submit = async (event: any) => {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    await unlock(password, remember)
    setBusy(false)
    setPassword('')
  }
  return (
    <form className="dsh-access-card" onSubmit={submit}>
      <div className="dsh-access-title">{first ? t('card.unlock.setup') : t('card.unlock.title')}</div>
      <input
        className="dsh-access-input"
        type="password"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        placeholder={t('card.unlock.placeholder')}
        autoComplete="current-password"
      />
      <label className="dsh-access-check">
        <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
        {t('card.unlock.remember')}
      </label>
      <div className="dsh-access-hint">{t('card.unlock.rememberHint')}</div>
      {vault.error ? <div className="dsh-access-error">{errorText(vault.error)}</div> : null}
      <div className="dsh-access-actions">
        <button className="dsh-access-button primary" type="submit" disabled={busy || password.length < 8}>
          {busy ? t('common.busy') : (first ? t('card.unlock.create') : t('card.unlock.button'))}
        </button>
        {!first && !confirmReset ? (
          <button className="dsh-access-button" type="button" onClick={() => setConfirmReset(true)}>{t('card.unlock.forgot')}</button>
        ) : null}
        {!first && confirmReset ? (
          <>
            <button className="dsh-access-button danger" type="button" onClick={() => { void resetVault() }}>{t('card.unlock.resetConfirm')}</button>
            <button className="dsh-access-button" type="button" onClick={() => setConfirmReset(false)}>{t('common.cancel')}</button>
          </>
        ) : null}
      </div>
      <div className="dsh-access-hint">{t('card.unlock.hint')}</div>
    </form>
  )
}

function CredentialForm(props: {
  initial?: { site?: string; label?: string; username?: string }
  entry?: Entry
  onDone?: (entry: Entry) => void
  onCancel?: () => void
}): any {
  const [site, setSite] = useState(props.entry?.site ?? props.initial?.site ?? '')
  const [label, setLabel] = useState(props.entry?.label ?? props.initial?.label ?? '')
  const [username, setUsername] = useState(props.entry?.username ?? props.initial?.username ?? '')
  const [password, setPassword] = useState('')
  const [notes, setNotes] = useState(props.entry?.notes ?? '')
  const [totp, setTotp] = useState(props.entry?.totp ?? '')
  const [busy, setBusy] = useState(false)
  const vault = useVault()
  const submit = async (event: any) => {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    const editing = props.entry
    const entry = editing
      ? await updateEntry(editing.id, {
        site: hostOf(site) || site,
        label,
        username,
        password: password === '' ? editing.password : password,
        notes,
        totp,
      })
      : await addEntry({ site, label, username, password, notes, totp })
    setBusy(false)
    if (entry) {
      setPassword('')
      props.onDone?.(entry)
    }
  }
  return (
    <form className="dsh-access-card" onSubmit={submit}>
      <div className="dsh-access-title">{props.entry ? t('settings.edit') : t('card.add.title')}</div>
      {vault.error ? <div className="dsh-access-hint" style={{ color: '#d9534f' }}>{vault.error}</div> : null}
      <label className="dsh-access-label">
        {t('card.add.site')}
        <input className="dsh-access-input" value={site} onChange={(event) => setSite(event.target.value)} placeholder="github.com" />
      </label>
      <label className="dsh-access-label">
        {t('card.add.label')}
        <input className="dsh-access-input" value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Work" />
      </label>
      <label className="dsh-access-label">
        {t('card.add.username')}
        <input className="dsh-access-input" value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" />
      </label>
      <label className="dsh-access-label">
        {t('card.add.password')}
        <input className="dsh-access-input" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" placeholder={props.entry ? t('card.add.passwordKeep') : undefined} />
      </label>
      <div className="dsh-access-actions">
        <button className="dsh-access-button" type="button" onClick={() => setPassword(generatePassword())}>{t('card.add.generate')}</button>
      </div>
      <label className="dsh-access-label">
        {t('card.add.notes')}
        <input className="dsh-access-input" value={notes} onChange={(event) => setNotes(event.target.value)} />
      </label>
      <label className="dsh-access-label">
        {t('card.add.totp')}
        <input className="dsh-access-input" value={totp} onChange={(event) => setTotp(event.target.value)} placeholder="Base32 secret (optional)" />
      </label>
      {vault.error ? <div className="dsh-access-error">{errorText(vault.error)}</div> : null}
      {vault.notice ? <div className="dsh-access-notice">{vault.notice}</div> : null}
      <div className="dsh-access-actions">
        <button className="dsh-access-button primary" type="submit" disabled={busy || site.trim() === '' || (!props.entry && password === '')}>
          {busy ? t('common.busy') : t('card.add.save')}
        </button>
        <button className="dsh-access-button" type="button" onClick={props.onCancel}>{t('card.add.cancel')}</button>
      </div>
    </form>
  )
}

export function LoginToolView(_props: any): any {
  const vault = useVault()
  const pending = vault.pendingLogin
  const [showNew, setShowNew] = useState(false)

  if (!pending) {
    return <div className="dsh-access-card"><div className="dsh-access-muted">{t('card.login.pending')}</div></div>
  }
  if (vault.status !== 'unlocked') {
    return <UnlockForm />
  }
  const matches = matchEntries(vault.entries, pending.site)
  const done = pending.status === 'filled' || pending.status === 'cancelled' || pending.status === 'expired'

  return (
    <div className="dsh-access-card">
      <div className="dsh-access-title">{t('card.login.title')}</div>
      <div className="dsh-access-muted">{t('card.login.subtitle', { site: pending.site || '—' })}</div>
      {pending.reason ? <div className="dsh-access-muted">{pending.reason}</div> : null}
      {vault.error ? <div className="dsh-access-error">{errorText(vault.error)}</div> : null}
      {vault.notice ? <div className="dsh-access-notice">{vault.notice}</div> : null}
      {pending.status === 'filled' ? <div className="dsh-access-notice">{t('card.login.filled')}</div> : null}
      {pending.status === 'cancelled' ? <div className="dsh-access-muted">{t('card.login.cancelled')}</div> : null}
      {done ? (
        <div className="dsh-access-actions">
          <button className="dsh-access-button" type="button" onClick={dismissLogin}>{t('common.close')}</button>
        </div>
      ) : showNew ? (
        <CredentialForm
          initial={{ site: pending.site }}
          onDone={() => setShowNew(false)}
          onCancel={() => setShowNew(false)}
        />
      ) : (
        <>
          {matches.length === 0 ? (
            <div className="dsh-access-muted">{t('card.login.noMatch')}</div>
          ) : (
            <div className="dsh-access-list">
              {matches.map((entry) => (
                <div className="dsh-access-item" key={entry.id}>
                  <div>
                    <div className="dsh-access-item-label">{entry.label}{entry.primary ?  <span className="dsh-access-badge">{t('settings.primary')}</span> : null}</div>
                    <div className="dsh-access-muted">{maskUsername(entry.username)} · {entry.site}</div>
                    {entry.totp ? <TotpBadge secret={entry.totp} /> : null}
                  </div>
                  <div className="dsh-access-actions">
                    <button className="dsh-access-button primary" type="button" disabled={vault.busy} onClick={() => { void fill(entry.id, false) }}>
                      {t('card.login.fill')}
                    </button>
                    <button className="dsh-access-button" type="button" disabled={vault.busy} onClick={() => { void fill(entry.id, true) }}>
                      {t('card.login.fillSubmit')}
                    </button>
                    {entry.totp ? (
                      <button className="dsh-access-button" type="button" disabled={vault.busy} onClick={() => { void fillTotp(entry.id) }}>
                        {t('card.login.fillTotp')}
                      </button>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="dsh-access-actions">
            <button className="dsh-access-button" type="button" onClick={() => setShowNew(true)}>{t('card.login.new')}</button>
            <button className="dsh-access-button" type="button" onClick={cancelLogin}>{t('card.login.cancel')}</button>
          </div>
        </>
      )}
    </div>
  )
}

export function CredentialToolView(_props: any): any {
  const vault = useVault()
  const card = vault.card
  if (!card || card.source !== 'tool') return null
  return (
    <div className="dsh-access-card">
      <div className="dsh-access-title">{t('card.add.title')}</div>
      <div className="dsh-access-muted">{card.site || t('card.add.site')}</div>
      <div className="dsh-access-actions">
        <button className="dsh-access-button primary" type="button" onClick={() => openCardModal()}>
          {t('card.add.open')}
        </button>
      </div>
    </div>
  )
}

export function AccessComposerButton(_props: any): any {
  return (
    <button
      className="dsh-access-button dsh-access-composer-button"
      type="button"
      title={t('settings.add')}
      aria-label={t('settings.add')}
      onClick={() => openAddCard({}, 'composer')}
    >
      <AccessIcon size={16} />
    </button>
  )
}

export function BrowserMenuAdd(props: any): any {
  if (props?.tab?.kind !== 'browser') return null
  return (
    <button
      className="dsh-access-menu-item"
      type="button"
      onClick={() => {
        openAddCard({ site: hostOf(activeBrowserUrl()) }, 'composer')
        props?.dismiss?.()
      }}
    >
      {t('settings.add')}
    </button>
  )
}

export function AccessCardOverlay(props: any): any {
  const useSessions = props?.useSessions
  const activeSessionId = typeof useSessions === 'function'
    ? useSessions((state: any) => Object.values(state?.byId ?? {}).find((session: any) => (session?.retainedBy?.mainView ?? 0) > 0)?.id)
    : undefined
  return <AccessCardOverlayBody activeSessionId={activeSessionId} />
}

function AccessCardOverlayBody(_props: { activeSessionId?: string }): any {
  const vault = useVault()
  const card = vault.card
  const login = vault.pendingLogin
  if (!card && !login) return null
  if (card && card.open !== true) return null
  const finish = (status: 'saved' | 'cancelled', entryLabel?: string) => {
    if (card) completeCard(status, entryLabel)
    else dismissLogin()
  }
  return (
    <div
      className="dsh-access-backdrop"
      role="dialog"
      aria-modal="true"
      onClick={(event) => {
        if (event.target === event.currentTarget) finish('cancelled')
      }}
    >
      <div className="dsh-access-modal" onClick={(event) => event.stopPropagation()}>
        <button
          className="dsh-access-button dsh-access-modal-close"
          type="button"
          aria-label={t('common.close')}
          onClick={() => finish('cancelled')}
        >
          {t('common.close')}
        </button>
        {card ? (
          vault.status !== 'unlocked'
            ? <UnlockForm />
            : <CredentialForm initial={card} onDone={(entry) => completeCard('saved', entry.label)} onCancel={() => completeCard('cancelled')} />
        ) : (
          <LoginToolView />
        )}
      </div>
    </div>
  )
}

function DevicePanel(): any {
  const vault = useVault()
  return (
    <div>
      <div className="dsh-access-section-title">{t('settings.device')}</div>
      <div className="dsh-access-card">
        <div className="dsh-access-muted">{vault.remembered ? t('settings.remembered') : t('settings.deviceHint')}</div>
        <div className="dsh-access-actions">
          {vault.remembered ? (
            <button className="dsh-access-button" type="button" onClick={forgetDevice}>{t('settings.forgetDevice')}</button>
          ) : (
            <button className="dsh-access-button" type="button" onClick={() => { void rememberCurrentDevice() }}>{t('settings.rememberDevice')}</button>
          )}
        </div>
      </div>
    </div>
  )
}

interface BridgeReading {
  state: string
  detail: string
  command?: string
}

/**
 * Settings → Access → browser engine.
 *
 * Three states, because "installed" and "usable in the official sidebar" are not
 * the same thing: the shared browser plugin ships a separate window until its
 * desktop bridge is installed. Each state offers the one action that moves the
 * user forward, so a fresh install never has to read the README to get a browser.
 */
function BrowserEnginePanel(): any {
  const [installed, setInstalled] = useState(false)
  const [canInstall, setCanInstall] = useState(false)
  const [enabled, setEnabled] = useState(false)
  const [bridge, setBridge] = useState<BridgeReading | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const read = async (): Promise<boolean> => {
    let external = installed
    try {
      const response = await fetch(new URL('dsh-access/api/browser-engine', document.baseURI).href, { cache: 'no-store' })
      const data = await response.json().catch(() => ({}))
      if (response.ok && data?.ok === true) {
        external = data.installed === true
        setInstalled(external)
        setEnabled(data.enabled === true)
        setCanInstall(data.manager === true)
      }
    } catch {
      // the host may be restarting; the panel keeps its last reading
    }
    try {
      const response = await fetch(new URL('dsh-builtin-browser/bridge-status', document.baseURI).href, { cache: 'no-store' })
      const data = await response.json().catch(() => ({}))
      const reading = data?.bridge
      if (response.ok && reading) {
        setBridge({
          state: String(reading.state ?? ''),
          detail: String(reading.detail ?? ''),
          command: typeof reading.command === 'string' ? reading.command : undefined,
        })
      } else {
        setBridge(null)
      }
    } catch {
      setBridge(null)
    }
    return external
  }

  useEffect(() => {
    void read()
  }, [])

  const install = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const response = await fetch(new URL('dsh-access/api/browser-engine', document.baseURI).href, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'install' }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || data?.ok !== true) throw new Error(String(data?.error ?? `HTTP ${response.status}`))
      setNotice(t('settings.browserInstallDone'))
      // Activation is live: poll briefly instead of asking the user to refresh.
      for (let attempt = 0; attempt < 8; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1500))
        if (await read()) break
      }
    } catch (installError) {
      setError(t('settings.browserEngineError', { error: installError instanceof Error ? installError.message : String(installError) }))
    } finally {
      setBusy(false)
    }
  }

  const installBridge = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      // Same-origin with the authenticated desktop session, so the plugin's own
      // maintenance route can coordinate the quit, the write and the restart.
      const locale = String(navigator.language ?? '').toLowerCase().startsWith('zh') ? 'zh' : 'en'
      const response = await fetch(new URL('dsh-builtin-browser/bridge-maintenance', document.baseURI).href, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'install', locale }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || data?.accepted !== true) throw new Error(String(data?.error ?? `HTTP ${response.status}`))
      setNotice(t('settings.browserBridgeStarted'))
    } catch (bridgeError) {
      setError(t('settings.browserEngineError', { error: bridgeError instanceof Error ? bridgeError.message : String(bridgeError) }))
    } finally {
      setBusy(false)
    }
  }

  const toggle = async (next: boolean): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const response = await fetch(new URL('dsh-access/api/browser-engine', document.baseURI).href, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || data?.ok !== true) throw new Error(data?.error ?? `HTTP ${response.status}`)
      setEnabled(next)
      setNotice(next ? t('settings.browserEngineEnabled') : t('settings.browserEngineDisabled'))
    } catch (toggleError) {
      setError(t('settings.browserEngineError', { error: toggleError instanceof Error ? toggleError.message : String(toggleError) }))
    } finally {
      setBusy(false)
    }
  }

  const bridgeReady = bridge?.state === 'installed'
  return (
    <div>
      <div className="dsh-access-section-title">{t('settings.browserEngine')}</div>
      <div className="dsh-access-card">
        {!installed ? (
          <div>
            <div className="dsh-access-muted">{t('settings.browserFallback')}</div>
            <div className="dsh-access-hint">{t('settings.browserUpgrade')}</div>
            <div className="dsh-access-actions">
              <button className="dsh-access-button primary" type="button" disabled={busy || !canInstall} onClick={() => { void install() }}>
                {busy ? t('common.busy') : t('settings.browserInstall')}
              </button>
            </div>
            <div className="dsh-access-hint">{t('settings.browserInstallHint')}</div>
          </div>
        ) : bridgeReady ? (
          <div>
            <div className="dsh-access-muted">{t('settings.browserReady')}</div>
            <label className="dsh-access-check">
              <input type="checkbox" checked={enabled} disabled={busy} onChange={(event) => { void toggle(event.target.checked) }} />
              {t('settings.browserEnginePlaywright')}
            </label>
            <div className="dsh-access-hint">{t('settings.browserEngineHint')}</div>
          </div>
        ) : (
          <div>
            <div className="dsh-access-muted">{t('settings.browserBridgeMissing')}</div>
            {bridge ? (
              <div className="dsh-access-hint">
                {t('settings.browserBridgeState', { state: bridge.state })}{bridge.detail ? ` — ${bridge.detail}` : ''}
              </div>
            ) : null}
            <div className="dsh-access-actions">
              <button className="dsh-access-button primary" type="button" disabled={busy} onClick={() => { void installBridge() }}>
                {busy ? t('common.busy') : t('settings.browserBridgeInstall')}
              </button>
              <button className="dsh-access-button" type="button" disabled={busy} onClick={() => { void read() }}>
                {t('settings.browserRefresh')}
              </button>
            </div>
            <div className="dsh-access-hint">{t('settings.browserBridgeHint')}</div>
          </div>
        )}
        {error ? <div className="dsh-access-error">{error}</div> : null}
        {notice ? <div className="dsh-access-notice">{notice}</div> : null}
      </div>
    </div>
  )
}

function PasswordPanel(): any {
  const vault = useVault()
  const [oldPassword, setOldPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (event: any) => {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    await changePassword(oldPassword, newPassword)
    setBusy(false)
    setOldPassword('')
    setNewPassword('')
  }
  return (
    <div>
      <div className="dsh-access-section-title">{t('settings.security')}</div>
      <form className="dsh-access-card" onSubmit={submit}>
        <div className="dsh-access-title">{t('settings.changePassword')}</div>
        <label className="dsh-access-label">
          {t('settings.oldPassword')}
          <input className="dsh-access-input" type="password" value={oldPassword} onChange={(event) => setOldPassword(event.target.value)} />
        </label>
        <label className="dsh-access-label">
          {t('settings.newPassword')}
          <input className="dsh-access-input" type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} />
        </label>
        {vault.error ? <div className="dsh-access-error">{errorText(vault.error)}</div> : null}
        {vault.notice ? <div className="dsh-access-notice">{vault.notice}</div> : null}
        <div className="dsh-access-actions">
          <button className="dsh-access-button primary" type="submit" disabled={busy || oldPassword.length < 8 || newPassword.length < 8}>
            {busy ? t('common.busy') : t('settings.changePassword')}
          </button>
        </div>
      </form>
    </div>
  )
}

function TransferPanel(): any {
  const vault = useVault()
  const [passphrase, setPassphrase] = useState('')
  const [importPassphrase, setImportPassphrase] = useState('')
  const [pendingImport, setPendingImport] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const exportFile = async (event: any) => {
    event.preventDefault()
    if (passphrase.length < 8) {
      setError(t('settings.passphraseShort'))
      return
    }
    setBusy('export')
    setError('')
    setNotice('')
    try {
      const text = await exportVaultFile(vault.entries, passphrase)
      downloadText('dsh-access-export.json', text)
      setNotice(t('settings.exported'))
      setPassphrase('')
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : String(exportError))
    } finally {
      setBusy('')
    }
  }

  const chooseFile = async (event: any) => {
    const file = event.target.files?.[0]
    if (!file) return
    setBusy('import')
    setError('')
    setNotice('')
    try {
      const text = await file.text()
      if (isEncryptedExport(text)) {
        setPendingImport(text)
        setNotice(t('settings.importPassphraseHint'))
      } else {
        const count = await addEntries(parseCsv(text))
        setNotice(t('settings.imported', { count }))
        setPendingImport('')
      }
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : String(importError))
    } finally {
      setBusy('')
    }
  }

  const importFile = async (event: any) => {
    event.preventDefault()
    setBusy('import')
    setError('')
    setNotice('')
    try {
      const count = await addEntries(await importEncryptedVault(pendingImport, importPassphrase))
      setNotice(t('settings.imported', { count }))
      setPendingImport('')
      setImportPassphrase('')
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : String(importError))
    } finally {
      setBusy('')
    }
  }

  return (
    <div>
      <div className="dsh-access-section-title">{t('settings.transfer')}</div>
      <div className="dsh-access-muted">{t('settings.transferDesc')}</div>
      {error ? <div className="dsh-access-error">{error}</div> : null}
      {notice ? <div className="dsh-access-notice">{notice}</div> : null}
      <form className="dsh-access-card" onSubmit={exportFile}>
        <div className="dsh-access-title">{t('settings.export')}</div>
        <label className="dsh-access-label">
          {t('settings.exportPassphrase')}
          <input className="dsh-access-input" type="password" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} />
        </label>
        <div className="dsh-access-actions">
          <button className="dsh-access-button primary" type="submit" disabled={busy !== '' || vault.entries.length === 0}>{t('settings.export')}</button>
        </div>
      </form>
      <div className="dsh-access-card">
        <div className="dsh-access-title">{t('settings.import')}</div>
        <input className="dsh-access-file" type="file" accept=".json,.csv" onChange={chooseFile} disabled={busy !== ''} />
        {pendingImport ? (
          <form onSubmit={importFile}>
            <label className="dsh-access-label">
              {t('settings.importPassphrase')}
              <input className="dsh-access-input" type="password" value={importPassphrase} onChange={(event) => setImportPassphrase(event.target.value)} />
            </label>
            <div className="dsh-access-actions">
              <button className="dsh-access-button primary" type="submit" disabled={busy !== '' || importPassphrase.length < 8}>{t('settings.import')}</button>
              <button className="dsh-access-button" type="button" onClick={() => setPendingImport('')}>{t('common.cancel')}</button>
            </div>
          </form>
        ) : null}
      </div>
    </div>
  )
}

function ConnectorsPanel(): any {
  const vault = useVault()
  const [connectors, setConnectors] = useState<any[]>([])
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState('')
  const [formId, setFormId] = useState('')
  const [fields, setFields] = useState<Record<string, string>>({})
  const [oauth, setOauth] = useState<any>(null)

  const load = async () => {
    try {
      setConnectors(await listConnectors())
      setError('')
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError))
    }
  }

  useEffect(() => {
    void load()
  }, [])

  useEffect(() => {
    if (!oauth) return
    let cancelled = false
    let timer: any
    const tick = async () => {
      try {
        const result = await pollOAuth(oauth.flowId)
        if (cancelled) return
        if (result?.pending) {
          const interval = Math.max(Number(result.interval) || oauth.interval || 5, 5)
          timer = setTimeout(tick, interval * 1000)
          return
        }
        setOauth(null)
        setFormId('')
        setNotice(t('settings.oauthConnected'))
        await load()
      } catch (pollError) {
        if (cancelled) return
        setOauth(null)
        setError(pollError instanceof Error ? pollError.message : String(pollError))
      }
    }
    timer = setTimeout(tick, Math.max(Number(oauth.interval) || 5, 5) * 1000)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [oauth?.flowId])

  const closeForm = () => {
    setFormId('')
    setOauth(null)
  }

  const startMicrosoft = async () => {
    if (busy !== '') return
    setBusy(formId)
    setError('')
    setNotice('')
    try {
      const result = await startOAuth(formId, fields)
      setOauth({
        flowId: String(result?.flowId ?? ''),
        userCode: String(result?.userCode ?? ''),
        verificationUri: String(result?.verificationUri ?? 'https://microsoft.com/devicelogin'),
        interval: Math.max(Number(result?.interval) || 5, 5),
      })
      setNotice(t('settings.oauthWaiting'))
    } catch (oauthError) {
      setError(oauthError instanceof Error ? oauthError.message : String(oauthError))
    } finally {
      setBusy('')
    }
  }

  const startGoogle = async () => {
    if (busy !== '') return
    setBusy(formId)
    setError('')
    setNotice('')
    try {
      const result = await startOAuth(formId, fields)
      setOauth({
        flowId: String(result?.flowId ?? ''),
        authUrl: String(result?.authUrl ?? ''),
        interval: Math.max(Number(result?.interval) || 2, 2),
      })
      setNotice(t('settings.oauthWaiting'))
      if (result?.authUrl) window.open(String(result.authUrl), '_blank', 'noopener')
    } catch (oauthError) {
      setError(oauthError instanceof Error ? oauthError.message : String(oauthError))
    } finally {
      setBusy('')
    }
  }

  const openForm = (connector: any, addAnother = false) => {
    const base = String(connector.id).split(':')[0]
    setFormId(addAnother ? `${base}:${Date.now().toString(36)}` : connector.id)
    setFields(base === 'email' ? { preset: 'qq' } : {})
    setError('')
    setNotice('')
  }

  const submit = async (event: any) => {
    event.preventDefault()
    if (busy !== '') return
    setBusy(formId)
    setError('')
    setNotice('')
    try {
      const result = await connectConnector(formId, fields)
      setNotice(result?.test?.detail ? t('settings.connectorConnected', { detail: result.test.detail }) : t('settings.connected'))
      setFormId('')
      await load()
    } catch (connectError) {
      setError(connectError instanceof Error ? connectError.message : String(connectError))
    } finally {
      setBusy('')
    }
  }

  const run = async (id: string, kind: 'test' | 'disconnect') => {
    setBusy(id)
    setError('')
    setNotice('')
    try {
      if (kind === 'test') {
        const result = await testConnector(id)
        setNotice(result?.detail ? t('settings.connectorTest', { detail: result.detail }) : t('settings.connected'))
      } else {
        await disconnectConnector(id)
        setNotice(t('settings.disconnect'))
      }
      await load()
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : String(actionError))
    } finally {
      setBusy('')
    }
  }

  const selectedBaseId = formId.split(':')[0]
  const selected = connectors.find((connector) => connector.id === formId)
    ?? connectors.find((connector) => String(connector.id).split(':')[0] === selectedBaseId)
  const preset = selected?.auth?.presets?.[fields.preset] ?? {}
  const requiredReady = (selected?.auth?.fields ?? [])
    .filter((field: any) => field.required === true)
    .every((field: any) => String(fields[field.key] ?? '').trim() !== '')

  const groups = (() => {
    const map = new Map<string, { base: any; accounts: any[] }>()
    for (const connector of connectors) {
      const baseId = String(connector.id).split(':')[0]
      const group = map.get(baseId) ?? { base: connector, accounts: [] }
      if (!String(connector.id).includes(':')) group.base = connector
      if (connector.connected) group.accounts.push(connector)
      map.set(baseId, group)
    }
    return [...map.entries()].map(([baseId, group]) => ({ baseId, ...group }))
  })()

  return (
    <div>
      <div className="dsh-access-section-title">{t('settings.connectors')}</div>
      <div className="dsh-access-muted">{t('settings.connectorsDesc')}</div>
      {vault.status !== 'unlocked' ? <div className="dsh-access-muted">{t('settings.connectorLocked')}</div> : null}
      {error ? <div className="dsh-access-error">{error}</div> : null}
      {notice ? <div className="dsh-access-notice">{notice}</div> : null}
      <div className="dsh-access-list" style={{ marginTop: 8 }}>
        {groups.map((group) => (
          <div className="dsh-access-item" key={group.baseId}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="dsh-access-item-label">
                {connectorBaseName(group.base)}
                {group.accounts.length > 0 ? <span className="dsh-access-badge">{t('settings.connected')}</span> : null}
              </div>
              <div className="dsh-access-muted">{connectorDescription(group.base)}</div>
              {group.accounts.length > 0 ? (
                <div className="dsh-access-account-list">
                  {group.accounts.map((account) => (
                    <div className="dsh-access-account" key={account.id}>
                      <span className="dsh-access-account-label">{accountLabel(account)}</span>
                      <div className="dsh-access-account-actions">
                        <button className="dsh-access-button" type="button" disabled={busy === account.id} onClick={() => { void run(account.id, 'test') }}>{t('settings.test')}</button>
                        <button className="dsh-access-button danger" type="button" disabled={busy === account.id} onClick={() => { void run(account.id, 'disconnect') }}>{t('settings.disconnect')}</button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
            <div className="dsh-access-actions">
              {group.accounts.length > 0 ? (
                group.base.auth?.kind !== 'oauth-device' ? (
                  <button className="dsh-access-button" type="button" disabled={busy === group.base.id} onClick={() => openForm(group.base, true)}>{t('settings.addAccount')}</button>
                ) : null
              ) : (
                <button className="dsh-access-button primary" type="button" disabled={busy === group.base.id || vault.status !== 'unlocked'} onClick={() => openForm(group.base)}>{t('settings.connect')}</button>
              )}
            </div>
          </div>
        ))}
      </div>
      {selected ? (
        <form className="dsh-access-card" onSubmit={selected.auth?.kind === 'oauth-device' || selected.auth?.kind === 'oauth-loopback' ? (event) => event.preventDefault() : submit}>
          <div className="dsh-access-title">{connectorName(selected)}{selected.id !== formId ? ` · ${t('settings.addAccount')}` : ''}</div>
          {selected.auth?.kind === 'api-key' ? (
            (selected.auth.fields ?? []).map((field: any) => (
              <label className="dsh-access-label" key={field.key}>
                {connectorFieldLabel(selected, field)}
                <input
                  className="dsh-access-input"
                  type={field.secret === true ? 'password' : 'text'}
                  value={fields[field.key] ?? ''}
                  onChange={(event) => setFields({ ...fields, [field.key]: event.target.value })}
                  placeholder={field.placeholder}
                />
              </label>
            ))
          ) : selected.auth?.kind === 'oauth-device' ? (
            <>
              {(selected.auth.fields ?? []).map((field: any) => (
                <label className="dsh-access-label" key={field.key}>
                  {connectorFieldLabel(selected, field)}
                  <input
                    className="dsh-access-input"
                    type={field.secret === true ? 'password' : 'text'}
                    value={fields[field.key] ?? ''}
                    onChange={(event) => setFields({ ...fields, [field.key]: event.target.value })}
                    placeholder={field.placeholder}
                  />
                </label>
              ))}
              {oauth ? (
                <div className="dsh-access-card">
                  <div className="dsh-access-title">{t('settings.oauthCode')}</div>
                  <div className="dsh-access-oauthCode">{oauth.userCode}</div>
                  <a className="dsh-access-link" href={oauth.verificationUri} target="_blank" rel="noreferrer">{t('settings.oauthLink')}</a>
                  <div className="dsh-access-hint">{t('settings.oauthWaiting')}</div>
                </div>
              ) : (
                <div className="dsh-access-hint">{t('settings.oauthHint')}</div>
              )}
            </>
          ) : selected.auth?.kind === 'oauth-loopback' ? (
            <>
              {(selected.auth.fields ?? []).map((field: any) => (
                <label className="dsh-access-label" key={field.key}>
                  {connectorFieldLabel(selected, field)}
                  <input
                    className="dsh-access-input"
                    type={field.secret === true ? 'password' : 'text'}
                    value={fields[field.key] ?? ''}
                    onChange={(event) => setFields({ ...fields, [field.key]: event.target.value })}
                    placeholder={field.placeholder}
                  />
                </label>
              ))}
              {oauth?.authUrl ? (
                <div className="dsh-access-card">
                  <div className="dsh-access-title">{t('settings.oauthGoogle')}</div>
                  <a className="dsh-access-link" href={oauth.authUrl} target="_blank" rel="noreferrer">{t('settings.oauthLinkGoogle')}</a>
                  <div className="dsh-access-hint">{t('settings.oauthWaiting')}</div>
                </div>
              ) : (
                <div className="dsh-access-hint">{t('settings.oauthHintGoogle')}</div>
              )}
            </>
          ) : (
            <>
              <div className="dsh-access-hint">{t('settings.emailOauthHint')}</div>
              <label className="dsh-access-label">
                {t('settings.provider')}
                <select className="dsh-access-select" value={fields.preset ?? 'qq'} onChange={(event) => setFields({ ...fields, preset: event.target.value })}>
                  {Object.entries(selected.auth?.presets ?? {}).filter(([key]) => key !== 'gmail' && key !== 'outlook').map(([key, value]: any) => (
                    <option key={key} value={key}>{value?.label ?? key}</option>
                  ))}
                </select>
              </label>
              {preset?.note ? <div className="dsh-access-hint">{tOptional(`connector.email.note.${fields.preset}`) ?? preset.note}</div> : null}
              {preset?.helpUrl ? <a className="dsh-access-link" href={preset.helpUrl} target="_blank" rel="noreferrer">{t('settings.getAppPassword')}</a> : null}
              <label className="dsh-access-label">
                {t('settings.email')}
                <input className="dsh-access-input" value={fields.email ?? ''} onChange={(event) => setFields({ ...fields, email: event.target.value })} placeholder="you@example.com" />
              </label>
              <label className="dsh-access-label">
                {fields.preset === 'gmail' ? t('settings.gmailAppPassword') : t('settings.appPassword')}
                <input className="dsh-access-input" type="password" value={fields.password ?? ''} onChange={(event) => setFields({ ...fields, password: event.target.value })} />
              </label>
              {preset?.passwordHint ? <div className="dsh-access-hint">{preset.passwordHint}</div> : null}
              {fields.preset === 'custom' ? (
                <>
                  <label className="dsh-access-label">
                    {t('settings.imapHost')}
                    <input className="dsh-access-input" value={fields.imapHost ?? ''} onChange={(event) => setFields({ ...fields, imapHost: event.target.value })} placeholder="imap.example.com" />
                  </label>
                  <label className="dsh-access-label">
                    {t('settings.smtpHost')}
                    <input className="dsh-access-input" value={fields.smtpHost ?? ''} onChange={(event) => setFields({ ...fields, smtpHost: event.target.value })} placeholder="smtp.example.com" />
                  </label>
                </>
              ) : null}
            </>
          )}
          {error ? <div className="dsh-access-error">{error}</div> : null}
          <div className="dsh-access-actions">
            {selected.auth?.kind === 'oauth-device' ? (
              <>
                <button className="dsh-access-button primary" type="button" disabled={busy === formId || !requiredReady || oauth !== null} onClick={() => { void startMicrosoft() }}>
                  {t('settings.signInMicrosoft')}
                </button>
                <button className="dsh-access-button" type="button" onClick={closeForm}>{t('common.cancel')}</button>
              </>
            ) : selected.auth?.kind === 'oauth-loopback' ? (
              <>
                <button className="dsh-access-button primary" type="button" disabled={busy === formId || !requiredReady || oauth !== null} onClick={() => { void startGoogle() }}>
                  {t('settings.signInGoogle')}
                </button>
                <button className="dsh-access-button" type="button" onClick={closeForm}>{t('common.cancel')}</button>
              </>
            ) : (
              <>
                <button className="dsh-access-button primary" type="submit" disabled={busy === formId || !requiredReady}>{busy === formId ? t('common.busy') : t('settings.connect')}</button>
                <button className="dsh-access-button" type="button" onClick={closeForm}>{t('common.cancel')}</button>
              </>
            )}
          </div>
        </form>
      ) : null}
    </div>
  )
}

export function SettingsPage(_props: any): any {
  const vault = useVault()
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<Entry | null>(null)
  const [confirmId, setConfirmId] = useState('')

  if (vault.status === 'loading') {
    return <div className="dsh-access-page"><div className="dsh-access-muted">{t('common.loading')}</div></div>
  }
  if (vault.status === 'error') {
    return (
      <div className="dsh-access-page">
        <div className="dsh-access-error">{errorText(vault.error) || t('common.error')}</div>
        <div className="dsh-access-actions">
          <button className="dsh-access-button" type="button" onClick={() => { void retryStore() }}>{t('settings.retry')}</button>
        </div>
      </div>
    )
  }
  if (vault.status !== 'unlocked') {
    return (
      <div className="dsh-access-page">
        <div className="dsh-access-page-title">{t('settings.title')}</div>
        <div className="dsh-access-muted">{t('settings.description')}</div>
        <UnlockForm />
      </div>
    )
  }

  return (
    <div className="dsh-access-page">
      <div className="dsh-access-page-head">
        <div>
          <div className="dsh-access-page-title">{t('settings.title')}</div>
          <div className="dsh-access-muted">{t('settings.description')}</div>
        </div>
        <div className="dsh-access-actions">
          <button className="dsh-access-button" type="button" onClick={() => setAdding((value) => !value)}>{t('settings.add')}</button>
          <button className="dsh-access-button" type="button" onClick={lock}>{t('settings.lock')}</button>
        </div>
      </div>
      {vault.error ? <div className="dsh-access-error">{errorText(vault.error)}</div> : null}
      {vault.notice ? <div className="dsh-access-notice">{vault.notice}</div> : null}
      {adding ? (
        <CredentialForm
          onDone={() => setAdding(false)}
          onCancel={() => setAdding(false)}
        />
      ) : null}
      {editing ? (
        <CredentialForm
          entry={editing}
          onDone={() => setEditing(null)}
          onCancel={() => setEditing(null)}
        />
      ) : null}
      {vault.entries.length === 0 ? (
        <div className="dsh-access-muted">{t('settings.empty')}</div>
      ) : (
        <div className="dsh-access-list">
          {vault.entries.map((entry) => (
            <div className="dsh-access-item" key={entry.id}>
              <div>
                <div className="dsh-access-item-label">{entry.label}{entry.primary ?  <span className="dsh-access-badge">{t('settings.primary')}</span> : null}</div>
                <div className="dsh-access-muted">
                  {entry.site} · {maskUsername(entry.username)} · {entry.lastUsedAt ? new Date(entry.lastUsedAt).toLocaleDateString() : t('settings.never')}
                </div>
              </div>
              <div className="dsh-access-actions">
                {confirmId === entry.id ? (
                  <>
                    <button className="dsh-access-button danger" type="button" onClick={() => { void deleteEntry(entry.id); setConfirmId('') }}>
                      {t('settings.confirmDelete')}
                    </button>
                    <button className="dsh-access-button" type="button" onClick={() => setConfirmId('')}>{t('common.cancel')}</button>
                  </>
                ) : (
                  <>
                    {entry.primary ? null : <button className="dsh-access-button" type="button" onClick={() => { void setPrimary(entry.id) }}>{t('settings.makePrimary')}</button>}
                    <button className="dsh-access-button" type="button" onClick={() => setEditing(entry)}>{t('settings.edit')}</button>
                    <button className="dsh-access-button" type="button" onClick={() => setConfirmId(entry.id)}>{t('settings.delete')}</button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      <PasswordPanel />
      <DevicePanel />
      <BrowserEnginePanel />
      <TransferPanel />
      <ConnectorsPanel />
      <div className="dsh-access-hint">{t('settings.autoLock')}</div>
    </div>
  )
}

export function AccessIcon(props: { size?: number }): any {
  const size = props?.size ?? 20
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <path d="M32 5 53 13v17c0 14-9 24-21 29C20 54 11 44 11 30V13L32 5Z" fill="currentColor" opacity=".18" />
      <path d="M32 5 53 13v17c0 14-9 24-21 29C20 54 11 44 11 30V13L32 5Z" fill="none" stroke="currentColor" strokeWidth="3" />
      <circle cx="32" cy="28" r="6" fill="none" stroke="currentColor" strokeWidth="3" />
      <path d="M32 34v12" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  )
}

