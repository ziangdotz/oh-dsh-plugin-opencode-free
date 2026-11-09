import { checkBytes, MAX_EVENT_BYTES, MAX_OUTPUT_BYTES } from './resources.js'

/**
 * The local OpenCode server client: the transport behind `opencode-free`.
 *
 * ## Why this exists
 *
 * The free tier refuses a bare `Authorization: Bearer public` request from an
 * arbitrary HTTP client — its own answer says so ("Free models work in
 * OpenCode"). The accepted client is the OpenCode CLI's local server, which
 * brings its own identity. So this transport drives that server instead of the
 * gateway:
 *
 * ```
 * POST /api/session                  → { data: { id } }        create a throwaway session
 * GET  /api/event                    → text/event-stream        every session in the process
 * POST /api/session/{id}/prompt      → { }                      starts the turn
 * POST /api/session/{id}/generate    → { data: { text } }       the same turn, synchronously
 * POST /api/session/{id}/interrupt   → best-effort cancel
 * ```
 *
 * ## What the contract actually is (measured, not assumed)
 *
 * Everything above was read from a live `opencode serve` 1.18.x through its own
 * `/openapi.json`, and every claim below was probed:
 *
 *   - the server prints `server password …` at startup and answers `401` without
 *     it. It accepts **HTTP Basic** with the username `opencode`; `Bearer`,
 *     `x-api-key` and a password header all stay `401`.
 *   - **there is no `/api/session/{id}/event`** — that path answers `404`. This
 *     version streams every session through the **global** `GET /api/event`, and
 *     it exposes a synchronous `generate` that returns the finished answer.
 *   - `POST …/prompt` takes `{ text }` at the top level; `{ prompt: { text } }`
 *     is rejected with `400 — Missing key at ["text"]`.
 *   - `POST …/generate` takes `{ prompt: string }` and answers `{ data: { text } }`.
 *
 * The transport therefore streams: `sendPrompt` starts a turn, and the answer
 * arrives as `session.text.delta` events on that global stream, filtered to the
 * session by the adapter. `generate` is kept because it is the simplest shape
 * the server offers, and the only one left when a release refuses `/api/event`.
 *
 * @module dsh-plugin-opencode-free/local/server
 */

import { attributionHeaders, LlmError } from '../compat.js'
import { parseModelListing, type CatalogEntry } from '../catalog.js'

/** Where the local server listens, and how patient to be with it. */
export interface LocalServerSettings {
  /** Origin of the server, for example `http://127.0.0.1:4399`. */
  serverURL: string
  /** The wire provider id the server expects in its model reference. */
  providerID: string
  /**
   * The password `opencode serve` prints as `server password …` at startup.
   *
   * The server answers `401 Unauthorized` without it. It is accepted as HTTP
   * Basic credentials with the username `opencode`, which is what the server's
   * own web client sends; a bare `Bearer` is refused, so the username is part
   * of the contract rather than a choice.
   */
  password?: string
  /** Deadline for the prompt POST to be admitted. */
  promptTimeoutMs: number
  /** Deadline for the turn to finish, including the model's own latency. */
  terminalTimeoutMs: number
  /** Whether the Host may start this server when nothing answers. */
  autoStart?: boolean
  /** How long a freshly started server gets to answer. */
  startTimeoutMs?: number
  /** The executable to start. */
  serverCommand?: string
  /**
   * Accepted for configuration compatibility with earlier drafts of this
   * transport; the synchronous `generate` has no separate header wait.
   */
  sseTimeoutMs?: number
}

/** The username the local server's Basic credentials use. */
export const LOCAL_AUTH_USERNAME = 'opencode'

/** The command a user must run when the server is missing, and where the password comes from. */
export const SERVER_START_HINT = 'start it with `opencode serve --hostname 127.0.0.1 --port 4399`; it prints a line `server password …`, so put that value in routes.<id>.local.password (or export it as OPENCODE_SERVER_PASSWORD and leave local.passwordEnv at its default)'

/**
 * Turn a transport failure into a `LlmError` that names the fix.
 *
 * A refused connection is the expected first-run state, not an exotic fault, so
 * it is reported with the command that resolves it instead of a bare
 * `ECONNREFUSED`.
 *
 * @param stage - what was being attempted, for the message.
 * @param serverURL - the origin that was tried.
 * @param error - the underlying failure.
 * @returns the error to throw.
 */
