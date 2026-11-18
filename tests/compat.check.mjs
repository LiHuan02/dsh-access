/**
 * Compatibility smoke test. Run with: node tests/compat.check.mjs
 *
 * It bundles the host compatibility module with esbuild (no DSH runtime
 * needed) and checks that a moved/absent API degrades a capability instead of
 * throwing out of plugin activation.
 */
import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'

const built = await build({
  entryPoints: ['src/host/compat.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  logLevel: 'silent',
})
const source = built.outputFiles[0].text
const mod = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)

let failures = 0
function check(name, condition) {
  if (condition) {
    console.log(`ok   ${name}`)
  } else {
    failures += 1
    console.log(`FAIL ${name}`)
  }
}

// 1. ctx.effect whose body throws must not escape.
{
  let threw = false
  const ctx = {
    effect(body) {
      try {
        const disposer = body()
        if (typeof disposer === 'function') disposer()
      } catch {
        threw = true
      }
    },
  }
  mod.safeEffect(ctx, () => { throw new Error('moved API') }, 'test: effect')
  check('safeEffect swallows a setup failure', threw === false)
}

// 2. tools.register that rejects options must retry without them.
{
  const calls = []
  const registered = []
  const ctx = {
    get(name) {
      if (name === 'tools') {
        return {
          register(definition, options) {
            calls.push(options)
            if (options !== undefined) throw new Error('options are not supported')
            registered.push(definition.name)
            return () => undefined
          },
          get() { throw new Error('no tool lookup') },
        }
      }
      return undefined
    },
    effect(body) { body() },
  }
  const ok = mod.registerTool(ctx, { name: 'sample' }, 'test: tool', { when: () => true })
  check('registerTool reports success', ok === true)
  check('registerTool retries without unsupported options', registered.length === 1 && registered[0] === 'sample')
  check('registerTool tried the options path first', calls.length === 2)
}

// 3. A throwing tools.get must read as "not available", never as an exception.
{
  const ctx = {
    get(name) {
      if (name === 'tools') return { get() { throw new Error('broken lookup') } }
      return undefined
    },
  }
  check('hasTool tolerates a throwing lookup', mod.hasTool(ctx, 'dsh_browser_open') === false)
}

// 4. Missing services must be no-ops.
{
  mod.safeEffect({}, () => undefined, 'test: no effect')
  mod.addPromptSection({}, { name: 'x', order: 1, text: 'y' })
  check('missing services are no-ops', true)
}

// 5. The manifest must not pin an exact DSH version again.
{
  const pkg = JSON.parse(await readFile('package.json', 'utf8'))
  const peers = pkg.peerDependencies ?? {}
  for (const [name, range] of Object.entries(peers)) {
    const exact = /^\d+\.\d+\.\d+/.test(range) && !range.startsWith('>=') && !range.startsWith('^') && !range.startsWith('~')
    check(`peer ${name} is a range (${range})`, exact === false)
  }
  check('engines.dsh is floor-only', String(pkg.engines?.dsh ?? '').startsWith('>='))
}

if (failures > 0) {
  console.error(`\n${failures} compatibility check(s) failed`)
  process.exit(1)
}
console.log('\nall compatibility checks passed')
