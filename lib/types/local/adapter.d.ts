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
import { LlmAdapter } from '../compat.js';
import type { ResolvedRoute } from '../config.js';
import { type LocalServerSettings } from './server.js';
/** What the adapter needs beyond the route and its settings. */
export interface AdapterOptions {
    signal?: AbortSignal;
    onCleanupFailed?: (reason: string) => void;
    /**
     * Start (or confirm) the local server. Awaited before the turn's first
     * request — never at mount, because mounting happens during Host startup.
     */
    ensureStarted?: () => Promise<void>;
    /**
     * Report the first failed model listing, once.
     *
     * `listModels()` is what the browser model picker reads, and this adapter
     * deliberately does not start a server from it: a picker refresh is not worth
     * a process spawn racing Host startup. The cost is that a dead server yields an
     * empty list, which the picker drops without a line of its own — so the failure
     * is reported here instead, where it can reach the log.
     */
    onListingFailed?: (reason: string) => void;
}
/**
 * The `LlmAdapter` implementation for one `opencode-free` route.
 *
 * Registration is per route, so one instance owns exactly one server origin and
 * one model catalog; the harness never has to guess which route an instance
 * belongs to.
 */
export declare class LocalServerAdapter extends LlmAdapter {
    #private;
    /**
     * @param route - the resolved route (display name, models, retry policy).
     * @param settings - the local server origin, credentials and deadlines.
     * @param options - `ensureStarted` starts (or confirms) the local server. It is
     *   awaited before the first request of a turn, never at mount: mounting runs
     *   inside Host startup, and starting a process there raced the desktop's own
     *   welcome/authentication flow on a cold boot. `onListingFailed` reports a
     *   failed listing once, because the picker that reads one shows nothing.
     */
    constructor(route: ResolvedRoute, settings: LocalServerSettings, options?: AdapterOptions);
    /**
     * Describe the route to the harness.
     * @param provider - the route id.
     * @returns its id and display name.
     */
    providerInfo(provider: string): {
        id: string;
        name: string;
    };
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
    listModels(provider: string): Promise<readonly unknown[]>;
    /**
     * Resolve one model's capabilities.
     * @param provider - the route id.
     * @param model - the model id.
     * @returns identity plus the configured capacity, never reasoning levels.
     */
    resolveModel(provider: string, model: string): Promise<unknown>;
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
    stream(request: unknown): AsyncGenerator<unknown, void, void>;
}
/**
 * Build the adapter for one `opencode-free` route.
 * @param route - the resolved route.
 * @param settings - the local server origin, credentials and deadlines.
 * @param options - the lazy start hook, when the caller has a supervisor.
 * @returns the adapter to register with `ctx.llm.registerAdapter`.
 */
export declare function createLocalAdapter(route: ResolvedRoute, settings: LocalServerSettings, options?: AdapterOptions): LocalServerAdapter;
