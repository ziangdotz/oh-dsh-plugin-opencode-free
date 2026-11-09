# The browser surfaces

## Chat output

OpenCode answer text streams as Markdown. Successful routine file operations
stay out of the transcript. Other tool results and failures appear in arrival
order, with commands and text details inside fenced code blocks. Each tool call
ID contributes at most one result. A turn with only routine file operations
shows a short completion summary.
The transcript uses ordinary DSH text blocks so the chat history can retain it.
DSH's native tool-call block represents a request for the Host to execute a tool.
OpenCode owns its own tool execution.

Two surfaces, both registered from `client.js`, both reading Host state through
the injected `discover` bridge.

## Where the design comes from

The page follows the visual language of this profile's
`dsh-plugin-custom-headers` plugin, which is the same one the host's own settings
pages use. Adopting it is not cosmetic: a plugin page that invents its own
spacing, borders and greys reads as a different application, and the reader loses
the cues that say "this is a settings page".

| Rule | How |
|---|---|
| a page is an intro plus one card | intro gap 8px (title 16/24 at weight 500, lead 14/22 tertiary), then one card on `--dsw-alias-settings-card-fill` with a `.5px` `--dsw-alias-settings-card-stroke`, `--dsw-radius-xl`, padded 12×14 |
| the card head carries meta and actions | a 12/18 tertiary summary line on the left, actions pushed right by `margin-left:auto` |
| controls have one size each | 36px page buttons on `--dsw-radius-md` with a `.5px` `--dsw-alias-border-l3` edge, 28px icon buttons, both with a `focus-visible` ring |
| every state is written out | loading, counts plus the updated time, a `role="alert"` error, and a dashed empty state that names the command to run — never a blank area |
| icons are inline SVG | one 14px refresh arrow, so the page pulls in no icon package |
| colours only from theme tokens | every colour is a `--dsw-alias-*` reference; the suite asserts no literal `#hex` or `rgb()` |
| radii, type and spacing come from the same tokens the host pages use | `--dsw-radius-*`, `--dsw-alias-label-tertiary`, `--ds-font-family-code` |
| no Harness Client package imported | the factory `require`s only `react` |
| styles removed on unmount | the stylesheet is a `<style>` element in the returned tree |
| text through the locale service | dictionaries registered under `opencode-free`; an English table is the fallback when the service is missing |
| controls keep the behaviour users rely on | `<button type="button">`, a real `disabled` state, `aria-busy`, `:focus-visible` ring, and an `aria-label` plus `title` on the icon-only refresh |

Two details borrowed from the sibling page and worth keeping: the refresh control
is disabled — not merely styled as busy — while the list is being re-asked, and
the whole card carries `aria-busy` so a screen reader knows the list is moving.

**A busy control must not look unavailable.** `disabled` still dims a button in
most stylesheets, and this page's own rule did (`opacity:.4`), so a refresh read as
"greyed out" exactly while it was working. The dimming is now scoped to
`:disabled:not([aria-busy="true"])`; a busy control keeps full contrast, takes the
occupied background the hover state uses, and switches the cursor to `progress`.
The page button also has a `min-width` and centred content, so swapping "Refresh"
for "Refreshing…" does not reflow the card head.

**A refresh has a minimum visible duration.** The Host answers a warm listing in a
few milliseconds, which on its own flipped the control back to idle before the next
frame — the click looked ignored, and the spinning arrow was never seen. The hook
therefore holds `busy` for at least 450 ms (`MIN_BUSY_MS`) in the `finally` of the
reload, measured from the click: the rows and the timestamp are applied immediately
as before, and only the acknowledgement is held. A load nobody clicked — the first
mount and the automatic retry — passes `0`, because "Loading…" is already its own
posture and a button that was never pressed must not claim to be working.
`test/render.test.mjs` clicks the button and asserts the control is still busy 80 ms
later and idle again after the window — a wall-clock assertion, because this is a
perception bug, not a state bug.

