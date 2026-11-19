# dsh-access

[![ci](https://github.com/LiHuan02/dsh-access/actions/workflows/ci.yml/badge.svg)](https://github.com/LiHuan02/dsh-access/actions/workflows/ci.yml)
[![release](https://img.shields.io/github/v/release/LiHuan02/dsh-access?display_name=tag)](https://github.com/LiHuan02/dsh-access/releases)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**Version 0.3.0** — see [CHANGELOG.md](CHANGELOG.md).

Access combines three things in one DeepSeek Harness plugin:

- **A persistent encrypted credential vault** for website logins. You enter a password once in a small in-conversation card; afterwards the agent can ask for a login and the browser fills it without the password ever reaching the model.
- **Connectors** for GitHub, Notion, Slack, email (Gmail, QQ, 163, 126, iCloud, Yahoo, custom IMAP/SMTP), Outlook / Microsoft 365 (OAuth), any HTTP API via Custom REST, and any MCP server over stdio or Streamable HTTP. The agent can call read actions directly; write actions ask you for approval.
- **Browser automation over CDP.** One toolset, `access_browser_*`, drives the browser panel in the official DSH sidebar — through the `dsh-builtin-browser` desktop bridge when it is installed, and through the built-in sidebar webview when it is not. The model never chooses a carrier, and a third-party tool layer that stops attaching cannot take the browser down with it.

## Install

From the plugin market, or from this repository:

```sh
pnpm install
node scripts/build.mjs
```

Then install this directory as a bundle in the current profile:

```text
plugin_manager install_bundle target=<absolute path to this directory>
```

Restart the Harness afterwards (the client bundle loads with the page).

## Use

1. Open **Settings → Access** and set a master password. Leave **Remember this device** checked to auto-unlock after a restart; uncheck it for a password prompt every time. The vault is encrypted in the renderer; the host stores only ciphertext.
2. Add credentials in Settings, with the key button at the left of the composer, from a browser tab's actions menu, or by asking the agent to remember a login. The agent calls `access_credential_card`, which posts a **clickable card** in the conversation and waits; click it to open the floating form, save or cancel, and the card closes and the conversation continues. The form can generate a strong password and accepts an optional Base32 TOTP secret. Settings also supports editing entries, changing the master password, encrypted export/import (Chrome/Bitwarden CSV), and **Forgot the master password? → reset** (deletes the vault and connectors).
3. Ask the agent to sign in somewhere. It calls `access_login`; the built-in browser opens the site and a card appears; choose an account and click **Fill** or **Fill & sign in**. When the credential has a TOTP secret, the card shows the current code and offers **Fill TOTP** on a verification page.
4. Connect GitHub, Notion, Slack, email, Gmail, Outlook, Custom REST or an MCP server in **Settings → Access → Connectors**. The agent discovers them with `access_connectors` and calls them with `access_connector_call`. For email (QQ/163/126/iCloud/Yahoo/custom), click **Add account** to connect another account; each account becomes its own instance under the Email card. **Gmail** and **Outlook** ship with a built-in OAuth client: click the sign-in button and authorize in the browser. Outlook uses the authorization-code + PKCE loopback flow (device code is kept for work accounts), so the Azure app registration needs the **Mobile and desktop applications** platform with `http://localhost` as its redirect URI. A personal Microsoft account can still fail here — see *Known limits*.

## Outlook sign-in details

The built-in app (client ID 0bfc6548-4f0f-40ff-aa18-eed77d5400b9, public client, no secret, redirect http://localhost) is used unless you type your own client ID into the connector form. Authority is always common so both work/school and personal accounts can sign in; scopes are openid profile offline_access User.Read Mail.ReadWrite Mail.Send.

Three things to know when shipping this to other people:

- **Unverified publisher.** The consent screen says the app is unverified. That is cosmetic: the client ID is public, and the app only asks for mail read/write/send plus profile. Publisher verification costs an MPN registration and buys nothing at this stage — document it rather than pay for it.
- **Work/school accounts can be blocked by their admin.** A personal account just consents. In a locked-down tenant the user's consent fails and their admin has to open https://login.microsoftonline.com/common/adminconsent?client_id=0bfc6548-4f0f-40ff-aa18-eed77d5400b9 once.
- **Bring your own app.** The connector's client-ID field falls back to the built-in app when empty. If the shared app is ever throttled or abused, an advanced user registers their own and pastes the ID.

A client secret must never be added: a desktop client cannot keep one, public client + PKCE is the correct shape. The refresh token is the real credential; here it lives encrypted in the Access vault (AES-GCM, key in the renderer) rather than an OS keychain, which gives the same "not plaintext on disk" guarantee while keeping it out of reach of the model.

## Browser

Access drives the browser the user can see, and it does so itself. One toolset, `access_browser_*`, answers on whichever carrier is available:

| Carrier | When | How Access drives it |
| --- | --- | --- |
| **Official DSH sidebar panel** | The desktop bridge from `dsh-builtin-browser` is installed and running | The bridge's two primitives — `ensureSidebar` (this conversation's page) and `cdp` (Chrome DevTools Protocol) — over its localhost socket. Access implements the tool layer, so a third-party tool layer that stops attaching cannot take the browser down with it. |
| **Built-in sidebar webview** | No bridge: a plain DSH install, or `dsh web` | The renderer finds the panel's `<webview>` and runs the same operations through `executeJavaScript`. |

Both carriers act on the same visible page, and the choice is per call: nothing to configure, nothing to switch.

- **Batching matters.** `access_browser_do` runs a whole flow — open, tap, field, key, wait_text, eval, check — in one call. Measured on a real sign-in-and-create-a-key task: 20+ separate tool calls took 45.6 s of wall time and failed; one batch took 2.4 s. Every separate call costs a model turn and a page settle probe.
- **Refs come from a snapshot.** `access_browser_snapshot` numbers the interactive elements (`[3] button "Sign in"`); `click`/`type` take that number. A stale ref reports itself instead of clicking the wrong thing.
- **Installing the bridge (optional).** Settings → Access → Browser engine offers **Install the shared browser** (calls the Harness plugin manager with `dsh-builtin-browser`; the click is the consent and a failed run restores the profile manifest and lockfile) and then **Install the sidebar bridge and restart**. The bridge lives in the desktop app (`resources/app.asar` → `app.asar.before-bridge`), so it cannot be written while DSH runs: that button quits, writes and restarts the shell. A desktop upgrade restores the archive and the panel says `stale` — press the same button again.
- **Several DSH Desktop installs live outside `%LOCALAPPDATA%\Programs`.** The bridge's own status route only looks there, so a custom install reports `missing` even when the bridge is fine; `ACCESS` reads the endpoint file instead (`~/.dsh/dsh-builtin-browser-bridge.json`), which is what actually drives the browser.

Credentials fill the same way on both carriers: the renderer decrypts, and on the desktop-bridge carrier the pair is posted to a one-shot host endpoint that fills the page over CDP and drops it.

## Compatibility

Access targets the DSH 0.2 line with **floor-only** peer ranges (`>=0.2.2-rc.1`, `>=4.1.0`), so a DSH patch or release-candidate bump no longer marks the plugin inactive. Host registrations go through a small compatibility layer: a missing service, a moved slot, or an unsupported `tools.register` option degrades that capability instead of failing activation. Run `node tests/compat.check.mjs` to verify the guards.

## Security model

- The master password is entered only in the renderer. It derives a keyring; the browser key never leaves the renderer, and the connector key is handed to the host only while the vault is unlocked.
- **Remember this device** keeps the two raw keys in the app's own local storage/cookie so a restart can auto-unlock without the password. This is convenient but weakens isolation from other processes on the same machine; use **Forget this device** to remove them. Resetting the vault deletes all credentials and connector secrets.
- The UI follows the app locale (Chinese/English).
- The host never stores website passwords. On the webview carrier the renderer decrypts and fills entirely in the renderer. On the desktop-bridge carrier the renderer posts the pair to a one-shot fill endpoint that fills the page over CDP and drops it; it is never persisted, logged, or returned, and the model never sees it. There is no reveal endpoint.
- Snapshots redact password fields (`[password]`); `access_browser_type` refuses to type into them; screenshots of the webview carrier blur them.
- Connector secrets are encrypted with the connector key. Tool results are scrubbed of tokens and passwords.
- Connector write actions require DSH approval. Email sending is a write action.

Known limits: DSH's main process owns the built-in browser sandbox. Its session partition is per-run (cookies do not survive a restart; the vault does, so re-login is one click), device permissions are denied, JS dialogs and HTTP Basic auth are disabled, and packaged builds have no DevTools. Gmail uses a Google Cloud OAuth client (Desktop app, loopback redirect, PKCE). QQ/163/126/iCloud/Yahoo use app passwords/authorization codes. Google apps in Testing mode require the signed-in address as a test user. Cross-origin iframe filling falls back to coordinate/keystroke automation where possible.

Two site-level limits are worth knowing before debugging:

- **The built-in webview cannot render every sign-in page.** `login.live.com` (a personal Microsoft account) renders only a logo inside the Electron guest, while the same URL renders a normal form in an installed Chrome. Nothing in the page is wrong; the webview is. `dsh-builtin-browser`'s `browser.channel` setting can drive an installed Chrome instead (`chrome` + `headless` in `~/.dsh/dsh-builtin-browser-host/settings.json`), which is the supported workaround.
- **A personal Microsoft account cannot finish Graph OAuth from an app registered in a personal-account directory.** Entra then issues an opaque MSA ticket (`EwB…`, not a JWT) instead of a Graph access token — on the device-code flow and on the authorization-code flow alike — and Microsoft Graph answers 401. The connector reports exactly that instead of a bare 401. Register the app in a work/school Azure AD tenant and connect with tenant `common`; work accounts hit none of this.

## Dependencies and licensing

This plugin contains no copied code from other plugins. `dsh-builtin-browser` is an
optional sibling plugin: Access offers to install it from Settings (a click, never an
automatic write), speaks the two primitives of its desktop bridge (`ensureSidebar`,
`cdp`) over a localhost socket, and drives the built-in sidebar webview when it is
absent. The host bundle externalises
`@deepseek-ai/*`, Node builtins, `imapflow`, `nodemailer`, `mailparser` and
`@modelcontextprotocol/sdk`; the client bundle externalises React. Nothing third-party
is redistributed in `lib/`, so there is no bundled licence to ship. Per-dependency
licences (all MIT or MIT-0 apart from TypeScript's Apache-2.0, which is build-only) are
listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), together with the rules to
follow if part of another project is ever vendored in.

## Tools

Credentials and connectors: `access_status`, `access_sites`, `access_page_state`, `access_credential_card`, `access_login`, `access_request_status`, `access_autofill`, `access_connectors`, `access_connector_call`, `access_install_browser_bridge`.

Browser: `access_browser_open`, `access_browser_snapshot`, `access_browser_read`, `access_browser_click`, `access_browser_type`, `access_browser_key`, `access_browser_scroll`, `access_browser_action`, `access_browser_file`, `access_browser_view`, `access_browser_tabs`, `access_browser_screenshot`, and `access_browser_do` for a whole flow in one call.

## Development

```sh
node scripts/build.mjs              # lib/index.js + lib/client.js
node tests/compat.check.mjs         # peer-range and compatibility guards
node tests/connectors.check.mjs     # connector definitions, including write execution
node tests/approval.check.mjs       # approval gate: read runs, rejected write blocks, approved write executes
node tests/browser-setup.check.mjs  # one-click shared-browser install: every answer the plugin manager can give
node tests/bridge.check.mjs         # desktop-bridge client against a fake bridge: ordering, refusal, timeout
node tests/unit.check.mjs           # TOTP vectors, encrypted export round trip, CSV importers
node tests/plugin-load.check.mjs    # activation: every tool, schema and prompt section, with services missing
```

The test files are plain Node scripts with no test runner. `connectors.check.mjs` bundles the connector modules with esbuild and calls the actions directly (so a write can be exercised without an approval prompt); `approval.check.mjs` points `DSH_HOME` at a temporary directory, unlocks a throwaway connector vault with `setConnectorKey`, and injects an `approve` callback into `runtime.callConnector`; `bridge.check.mjs` stands up a fake bridge socket and speaks the wire protocol to it. None of them touches the real vault or the real browser.

Hot reload while developing: rebuild, then `plugin_manager set_bundle target=dsh-access enabled=false` followed by `enabled=true`. The bundle is re-imported, so host changes apply without restarting DSH. Client changes (`lib/client.js`) live in the page, so they need a restart.



## License

MIT — see [LICENSE](LICENSE). Third-party licences are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).


A source build has no built-in Google OAuth client (the packaged build injects one from a gitignored `secrets.local.json`). Without it Gmail asks for your own client ID and secret in the connector form; every other connector works unchanged.

