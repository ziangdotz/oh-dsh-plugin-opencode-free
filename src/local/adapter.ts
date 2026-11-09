import { acquireTurn, checkBytes, checkSize, MAX_OUTPUT_BYTES, MAX_TOOL_BYTES, scheduleCleanup } from './resources.js'

/**
 * The `opencode-free` adapter: one DSH route served by a local OpenCode server.
 *
 * ## What it can and cannot do
 *
 * This transport exists for one reason: the free tier only answers inside
 * OpenCode, so the cheapest honest way to use it is to borrow OpenCode's own
 * client. The price is stated once, here, because nothing downstream can hide
 * it:
 *
 *   - **text output only** — OpenCode runs its own agent and tool loop in its
 *     own process; DSH's tool schemas, sandbox, approvals and working directory
 *     cannot reach it, so this adapter advertises `text` and yields no tool calls;
 *   - **streamed, one text block per turn** — answers arrive as
 *     `session.text.delta` events on the server's global stream, so the adapter
 *     emits deltas as they come. `generate` stays as a fallback that emits the
 *     finished answer as a single block, for a release that refuses `/api/event`;
 *   - **stateless per call** — every `stream()` opens a fresh session, so the
 *     conversation is re-serialized into one prompt by `./serialize.ts` and
 *     there is no replay state. That session is deleted when the turn ends, on
 *     every exit path: DSH owns the conversation, so the server's copy would
 *     otherwise accumulate forever — one session per turn, each holding the
 *     whole history it was sent;
 *   - **no usage report** — the server does not bill tokens per turn, so the
 *     harness estimates rather than receiving counts.
 *
 * The direct gateway transport that once shared this route is deleted, so these
 * are the only properties the route has; nothing here exists twice.
 *
 * @module dsh-plugin-opencode-free/local/adapter
 */

import { LlmAdapter, LlmError } from '../compat.js'
import type { ResolvedRoute } from '../config.js'
import { serializeConversation } from './serialize.js'
import { admitCatalog, displayNameOf, isFreeModelId, type CatalogEntry } from '../catalog.js'
import { DEFAULT_CATALOG_TIMEOUT_MS } from './limits.js'
import {
  createSession,
  deadlineSignal,
  deleteSession,
  deltaText,
  endedText,
  eventIdentity,
  generate,
  interruptSession,
  listModels,
  openEventStream,
  readEvents,
  sendPrompt,
  withDeadline,
  type LocalServerSettings,
} from './server.js'

/** Event types that end the turn cleanly. */
const TERMINAL_SUCCESS_EVENTS = new Set(['session.execution.succeeded', 'session.idle'])
const QUIET_SUCCESS_TOOLS = new Set(['read', 'write', 'edit', 'glob', 'grep', 'list', 'apply_patch'])

/** Event types that end the turn with a provider failure. */
const TERMINAL_FAILURE_EVENTS = new Set(['session.step.failed', 'session.execution.failed', 'session.error'])

/** The request fields this adapter reads; the harness owns the real type. */
interface StreamRequest {
  model?: string
  signal?: AbortSignal
  system?: string
  messages?: readonly unknown[]
}

/** What the adapter needs beyond the route and its settings. */
export interface AdapterOptions {
  signal?: AbortSignal
  onCleanupFailed?: (reason: string) => void
  /**
   * Start (or confirm) the local server. Awaited before the turn's first
   * request — never at mount, because mounting happens during Host startup.
   */
  ensureStarted?: () => Promise<void>
  /**
   * Report the first failed model listing, once.
   *
   * `listModels()` is what the browser model picker reads, and this adapter
   * deliberately does not start a server from it: a picker refresh is not worth
   * a process spawn racing Host startup. The cost is that a dead server yields an
   * empty list, which the picker drops without a line of its own — so the failure
   * is reported here instead, where it can reach the log.
   */
  onListingFailed?: (reason: string) => void
}

/**
 * The `LlmAdapter` implementation for one `opencode-free` route.
 *
 * Registration is per route, so one instance owns exactly one server origin and
 * one model catalog; the harness never has to guess which route an instance
 * belongs to.
 */
export class LocalServerAdapter extends LlmAdapter {
  readonly #lifetime: AbortSignal | undefined
  readonly #onCleanupFailed: (reason: string) => void
  readonly #provider: string
  readonly #settings: LocalServerSettings
  readonly #route: ResolvedRoute
  readonly #ensureStarted: (() => Promise<void>) | undefined
  readonly #onListingFailed: ((reason: string) => void) | undefined