## The provider card

`settings.models.provider-card`, keyed by `OpenCodeFree` — the settings namespace,
which equals the Cordis row id. It renders inside the host's own provider card, so
it draws no border of its own: one head row (title 14/22 at weight 500, the live
count as a status line, one 28px icon refresh), then one line of explanation.

**There is no credential row and no key pool.** The local server brings its own
identity; the card used to edit a key ring because the direct transport needed one,
and that transport is gone.

## The models page

`settings.section` with id `opencode-free`, sitting after the shipped pages.

```
OpenCode Free
The models this OpenCode server offers right now. Refresh to ask it again…

┌──────────────────────────────────────────────────────────────────────┐
│ 9 model(s) · 8 free · Updated 17:20:31                    [ ↻ Refresh ] │
│                                                                      │
│  Model id                    Name                        Context  Tier │
│  deepseek-v4.1-flash-free    DeepSeek V4.1 Flash Free    200000   free │
│  big-pickle                  Big Pickle                  200000   other│
│  …                                                                    │
└──────────────────────────────────────────────────────────────────────┘
```

The card ends with the listing. There is no password row and no footer: the local
server's password is not something a reader of this page can act on, and when a
request is refused the Host's own message already names
`routes.<id>.local.password` and `OPENCODE_SERVER_PASSWORD`.

States the page distinguishes, each with its own copy instead of a blank area:

| State | What renders |
|---|---|
| first load | the summary reads "Loading…", the refresh button is disabled and its icon turns on its own axis |
| re-asking | the previous rows stay on screen; the button reads "Refreshing…" and the card is `aria-busy` |
| loaded, rows | count line with the time the listing was taken, one row per model, free and other told apart by the tier pill |
| loaded, no rows | a dashed empty state naming `opencode serve` — an empty table would look like a bug |
| discovery refused | the error line carries the Host's own message; previous rows are kept |
| listing shape unknown | its own line, so an envelope change is visible instead of reading as "no models" |
| discovery seam missing (old release) | the empty state says so, and the refresh button stays disabled |

**Refresh is also how a closed server comes back.** The page does not decide
whether the server is running — it asks the Host, which probes the port and starts
one when nothing answers. So the states above are all reachable again from the same
button: stop `opencode serve` by hand and the page goes empty; click Refresh and the
button holds its busy state through the restart, then lists what the server now
offers. With `local.autoStart: false` the same click reports the connection error
instead, because that setting means "never start one".

On a narrow column the Context column is dropped (`@media (max-width:560px)`), so
the id, the name and the tier stay readable instead of wrapping into a wall of
text.

## Activation: what an empty panel taught us

Both surfaces are registered from `client.js`, and a registration can exist
**without being active**. Measured on this release:

| Registration | Slot result | Rendered |
|---|---|---|
| `settings.models.provider-card` with `{ name, key }` | occupant `active: true` | content |
| `settings.section` with `{ name, id, order, label, locale }` | occupant **`active: false`** | **nothing** |
| the same, plus `inject: () => ({})` inside a labelled `ctx.effect` | occupant `active: true` | content |

So a section must supply a face — an empty object is enough when the page needs no
service — and should be owned by an effect so it is withdrawn with the plugin. The
`label` is a thunk, which the shell re-reads after a language switch.

`test/client.test.mjs` pins all three facts, because the failure mode is silent:
the entry is listed, the page is blank, and nothing throws.

## What the suites hold

`test/client.test.mjs` checks what the factory registers and what the two
surfaces serialize to: the card surface classes, the icon button with its
`aria-busy` and `aria-label`, the status region on the count line, the absence of a
password hint or an empty footer, and the absence of literal colours.
`test/render.test.mjs` runs both components
through a hook runtime and asserts the four states that have visible copy — rows,
updated time, empty, unrecognized shape — plus a refused discovery. Neither suite
can see how the page looks; that remains a human check.
