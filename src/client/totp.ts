export function base32Decode(input: string): Uint8Array {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  const clean = String(input ?? '').replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase()
  let bits = 0
  let value = 0
  const bytes: number[] = []
  for (const char of clean) {
    const index = alphabet.indexOf(char)
    if (index < 0) continue
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      bits -= 8
      bytes.push((value >>> bits) & 0xff)
    }
  }
  return new Uint8Array(bytes)
}

export async function generateTotpAt(secret: string, timeMs: number): Promise<{ code: string; remaining: number }> {
  const raw = base32Decode(secret)
  if (raw.length === 0) return { code: '', remaining: 0 }
  const key = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'])
  const counter = Math.floor(timeMs / 30000)
  const buffer = new ArrayBuffer(8)
  const view = new DataView(buffer)
  view.setUint32(0, Math.floor(counter / 0x100000000), false)
  view.setUint32(4, counter >>> 0, false)
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, buffer))
  const offset = signature[signature.length - 1] & 0x0f
  const binary = ((signature[offset] & 0x7f) << 24)
    | ((signature[offset + 1] & 0xff) << 16)
    | ((signature[offset + 2] & 0xff) << 8)
    | (signature[offset + 3] & 0xff)
  return {
    code: String(binary % 1000000).padStart(6, '0'),
    remaining: 30 - (Math.floor(timeMs / 1000) % 30),
  }
}

export async function generateTotp(secret: string): Promise<{ code: string; remaining: number }> {
  return generateTotpAt(secret, Date.now())
}
