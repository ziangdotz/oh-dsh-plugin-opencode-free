# Why the local server is the only transport

## What was tried first

A direct route to the Zen gateway: `baseURL: https://opencode.ai/zen/v1`, an
OpenAI-compatible provider from the Harness's own `PiAiAdapter`, a key pool with
quota cooldowns, and a live `/models` listing. It had full DSH tool calling, which
the local transport cannot offer.

It did not work, and the reason was not the key. Every request came back
`429 FreeUsageLimitError`, including requests carrying the literal `public` key and
requests with real account keys. The gateway authenticates the **client**, and a
request from DSH is not OpenCode.

## The discovery

Upstream project <https://github.com/goku54477/dsh-opencode-provider> (MIT) reaches
the free models by not talking to the gateway at all: it starts `opencode serve`
locally and drives that process. The gateway accepts that client because it *is*
OpenCode, so the free tier answers.

That works — at a cost, and the cost is structural rather than a missing feature:
OpenCode runs its own agent loop, so DSH tools (sandbox, approvals, working
directory) never reach the model. A continuation is text; a tool call the model
would like to make happens inside OpenCode's own environment, not here.

## What the local API actually looks like

Measured, not assumed — the upstream project's notes described an older shape:

1. **Every request needs a password** (`opencode serve` prints a fresh one each
   start and stores it nowhere), as HTTP Basic with the fixed username `opencode`.
   `Bearer` and `x-api-key` both answer `401`. Setting
   `OPENCODE_SERVER_PASSWORD` makes the server adopt a fixed value instead, which
   is what makes a configuration survive a restart.
2. **There is no session-scoped event stream.** `GET /api/session/{id}/event`
   answers `404`. Events live on a single global `GET /api/event`, whose messages
   are unnamed and carry `{ type, data }`; they must be filtered by
   `data.sessionID` or another session's answer arrives in yours.
3. **The prompt body is `{ text }`** on `POST …/prompt`. The synchronous
   `POST …/generate` takes `{ prompt: string }`. `{ prompt: { text } }` is rejected
   by both with `400 — Missing key at ["text"]`.
4. **The model catalog is the server's**: `GET /api/model` reports the ids, and
   that same list is what the picker and the settings page should show.

## The decision

Given (2), there are two possible implementations: drive `generate` and emit one
block, or subscribe to the global stream and emit deltas. The plugin does the
second, with the first kept as a fallback when a release refuses `/api/event`. A
first version of this transport drove a session-scoped SSE stream that the server
never had; it hung until the test timeout, which is how the ordering rule below was
found.

**The subscribe-then-prompt ordering is not stylistic.** The server flushes the
stream's headers only once it has something to say, so awaiting the subscription
before sending the prompt deadlocks: the client waits for headers, the server waits
for a prompt that was never sent.

## Why the direct transport was deleted rather than kept

Because there is no configuration for it. The gateway refuses this client no matter
which key the profile holds, so leaving a key pool, a cooldown table and a
`/models` call in the plugin would mean maintaining a code path that can only fail
— and a Models page offering two transports where one is known-broken. The names
`opencode-free`, `OpenCodeFree` and `OpenCode Free` therefore belong to the local
transport.
