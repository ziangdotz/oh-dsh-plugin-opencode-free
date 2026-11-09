# Verification

## Windows desktop acceptance

The local target is DSH desktop `0.2.2-rc.1` on Windows x64. Run
`npm run verify:full`, `npm run local-smoke:self`, and `npm run pack:check`
from the checkout. The first command reports the resolved Host dependencies,
checks TypeScript and runs the offline suites, including loopback HTTP tests.

After rebuilding the linked bundle, restart DSH. Check the plugin inventory,
open the OpenCode Free settings page, and refresh its model list. Then open the
composer's picker, choose a free model, and send a short test prompt. Record
whether the picker updates and the answer streams. Repeat with OpenCode initially
stopped to cover the first-use startup path. The user's confirmation on
2026-11-03 establishes UI visibility for the installed bundle.

On 2026-11-03, all seven suites and the mock streaming smoke test passed
with Node `24.21.0` and the dependencies extracted from the desktop app's
`app.asar`. The checkout also passed `verify:full`, `local-smoke:self` and
`pack:check` with its development dependencies. The test runner removes
`OPENCODE_SERVER_PASSWORD` from test children so local credentials cannot
change unauthenticated test cases.

Every claim in this repository is either a recorded probe or a test that runs in
`node tools/run-tests.mjs`. Nothing here is asserted from memory.

## 1. Offline

On 2026-11-06, `npm run compat:desktop` passed against dependencies extracted
from `C:/Tools/DeepSeek Harness/resources/app.asar` with desktop Node `24.21.0`.
The archive reports desktop and LLM `0.2.2-rc.1`, Cordis `4.1.0`, and
Schemastery `3.19.0`. All seven regression suites passed, including streaming,
completion, model discovery, settings rendering, and server reuse. Loopback
tests require an environment that permits localhost connections.

`tools/desktop-check.mjs` creates an isolated temporary checkout, extracts the
three Host packages and their dependency closure, builds against their types,
and runs the compatibility probe and existing suites. Pass another `app.asar`
path as its argument for a different desktop installation. The temporary
checkout is retained for inspection. This verifies the runtime dependencies
and test doubles. Desktop UI acceptance still requires restarting DSH and
checking the settings page and a real conversation.

```
node tools/build.mjs                                     # build, 0 errors, orphans pruned
node tools/run-tests.mjs                                 # 7 suites, 72 assertions, all pass
node --check client.js                                   # browser half parses
node tools/compat-check.mjs                              # 4 seams present
node tools/local-smoke.mjs --self-test                   # one streamed turn against a mock
```

| Suite | Assertions | Covers |
|---|---|---|
| `apply.test.mjs` | 17 | route registration, discovery wiring, directory entry, status tool, missing seams, disposal, reconcile, that mounting starts no server, that an answering server re-announces the route, that a failed picker listing is reported once, and that a second ask re-probes and re-attempts the start |
| `catalog.test.mjs` | 7 | `GET /api/model` shapes, provider filtering, admission, display names |
| `client.test.mjs` | 8 | module id, inject list, both surfaces, the inject face that activates a section, effect ownership, no credential reference, theme tokens |
| `config.test.mjs` | 6 | defaults, password lookup, model entries, fingerprint stability |
| `local-wire.test.mjs` | 15 | the whole transport against a fake server: streaming, per-turn session deletion, and waiting for `ensureStarted` before the first request |
| `render.test.mjs` | 8 | both surfaces through a hook runtime: rows, updated time, empty state, unrecognized shape, refused discovery, and that a clicked refresh stays busy past the round trip |
| `supervisor.test.mjs` | 11 | start rules: no duplicate, bounded wait, failure reporting, password adoption, detached launcher, cancellation on unload, and that a server stopped by hand is started again by the next ask |

## 1b. The local server contract, as measured

Probed against a live `opencode serve` on `127.0.0.1:4399`.

