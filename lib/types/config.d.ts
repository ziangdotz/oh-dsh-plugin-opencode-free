/**
 * Configuration schema and route resolution.
 *
 * The plugin has exactly one transport now: a local `opencode serve` process.
 * The free tier only answers inside OpenCode, so the earlier direct-to-gateway
 * transport (keys, cooldowns, a `/models` listing) is gone rather than dormant —
 * a configuration surface that can no longer reach anything is worse than none.
 *
 * A row with `config: {}` is therefore usable: it points at
 * `http://127.0.0.1:4399`, the default port this project uses.
 *
 * @module dsh-plugin-opencode-free/config
 */
import type { LocalServerSettings } from './local/server.js';
/** Mark a configuration failure as this plugin's, so `apply` can log it alone. */
export declare class RouteConfigError extends Error {
    readonly name = "RouteConfigError";
}
/** The route id used when the configuration declares none. */
export declare const DEFAULT_ROUTE_ID = "opencode-free";
/** The display name a route shows when the configuration names none. */
export declare const DEFAULT_DISPLAY_NAME = "OpenCode Free";
/** Where a local `opencode serve` process listens by default. */
export declare const DEFAULT_SERVER_URL = "http://127.0.0.1:4399";
/** The wire provider id the local server expects in a model reference. */
export declare const DEFAULT_LOCAL_PROVIDER_ID = "opencode";
/** The environment variable read for the local server's password when the row names none. */
export declare const DEFAULT_LOCAL_PASSWORD_ENV = "OPENCODE_SERVER_PASSWORD";
/**
 * Whether a route offers ids that do not advertise the free tier.
 *
 * `false`: this route exists for the free models, so an id without the `-free`
 * suffix is not what it is for, and offering one in the picker suggests a tier
 * the gateway answers `429` to. A deployment whose server really serves paid
 * ids sets `catalog.includeNonFree: true` itself.
 */
export declare const DEFAULT_INCLUDE_NON_FREE = false;
/** One route endpoint. */
export declare const routeProfile: any;
/** Plugin configuration. */
export declare const Config: any;
/** One resolved route. */
export interface ResolvedRoute {
    provider: string;
    displayName: string;
    /** Endpoint the route talks to: the local server origin. */
    baseURL: string;
    /** The local server's origin, credentials and deadlines. */
    local: LocalServerSettings;
    /** Explicitly configured models, when the config names any. */
    configuredModels: ModelEntry[];
    defaultContextWindow: number;
    defaultMaxTokens: number;
    /** The listing decision this route was resolved under. */
    catalog?: CatalogSettings;
}
/** The catalog decision a route admits its models under. */
export interface CatalogSettings {
    autoDiscover: boolean;
    maxAgeMs: number;
    timeoutMs: number;
    exclude: string[];
    includeNonFree: boolean;
}
/** One configured (or discovered) model. */
export interface ModelEntry {
    id: string;
    name?: string;
    contextWindow?: number;
    maxTokens?: number;
}
/** The raw configuration as the Loader hands it over. */
export type RawConfig = Record<string, unknown> | undefined;
/**
 * Read the routes dictionary.
 * @param config - the row's configuration.
 * @returns provider id → raw route source.
 */
export declare function readRoutes(config: RawConfig): Record<string, Record<string, unknown>>;
/**
 * Read the catalog section.
 * @param config - the row's configuration.
 * @returns the listing settings, each defaulted.
 */
export declare function readCatalog(config: RawConfig): {
    autoDiscover: boolean;
    maxAgeMs: number;
    timeoutMs: number;
    exclude: string[];
    includeNonFree: boolean;
};
/**
 * Resolve the local server's password from the row, or from the environment.
 *
 * `opencode serve` generates a fresh password on every start and prints it, so
 * it cannot be defaulted: the row either carries the literal value or names an
 * environment variable. `OPENCODE_SERVER_PASSWORD` also makes the server adopt
 * that value instead of generating one, which is what keeps a setup stable
 * across restarts.
 *
 * @param local - the route's `local` section.
 * @returns the password, or `undefined` when the row provides none.
 */
export declare function readLocalPassword(local: Record<string, unknown>): string | undefined;
/**
 * Resolve the facts the local-server transport needs.
 *
 * @param source - the route's configuration object.
 * @returns the server origin, provider id, credentials and deadlines.
 */
export declare function readLocalSettings(source: Record<string, unknown>): LocalServerSettings;
/**
 * Resolve one route.
 *
 * @param provider - the route id.
 * @param source - the route's configuration object.
 * @returns the resolved route.
 */
export declare function resolveRoute(provider: string, source: Record<string, unknown>): ResolvedRoute;
/**
 * A stable text form of one route, for change detection across configuration
 * updates: identical input means the mounted adapter is still correct.
 * @param route - the resolved route.
 * @returns the fingerprint.
 */
export declare function routeFingerprint(route: ResolvedRoute): string;
