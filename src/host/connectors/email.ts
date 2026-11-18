import type { ConnectorDefinition } from './types.js'
import { requireField } from './types.js'

const PRESETS: Record<string, any> = {
  gmail: {
    label: 'Gmail',
    imapHost: 'imap.gmail.com', imapPort: 993, imapSecure: true,
    smtpHost: 'smtp.gmail.com', smtpPort: 465, smtpSecure: true,
    helpUrl: 'https://myaccount.google.com/apppasswords',
    passwordHint: 'Gmail 需要 16 位应用专用密码（不是 Google 账号密码）。',
    note: 'Requires 2-Step Verification and a Google app password.',
  },
  outlook: {
    label: 'Outlook / Microsoft 365',
    imapHost: 'outlook.office365.com', imapPort: 993, imapSecure: true,
    smtpHost: 'smtp.office365.com', smtpPort: 587, smtpSecure: false,
    note: 'Microsoft rejects app passwords over IMAP/SMTP; use the separate Outlook connector (device-code OAuth) instead.',
  },
  qq: {
    label: 'QQ Mail',
    imapHost: 'imap.qq.com', imapPort: 993, imapSecure: true,
    smtpHost: 'smtp.qq.com', smtpPort: 465, smtpSecure: true,
    helpUrl: 'https://service.mail.qq.com/detail/0/75',
    note: 'Enable IMAP/SMTP in QQ Mail settings and use the authorization code.',
  },
  '163': {
    label: '163 Mail',
    imapHost: 'imap.163.com', imapPort: 993, imapSecure: true,
    smtpHost: 'smtp.163.com', smtpPort: 465, smtpSecure: true,
    note: 'Enable IMAP/SMTP and use the client authorization password.',
  },
  '126': {
    label: '126 Mail',
    imapHost: 'imap.126.com', imapPort: 993, imapSecure: true,
    smtpHost: 'smtp.126.com', smtpPort: 465, smtpSecure: true,
    note: 'Enable IMAP/SMTP and use the client authorization password.',
  },
  icloud: {
    label: 'iCloud Mail',
    imapHost: 'imap.mail.me.com', imapPort: 993, imapSecure: true,
    smtpHost: 'smtp.mail.me.com', smtpPort: 587, smtpSecure: false,
    helpUrl: 'https://support.apple.com/en-us/102654',
    note: 'Use an app-specific password from your Apple account.',
  },
  yahoo: {
    label: 'Yahoo Mail',
    imapHost: 'imap.mail.yahoo.com', imapPort: 993, imapSecure: true,
    smtpHost: 'smtp.mail.yahoo.com', smtpPort: 465, smtpSecure: true,
    helpUrl: 'https://help.yahoo.com/kb/generate-third-party-passwords-sln15241.html',
    note: 'Use an app password from Yahoo account security.',
  },
  custom: { label: 'Custom IMAP/SMTP' },
}

function resolve(secrets: any): any {
  const presetId = String(secrets?.preset ?? 'custom')
  const preset = PRESETS[presetId] ?? PRESETS.custom
  const config = {
    preset: presetId,
    email: String(secrets?.email ?? '').trim(),
    password: String(secrets?.password ?? ''),
    imapHost: String(secrets?.imapHost || preset.imapHost || '').trim(),
    imapPort: Number(secrets?.imapPort || preset.imapPort || 993),
    imapSecure: secrets?.imapSecure === undefined ? preset.imapSecure !== false : secrets.imapSecure === true || secrets.imapSecure === 'true',
    smtpHost: String(secrets?.smtpHost || preset.smtpHost || '').trim(),
    smtpPort: Number(secrets?.smtpPort || preset.smtpPort || 465),
    smtpSecure: secrets?.smtpSecure === undefined ? preset.smtpSecure !== false : secrets.smtpSecure === true || secrets.smtpSecure === 'true',
  }
  if (config.email === '' || config.password === '') throw new Error('Email address and password are required.')
  if (config.imapHost === '') throw new Error('IMAP host is required.')
  if (config.smtpHost === '') throw new Error('SMTP host is required.')
  if (presetId === 'gmail') {
    const compact = config.password.replace(/\s+/g, '')
    if (compact.length !== 16) {
      throw new Error('Gmail 需要使用 16 位应用专用密码（需开启两步验证），不是 Google 账号密码。生成地址：https://myaccount.google.com/apppasswords')
    }
    config.password = compact
  }
  return config
}

