# Third-party notices

dsh-access contains **no copied source code from other plugins**. Everything under
`src/` and the two build artifacts in `lib/` are this project's own code. This file
records what the plugin depends on, which licences those dependencies carry, and how
to stay compliant if part of another project is ever vendored in.

## What is actually redistributed

| Artifact | Contents |
| --- | --- |
| `lib/index.js` (host bundle) | dsh-access host code only. `scripts/build.mjs` marks `@deepseek-ai/*`, all `node:*` builtins, `imapflow`, `nodemailer`, `mailparser` and `@modelcontextprotocol/sdk` as **external**, so none of them is bundled. |
| `lib/client.js` (client bundle) | dsh-access client code only. React is externalised and provided by the Harness page. |

Because nothing third-party is bundled, this repository redistributes no third-party
code and needs no bundled licence files. Users install the dependencies below
themselves through their package manager, which keeps each package's own `LICENSE`.

## Runtime dependencies (declared in `package.json`, installed by the user)

| Package | Licence |
| --- | --- |
| `imapflow` | MIT |
| `mailparser` | MIT |
| `nodemailer` | MIT-0 |
| `@modelcontextprotocol/sdk` | MIT |

## Peer dependencies (provided by DeepSeek Harness, never bundled)

| Package | Licence |
| --- | --- |
| `@deepseek-ai/cordis` | MIT |
| `@deepseek-ai/dsh-tools` | MIT |

DeepSeek Harness itself is MIT, Copyright (c) 2026 DeepSeek.

## Build and development tooling (not shipped)

| Package | Licence |
| --- | --- |
| `esbuild` | MIT |
| `typescript` | Apache-2.0 |
| `react` | MIT |
| `@types/node`, `@types/react` | MIT |

`typescript` is Apache-2.0: it is used only to compile and type-check during development,
and no part of it ends up in `lib/`, so the plugin can carry any licence the author picks.

## Optional companion plugin, not included

`dsh-builtin-browser` (package name `dsh-builtin-browser`, project *dsh-browser*,
https://github.com/wqty123/dsh-browser) is **not part of this repository**. It is a
separate DSH plugin: the user installs it from the plugin market, or clicks
**Install the shared browser** in Settings → Access → Browser engine, which asks the
Harness plugin manager to install the published package into the current profile.
That is an ordinary package install — nothing is copied into this repository, and the
installed plugin keeps its own `LICENSE`.

- Licence: MIT, Copyright (c) 2026 dsh-browser contributors.
- What dsh-access touches: the two primitives of the desktop bridge it installs —
  `ensureSidebar` (this conversation's sidebar page) and `cdp` (Chrome DevTools
  Protocol) — over the localhost socket the shell publishes in
  `~/.dsh/dsh-builtin-browser-bridge.json`; its settings route
  `dsh-builtin-browser/bridge-maintenance` (used by `access_install_browser_bridge`);
  and the bundle enable/disable switch in Settings → Access → Browser engine.
  Speaking a protocol is not copying an implementation: the tool layer above those
  two ops is this project's own code.
- What dsh-access does **not** do: it ships no copy of that plugin, no Electron
  carrier, and no CDP driver of its own beyond the small client in
  `src/host/sidebar-cdp.ts`.

If that plugin is missing, dsh-access degrades to its own built-in sidebar browser
(`access_browser_*`) instead of failing.

## If you ever vendor third-party code into this project

The MIT licence (used by every dependency above except TypeScript) allows copying as
long as you keep the notice. Concretely, when copying code from another project:

1. Keep the original copyright line and the full permission text. Add the upstream
   `LICENSE` file under `third_party/<project>/LICENSE` and list it in this file.
2. Mark the files you changed (a header such as `Adapted from <project> (<licence>);
   modified by dsh-access`) so recipients can tell your changes from the original.
3. Do not relicense the copied parts. You may licence your own code however you like
   and ship the combination, but the vendored pieces stay under their original terms
   and their notice must travel with every distribution.
4. Do not use the upstream project's name, logo or author names to endorse this plugin.
   Referring to it factually ("compatible with", "derived from") is fine; implying the
   upstream authors endorse dsh-access is not.
5. Apache-2.0 code (TypeScript, if it were ever bundled) additionally requires keeping
   its `NOTICE` file and stating your modifications.
6. Bundling a dependency also means shipping its licence text inside the artifact, so
   prefer keeping dependencies external as the build does today.

## Publishing checklist

- Choose a licence for dsh-access itself (none is declared yet) and drop
  `"private": true` from `package.json` at that point.
- Keep `.refs/` (local reference clones of other projects) out of the published tree;
  it is a working aid, not a dependency, and shipping it would redistribute other
  people's code.