  /**
   * @param route - the resolved route (display name, models, retry policy).
   * @param settings - the local server origin, credentials and deadlines.
   * @param options - `ensureStarted` starts (or confirms) the local server. It is
   *   awaited before the first request of a turn, never at mount: mounting runs
   *   inside Host startup, and starting a process there raced the desktop's own
   *   welcome/authentication flow on a cold boot. `onListingFailed` reports a
   *   failed listing once, because the picker that reads one shows nothing.
   */
  constructor (route: ResolvedRoute, settings: LocalServerSettings, options: AdapterOptions = {}) {
    super()
    this.#lifetime = options.signal
    this.#onCleanupFailed = options.onCleanupFailed ?? ((message) => console.warn(message))
    this.#provider = route.provider
    this.#route = route
    this.#settings = settings
    this.#ensureStarted = options.ensureStarted
    this.#onListingFailed = options.onListingFailed
  }

  /** A cached server listing, so one turn does not ask on every call. */
  #catalogCache: { rows: CatalogEntry[], at: number } | undefined

  /** Whether the last failed listing was already reported. */
  #listingFailureReported = false

  /**
   * Say once why the listing is empty.
   *
   * An empty answer and a dead server look identical to the picker, and the
   * picker drops either silently. Reporting the first failure — and resetting the
   * flag on the next success — makes "no OpenCode Free group" diagnosable from
   * the log instead of only from the source.
   *
   * @param error - the failure the listing produced.
   */
  #reportListingFailure (error: unknown): void {
    if (this.#listingFailureReported) return
    this.#listingFailureReported = true
    const reason = error instanceof Error ? error.message : String(error)
    try {
      this.#onListingFailed?.(reason)
    } catch {
      /* A diagnostics sink must not turn a listing failure into a throw. */
    }
  }

