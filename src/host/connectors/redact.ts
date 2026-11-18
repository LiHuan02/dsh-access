const SECRET_KEY = /token|secret|password|authorization|api[_-]?key|cookie/i
const TOKEN_VALUE = /^(gh[pousr]_|github_pat_|xox[baprs]-|sk-|AKIA|ASIA|eyJ)/

export function redactSecrets(value: any, depth = 0): any {
  if (depth > 6) return '[truncated]'
  if (typeof value === 'string') return TOKEN_VALUE.test(value) ? '[redacted]' : value
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item, depth + 1))
  if (value !== null && typeof value === 'object') {
    const output: Record<string, any> = {}
    for (const [name, item] of Object.entries(value)) {
      output[name] = SECRET_KEY.test(name) ? '[redacted]' : redactSecrets(item, depth + 1)
    }
    return output
  }
  return value
}
