import { build } from 'esbuild'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'

/**
 * Build inputs that do not belong in the repository.
 *
 * `secrets.local.json` (gitignored) carries the OAuth client a packaged build
 * ships so users get a zero-config sign-in. A source build without it leaves the
 * built-in client empty and the connector asks for the user's own — the plugin
 * still builds and runs, it just has one more field to fill.
 */
function builtinSecrets() {
  const define = {}
  const empty = { 'process.env.DSH_ACCESS_GMAIL_CLIENT_ID': '""', 'process.env.DSH_ACCESS_GMAIL_CLIENT_SECRET': '""' }
  if (!existsSync('secrets.local.json')) return { define: empty, source: 'none' }
  try {
    const parsed = JSON.parse(readFileSync('secrets.local.json', 'utf8'))
    const clientId = typeof parsed?.gmail?.clientId === 'string' ? parsed.gmail.clientId : ''
    const clientSecret = typeof parsed?.gmail?.clientSecret === 'string' ? parsed.gmail.clientSecret : ''
    if (clientId === '' || clientSecret === '') return { define: empty, source: 'incomplete' }
    define['process.env.DSH_ACCESS_GMAIL_CLIENT_ID'] = JSON.stringify(clientId)
    define['process.env.DSH_ACCESS_GMAIL_CLIENT_SECRET'] = JSON.stringify(clientSecret)
    return { define, source: 'secrets.local.json' }
  } catch (error) {
    console.warn(`[build] ignoring secrets.local.json: ${error instanceof Error ? error.message : String(error)}`)
    return { define: empty, source: 'unreadable' }
  }
}

mkdirSync('lib', { recursive: true })

const secrets = builtinSecrets()
if (secrets.source !== 'secrets.local.json') {
  console.log(`[build] no built-in Google client (${secrets.source}); Gmail will ask for a client ID`)
}

await build({
  entryPoints: ['src/host/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: 'lib/index.js',
  external: ['@deepseek-ai/*', 'node:*', 'imapflow', 'nodemailer', 'mailparser', '@modelcontextprotocol/sdk', '@modelcontextprotocol/sdk/*'],
  define: secrets.define,
  logLevel: 'info',
})

const client = await build({
  entryPoints: ['src/client/index.tsx'],
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: 'es2022',
  write: false,
  external: ['react', 'react/jsx-runtime', 'react-dom'],
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'info',
})

const code = client.outputFiles[0].text
const wrapped = `window.__ModuleLoader__.load({\n  id: 'dsh-access',\n  factory(require) {\n    var module = { exports: {} };\n    var exports = module.exports;\n${code}\n    return module.exports;\n  },\n});\n`
writeFileSync('lib/client.js', wrapped)
