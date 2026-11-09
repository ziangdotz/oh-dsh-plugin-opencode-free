/**
 * The Host surface this plugin consumes, kept small on purpose.
 *
 * The route is served by a local `opencode serve` process, so the plugin needs
 * no credential, attachment or image seam — only the LLM registry, a logger and
 * the tools registry. Narrowing this file is what makes the rest of `src/`
 * testable with a plain object instead of a Cordis context.
 *
 * @module dsh-plugin-opencode-free/host
 */
import type { LlmDiscoveredModel, LlmModelDiscoveryRequest } from './compat.js';
/** The logging surface this plugin uses; every call is best-effort. */
export interface PluginLogger {
    info?: (message: string) => void;
    warn?: (message: string) => void;
    error?: (message: string) => void;
    debug?: (message: string) => void;
}
/** The slice of a Cordis plugin context this plugin touches. */
export interface PluginContext {
    get(service: string): any;
    on(event: string, listener: (...args: any[]) => void): unknown;
    effect(callback: () => (() => void) | void): unknown;
    logger: PluginLogger;
    llm: {
        /**
         * Register an adapter for provider routes. The returned handle is the
         * disposer; `replace` re-commits its routes, which publishes the
         * `llm/adapters-updated` event the browser's model catalog listens for.
         */
        registerAdapter(providers: string[], adapter: unknown): (() => void) & {
            replace?: (providers: string[]) => void;
        };
        registerModelDiscovery(settingsNs: string, discover: (request: LlmModelDiscoveryRequest, signal?: AbortSignal) => Promise<readonly LlmDiscoveredModel[]>): () => void;
        registerConfigurableProviders?(entries: readonly ConfigurableProviderEntry[]): () => void;
    };
}
/**
 * One entry in the harness configurable-provider directory.
 *
 * The Models page renders an adapter extension area for each row it finds here,
 * which is what makes this plugin's settings card appear beside the route.
 */
export interface ConfigurableProviderEntry {
    provider: string;
    displayName: string;
    settingsNs: string;
    settingsPath: readonly string[];
    declared?: boolean;
    defaultBaseURL?: string;
    baseURLEnv?: readonly string[];
}
/**
 * Log without ever letting logging break mounting.
 * @param ctx - the plugin context.
 * @param level - preferred logger level, falling back to `debug`.
 * @param message - the line to write.
 */
export declare function safeLog(ctx: {
    logger?: PluginLogger;
} | undefined, level: 'info' | 'warn' | 'error', message: string): void;
