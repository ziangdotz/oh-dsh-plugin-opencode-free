# Changelog

## Local compatibility update — 2026-11-06

- Kept version `0.1.0` and declared localized plugin detail documents through
  `locale/en.json` and `locale/zh.json` `meta.detail`, including both READMEs in
  the package for the desktop language switch.

- Added DSH `0.2.2-rc.1`, Cordis `4.1.0`, and Schemastery `3.19.0` to the
  supported peers after building and running all seven suites against the
  installed desktop archive with Node `24.21.0`.
- Added `compat:desktop` to repeat archive-based verification in an isolated
  temporary checkout, and updated installation and verification guidance.

## 0.1.0

First release: one route, served by a local `opencode serve` process.

The fixes made before publication are folded into this same version rather than a
separate one: the version number stays `0.1.0`, and everything below describes the
state this release ships.

### Added

- `opencode-free` / `OpenCode Free`: a route that creates a session per turn on a
  local OpenCode server and streams the answer back, filtered to that session.
- The measured contract, encoded in `src/local/server.ts`: HTTP Basic with the
  fixed username `opencode`, a **global** `/api/event` stream whose messages are
  unnamed and carry `{ type, data }`, `{ text }` on `/prompt`, `{ prompt }` on
  `/generate`, and `GET /api/model` as the only listing call.
- Streaming by default: `session.text.delta` becomes a text delta,
  `session.step.ended` ends the turn. `generate` is kept as a fallback for a
  release that refuses `/api/event`.
- The model catalog comes from the server: `GET /api/model` is parsed, filtered to
  `local.providerID`, and cached for `catalog.maxAgeMs`. `routes.<id>.models` pins a
  subset and wins when present.
- The password is read from `routes.<id>.local.password` or, by default, from
  `OPENCODE_SERVER_PASSWORD` — the same variable that makes the server stop
  generating a fresh one on every start.
- The server is started for you, on first use: the first turn (the adapter awaits
  `ensureStarted` before its first request) and the first Models page (the
  discovery handler) probe the configured origin and, when nothing answers, start
  `opencode serve` with the configured password. An answering server is never
  duplicated, so a manual start still works; a failure logs the command to run by
  hand and the route stays registered. Discovery waits for the start, so the first
  Models page lists models instead of a connection error. `local.autoStart: false`
  restores strictly-manual behaviour. Because `opencode serve` detaches, the plugin
  reports the start instead of claiming it can stop it — the server outlives the
  app and is reused next launch.
- **The turn's session is deleted when the turn ends.** Every turn opens a fresh
  session on the local server and never reads it again: DSH owns the conversation,
  and the next turn re-sends all of it into a new session. The old one therefore
  sat in the server for the life of the process — one more entry per turn, each
  holding the whole history it was sent, in the session list, in
  `~/.local/share/opencode` and in the memory that indexes them. Measured on this
  machine after 3.3 hours: 24 sessions, 26 MB of server storage.
  `src/local/server.ts` gained `deleteSession()`, and `adapter.stream()` calls it
  in the `finally` it already had, so all three exit paths clean up — finished,
  failed and aborted. It is fire-and-forget and best-effort, like
  `interruptSession`: the answer is already decided, so a refused delete (the API
  answers `204`, and `404` for an id someone else removed) must never turn a good
  turn into an error.
  Measured against the live server: `DELETE /api/session/{id}` → `204`, and `GET`
  on that id → `404`; one real turn left the session count unchanged (24 → 24, none
  created in the preceding three minutes).
  The trade-off is stated rather than hidden: **`opencode`'s own session browser no
  longer shows history from this route.** DSH's history is untouched by this — it
  lives in `~/.dsh/sessions`, written by the Host, and the plugin never had a say in
  it. Sessions the plugin did not create are not deleted.
- `opencode_free_status`, a tool that reports the mounted route, its server
  origin, whether a password is configured, and the pinned models.
- `tools/local-smoke.mjs`: one real turn without DSH, with `--self-test` running
  against a throwaway mock so no external process is needed.
- A provider card and a models page, both describing what the server serves.
  Neither holds a credential: there is none to hold.

### Changed