async function withImap(secrets: any, fn: (client: any) => Promise<any>): Promise<any> {
  const config = resolve(secrets)
  const { ImapFlow } = await import('imapflow') as any
  const client = new ImapFlow({
    host: config.imapHost,
    port: config.imapPort,
    secure: config.imapSecure,
    auth: { user: config.email, pass: config.password },
    logger: false,
    tls: { rejectUnauthorized: true },
    connectionTimeout: 20000,
    greetingTimeout: 15000,
    socketTimeout: 60000,
  })
  try {
    await client.connect()
    return await fn(client)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (config.preset === 'gmail' && /auth|credential|command failed|login|invalid/i.test(message)) {
      throw new Error('Gmail 认证失败：请使用 16 位应用专用密码（不是 Google 账号密码），并确认已开启两步验证。')
    }
    throw error
  } finally {
    try {
      await client.logout()
    } catch {
      // ignore
    }
  }
}

async function recentMessages(client: any, mailbox: string, limit: number): Promise<any[]> {
  await client.mailboxOpen(mailbox)
  const exists = Number(client.mailbox?.exists ?? 0)
  if (exists === 0) return []
  const start = Math.max(1, exists - limit + 1)
  const messages: any[] = []
  for await (const message of client.fetch(`${start}:*`, { envelope: true, flags: true, uid: true })) {
    messages.push({
      uid: message.uid,
      subject: message.envelope?.subject ?? '',
      from: (message.envelope?.from ?? []).map((item: any) => item.address).filter(Boolean).join(', '),
      date: message.envelope?.date?.toISOString?.() ?? '',
      seen: message.flags?.has?.('\\Seen') === true,
    })
  }
  return messages.reverse()
}

