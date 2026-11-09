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
import { LlmError } from '../compat.js';
import { type CatalogEntry } from '../catalog.js';
/** Where the local server listens, and how patient to be with it. */
export interface LocalServerSettings {
    /** Origin of the server, for example `http://127.0.0.1:4399`. */
    serverURL: string;
    /** The wire provider id the server expects in its model reference. */
    providerID: string;
    /**
     * The password `opencode serve` prints as `server password …` at startup.
     *
     * The server answers `401 Unauthorized` without it. It is accepted as HTTP
     * Basic credentials with the username `opencode`, which is what the server's
     * own web client sends; a bare `Bearer` is refused, so the username is part
     * of the contract rather than a choice.
     */
    password?: string;
    /** Deadline for the prompt POST to be admitted. */
    promptTimeoutMs: number;
    /** Deadline for the turn to finish, including the model's own latency. */
    terminalTimeoutMs: number;
    /** Whether the Host may start this server when nothing answers. */
    autoStart?: boolean;
    /** How long a freshly started server gets to answer. */
    startTimeoutMs?: number;
    /** The executable to start. */
    serverCommand?: string;
    /**
     * Accepted for configuration compatibility with earlier drafts of this
     * transport; the synchronous `generate` has no separate header wait.
     */
    sseTimeoutMs?: number;
}
/** The username the local server's Basic credentials use. */
export declare const LOCAL_AUTH_USERNAME = "opencode";
/** The command a user must run when the server is missing, and where the password comes from. */
export declare const SERVER_START_HINT = "start it with `opencode serve --hostname 127.0.0.1 --port 4399`; it prints a line `server password \u2026`, so put that value in routes.<id>.local.password (or export it as OPENCODE_SERVER_PASSWORD and leave local.passwordEnv at its default)";
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
export declare function connectionError(stage: string, serverURL: string, error: unknown): LlmError;
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
export declare function withDeadline<T>(promise: Promise<T>, ms: number, stage: string, signal?: AbortSignal): Promise<T>;
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
export declare function deadlineSignal(ms: number, signal?: AbortSignal): AbortSignal;
/**
 * Create one throwaway session for the model this call names.
 *
 * @param settings - server origin, provider id and credentials.
 * @param model - the wire model id.
 * @param signal - caller cancellation.
 * @returns the new session id.
 * @throws LlmError `TRANSPORT` when the server refuses, `EMPTY_RESPONSE` when it answers no id.
 */
export declare function createSession(settings: LocalServerSettings, model: string, signal?: AbortSignal): Promise<string>;
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
export declare function listModels(settings: LocalServerSettings, signal?: AbortSignal): Promise<CatalogEntry[]>;
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
export declare function generate(settings: LocalServerSettings, sessionId: string, prompt: string, signal?: AbortSignal): Promise<string>;
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
export declare function openEventStream(settings: LocalServerSettings, signal?: AbortSignal): Promise<Response>;
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
export declare function sendPrompt(settings: LocalServerSettings, sessionId: string, text: string, signal?: AbortSignal): Promise<void>;
/** One event as the server emits it. */
export interface ServerEvent {
    type?: string;
    data?: {
        sessionID?: unknown;
        delta?: unknown;
        text?: unknown;
        finish?: unknown;
        tokens?: {
            input?: unknown;
            output?: unknown;
            reasoning?: unknown;
        };
        [key: string]: unknown;
    };
}
/**
 * Read `event.type` and the session it belongs to.
 * @param event - one parsed event.
 * @returns the type and session id, when present.
 */
export declare function eventIdentity(event: ServerEvent): {
    type: string;
    sessionID?: string;
};
/**
 * Read the text increment one delta event carries.
 * @param event - a `session.text.delta` event.
 * @returns the increment, or an empty string.
 */
export declare function deltaText(event: ServerEvent): string;
/**
 * Read the completed text one `session.text.ended` event carries.
 * @param event - a `session.text.ended` event.
 * @returns the whole block, or an empty string.
 */
export declare function endedText(event: ServerEvent): string;
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
export declare function readEvents(settings: LocalServerSettings, response: Response, signal?: AbortSignal): AsyncGenerator<ServerEvent, void, void>;
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
export declare function interruptSession(settings: LocalServerSettings, sessionId: string): Promise<void>;
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
export declare function deleteSession(settings: LocalServerSettings, sessionId: string): Promise<boolean>;