- **Manifest.** `description` and the keywords described a transport this plugin
  no longer has; both now name the local server, the streamed answer and the
  server-driven catalog. The undocumented `dsh.manifestVersion` field was removed:
  no shipped bundle in this profile declares it and the reference manifest does
  not list it.
- **Display metadata.** `locale/en.json` and `locale/zh.json` now carry a
  recognizable title and a description of what the plugin actually does — the
  Plugin Manager and Settings read those without activating the plugin.
- **The Plugins page names the package.** `locale/en.json` and `locale/zh.json`
  carry `meta.title` = `dsh-plugin-opencode-free` instead of `OpenCode Free`, at the
  repository owner's request: the Plugins page is where a package is installed and
  identified, so it shows the package name. This is a deliberate deviation from the
  reference's "a recognizable title, not the package name", recorded in
  `docs/CONTRACT.md` §6. The Settings section is unaffected and keeps the product
  label: its nav entry, page heading and copy still read "OpenCode Free", because
  that surface is about the route a user selects, not the package they installed.
- **Registration ownership.** The provider card is now registered inside a
  labelled `ctx.effect`, like the settings page, so it is withdrawn with the
  plugin instead of relying on the slot's own lifetime.
- **Entry point.** The test-only re-export block at the end of `src/index.ts` was
  removed: the module exports the plugin contract (`apply`, `inject`, `Config`,
  `name`) and nothing else.
- **Shipped patch.** The bundle's default row no longer carries a placeholder
  password that could not work; it reads `OPENCODE_SERVER_PASSWORD` and says so.
- **`docs/CONTRACT.md`** maps every requirement of the Harness plugin contract to
  where this repository satisfies it, including the deviations and their reasons.
- **`catalog.includeNonFree` now defaults to `false`**, which is what both
  READMEs and the bundle's own patch already documented. The code had defaulted
  to `true`, so a row that named no `catalog` section offered paid ids the free
  tier does not answer for. Opting in stays possible with an explicit `true`.
  `DEFAULT_INCLUDE_NON_FREE` is the single source for the default, and
  `test/config.test.mjs` now pins both directions.
- **The adapter and server module docs describe the transport that exists.**
  Both still said the adapter emits one block per turn because `generate` is
  synchronous, and one of them claimed the direct transport still lived "side by
  side" with this one. Both now describe the streamed turn with `generate` as
  the fallback.
- **`opencode-server` is gone as a name.** The route, its adapter and the smoke
  tool are `opencode-free` everywhere; the manifest keyword became
  `opencode-serve`, the command it actually starts.

### Changed — the settings surfaces follow the host design language

- Both surfaces were rebuilt against the Harness UI practices and the host's own
  settings pages: colours only from `--dsw-alias-*` tokens (no literal colour
  remains in the stylesheet), title 16/24 at weight 500, body 14/22, secondary
  12/18, table cells padded 10×12, buttons 36px high with a `.5px` border.
- `client.js` was rewritten whole rather than patched. The stale-identifier class
  of bug came from splicing, so the file is now one coherent module and the suite
  renders it through a hook runtime.
- Discovery fills a model's context window and output cap from the route defaults
  when the server reports none, so the page and the picker never disagree about a
  model's capacity.

The Settings page then moved to the `dsh-plugin-custom-headers` design, which the
sibling plugin in this profile established and the host's own pages share. This
plugin's page now speaks it instead of its own:

- **The listing sits on one card surface** — `--dsw-alias-settings-card-fill` with
  a `.5px` `--dsw-alias-settings-card-stroke` on `--dsw-radius-xl`, padded 12×14,
  with a head row that carries the count line and the action. Before, the table
  floated on the page background with no container, which read as an unfinished
  page.
- **Refresh is a 36px page button with an inline SVG arrow** carrying
  `aria-busy`, instead of the `↻` glyph typed into an icon-only control: the
  glyph's size and vertical position depended on the font, and English and
  Chinese put it on different baselines. While the list is being re-asked the
  label reads "Refreshing…" and the arrow turns on its own axis (with
  `prefers-reduced-motion` respected).