export const email: ConnectorDefinition = {
  id: 'email',
  name: 'Email',
  description: 'Read and send mail over IMAP/SMTP with an app password or authorization code. Supports QQ, 163, 126, iCloud, Yahoo and custom servers. Use the Gmail/Outlook OAuth connectors for those providers.',
  auth: {
    kind: 'email',
    presets: PRESETS,
    fields: [
      { key: 'preset', label: 'Provider', required: true },
      { key: 'email', label: 'Email address', required: true, placeholder: 'you@example.com' },
      { key: 'password', label: 'App password / authorization code', secret: true, required: true },
      { key: 'imapHost', label: 'IMAP host' },
      { key: 'imapPort', label: 'IMAP port' },
      { key: 'imapSecure', label: 'IMAP TLS' },
      { key: 'smtpHost', label: 'SMTP host' },
      { key: 'smtpPort', label: 'SMTP port' },
      { key: 'smtpSecure', label: 'SMTP TLS' },
    ],
  },
  actions: [
    {
      id: 'list_mailboxes',
      name: 'List mailboxes',
      description: 'List folders in the mailbox.',
      mode: 'read',
      parameters: {},
      run: (secrets) => withImap(secrets, async (client) => {
        const list = await client.list()
        return list.map((item: any) => ({ path: item.path, name: item.name, specialUse: item.specialUse ?? null }))
      }),
    },
    {
      id: 'list_messages',
      name: 'List recent messages',
      description: 'List the most recent messages in a mailbox (newest first).',
      mode: 'read',
      parameters: {
        mailbox: { type: 'string', description: 'Mailbox path, default INBOX.' },
        limit: { type: 'number', description: '1–50, default 20.' },
      },
      run: (secrets, args) => withImap(secrets, async (client) => {
        const mailbox = String(args?.mailbox || 'INBOX')
        const limit = Math.min(Math.max(Number(args?.limit) || 20, 1), 50)
        return { mailbox, messages: await recentMessages(client, mailbox, limit) }
      }),
    },
    {
      id: 'search_messages',
      name: 'Search messages',
      description: 'Search the most recent 100 messages by subject or sender.',
      mode: 'read',
      parameters: {
        query: { type: 'string', required: true },
        mailbox: { type: 'string' },
        limit: { type: 'number' },
      },
      run: (secrets, args) => withImap(secrets, async (client) => {
        const mailbox = String(args?.mailbox || 'INBOX')
        const query = String(requireField(args, 'query')).toLowerCase()
        const limit = Math.min(Math.max(Number(args?.limit) || 20, 1), 50)
        const messages = await recentMessages(client, mailbox, 100)
        return {
          mailbox,
          messages: messages.filter((message) => message.subject.toLowerCase().includes(query) || message.from.toLowerCase().includes(query)).slice(0, limit),
        }
      }),
    },
    {
      id: 'read_message',
      name: 'Read a message',
      description: 'Read one message by UID, returning its text and attachment metadata.',
      mode: 'read',
      parameters: {
        uid: { type: 'number', required: true },
        mailbox: { type: 'string' },
      },
      run: (secrets, args) => withImap(secrets, async (client) => {
        const mailbox = String(args?.mailbox || 'INBOX')
        const uid = requireField(args, 'uid')
        await client.mailboxOpen(mailbox)
        const message = await client.fetchOne(String(uid), { source: true, envelope: true }, { uid: true })
        if (!message?.source) throw new Error('Message not found.')
        const { simpleParser } = await import('mailparser') as any
        const parsed = await simpleParser(message.source)
        return {
          uid,
          subject: parsed.subject ?? '',
          from: parsed.from?.text ?? '',
          to: parsed.to?.text ?? '',
          date: parsed.date?.toISOString?.() ?? '',
          text: String(parsed.text ?? '').slice(0, 20000),
          attachments: (parsed.attachments ?? []).map((item: any) => ({
            filename: item.filename ?? '',
            contentType: item.contentType ?? '',
            size: item.size ?? 0,
          })),
        }
      }),
    },
    {
      id: 'send_email',
      name: 'Send email',
      description: 'Send a plain-text email. This writes and requires user approval.',
      mode: 'write',
      parameters: {
        to: { type: 'string', required: true },
        subject: { type: 'string', required: true },
        text: { type: 'string', required: true },
        cc: { type: 'string' },
        bcc: { type: 'string' },
      },
      run: async (secrets, args) => {
        const config = resolve(secrets)
        const nodemailer = (await import('nodemailer') as any).default
        const transport = nodemailer.createTransport({
          host: config.smtpHost,
          port: config.smtpPort,
          secure: config.smtpSecure,
          auth: { user: config.email, pass: config.password },
          requireTLS: !config.smtpSecure,
          connectionTimeout: 20000,
          greetingTimeout: 15000,
          socketTimeout: 60000,
        })
        const info = await transport.sendMail({
          from: config.email,
          to: requireField(args, 'to'),
          cc: typeof args?.cc === 'string' ? args.cc : undefined,
          bcc: typeof args?.bcc === 'string' ? args.bcc : undefined,
          subject: requireField(args, 'subject'),
          text: String(args?.text ?? ''),
        })
        return { messageId: info.messageId, accepted: info.accepted, rejected: info.rejected }
      },
    },
  ],
  async test(secrets) {
    const config = resolve(secrets)
    await withImap(secrets, async (client) => client.list())
    const nodemailer = (await import('nodemailer') as any).default
    const transport = nodemailer.createTransport({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.smtpSecure,
      auth: { user: config.email, pass: config.password },
      requireTLS: !config.smtpSecure,
      connectionTimeout: 20000,
    })
    await transport.verify()
    return { ok: true, detail: 'IMAP and SMTP connected.' }
  },
}
