# Architecture

One route, one transport, one source of truth for its models.

```
cordis.patch.yml  row OpenCodeFree
        │
        ▼
src/index.ts ── apply(ctx, config)
        ├── reconcile()            README route per entry in routes
        │     └── resolveRoute()   src/config.ts: defaults, password lookup
        ├── registerConfigurableProviders()  the Models-page card
        ├── registerModelDiscovery()         the settings page and the picker
        └── tools.register(opencode_free_status)
```

## 1. Why there is only a local transport

The free tier answers only inside OpenCode. A direct request to the Zen gateway is
refused with `429 FreeUsageLimitError` regardless of the key, because the gateway
authenticates the *client*, not a subscription. Every attempt to speak the OpenAI
wire format from here fails for that one reason.

So the plugin borrows the client: it drives a local `opencode serve` process over
that process's own HTTP API. The earlier direct transport — a `PiAiAdapter` route,
a key pool with quota cooldowns, and a `/models` listing — is **deleted**, not
disabled. A configuration surface that can reach nothing is worse than none.

## 2. The pieces

| File | Responsibility |
|---|---|
| `src/index.ts` | the entry point: reconcile, discovery, card declaration, status tool |
| `src/config.ts` | defaults and route resolution, including the password lookup |
| `src/catalog.ts` | the `GET /api/model` parser, admission rule, display names |
| `src/local/server.ts` | the HTTP client: sessions, prompt, event stream, listing, interrupt |
| `src/local/adapter.ts` | the `LlmAdapter`: one turn, streamed |
| `src/local/serialize.ts` | the conversation → one prompt |
| `src/local/supervisor.ts` | starts the server on first use, and refuses to duplicate one |
| `src/local/limits.ts` | capacity fallbacks for a model the server does not describe |
| `src/compat.ts` | the only import boundary to the Host |
| `client.js` | the browser half: provider card and models page |

## 2b. The measured contract

Everything below was probed against a live `opencode serve` 1.18.x; §1b of
[VERIFICATION.md](VERIFICATION.md) holds the raw results.

```
POST /api/session              { model: { id, providerID } }  → { data: { id } }
GET  /api/event                unnamed SSE messages, { type, data } per message
POST /api/session/{id}/prompt  { text }                       starts the turn
POST /api/session/{id}/generate { prompt }                    whole answer, synchronous
GET  /api/model                { data: [ { id, providerID, name? } ] }
POST /api/session/{id}/interrupt                              stops a turn
DELETE /api/session/{id}      204, then GET on it answers 404 — the turn's session is discarded
GET  /api/session/{id}/event   404 — no session-scoped stream exists

every request:  Authorization: Basic base64("opencode:" + password)
```

| Property | Cause |
|---|---|
| text output only | OpenCode runs its own agent and tool loop; DSH tool schemas cannot reach it |
| streamed output | `session.text.delta` carries answer text; `session.tool.success` contributes text results; `session.execution.succeeded` ends the turn |
| one fresh session per call | the API exposes session creation cheaply and nothing else for reuse |
| the whole conversation re-sent per turn | with no session reuse, history has nowhere else to live |
| the catalog is the server's | `GET /api/model` is the only listing call, and the picker accepts what it reports |

**The ordering is load-bearing, in the opposite direction from the obvious one.**
The server flushes the event stream's response headers only once it has something
to say, so awaiting the subscription before sending the prompt deadlocks: the
client waits for headers, the server waits for a prompt that was never sent. The
adapter fires the subscription, sends the prompt, and only then awaits the stream.

**The stream is global, so it must be filtered.** `/api/event` carries every
session in the process. Events are matched on `data.sessionID`; without that
filter another session's answer would be spliced into this turn, and the wire
tests keep an interleaved foreign session for exactly that.

**`generate` remains as a fallback.** If the subscription itself is refused (a
release without `/api/event`), the adapter calls `POST …/generate { prompt }`,
which answers the whole text synchronously, and emits it as one block.

**The password is per-process and printed, not stored.** `opencode serve` prints
`server password …` on every start and keeps it nowhere. Setting
`OPENCODE_SERVER_PASSWORD` makes the server adopt that value instead (verified: it
then prints no password line, and a wrong password still answers `401`), which is
why the plugin reads that variable by default rather than requiring a literal.

