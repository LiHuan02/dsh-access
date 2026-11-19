# Changelog

All notable changes to this plugin are recorded here. The version in
`package.json` is what the DSH plugin manager and the plugin market show.

## 0.3.0 — 2026-11-18

The browser half was rebuilt around the desktop bridge instead of a third-party
tool layer, which is what makes it survive a restart.

### Browser

- **One toolset, two carriers.** `access_browser_*` is always registered and drives
  the official sidebar panel over Chrome DevTools Protocol (`ensureSidebar` + `cdp`
  from the `dsh-builtin-browser` bridge), falling back to DSH's built-in sidebar
  webview when no bridge is installed. The model never picks a carrier.
- **`access_browser_do`** runs a whole flow — open, tap, field, type, key, scroll,
  sleep, wait_text, wait_gone, wait_url, wait_idle, eval, check — in one call.
  Measured on a real sign-in-and-create-a-key task: 20+ separate calls took 45.6 s
  and failed; one batch took 2.4 s.
- **Self-healing pages.** A webview the shell stopped rendering keeps answering the
  page list while every CDP command hangs; the driver now pings the page it resolved
  and closes/replaces a frozen one. A page the bridge's panel op refuses is found
  through the shell's own page list instead.
- **Sign-in over CDP.** Credential and TOTP filling go through the same driver
  (measured 7 ms against a local form), with the renderer webview as the fallback.
- **Settings → Access → Browser engine** is now a three-step panel: install the
  shared browser, install the sidebar bridge (which needs a restart), or toggle the
  carrier once both are present.

### Credentials

- Multi-account sites with an explicit primary account (the oldest saved one is used
  when none is marked), account-specific `access_autofill` / `access_login`, TOTP,
  encrypted export/import and Chrome/Bitwarden CSV import.
- Silent fill stays the default: a matching credential fills without a card, and only
  MFA, an OAuth consent screen or a CAPTCHA reaches the user.

### Connectors

- GitHub, Notion, Slack, email (Gmail, QQ, 163, 126, iCloud, Yahoo, custom IMAP/SMTP),
  Outlook / Microsoft 365, Custom REST and MCP over stdio or Streamable HTTP.
- Write actions go through DSH approval; results are scrubbed of tokens and passwords.

### Compatibility and packaging

- Floor-only peer ranges (`@deepseek-ai/cordis >=4.1.0`, `@deepseek-ai/dsh-tools
  >=0.2.2-rc.1`, `engines.dsh >=0.2.2-rc.1`) plus a compatibility layer, so a DSH
  patch or release-candidate bump no longer disables the plugin.
- Built-in OAuth clients are injected at build time from a gitignored
  `secrets.local.json`, so no credential lives in this repository.
- Seven test suites (compatibility, connectors, approval, browser setup, bridge
  protocol, unit checks, activation) run in CI on every push.