  /**
   * The models this route may offer, from configuration or from the server.
   *
   * Explicit `models:` win; otherwise `GET /api/model` is asked once per
   * `catalog.maxAgeMs` window. A failed listing returns what was cached, or an
   * empty list — never a fabricated model, because a picker entry that cannot
   * answer is worse than a short list.
   *
   * @returns the admitted rows.
   */
  async #catalog (): Promise<CatalogEntry[]> {
    const cacheMs = this.#route.catalog?.maxAgeMs ?? 0
    const now = Date.now()
    if (this.#catalogCache !== undefined && now - this.#catalogCache.at < cacheMs) return this.#catalogCache.rows
    let rows: CatalogEntry[]
    if (this.#route.configuredModels.length > 0) {
      rows = this.#route.configuredModels.map((model) => ({
        id: model.id,
        name: model.name ?? displayNameOf(model.id),
        free: isFreeModelId(model.id),
        ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
        ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
      }))
    } else {
      if (this.#route.catalog?.autoDiscover === false) return []
      try {
        /* Bounded by `catalog.timeoutMs`: the picker asks for this with no turn
         * around it, so a half-open port must fail the listing rather than hold
         * the reader. */
        const answer = await listModels(this.#settings, deadlineSignal(this.#route.catalog?.timeoutMs ?? DEFAULT_CATALOG_TIMEOUT_MS))
        rows = admitCatalog(answer, this.#route.catalog ?? { includeNonFree: false, exclude: [] })
      } catch (error) {
        /* A failed listing yields the cache, or an empty list — never a
         * fabricated model, and never a throw. The Host may enumerate models
         * during its own startup; a dead local server must not turn that into an
         * error there. Discovery reports the real failure on the Models page, and
         * this one line is what a picker-only reader gets. */
        this.#reportListingFailure(error)
        if (this.#catalogCache !== undefined) return this.#catalogCache.rows
        return []
      }
    }
    this.#catalogCache = { rows, at: now }
    this.#listingFailureReported = false
    return rows
  }

  /**
   * Describe the route to the harness.
   * @param provider - the route id.
   * @returns its id and display name.
   */
  override providerInfo (provider: string): { id: string, name: string } {
    return { id: provider, name: this.#route.displayName }
  }

  /**
   * The models this route offers.
   *
   * The local server is the only source: whatever it lists is what the picker and
   * the settings page show. Explicitly configured entries win when the row names
   * any, because that is how a deployment pins a known-good subset.
   *
   * This is also the browser model picker's path (`llm.listProviders()` →
   * `llm.listModels()`), and it never starts the server: a picker refresh is not
   * worth a process spawn racing Host startup, so a dead server yields an empty
   * list and the picker drops the group. The plugin re-announces its route once a
   * server answers, which is what makes the picker ask again.
   *
   * @param provider - the route id.
   * @returns one row per offered model, text-only.
   */
  override async listModels (provider: string): Promise<readonly unknown[]> {
    const rows = await this.#catalog()
    return rows.map((row) => ({
      provider,
      id: row.id,
      name: row.name,
      description: 'local OpenCode server (text output only)',
      inputModalities: ['text'],
      ...row.contextWindow === undefined ? {} : { context: { contextWindow: row.contextWindow } },
      ...row.maxTokens === undefined ? {} : { defaultMaxTokens: row.maxTokens },
    }))
  }
  /**
   * Resolve one model's capabilities.
   * @param provider - the route id.
   * @param model - the model id.
   * @returns identity plus the configured capacity, never reasoning levels.
   */
  override async resolveModel (provider: string, model: string): Promise<unknown> {
    const known = this.#route.configuredModels.find((entry) => entry.id === model)
    return {
      provider,
      id: model,
      name: known?.name ?? model,
      description: 'local OpenCode server (text output only)',
      inputModalities: ['text'],
      context: { contextWindow: known?.contextWindow ?? this.#route.defaultContextWindow },
      defaultMaxTokens: known?.maxTokens ?? this.#route.defaultMaxTokens,
    }
  }

  /**
   * Run one turn against the local server.
   *
   * Two paths, in preference order:
   *
   *   1. **streaming** — subscribe to the global event stream, deliver the
   *      prompt, then translate the events for *this* session into text deltas.
   *      The stream carries every session in the process, so events are filtered
   *      by `data.sessionID`; a missing filter would splice another session's
   *      answer into this one.
   *   2. **generate** — used only when the subscription itself is refused, so a
   *      release without `/api/event` still answers, at the cost of one block.
   *
   * @param request - the harness request; only `model`, `system`, `messages` and `signal` are read.
   * @returns the chunks: text deltas (or one block), then exactly one `finish`.
   */
  override async * stream (request: unknown): AsyncGenerator<unknown, void, void> {
    const input = (request ?? {}) as StreamRequest
    const model = typeof input.model === 'string' && input.model.length > 0 ? input.model : this.#route.configuredModels[0]?.id
    if (model === undefined) {
      throw new LlmError(`route "${this.#provider}" has no model to send to the local server`, 'UNKNOWN_MODEL')
    }
    const settings = this.#settings
    const controller = new AbortController()
    const sources = [controller.signal, input.signal, this.#lifetime].filter((s): s is AbortSignal => s !== undefined)
    const signal = AbortSignal.any(sources)
    let release: (() => void) | undefined
    let turnTimer: ReturnType<typeof setTimeout> | undefined

    let sessionId: string | undefined
    let subscription: Promise<Response> | undefined
    let text = ''
    let outputBytes = 0
    let opened = false
    let completed = false
    try {
      release = await acquireTurn(settings.serverURL, signal)
      const prompt = serializeConversation(input)
      /* A turn is a user action, so a cold start is allowed here. The budget is
       * the supervisor's own deadline plus a margin: it bounds itself, this is
       * only the outer safety net. */
      if (this.#ensureStarted !== undefined) {
        await withDeadline(
          this.#ensureStarted(),
          (settings.startTimeoutMs ?? 20000) + 5000,
          'server startup',
          signal,
        )
      }
      turnTimer = setTimeout(() => controller.abort(new LlmError('OpenCode turn timed out', 'TIMEOUT')), settings.terminalTimeoutMs)
      sessionId = await withDeadline(createSession(settings, model, signal), settings.promptTimeoutMs, 'session creation', signal)

      /* Subscribe before the prompt — the server announces the answer on this
       * stream, and an event emitted before the subscription exists is gone —
       * but do **not** await it yet: the server flushes these headers only once
       * the stream has something to say, so awaiting first deadlocks against a
       * prompt that has not been sent. Order: fire, prompt, then await. */
      subscription = openEventStream(settings, signal)
      void subscription.catch(() => {})
      await withDeadline(sendPrompt(settings, sessionId, prompt, signal), settings.promptTimeoutMs, 'prompt delivery', signal)
      const events = await withDeadline(subscription, settings.terminalTimeoutMs, 'event subscription', signal)
      if (!events.ok) {
        void events.body?.cancel().catch(() => {})
        subscription = undefined
        const text = await withDeadline(generate(settings, sessionId, prompt, signal), settings.terminalTimeoutMs, 'generation', signal)
        if (text.trim().length === 0) throw new LlmError('OpenCode returned no displayable output', 'EMPTY_RESPONSE')
        if (text.length > 0) {
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'text-delta', index: 0, text }
          yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        }
        completed = true
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }

      let streamedText = ''
      let streamedBytes = 0
      let hasAnswer = false
      let hasToolResult = false
      let quietSuccessCount = 0
      const toolNames = new Map<string, string>()
      const toolCommands = new Map<string, string>()
      const completedTools = new Set<string>()
      let toolMetadataBytes = 0
      for await (const event of readEvents(settings, events, signal)) {
        const identity = eventIdentity(event)
        if (identity.type === '') continue
        /* Another session's traffic must never reach this answer. */
        if (identity.sessionID !== sessionId) continue

        let delta = ''
        if (identity.type === 'session.text.started') {
          streamedText = ''
          streamedBytes = 0
        } else if (identity.type === 'session.text.delta') {
          delta = deltaText(event)
          checkBytes(delta, MAX_OUTPUT_BYTES - streamedBytes, 'text block')
          streamedBytes += Buffer.byteLength(delta)
          streamedText += delta
        } else if (identity.type === 'session.text.ended') {
          const whole = endedText(event)
          if (whole.startsWith(streamedText)) delta = whole.slice(streamedText.length)
          streamedText = ''
          streamedBytes = 0
        } else if (identity.type === 'session.tool.input.started') {
          const { id, name } = event.data ?? {}
          if (typeof id === 'string' && typeof name === 'string') {
            toolMetadataBytes += Buffer.byteLength(id) + Buffer.byteLength(name)
            checkSize(toolMetadataBytes, MAX_TOOL_BYTES, 'tool metadata')
            toolNames.set(id, name)
          }
        } else if (identity.type === 'session.tool.called') {
          const { id, input } = event.data ?? {}
          if (typeof id === 'string' && input !== null && typeof input === 'object' &&
              'command' in input && typeof input.command === 'string') {
            toolMetadataBytes += Buffer.byteLength(id) + Buffer.byteLength(input.command)
            checkSize(toolMetadataBytes, MAX_TOOL_BYTES, 'tool metadata')
            toolCommands.set(id, input.command)
          }
        } else if (identity.type === 'session.tool.success' || identity.type === 'session.tool.failure') {
          const { id, content, error } = event.data ?? {}
          if (typeof id === 'string') {
            if (completedTools.has(id)) continue
            toolMetadataBytes += Buffer.byteLength(id) + 1
            checkSize(toolMetadataBytes, MAX_TOOL_BYTES, 'tool metadata')
            completedTools.add(id)
          }
          const name = (typeof id === 'string' ? toolNames.get(id) : undefined)
            ?.replace(/[^\p{L}\p{N} ._-]/gu, ' ') || 'tool'
          const failed = identity.type === 'session.tool.failure'
          if (!failed && QUIET_SUCCESS_TOOLS.has(name.toLowerCase())) {
            quietSuccessCount += 1
            continue
          }
          const result = failed
            ? typeof error === 'string' ? error
              : error !== null && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
                ? error.message : 'OpenCode reported a tool failure.'
            : Array.isArray(content)
              ? content.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('\n')
              : ''
          const command = typeof id === 'string' ? toolCommands.get(id) : undefined
          checkBytes(result, MAX_TOOL_BYTES, 'tool result')
          const output = command === undefined ? result : `$ ${command}\n\n${result}`
          checkBytes(output, MAX_TOOL_BYTES, 'tool result')
          const fenceLength = (output.match(/`+/g) ?? []).reduce((length, run) => Math.max(length, run.length + 1), 3)
          const fence = '`'.repeat(fenceLength)
          const details = output.trim().length > 0 ? `\n\n${fence}\n${output}\n${fence}` : ''
          delta = `\n\n**OpenCode · ${name} · ${failed ? 'Failed' : 'Completed'}**${details}\n\n`
          hasToolResult = true
        }
        if (identity.type === 'session.execution.interrupted') {
          throw new LlmError('OpenCode interrupted the turn', 'ABORTED')
        }
        if (delta.length > 0) {
          if (identity.type.startsWith('session.text.') && delta.trim().length > 0) hasAnswer = true
          if (!opened) {
            opened = true
            yield { type: 'block-start', index: 0, blockType: 'text' }
          }
          checkBytes(delta, MAX_OUTPUT_BYTES - outputBytes, 'output')
          outputBytes += Buffer.byteLength(delta)
          text += delta
          yield { type: 'text-delta', index: 0, text: delta }
          continue
        }

        if (TERMINAL_FAILURE_EVENTS.has(identity.type)) {
          if (opened) yield { type: 'block-end', index: 0, block: { type: 'text', text } }
          const message = typeof event.data?.message === 'string'
            ? event.data.message
            : `the local OpenCode server reported ${identity.type}`
          yield { type: 'finish', reason: { kind: 'error', failure: { message, code: 'PROVIDER_ERROR' } } }
          return
        }

        if (TERMINAL_SUCCESS_EVENTS.has(identity.type)) {
          break
        }

        /* Anything else belongs to another part of the server's stream. */
      }

      /* The stream closed without a terminal event: report what arrived rather
       * than losing text the user already saw. */
      if (!hasAnswer && (hasToolResult || quietSuccessCount > 0)) {
        const notice = quietSuccessCount === 0
          ? 'OpenCode did not return a final reply.'
          : `OpenCode completed ${quietSuccessCount} file operation(s) without returning a final reply.`
        if (!opened) {
          opened = true
          yield { type: 'block-start', index: 0, blockType: 'text' }
        }
        checkBytes(notice, MAX_OUTPUT_BYTES - outputBytes, 'output')
        text += notice
        yield { type: 'text-delta', index: 0, text: notice }
      }
      if (text.trim().length === 0) throw new LlmError('OpenCode returned no displayable output', 'EMPTY_RESPONSE')
      if (opened) yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      completed = true
      yield { type: 'finish', reason: { kind: 'stop' } }
    } catch (caught) {
      const error = controller.signal.reason instanceof LlmError ? controller.signal.reason : caught
      controller.abort()
      if (opened) yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      const aborted = input.signal?.aborted === true || this.#lifetime?.aborted === true || (error instanceof LlmError && error.code === 'ABORTED')
      if (aborted) {
        const message = error instanceof Error ? error.message : 'the caller aborted the turn'
        yield { type: 'finish', reason: { kind: 'aborted', failure: { message, code: 'ABORTED' } } }
        return
      }
      const failure = error instanceof LlmError
        ? { message: error.message, code: error.code }
        : { message: error instanceof Error ? error.message : String(error), code: 'PROVIDER_ERROR' }
      yield { type: 'finish', reason: { kind: 'error', failure } }
    } finally {
      if (turnTimer !== undefined) clearTimeout(turnTimer)
      controller.abort()
      /* The subscription may still settle after a failure, and its rejection is
       * expected: claim it here so it cannot surface as unhandled. */
      if (subscription !== undefined) void subscription.catch(() => {})
      /* The session existed for this turn only. DSH keeps the conversation and
       * the next turn re-sends all of it, so the server's copy is dead weight:
       * it would sit in the session list, on disk and in memory forever, one
       * more with every turn. Finish the bounded cleanup before releasing the
       * origin's turn slot so the next turn does not overlap abandoned work. */
      if (sessionId !== undefined) {
        if (!completed) await interruptSession(settings, sessionId)
        const id = sessionId
        await scheduleCleanup({ run: () => deleteSession(settings, id), warn: (message) => this.#onCleanupFailed(`${message} (session ${id})`) })
      }
      release?.()
    }
  }
}

/**
 * Build the adapter for one `opencode-free` route.
 * @param route - the resolved route.
 * @param settings - the local server origin, credentials and deadlines.
 * @param options - the lazy start hook, when the caller has a supervisor.
 * @returns the adapter to register with `ctx.llm.registerAdapter`.
 */
export function createLocalAdapter (
  route: ResolvedRoute,
  settings: LocalServerSettings,
  options: AdapterOptions = {},
): LocalServerAdapter {
  return new LocalServerAdapter(route, settings, options)
}