- **The count line now says when the listing was taken** ("9 model(s) · 8 free ·
  Updated 17:20:31") and is a `role="status"` region, so a refresh announces
  itself. The page and the Model card share one `useModelListing` hook, so the two
  surfaces cannot disagree about the same answer.
- **Every state has its own line, and none of them is blank**: a dashed empty
  state naming `opencode serve`, an error marked `role="alert"` that keeps the
  previous rows on screen, a separate line for an unrecognized envelope, and an
  unavailable-discovery state. A failed refresh no longer wipes the table.
- **Tokens and type come from the same set the sibling page uses**:
  `--dsw-alias-label-tertiary`, `--dsw-alias-border-l3`, `--dsw-radius-*`,
  `--dsw-alias-interactive-bg-hover(-solid)`, `--ds-font-family-code` for model
  ids, `--dsw-focus-ring-color` for the focus ring, and `tabular-nums` for the
  context column. Literal `6px` radii are gone.
- **The Context column drops below 560px**, and the header cells carry
  `scope="col"`, so a narrow settings column stays readable.
- **The password hint line is gone.** The card ended with a footer explaining
  where the local server's password comes from; nothing on this page can act on
  that answer, and a refused request already answers with the same two names, so
  the card now ends with the listing and no empty footer is left behind.

The page also kept the behaviour users rely on: `type="button"`, a real `disabled`
state, a `:focus-visible` ring, a dashed empty state naming `opencode serve`, and
separate lines for a refused discovery and an unrecognized listing shape — instead
of one ambiguous blank.

`test/render.test.mjs` grew from 4 to 7 assertions: the updated-time line, the
empty state, and the unrecognized-envelope state each render through a hook
runtime, because all three were previously reachable only by eye.
`test/client.test.mjs` pins the card classes, the icon button's `aria-busy`, and
the status region, so a later rewrite cannot quietly drop them.

### Changed — the refresh control acknowledges the click

Clicking Refresh on the settings page gave no visible feedback: the Host answers a
warm listing in a few milliseconds, so `busy` flipped back to idle before a frame
painted, and the one visible cue — the arrow turning — was never seen. The
`disabled` styling made it worse: `opacity:.4` made the control look unavailable
exactly while it was working.

- **The busy state is held for at least 450 ms** (`MIN_BUSY_MS`, measured from the
  click). The rows and the "Updated …" timestamp are still applied the moment the
  answer arrives; only the acknowledgement waits, so a slow turn is not made
  slower. The first mount and the automatic retry pass `0`: "Loading…" is already
  their posture, and a control nobody pressed must not claim to be working.
- **A busy control keeps full contrast**: the dimming rule is now
  `:disabled:not([aria-busy="true"])`, a busy refresh takes the occupied background
  the hover state uses, and its cursor becomes `progress`. The page button gained a
  `min-width` with centred content, so "Refresh" → "Refreshing…" no longer reflows
  the card head.
- The same treatment applies to the provider card's 28px icon button, which shares
  the hook.

`test/render.test.mjs` grew from 7 to 8 assertions: it renders the page, clicks the
refresh button, and asserts the control is busy on the spot, still busy 80 ms later,
and idle again once the window has passed — a wall-clock assertion, because this
was a perception bug rather than a state bug. `test/client.test.mjs` pins the
non-dimming rule, since dropping it would silently bring the greyed-out look back.

### Fixed

- **A refresh could not bring back a server the user had closed.** `ensureOrigin`
  cached its first answer per origin for the life of the process, so after
  `opencode serve` was stopped by hand, every later refresh replayed a resolved
  promise, skipped the probe, and let the listing fail against a dead port: the
  page stayed empty and only an app restart could recover it. That is exactly the
  case a refresh button exists for.

  The cached entry is now a coalescing handle for a start *in flight only* — it is
  dropped the moment it settles — and the discovery handler asks the port on every
  call. A closed server is therefore started again by the next refresh (or the next
  turn), with the button held busy while it comes up. `local.autoStart: false` still
  means "never start one": the refresh then reports the connection error and names
  the command.

  Measured on this machine, 2026-10-27: server answering (`GET /api/model` → `200`)
  → listener killed (`connection refused`) → the supervisor asked again the way the
  refresh button does → `started: true` → `200` again.

  The listing itself now honours `catalog.timeoutMs`, which the README documented
  but nothing applied: a page or the picker makes that request with no turn around
  it, so a half-open port has to fail the refresh rather than hold it.

  `test/supervisor.test.mjs` grew to 11 assertions (a stopped server is started by
  the next ask) and `test/apply.test.mjs` to 17 (a second ask re-probes, and
  re-attempts a start that failed).

- **The model picker never listed this route.** The composer's model list is built
  by the Host from `llm.listProviders()` → `llm.listModels()`, which for this plugin
  is `LocalServerAdapter.listModels()`. That path deliberately never starts the
  server — a picker refresh is not worth a process spawn racing Host startup — so
  with nothing listening it returned an empty list, and `buildModelCatalog` drops a
  group whose `models` array is empty. The route was therefore simply absent from
  the picker, with no failure line, while Settings → Models showed the full list
  (that path goes through discovery, which does start and await the server).
  Measured: the same call returned **0 rows** against a dead port with
  `ensureStarted` called **0 times**, and **8 rows** against a server that answers.

  Two changes:

  - **The route is re-announced once a server answers.** `registerAdapter()`
    returns a handle whose `replace()` re-commits the routes and publishes
    `llm/adapters-updated` — the one event the browser's per-generation model
    catalog is rebuilt on. `ensureOrigin` calls it after any successful ensure
    (a fresh start or `already-running`), so a picker opened while the server was
    down fills in after the first turn or the first Models page, with no restart
    and no settings edit. Nothing new is started, so the cold-boot rule is
    untouched.
  - **A failed listing is reported once.** The picker drops an empty group
    silently, so the reason now reaches the log as one line
    (`the model picker could not list "opencode-free": …`); the flag resets on the
    next successful listing, so a later failure is still visible.

  `test/apply.test.mjs` grew from 12 to 15 assertions: an answering server
  announces the route, a server that never answers announces nothing, and a dead
  server's listing is reported exactly once while still returning a list.

- **A cold boot could take the desktop app down.** The first launch after a
  power-on died with `desktop backend startup and cleanup failed`, `desktop
  welcome: Web authentication failed` and `host did not exit after SIGKILL`. The
  cause was this plugin's own design, and the server's log proves it:
  `cli starting … args=["serve","--hostname","127.0.0.1","--port","4399"]` at
  19:05:39 — a mount-time spawn — and the crash at 19:05:57. On a cold boot nothing
  holds port 4399, so mounting spawned `opencode serve` inside the Host's startup
  window, where the app's welcome flow was trying to authenticate; later launches
  only probed, because that server had survived the crash.

  Three changes:

  - **The server starts on first use, never at mount.** `apply()` no longer calls
    the supervisor: the adapter awaits `AdapterOptions.ensureStarted` before the
    first request of a turn, and the discovery handler triggers the start when the
    Models page opens. Both are user actions, so the work happens where something
    is already waiting for it.
  - **The launcher cannot hold the Host open.** It is spawned with
    `detached: true`, no stdio unless a printed password has to be read (stderr is
    always discarded) and `unref()`; the one stdout pipe kept for that password is
    `unref()`d — not closed, which would make the server's next write fail with
    EPIPE — before `ensureServer` returns. A Host that still held that pipe could
    not exit while the server was alive, which is what `host did not exit after
    SIGKILL` was about.
  - **Unloading aborts a start in progress.** The plugin's lifetime is an
    `AbortSignal`; the probe loop stops (`reason: 'cancelled'`) and a server that was
    coming up is left running instead of being killed on the way out.

  A model listing that fails now returns the cache or an empty list instead of
  throwing, so a Host that enumerates models before any server exists sees "no
  models" rather than an error — which is what `docs/ARCHITECTURE.md` §4 already
  claimed.

  `test/apply.test.mjs` pins "mounting starts nothing, the first discovery does";
  `test/local-wire.test.mjs` pins that a turn waits for `ensureStarted`;
  `test/supervisor.test.mjs` pins the detached launcher and the cancellation.
- **The Settings page rendered empty.** Two independent causes, and the first
  one hid the second:
  1. a `settings.section` registration with no inject face still appears in the
     slot registry, but as `active: false`, and an inactive section renders
     nothing. It now registers as a labelled `ctx.effect` around `slots.inject`
     with a `label` thunk and an (empty) inject face — measured with the client
     Slots inspect: `active: false` → `active: true`;
  2. the table body referenced three identifiers that the rewrite had deleted
     (`isFree`, `usableSet`, `probed`, and later `free`/`paid`). An undeclared
     identifier throws on first use — and it was only used when rows existed, so
     the page rendered its "cannot reach the server" message while the server was
     down, and went blank once it worked. `test/render.test.mjs` now renders both
     surfaces through a hook runtime with a resolved discovery, so the table body
     runs in CI.
- **A dead "check availability" button** was removed: its Host half
  (`OpenCodeFree#probe` discovery) went away with the direct transport, so the
  button could only fail.
- **The plugin row could not be toggled.** The profile inserted a second row with
  the same id the bundle already inserts, so the inventory could not decide which
  one to change. A profile now **overrides** the bundle's row by id.
- **`tools/local-smoke.mjs --self-test` failed.** Its mock emitted
  `session.next.text.delta` / `session.next.step.ended`, names no adapter
  listens for, so the run reported a single `finish` chunk and no text. The mock
  now emits `session.text.delta` / `session.step.ended` with the session id the
  adapter filters on, answers `/api/model`, `/api/generate` and
  `/api/interrupt`, and returns `404` for any other path so a contract change
  reads as one. `--self-test` passes: `chunks: 5`, `text: "OK"`.
- **Deleted modules stayed in `lib/`.** `tsc` never removes output, and `lib/`
  is tracked on purpose, so `lib/adapter.js`, `lib/keys.js`, `lib/models.js`,
  `lib/quota.js` and their declarations — left from the deleted direct
  transport — were still there, and the manifest's `files` list shipped them.
  `tools/build.mjs` now removes any file under `lib/` that no `src/` file
  produces, and `build`, `test` and `compat` all compile through it. The clean
  is surgical: the profile installs this checkout through a junction, so the
  running Host reads the same files and the directory must never be emptied.

### Removed

- The direct transport: a `PiAiAdapter` route to the Zen gateway, the key pool
  with quota cooldowns, the `/models` discovery call, the seed catalog, and the
  peer dependencies they needed (`dsh-llm-pi-ai`, `pi-ai`, `dsh-credentials`,
  `dsh-launch-environment`). The gateway answers `429 FreeUsageLimitError` to any
  client that is not OpenCode, so that path could only fail.
- The credential rows on the Models-page card, for the same reason.
- `tools/online-smoke.mjs`, which probed the gateway.

### Documentation

- Suite counts corrected: `docs/VERIFICATION.md` said 6 suites / 52 assertions
  and `README.md` said 5 suites; the repository has 7 suites / 72 assertions.
  `render.test.mjs` was missing from the table, `apply.test.mjs` said 10 where
  it has 17, and the self-test now has its own evidence row.
- The configuration table in both READMEs now lists `local.autoStart`,
  `local.startTimeoutMs`, `local.serverCommand`, `routes.<id>.models`,
  `defaultContextWindow`, `defaultMaxTokens`, `catalog.timeoutMs` and
  `catalog.exclude` — all of them are used by the shipped patch or the examples,
  and none was documented. `catalog.timeoutMs` is now actually applied to the
  listing requests, not merely advertised.
- `tools/compat-check.mjs` regained the half sentence its header had lost.
- `docs/ARCHITECTURE.md` §2 no longer says the supervisor "starts the server at
  mount": it starts on first use, as §7 and the code already said.

### Notes

- Text output only. OpenCode runs its own agent and tool loop, so DSH tools never
  reach the model. This is a property of the transport, not a gap.
- The event stream is global; the adapter filters on `data.sessionID` and the wire
  suite keeps an interleaved foreign session to hold that.
- The server must be running: `opencode serve --hostname 127.0.0.1 --port 4399`.
  Without it a turn fails with one message naming that command. The plugin starts
  it on first use, so this is only the fallback for `local.autoStart: false`.