export function connectionError (stage: string, serverURL: string, error: unknown): LlmError {
  if (error instanceof LlmError) return error
  const reason = error instanceof Error ? error.message : String(error)
  const refused = /ECONNREFUSED|fetch failed|ECONNRESET|EHOSTUNREACH/i.test(reason)
  return new LlmError(
    refused
      ? `the local OpenCode server at ${serverURL} is not reachable (${reason}); ${SERVER_START_HINT}`
      : `${stage} against the local OpenCode server at ${serverURL} failed: ${reason}`,
    'TRANSPORT',
    { cause: error },
  )
}

/**
 * Race a promise against a deadline, forwarding the caller's cancellation.
 *
 * @param promise - the work to bound.
 * @param ms - the deadline in milliseconds.
 * @param stage - what is being awaited, for the error message.
 * @param signal - the caller's cancellation.
 * @returns the promise's value.
 * @throws LlmError with `TIMEOUT` or `ABORTED`.
 */
export async function withDeadline<T> (
  promise: Promise<T>,
  ms: number,
  stage: string,
  signal?: AbortSignal,
): Promise<T> {
  /* Claim the work first. `promise` is already running by the time this is
   * called, and every early return below would otherwise leave it unobserved —
   * the failure mode that surfaced as an unhandled `AbortError` from a read
   * created just before the caller's cancel. */
  void promise.catch(() => {})
  if (signal?.aborted === true) throw new LlmError(`OpenCode ${stage} aborted by caller`, 'ABORTED')
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new LlmError(`OpenCode ${stage} timed out after ${ms}ms`, 'TIMEOUT')), ms)
    onAbort = () => reject(new LlmError(`OpenCode ${stage} aborted by caller`, 'ABORTED'))
    signal?.addEventListener('abort', onAbort, { once: true })
  })
  /* Whichever side loses the race may reject later with nobody left to read it;
   * its rejection is claimed for the same reason as above. */
  void deadline.catch(() => {})
  try {
    return await Promise.race([promise, deadline])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * Combine the caller's cancellation with a per-request deadline.
 *
 * A turn has `withDeadline` around it, but the model listing does not: a settings
 * page or the model picker asks for it with no turn to bound the wait, and a
 * half-open port — a dropped SYN, a frozen process — would hold the page instead
 * of failing it. `catalog.timeoutMs` is that bound; this is how it reaches the
 * `fetch`.
 *
 * @param ms - the deadline in milliseconds.
 * @param signal - the caller's cancellation, when there is one.
 * @returns a signal that aborts on whichever comes first.
 */
export function deadlineSignal (ms: number, signal?: AbortSignal): AbortSignal {
  const deadline = AbortSignal.timeout(ms)
  return signal === undefined ? deadline : AbortSignal.any([signal, deadline])
}

/**
 * Unwrap the `{ data: … }` envelope the server always adds.
 * @param body - a parsed response body.
 * @returns the payload, unwrapped when it was enveloped.
 */
function unwrapEnvelope (body: unknown): unknown {
  if (body !== null && typeof body === 'object' && 'data' in body) {
    return (body as { data: unknown }).data
  }
  return body
}

/** Bound the wire body before JSON parsing, including synchronous generation. */
async function boundedJson (response: Response, limit: number): Promise<unknown> {
  if (response.body === null) return undefined
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const item = await reader.read()
      if (item.done) break
      bytes += item.value.byteLength
      if (bytes > limit) throw new LlmError(`OpenCode response exceeds ${limit} bytes`, 'TRANSPORT')
      chunks.push(item.value)
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return undefined }
  } finally { void reader.cancel().catch(() => {}) }
}

/**
 * Read a session id out of whatever shape the create reply used.
 * @param body - the parsed `POST /api/session` reply.
 * @returns the session id.
 * @throws LlmError with `EMPTY_RESPONSE` when no id is present.
 */