| Probe | Result |
|---|---|
| `GET /openapi.json` | `200`, `opencode HttpApi 0.0.1`, 124 paths |
| `POST /api/session` without credentials | `401` |
| `POST /api/session` with `Authorization: Bearer …` | `401` |
| `POST /api/session` with an `x-api-key` header | `401` |
| `POST /api/session` with `Basic base64("opencode:<pw>")` | **`200 {"data":{"id":"ses_…"}}`** |
| `GET /api/session/{id}/event` | **`404` — no session-scoped stream** |
| `GET /api/event` | `text/event-stream`; messages are **unnamed**, `data.type` is the event name |
| events during a prompt | `session.execution.started`, `session.text.started`, `session.text.delta`, `session.text.ended`, `session.step.ended`, `session.usage.updated`, `session.execution.succeeded` |
| `session.text.delta` payload | `data: { sessionID, assistantMessageID, ordinal, delta }` |
| `session.step.ended` payload | `data.finish` + `data.tokens` |
| `POST …/prompt {"text":…}` | `200` |
| `POST …/prompt {"prompt":{"text":…}}` | `400 — Missing key at ["text"]` |
| `POST …/generate {"prompt":…}` | **`200 {"data":{"text":"OK"}}`** |
| `DELETE /api/session/{id}` | **`204`**; `GET` on the same id then answers `404` |
| `GET /api/model` | `200`, 9 rows: `big-pickle`, `deepseek-v4.1-flash-free`, `glm-5.3-flash-free`, `flint-40b-free`, `nemotron-3.5-super-vl-free`, `beam-free`, `mimo-v2.6-flash-free`, `nemotron-3.5-lightning-free`, `nemotron-3-ultra-free` |
| restart `opencode serve` | a **different** generated password; nothing on disk holds it |
| start with `OPENCODE_SERVER_PASSWORD=<value>` | no password line printed; that value authenticates, a wrong one answers `401` |

## 2. Live transport evidence

| Check | Observed |
|---|---|
| `node tools/local-smoke.mjs --password … --prompt 'Reply … READY.'` | `finish: stop`, `text: "READY"`, ~2.7 s |
| same tool, a 50-number answer | `chunks: 6` — three text deltas plus the block boundaries, so the answer really streams |
| `node tools/local-smoke.mjs --self-test` | `chunks: 5`, `text: "OK"`, `finish: stop` — the mock emits `session.text.delta` / `session.step.ended` with the session id, so the self-test breaks if the adapter's event names drift |
| one real turn through the new adapter, 2026-10-26 17:35 | `chunks: 4`, `text: "OK"`, 2.6 s; `GET /api/session` was **24 before and 24 after**, and none of them was created in the preceding 3 minutes — the turn's session was created and deleted |
| one real turn through the adapter on a store that held no session, 2026-10-26 20:42 | server answered `GET /api/model` with 9 rows; the turn returned `chunks: 4`, `text: "READY"`, `finish: stop`, 2.8 s; `GET /api/session` was **0 before and 0 after**, and the server's own log records the turn's `GET /api/event` → `200` at that time — created and deleted, with nothing left behind |
| the Host's projected schema | contains `routes.<id>.local` (`serverURL`, `providerID`, `password`, `passwordEnv`, both deadlines) and `catalog.includeNonFree` |
| `include:OpenCodeFree` row | `enabled: true`, `fiberPhase: active` |
| `opencode serve` first call of a session with no password | `401` naming `local.password` / `OPENCODE_SERVER_PASSWORD` — the message a user sees |
| the picker's path (`adapter.listModels()`) with nothing listening, 2026-10-26 20:5x | **0 rows**, and `ensureStarted` was called **0** times — the picker never starts the server, and the Host drops a group whose models array is empty, so the route is absent from the picker with no failure line |
| the same call against a server that answers | **8 rows** (9 listed, `big-pickle` is not `-free` and `includeNonFree` is `false`) — the adapter is fine; only the missing server makes the group empty |
| after a successful ensure | the registration handle's `replace()` is called once for the route, which is what publishes `llm/adapters-updated`; `test/apply.test.mjs` pins both the announce and its absence when no server ever answers |

## 2b. Auto-start, verified on this machine

**It runs on first use, never at mount.** The first version started the server from
`apply()`, which is Host startup. On 2026-10-26 the first launch after a cold boot
showed what that costs, from the server's own log and the app's crash dialog:

| Time (local) | Evidence |
|---|---|
| 19:05:39 | `opencode.log`: `cli starting … args=["serve","--hostname","127.0.0.1","--port","4399"]` — the plugin's own spawn, at mount |
| 19:05:57 | the desktop app: `desktop welcome: Web authentication failed`, `host did not exit after SIGKILL` |
| 19:11 / 19:12 | two later `serve` attempts: `Failed to start server. Is port 4399 in use?` — the 19:05 server had survived |
| every later launch | only a probe (`GET /api/model` → 401), because that server still answered — which is why the fault only showed on a cold boot |

`test/apply.test.mjs` now pins the rule — mounting starts nothing, the first
discovery does — and `test/local-wire.test.mjs` pins that a turn awaits
`ensureStarted` before its first request.

