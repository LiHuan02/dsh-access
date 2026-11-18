export function hostOf(value: string): string {
  const raw = String(value ?? '').trim()
  if (raw === '') return ''
  try {
    const url = new URL(raw.includes('://') ? raw : `https://${raw}`)
    return url.hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return raw.toLowerCase().replace(/^www\./, '')
  }
}

export function matchEntries<T extends { site: string; origins?: string[] }>(entries: T[], site: string): T[] {
  const target = hostOf(site)
  if (target === '') return []
  return entries.filter((entry) => {
    const candidate = hostOf(entry.site)
    if (candidate === '') return false
    if (candidate === target) return true
    if (target.endsWith(`.${candidate}`)) return true
    if (candidate.endsWith(`.${target}`)) return true
    return (entry.origins ?? []).some((origin) => hostOf(origin) === target)
  })
}

export function maskUsername(username: string): string {
  const value = String(username ?? '')
  if (value === '') return ''
  const at = value.indexOf('@')
  if (at > 0) return `${value.slice(0, 1)}***${value.slice(at)}`
  return `${value.slice(0, 1)}***`
}