function sessionIdOf (body: unknown): string {
  const unwrapped = unwrapEnvelope(body) as Record<string, unknown> | null | undefined
  const direct = body as Record<string, unknown> | null
  const candidates = [
    unwrapped?.id,
    unwrapped?.sessionID,
    direct?.id,
    direct?.sessionID,
    (direct?.data as Record<string, unknown> | undefined)?.id,
    (direct?.data as Record<string, unknown> | undefined)?.sessionID,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  throw new LlmError('the local OpenCode server created a session but reported no session id', 'EMPTY_RESPONSE')
}

/** Trim a trailing slash so path joins stay single-slashed. */
function origin (serverURL: string): string {
  return serverURL.replace(/\/+$/, '')
}

/**
 * Headers every request carries.
 *
 * The server's own client authenticates with HTTP Basic and the username
 * `opencode`; `Authorization: Bearer`, `x-api-key` and a password header were
 * all answered `401` on 1.18.x, so Basic is the mechanism, not a preference.
 *
 * @param settings - the route's server settings, whose `password` is optional.
 * @returns the headers, with credentials only when a password is configured.
 */
function baseHeaders (settings: LocalServerSettings): Record<string, string> {
  const headers: Record<string, string> = { ...attributionHeaders() }
  if (settings.password !== undefined && settings.password.length > 0) {
    const encoded = Buffer.from(`${LOCAL_AUTH_USERNAME}:${settings.password}`, 'utf8').toString('base64')
    headers.authorization = `Basic ${encoded}`
  }
  return headers
}

/**
 * Report a refused response as the failure it is.
 *
 * `401` is separated from the rest because it has a fix the message can name:
 * the password the server printed at startup.
 *
 * @param what - the operation, for the message.
 * @param response - the refused response.
 * @returns the error to throw.
 */
async function refusal (what: string, response: Response): Promise<LlmError> {
  const reader = response.body?.getReader()
  let body = ''
  if (reader !== undefined) {
    try {
      const first = await reader.read()
      body = new TextDecoder().decode(first.value?.subarray(0, 300))
    } catch { /* The HTTP status is sufficient for diagnostics. */ }
    finally { void reader.cancel().catch(() => {}) }
  }
  if (response.status === 401 || response.status === 403) {
    return new LlmError(
      `the local OpenCode server refused ${what} (HTTP ${response.status}): it requires the password it printed at startup — set routes.<id>.local.password or export OPENCODE_SERVER_PASSWORD`,
      'INVALID_CREDENTIAL',
    )
  }
  return new LlmError(
    `the local OpenCode server refused ${what} (HTTP ${response.status})${body.length === 0 ? '' : `: ${body.slice(0, 300)}`}`,
    'TRANSPORT',
  )
}

/**
 * Create one throwaway session for the model this call names.
 *
 * @param settings - server origin, provider id and credentials.
 * @param model - the wire model id.
 * @param signal - caller cancellation.
 * @returns the new session id.
 * @throws LlmError `TRANSPORT` when the server refuses, `EMPTY_RESPONSE` when it answers no id.
 */
export async function createSession (
  settings: LocalServerSettings,
  model: string,
  signal?: AbortSignal,
): Promise<string> {
  let response: Response
  try {
    response = await fetch(`${origin(settings.serverURL)}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...baseHeaders(settings) },
      body: JSON.stringify({ model: { id: model, providerID: settings.providerID } }),
      ...signal === undefined ? {} : { signal },
    })
  } catch (error) {
    throw connectionError('session creation', settings.serverURL, error)
  }
  if (!response.ok) throw await refusal('to create a session', response)
  return sessionIdOf(await boundedJson(response, MAX_EVENT_BYTES))
}

/**
 * Read the models the server offers.
 *
 * This is the one listing call the local API exposes, and it is the source of
 * truth for both the picker and the settings page: whatever the server reports
 * is what a session can select. Its rows look like
 * `{ id, providerID, name? }`, wrapped in `{ data: [...] }`.
 *
 * @param settings - server origin and credentials.
 * @param signal - caller cancellation.
 * @returns the catalog rows, filtered to this route provider when the server says who serves them.
 * @throws LlmError `TRANSPORT`, `INVALID_CREDENTIAL` or `TIMEOUT`.
 */
export async function listModels (
  settings: LocalServerSettings,
  signal?: AbortSignal,
): Promise<CatalogEntry[]> {
  let response: Response
  try {
    response = await fetch(`${origin(settings.serverURL)}/api/model`, {
      method: 'GET',
      headers: { accept: 'application/json', ...baseHeaders(settings) },
      ...signal === undefined ? {} : { signal },
    })
  } catch (error) {
    throw connectionError('model listing', settings.serverURL, error)
  }
  if (!response.ok) throw await refusal('to list models', response)
  return parseModelListing(await boundedJson(response, MAX_EVENT_BYTES), settings.providerID)
}

/**
 * Run one turn on the session and return its finished text.
 *
 * Kept as the fallback path: it is the simplest operation the server offers and
 * it works even when the event stream cannot be read. The adapter prefers the
 * streaming path below, which delivers the same answer increment by increment.
 *
 * @param settings - server origin and credentials.
 * @param sessionId - the session to run.
 * @param prompt - the serialized conversation.
 * @param signal - caller cancellation.
 * @returns the assistant text.
 * @throws LlmError `TRANSPORT`, `INVALID_CREDENTIAL`, `EMPTY_RESPONSE` or `TIMEOUT`.
 */
export async function generate (
  settings: LocalServerSettings,
  sessionId: string,
  prompt: string,
  signal?: AbortSignal,
): Promise<string> {
  let response: Response
  try {
    response = await fetch(`${origin(settings.serverURL)}/api/session/${encodeURIComponent(sessionId)}/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...baseHeaders(settings) },
      body: JSON.stringify({ prompt }),
      ...signal === undefined ? {} : { signal },
    })
  } catch (error) {
    throw connectionError('generation', settings.serverURL, error)
  }
  if (!response.ok) throw await refusal('the prompt', response)
  const parsed = await boundedJson(response, MAX_OUTPUT_BYTES)
  const payload = unwrapEnvelope(parsed) as { text?: unknown } | undefined
  const text = payload?.text
  if (typeof text !== 'string') {
    throw new LlmError('the local OpenCode server answered without a text field', 'EMPTY_RESPONSE')
  }
  checkBytes(text, MAX_OUTPUT_BYTES, 'output')
  return text
}