| Check | Observed |
|---|---|
| port free, discovery with `autoStart: true` | log: `started "opencode" for http://127.0.0.1:4399; it keeps running after this app closes and will be reused next launch` |
| discovery immediately after | **9 models in 1003 ms** — the wait is real, not a retry loop |
| plugin applied a second time, no request made | no supervisor line at all: nothing is probed or spawned at mount |
| a start asked for twice | log: `a server already answers at http://127.0.0.1:4399; this plugin did not start one` — no second process |
| adapter `listModels` afterwards | 9 rows |
| `opencode serve` lifecycle | the spawned pid exits and the server is reparented (`opencode.exe`, new pid, parent ≠ our pid) — measured, and the reason the supervisor does not claim to stop it |
| spawn options | `detached: true`; `stdio` is `['ignore','ignore','ignore']` when the password is configured and `['ignore','pipe','ignore']` when it must be read; `unref()` called; the stdout pipe is `unref()`d, not closed — a Host that held it could not exit, and closing it would break the server's next write |
| plugin unloaded mid-start | probe loop stops (`reason: 'cancelled'`), the starting server is left alone |
| command that cannot exist | log names `serve --hostname 127.0.0.1 --port …`; the route stays registered |
| a server closed by hand, 2026-10-27 15:0x | server up (`GET /api/model` → `200`), listener killed → `connection refused`, then the supervisor asked again the way the refresh button does → `started: true`, `GET /api/model` → `200` again; the port was left free afterwards |

## 2c. The empty Settings page, measured twice

The panel was blank with no error, and it had **two** causes. The first fix looked
sufficient because the slot registry then reported the entry as active — it was
not, because the render still threw.

| Step | Evidence |
|---|---|
| first reading | `settings.section` occupant: `active: false` → an inactive section renders nothing |
| after adding an inject face inside a labelled effect | occupant: `active: true` — necessary, not sufficient |
| the page was **still** blank | the table body called `isFree`, `usableSet` and `probed`, none of which existed after the rewrite; an undeclared identifier throws at first use |
| why it looked fine while the server was down | `rows` was empty, so the `rows.map` body never ran and the page showed its connection message |
| after declaring them, and `free`/`paid` next to the counts | rendered with the live server's own listing: **9 models, 18 matching cells**, card shows `9 model(s) served · 8 free` |
| guard added | `test/render.test.mjs` renders both surfaces through a hook runtime with a resolved discovery, so the table body runs in CI — the earlier suite rendered once, before the async load, and never reached it |

## 3. What is not verified here

- **A turn the user starts from the composer, inside the desktop app.** The route
  registering in the Host is proven by the row's `fiberPhase: active` plus the
  projected schema, and the transport behind it is exercised against a live server
  (§2, twice), but the picker → session → answer path through the app's own UI is a
  user-visible fact this repository cannot observe from a terminal.
- **Rendering of the browser surfaces.** `client.test.mjs` checks what the factory
  registers and what the card element contains, not how it looks.
- **The picker actually redrawing after the re-announce.** The event is published
  (`replace()` → `llm/adapters-updated`), and the client's catalog is known to
  rebuild on it — read from `dsh-client-ui-model-selection` — but the redraw itself
  is a browser fact, not something a terminal check can see.

## Resource management verification — 2026-11-07

- TypeScript check passed; 89 tests in 9 files passed on Windows with Node 24.22.1.
- Added tests for per-origin serialization, queue overflow/cancellation, UTF-8
  input limits, SSE limits, oversized tool output, total turn timeout, consumer
  early return, deletion retries/404/exhaustion, and catalog-only hot updates.
- Windows owner integration: an exiting launcher with a detached grandchild
  stays resident until plugin unload; forced Host termination also reclaims the
  tree and leaves an unrelated process alive.
- Installed OpenCode v2.2.5: actual `serve` reached HTTP 401 on a random loopback
  port, and closing the lifetime pipe closed the listener. No model inference
  was invoked; this is a lifecycle smoke, not a v2 generation-contract test.
- One idle sample, two seconds after startup: complete owned tree working set
  175.3 MiB, private memory 294.0 MiB. Includes server, launcher wrappers and
  owner helper. The helper itself used 14.3 MiB working set / 11.6 MiB private.
  This is a baseline sample, not a peak-memory guarantee or a before/after claim.
- Package dry run includes owner/resource runtime modules and both platform
  helper sources. The managed server uses no idle shutdown timer.
