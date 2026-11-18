/**
 * One-click setup for the shared browser engine, without a running DSH.
 *
 * Settings → Access → Browser engine installs `dsh-builtin-browser` from the
 * plugin market for a user who does not have it. That path is the only place
 * dsh-access installs another package, and it must never pretend success: this
 * checks the four answers the manager can give (installed, installed live,
 * already here, unsupported host) against a fake manager.
 *
 *   node tests/browser-setup.check.mjs
 */

import { mkdir, rm } from 'node:fs/promises'
import { build } from 'esbuild'

const work = '.tmp-browser-setup'
await rm(work, { recursive: true, force: true })
await mkdir(work, { recursive: true })

await build({
  entryPoints: ['src/host/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: `${work}/host.mjs`,
  packages: 'external',
  logLevel: 'silent',
})

const { installBrowserBundle } = await import(`../${work}/host.mjs`)

let failed = 0
function check(ok, label) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`)
  if (!ok) failed += 1
}

// 1. A host whose plugin manager cannot install refuses instead of throwing.
const unsupported = await installBrowserBundle({ setBundleEnabled: async () => ({}) })
check(unsupported.ok === false, 'a manager without installBundle is refused')
check(/market/i.test(String(unsupported.error)), 'the refusal names the plugin market instead of failing silently')

// 2. A live profile reports the bundle as applied.
const applied = await installBrowserBundle({
  installBundle: async (spec) => ({ changed: true, application: 'applied', stage: 'install', target: spec, bundle: spec, version: '0.5.8' }),
})
check(applied.ok === true, 'an applied install reports ok')
check(applied.version === '0.5.8' && applied.bundle === 'dsh-builtin-browser', 'the installed bundle and version come back')
check(applied.application === 'applied', 'the application state is passed through')

// 3. already-installed is success, whether it arrives as a code or a throw.
const asCode = await installBrowserBundle({
  installBundle: async () => ({ changed: false, application: 'failed', stage: 'install', target: 'dsh-builtin-browser', error: { code: 'already-installed' } }),
})
check(asCode.ok === true && asCode.alreadyInstalled === true, 'already-installed as a result code is success')

const asThrow = await installBrowserBundle({
  installBundle: async () => { throw new Error('already-installed') },
})
check(asThrow.ok === true && asThrow.alreadyInstalled === true, 'already-installed as a thrown failure is success too')

// 4. A real failure stays a failure and names what happened.
const refused = await installBrowserBundle({
  installBundle: async () => ({ changed: false, application: 'failed', stage: 'install', target: 'dsh-builtin-browser', error: { code: 'pnpm-failed' } }),
})
check(refused.ok === false, 'a failed install is not reported as success')
check(refused.error === 'pnpm-failed', 'the failure code is surfaced for the settings page')

// 5. A restart-required install still counts: the bundle is there.
const restart = await installBrowserBundle({
  installBundle: async () => ({ changed: true, application: 'restart-required', stage: 'install', target: 'dsh-builtin-browser', restartReason: 'host-restart' }),
})
check(restart.ok === true, 'restart-required is reported as installed')
check(restart.restartReason === 'host-restart', 'the restart reason is kept')

await rm(work, { recursive: true, force: true })

if (failed > 0) {
  console.error(`\n${failed} browser setup check(s) failed`)
  process.exit(1)
}
console.log('\nall browser setup checks passed')