/**
 * Subscribe to the server's event stream.
 *
 * Returns the pending response rather than awaiting it, so the caller can start
 * the turn while the subscription is being established; a server that greets
 * slowly must not delay the prompt.
 *
 * @param settings - server origin and credentials.
 * @param signal - caller cancellation.
 * @returns the pending `text/event-stream` response.
 */
export function openEventStream (
  settings: LocalServerSettings,
  signal?: AbortSignal,
): Promise<Response> {
  return fetch(`${origin(settings.serverURL)}/api/event`, {
    method: 'GET',
    headers: { accept: 'text/event-stream', ...baseHeaders(settings) },
    ...signal === undefined ? {} : { signal },
  })
}

/**
 * Deliver the serialized conversation, which starts the turn.
 *
 * The body is `{ text }` at the top level; `{ prompt: { text } }` is rejected
 * with `400 — Missing key at ["text"]`. The answer does not arrive in this
 * response — it comes back on the event stream.
 *
 * @param settings - server origin and credentials.
 * @param sessionId - the target session.
 * @param text - the serialized conversation.
 * @param signal - caller cancellation.
 * @throws LlmError `TRANSPORT` or `INVALID_CREDENTIAL`.
 */
export async function sendPrompt (
  settings: LocalServerSettings,
  sessionId: string,
  text: string,
  signal?: AbortSignal,
): Promise<void> {
  let response: Response
  try {
    response = await fetch(`${origin(settings.serverURL)}/api/session/${encodeURIComponent(sessionId)}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...baseHeaders(settings) },
      body: JSON.stringify({ text }),
      ...signal === undefined ? {} : { signal },
    })
  } catch (error) {
    throw connectionError('prompt delivery', settings.serverURL, error)
  }
  if (!response.ok) throw await refusal('the prompt', response)
  void response.body?.cancel().catch(() => {})
}

/** One event as the server emits it. */
export interface ServerEvent {
  type?: string
  data?: {
    sessionID?: unknown
    delta?: unknown
    text?: unknown
    finish?: unknown
    tokens?: { input?: unknown, output?: unknown, reasoning?: unknown }
    [key: string]: unknown
  }
}

/**
 * Read `event.type` and the session it belongs to.
 * @param event - one parsed event.
 * @returns the type and session id, when present.
 */
export function eventIdentity (event: ServerEvent): { type: string, sessionID?: string } {
  const type = typeof event.type === 'string' ? event.type : ''
  const sessionID = typeof event.data?.sessionID === 'string' ? event.data.sessionID : undefined
  return sessionID === undefined ? { type } : { type, sessionID }
}

/**
 * Read the text increment one delta event carries.
 * @param event - a `session.text.delta` event.
 * @returns the increment, or an empty string.
 */
export function deltaText (event: ServerEvent): string {
  return typeof event.data?.delta === 'string' ? event.data.delta : ''
}

/**
 * Read the completed text one `session.text.ended` event carries.
 * @param event - a `session.text.ended` event.
 * @returns the whole block, or an empty string.
 */
export function endedText (event: ServerEvent): string {
  return typeof event.data?.text === 'string' ? event.data.text : ''
}

/**
 * Stream the server's events until the stream closes or a read deadline expires.
 *
 * The server sends unnamed SSE messages whose `data` is the event itself
 * (`{ id, type, data }`), which is why the parser reads `data:` lines only and
 * ignores `event:` names. A silent subscription is bounded per read so a stalled
 * server cannot hang a turn.
 *
 * @param settings - server origin, for error messages and the read deadline.
 * @param response - the event-stream response.
 * @param signal - caller cancellation.
 * @returns the parsed events, in order.
 */
export async function * readEvents (
  settings: LocalServerSettings,
  response: Response,
  signal?: AbortSignal,
): AsyncGenerator<ServerEvent, void, void> {
  const body = response.body
  if (body === null) throw new LlmError('the local OpenCode event stream had no body', 'EMPTY_RESPONSE')
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const chunk = await withDeadline(reader.read(), settings.terminalTimeoutMs, 'event stream', signal)
      if (chunk.done === true) return
      buffer += decoder.decode(chunk.value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      checkBytes(buffer, MAX_EVENT_BYTES, 'SSE line')
      for (const line of lines) {
        checkBytes(line, MAX_EVENT_BYTES, 'SSE line')
        const trimmed = line.replace(/\r$/, '')
        if (!trimmed.startsWith('data:')) continue
        const payload = trimmed.slice('data:'.length).trim()
        if (payload.length === 0) continue
        try {
          const parsed = JSON.parse(payload) as ServerEvent
          if (parsed !== null && typeof parsed === 'object') yield parsed
        } catch {
          /* A non-JSON payload is not an event this transport understands. */
        }
      }
    }
  } finally {
    // The global SSE connection can stay open after this session completes.
    // Iterator cleanup must let the adapter deliver its finish immediately.
    void reader.cancel().catch(() => {})
  }
}

/**
 * Ask the server to stop working on a session.
 *
 * Best-effort by design: it runs on cleanup paths that already hold the error
 * the caller will see, so a failed interrupt must not replace it. It therefore
 * uses its own short deadline instead of the caller's signal, which is usually
 * aborted by now.
 *
 * @param settings - server origin and credentials.
 * @param sessionId - the session to interrupt.
 */
export async function interruptSession (
  settings: LocalServerSettings,
  sessionId: string,
): Promise<void> {
  try {
    const response = await fetch(`${origin(settings.serverURL)}/api/session/${encodeURIComponent(sessionId)}/interrupt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...baseHeaders(settings) },
      body: '{}',
      signal: AbortSignal.timeout(1000),
    })
    void response.body?.cancel().catch(() => {})
  } catch {
    /* Cleanup only; the caller owns the outcome. */
  }
}

/**
 * Delete a session this route created.
 *
 * Every turn opens a throwaway session: nothing depends on it afterwards. DSH
 * owns the conversation, and the next turn re-sends the whole of it into a new
 * session, so the old one is unreachable dead weight in the server's own store —
 * its session list, its on-disk messages and the memory that indexes them. The
 * adapter therefore deletes it when the turn ends, on every exit path.
 *
 * Best-effort, like the interrupt: it runs once the answer is already decided.
 * Returns success so the bounded cleanup scheduler can retry and log failures. `DELETE
 * /api/session/{id}` answers `200`/`204`; a `404` means someone else removed it,
 * which is the outcome this call wanted anyway.
 *
 * @param settings - server origin and credentials.
 * @param sessionId - the session to discard.
 */
export async function deleteSession (
  settings: LocalServerSettings,
  sessionId: string,
): Promise<boolean> {
  try {
    const response = await fetch(`${origin(settings.serverURL)}/api/session/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
      headers: { accept: 'application/json', ...baseHeaders(settings) },
      signal: AbortSignal.timeout(1000),
    })
    void response.body?.cancel().catch(() => {})
    return response.ok || response.status === 404
  } catch {
    return false
  }
}