## 3. Reconcile

`apply()` resolves every configured route and registers an adapter for it, keyed
by a fingerprint of its wire facts. A volatile configuration update — which is how
a profile-layer edit reaches a running Host — re-runs the reconciliation: an
unchanged route is left alone, a changed one is replaced, a removed one is
withdrawn. Registration is per route, so one adapter owns exactly one server origin.

A failure is contained: a route that cannot be resolved is logged with its code and
the other routes still mount. The plugin never throws out of `apply()` because of
one bad row.

## 4. Discovery and the catalog

The two browser surfaces do not reach this plugin the same way, and the difference
is load-bearing:

| Reader | Path | Starts the server? |
|---|---|---|
| Settings → Models, this plugin's page and card | `llm.discoverModels('OpenCodeFree', …)` → this plugin's handler | **yes** — awaited, bounded at 25 s |
| The composer's model picker | Host `buildModelCatalog`: `llm.listProviders()` → `llm.listModels(provider)` → this adapter's `listModels()` | **no** |

The picker's list is therefore whatever the adapter can answer *right now*: it
never spawns a process, because a picker refresh is not worth racing Host startup
(the cold-boot failure in §7 is why). With nothing listening, `listModels()`
returns an empty list, and `buildModelCatalog` drops groups whose `models` array is
empty — so the route is simply absent, with no failure line of its own.

Two consequences, both deliberate:

- **the failure is logged once** by the adapter (`the model picker could not list
  "opencode-free": …`), since the picker itself reports nothing;
- **the plugin re-announces its route once a server answers.** `registerAdapter()`
  returns a handle whose `replace()` re-commits the routes and publishes
  `llm/adapters-updated`, which is the event the browser's per-generation catalog
  is rebuilt on. `ensureOrigin` calls it after any successful ensure (started or
  `already-running`), so a picker opened while the server was down fills in after
  the first turn or the first Models page — no restart, no settings change.

The discovery handler reads the live configuration on each call:

- `routes.<id>.models` non-empty → that list wins;
- otherwise `GET /api/model` is asked, filtered to `local.providerID`, and
  admitted with `catalog.exclude` and `catalog.includeNonFree`. That flag is
  `false` by default: the route serves the free tier, so an id without the suffix
  is only offered when a deployment opts in with `catalog.includeNonFree: true`.

The adapter caches the listing for `catalog.maxAgeMs` so one turn does not re-ask.
A failed listing returns the cached rows, or an empty list — never a fabricated
model, because a picker entry that cannot answer is worse than a short list. That
listing is bounded by `catalog.timeoutMs` (`deadlineSignal`), because it is the one
request a page or the picker makes with no turn around it: a half-open port has to
fail the refresh, not hold it.

## 5. The browser half

`client.js` registers two surfaces: a card in the Models page, keyed by the
settings namespace, and a page that lists what the server serves. It reaches the
Host only through the injected `discover` bridge — it cannot call the local server
itself, and it holds no credential, because there is none to hold. Styling uses
`--dsw-alias-*` tokens so light and dark follow the app.

## 6. What this plugin deliberately does not do

- **No tool calling.** Not a stub: OpenCode's agent loop never sees DSH tools.
- **No session reuse.** Every turn creates a session and sends the serialized
  conversation; the server offers no cheap continuation handle.
- **No server-side history.** That session is deleted when the turn ends, on
  every exit path. DSH owns the conversation, the next turn re-sends all of it
  into a new session, and nothing reads the old one again — so keeping it would
  grow the server's session list, its store and its memory by one entry per turn,
  with the full history it was sent. The cost of this choice: `opencode`'s own
  session browser shows no history from this route. Deliberately not deleted are
  sessions the plugin never created.
- **No credential storage.** The local server brings its own identity.
- **No retry policy.** The route answers or fails; retrying a turn here would
  duplicate work the user can see.

## 7. Starting the server

The route is useless without a listening process, so the plugin starts one — but
the shape of that code comes from measuring what `opencode serve` does:

