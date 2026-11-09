# Conformance with the DSH plugin contract

This file maps each requirement from the Harness plugin-development reference
(`cordis-plugin-development`: `references/host-plugin.md` and
`references/ui-plugin.md`) to where this repository satisfies it, and to the check
that would catch a regression. It exists so a future change can be audited without
re-reading the reference.

Upstream references: [First plugin](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/index.md)
and [Harness architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md).
Use the installed release to verify Host and client extension points. The
upstream branch can describe capabilities newer than the installed desktop app.

The Windows desktop target for this checkout is DSH `0.2.2-rc.1`, whose
application archive ships `dsh-llm 0.2.2-rc.1`, Cordis `4.1.0`, and
Schemastery `3.19.0`. The desktop runtime provides Node `24.21.0`.
The manifest also retains the previously supported `dsh-llm` peers.
The compatibility command reports the packages resolved by the checkout.
Compare those versions with the desktop packages before using the report as
evidence for a desktop release.

## 1. Package manifest

| Requirement | Here | Check |
|---|---|---|
| package declares `dsh.bundle.patch` | `package.json` → `dsh.bundle.patch: ./cordis.patch.yml` | `node -e "require('./package.json').dsh.bundle.patch"` |
| bundle patch inserts a plugin row | `cordis.patch.yml` → one `insert` with `id: OpenCodeFree` | `test/apply.test.mjs` mounts the same config |
| a profile that customizes the row **overrides it by id** | `examples/profile.patch.example.yml`, `docs/ARCHITECTURE.md` §8 | recorded in the changelog after the duplicate-id bug |
| `exports` covers runtime, client, locales, icon | `package.json` → `.`, `./client`, `./locale/*.json`, `./icon`, `./package.json` | `npm pack --dry-run` lists all of them |
| `files` lists patch, locales, icon and every runtime file | `package.json` → `files` | `npm run pack:check` |
| `type: module`, no build script needed to load | `type: module`; `main: lib/index.js` | `node -e "import('./lib/index.js')"` |

## 2. Display metadata and icon

| Requirement | Here |
|---|---|
| `locale/en.json` with `meta.title` and `meta.description` | title `dsh-plugin-opencode-free`, description names the local server and the streamed answer |
| the same for the user's language (`locale/zh.json`) | present, same meaning in Chinese |
| localized detail document on DSH `0.2.2-rc.1` | `meta.detail` selects `README.md` in English and `README.zh.md` in Chinese; both are included in package files |
| a recognizable title, not the package name | **deviates on request**: the title is the package name in both locales (see §6) |
| an original icon, exported as `./icon`, inside the package | `icon.svg` (834 bytes, well under 256 KiB), only the SVG namespace as an external reference |
| metadata readable without activating the plugin | both files are pure JSON with a single `meta` object |

## 3. Host plugin export form

`src/index.ts` exports exactly one form — `apply(ctx, config)` — plus the optional
`inject` and `Config`. There is no default export and no service class, so the
forms are not mixed. The complete runtime surface, observed with
`Object.keys(await import('./lib/index.js'))`:

```
Config, SETTINGS_NAMESPACE, apply, inject, name
```

`Config`, `inject` and `apply` are the contract; `name` is the package identity the
Loader reports, and `SETTINGS_NAMESPACE` is the settings key the client half and
the Host's discovery registration must agree on.

| Requirement | Here |
|---|---|
| `export function apply (ctx, config)` | `src/index.ts` |
| optional `export const inject` | `inject = ['llm']` — nothing registers before the LLM seam exists |
| optional `export const Config` | re-exported from `src/config.ts` |
| every resource registered inside `apply` with `ctx.effect`/`ctx.on`, returning cleanup | adapter → disposed by an `ctx.effect` cleanup; discovery, provider directory and status tool → each inside its own `ctx.effect`; reconciliation → a `loader/volatile-update` listener |
| a failed registration is contained | each seam is wrapped: a missing tools registry or provider directory logs one warning and the route still mounts (`test/apply.test.mjs` covers both) |

## 4. Client module

| Requirement | Here |
|---|---|
| a lazy factory whose id equals the package name | `client.js` → `window.__ModuleLoader__.load({ id: 'dsh-plugin-opencode-free', factory })` |
| React from the browser module table, no duplicate install | the factory only `require('react')` |
| non-baseline imports declared in `dsh.client.external` | none: the client imports nothing else |
| register through `ctx.slots.inject` + `ctx.slots.register` | provider card and settings page |
| register resources inside `apply`, with cleanup | both registrations are wrapped in labelled `ctx.effect` calls |
| visible text through the Client locale service | `ctx.locale.register('opencode-free', { en, zh })`, with an English fallback table |
| component styles as React elements | the `<style>` element is part of the returned tree |
| no DOM outside this plugin, no second application root | none |
| colours only from theme tokens | the stylesheet has no literal colour; `test/render.test.mjs` and `test/client.test.mjs` assert the token references |

A settings section must also supply an **inject face**: without one the entry
registers but stays `active: false`, and an inactive section renders nothing. That
was a real defect here; `test/client.test.mjs` now pins it.

## 5. Installation and verification

Cordis lifecycle and bundle composition follow the upstream plugin model.
The LLM registration handle, provider directory, discovery bridge and settings
slot payloads are release-sensitive integration points. The symbol probe
checks the imported runtime values. The apply and client suites exercise
registration, cleanup and rendering with test doubles. A desktop acceptance
run is still needed to verify those calls through the live Host and renderer.

| Step | Status |
|---|---|
| installed into the profile | `plugin_manager` reports the bundle applied; the row is `active` |
| live rows confirmed by inspection, not process lists | `cordis_inspect_query` on `Config.listConfigs` and `Slots.listSubTree` |
| the capability exercised, not just registered | `tools/local-smoke.mjs` runs a real turn; `docs/VERIFICATION.md` §1b/§2 records the contract |
| what is not verified, stated | `docs/VERIFICATION.md` §3 |

## 6. Known deviations, and why

- **`dsh.client.immediately` is not set.** No working bundle in this profile sets
  it; the client half registers its surfaces when the page loads, which is what the
  settings panel needs.
- **No `dsh.manifestVersion`.** Removed with this normalization: no shipped bundle
  in this profile declares it, and the reference manifest does not list it.
- **`meta.title` is the package name.** The reference asks for a recognizable
  title rather than the package name; the repository owner asked for
  `dsh-plugin-opencode-free` so the Plugins page names the package it installs.
  The Settings section keeps the product label "OpenCode Free", which is a
  different surface with a different job.
- **Runtime strings live in `client.js`, not in `locale/*.json`.** The JSON files
  carry display metadata, which the Plugin Manager reads without activating the
  plugin; the page copy is registered through the locale service at runtime, which
  is the contract for visible UI text. Keeping one copy of each avoids two sources
  of truth drifting apart.
