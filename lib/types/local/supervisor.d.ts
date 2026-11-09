/** Lazy startup; servers we launch are owned by the plugin lifetime. */
/** The minimum a spawned child must offer, so a test can stand in for one. */
export interface SpawnedChild {
    pid?: number;
    stdin?: {
        end: () => void;
    } | null;
    kill?: (signal?: NodeJS.Signals | number) => boolean;
    /** Detaches the child from the Host's event loop, so the Host can exit first. */
    unref?: () => void;
    stdout?: {
        on: (event: string, listener: (chunk: unknown) => void) => unknown;
        removeListener?: (event: string, listener: (chunk: unknown) => void) => unknown;
        /** Stops the pipe from holding the Host open, without closing it. */
        unref?: () => void;
    } | null;
    on?: (event: string, listener: (...args: unknown[]) => void) => unknown;
}
/** What `ensureServer` needs to know, resolved from the route and the plugin. */
export interface SupervisorSettings {
    /** Whether this plugin should start a server at all. */
    autoStart: boolean;
    /** How long to wait for a freshly spawned server to answer. */
    startTimeoutMs: number;
    /** How long one reachability probe may take. */
    probeTimeoutMs: number;
    /** The server origin, e.g. `http://127.0.0.1:4399`. */
    serverURL: string;
    /** The password to hand the server; when absent the server prints one and we read it. */
    password?: string;
    /** The executable name or path. */
    command: string;
    /**
     * Aborted when the plugin unloads. The probe loop then stops instead of
     * holding the Host's event loop open for the rest of the start deadline.
     */
    signal?: AbortSignal;
}
/** What a supervision attempt did. */
export interface SupervisorOutcome {
    /** Whether this call left a server running that was not running before. */
    started: boolean;
    /** The owner helper pid; descendants are managed as a tree. */
    pid?: number;
    /**
     * Why nothing was started, when nothing was: an existing server, a
     * port that may already be occupied, a configuration decision, a spawn
     * failure, a server that never answered, or a cancelled probe.
     */
    reason?: 'already-running' | 'port-unconfirmed' | 'disabled' | 'spawn-failed' | 'never-answered' | 'cancelled';
}
/** Read the port from a server origin. @param serverURL - e.g. `http://127.0.0.1:4399`. @returns the port, or the default. */
export declare function portOf(serverURL: string): number;
/** Read the host from a server origin. @param serverURL - e.g. `http://127.0.0.1:4399`. @returns the hostname. */
export declare function hostOf(serverURL: string): string;
/**
 * Whether something is listening and answering on that origin.
 *
 * Any HTTP answer counts, including `401` and `404`: the question is whether a
 * process answers HTTP, regardless of whether it accepts this request.
 *
 * @param serverURL - the origin to probe.
 * @param timeoutMs - per-probe deadline.
 * @param fetchImpl - the fetch to use; injected so a test needs no network.
 * @returns true when the port is held by something that speaks HTTP.
 */
export declare function isReachable(serverURL: string, timeoutMs: number, fetchImpl?: typeof fetch): Promise<boolean>;
/**
 * Make sure a server answers at the configured origin, starting one if allowed.
 *
 * @param settings - what to start and how long to wait.
 * @param logger - writes one diagnostic line per decision, never throws.
 * @param spawnImpl - the spawn to use; injected so a test can stand in.
 * @param fetchImpl - the fetch used to probe.
 * @param onPassword - called with a password the server printed, when the configuration named none.
 * @returns what happened, so a caller can tell "already running" from "started".
 */
export declare function ensureServer(settings: SupervisorSettings, logger: (level: 'info' | 'warn' | 'error', message: string) => void, spawnImpl?: (command: string, args: string[], options: Record<string, unknown>) => SpawnedChild, fetchImpl?: typeof fetch, onPassword?: (password: string) => void): Promise<SupervisorOutcome>;