- **it starts on first use, not at mount.** Mounting runs inside Host startup. On
  2026-10-26 a cold boot showed what spawning there costs: the plugin's `serve`
  was logged at 19:05:39 and the desktop app died at 19:05:57 with
  `desktop welcome: Web authentication failed` and `host did not exit after
  SIGKILL`. The first turn (`AdapterOptions.ensureStarted`, awaited before the
  first request) and the first Models page (the discovery handler) are the only
  callers now, so a user action is already waiting for the server.
- **the plugin owns the process tree it starts.** `local/owner.ts` launches a
  lifetime helper with an unreferenced stdin pipe. Plugin unload closes the pipe;
  Host exit (including forced termination) closes it at the OS level. On Windows,
  the helper joins a kill-on-close Job Object before spawning OpenCode, so even
  detached descendants are reclaimed. A small C# helper is compiled by the system
  .NET Framework compiler on first use and cached by source hash in the temp
  directory; no PowerShell process remains resident. On POSIX the helper owns a
  process group. An existing, externally started server is never adopted or killed.
  The server remains resident while the plugin runs; there is no idle shutdown.
- it answers `401` when it is up, which is a perfectly good liveness signal: any
  HTTP status means the port is held, so `isReachable` treats `401` as "up" and
  only a refused connection as "down". That is what makes "never duplicate an
  answering server" safe, including for a server a user started by hand.
- its password is either printed or adopted from `OPENCODE_SERVER_PASSWORD`. When
  the configuration names none, the supervisor reads the printed line out of the
  child's stdout and writes it into the route's settings in place, so every later
  request authenticates without the user copying anything.
- **every ask re-probes, and the plugin remembers no answer.** The in-flight start
  is cached only while it is in flight — that is what coalesces a double click —
  and the entry is dropped the moment it settles. So a server the user closed by
  hand is started again by the next refresh or the next turn, which is the whole
  point of a refresh button. A promise kept for the life of the process would turn
  that click into a replay of the first answer and leave the page permanently empty.

Discovery awaits the start promise it triggers itself, bounded at 25s. That is why
a Models page opened while a server is still coming up lists models rather than
showing the connection error: it is waiting for a server that is on its way, not
failing. The plugin's lifetime is an `AbortSignal`: unloading aborts a probe loop
and closes the owned process tree, including a server still starting.

Measured on this machine (2026-10-27): server up (`200`), listener killed
(`connection refused`), the supervisor asked again → `started: true`, and the port
answered `200` again. The listing itself is bounded by `catalog.timeoutMs`, so a
half-open port fails the refresh instead of holding the page.

Everything is bounded and none of it throws: a missing `opencode`, a refused
spawn, or a server that never answers each produce one log line naming the command
a human would run, and the route stays registered so the failure is legible. A
model listing that fails returns the cache or an empty list instead of throwing,
so a Host that enumerates models before any server exists sees "no models", not
an error.

## 8. One row, two roles

The bundle's own `cordis.patch.yml` **inserts** `OpenCodeFree`. A profile that
customizes it **overrides that row by id**:

```yaml
- id: OpenCodeFree
  name: dsh-plugin-opencode-free
  config: { … }
```

`config` is replaced wholesale, never deep-merged. Writing a second
`- insert:` with the same id is the mistake this repository already made once: the
composed entry list then holds two rows sharing an id, and the plugin inventory
answers «the current profile's patch cannot uniquely locate this item», because
toggling needs exactly one target. One id, one row — the bundle inserts it, the
profile overrides it.

## 9. Resource budgets

`local/resources.ts` shares a one-turn gate per origin across adapter instances,
with eight cancellable waiting turns. Serialization checks a 1 MiB prompt budget
before joining the full history. Output is bounded at 2 MiB, SSE lines at 1 MiB,
and tool output / per-turn metadata at 256 KiB each. Limits count UTF-8 bytes.
Each turn has an internal abort controller and a total execution deadline, and
cleanup closes HTTP/SSE work even when the consumer returns early. Session
cleanup retries three times, has a bounded waiting queue (63 entries), reports
exhaustion, and runs in the foreground under overload before releasing the turn.
Catalog configuration participates in reconciliation fingerprints; disabling
`autoDiscover` skips network discovery and keeps explicitly configured models.
