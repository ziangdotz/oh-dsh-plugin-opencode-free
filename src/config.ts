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

import { z } from './compat.js'
import { DEFAULT_EXCLUDED_IDS } from './catalog.js'
import type { LocalServerSettings } from './local/server.js'
import {
  DEFAULT_CATALOG_TIMEOUT_MS,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  DEFAULT_SERVER_COMMAND,
  DEFAULT_START_TIMEOUT_MS,
} from './local/limits.js'

/** Mark a configuration failure as this plugin's, so `apply` can log it alone. */
export class RouteConfigError extends Error {
  override readonly name = 'RouteConfigError'
}

/** The route id used when the configuration declares none. */
export const DEFAULT_ROUTE_ID = 'opencode-free'

/** The display name a route shows when the configuration names none. */
export const DEFAULT_DISPLAY_NAME = 'OpenCode Free'

/** Where a local `opencode serve` process listens by default. */
export const DEFAULT_SERVER_URL = 'http://127.0.0.1:4399'

/** The wire provider id the local server expects in a model reference. */
export const DEFAULT_LOCAL_PROVIDER_ID = 'opencode'

/** The environment variable read for the local server's password when the row names none. */
export const DEFAULT_LOCAL_PASSWORD_ENV = 'OPENCODE_SERVER_PASSWORD'

/** How long to wait for the local server to admit a request. */
const DEFAULT_PROMPT_TIMEOUT_MS = 10000

/** How long to wait for a turn to finish, including the model's own latency. */
const DEFAULT_TERMINAL_TIMEOUT_MS = 120000

/** How long a model listing stays cached. */
const DEFAULT_CATALOG_MAX_AGE_MS = 3600000

/**
 * Whether a route offers ids that do not advertise the free tier.
 *
 * `false`: this route exists for the free models, so an id without the `-free`
 * suffix is not what it is for, and offering one in the picker suggests a tier
 * the gateway answers `429` to. A deployment whose server really serves paid
 * ids sets `catalog.includeNonFree: true` itself.
 */
export const DEFAULT_INCLUDE_NON_FREE = false

/** One model entry. */
const modelProfile = z.object({
  id: z.string().required(),
  name: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
})

/** One route endpoint. */
export const routeProfile = z.object({
  displayName: z.string(),
  /** Facts for the local server this route drives. */
  local: z.object({
    serverURL: z.string(),
    providerID: z.string(),
    /** The password `opencode serve` requires; omit it to read the environment. */
    password: z.string(),
    /** Environment variable naming that password. */
    passwordEnv: z.string(),
    promptTimeoutMs: z.number().min(1),
    terminalTimeoutMs: z.number().min(1),
    /**
     * Start the server from the Host, if nothing answers there yet.
     *
     * On by default: a route whose server is never running is a route that
     * fails on every turn. A server that already answers is left untouched, so
     * starting one by hand still works and is never duplicated.
     */
    autoStart: z.boolean(),
    /** How long a freshly started server gets to answer. */
    startTimeoutMs: z.number().min(1),
    /** The executable to start; a path also works. */
    serverCommand: z.string(),
  }),
  /** Explicit models; when empty, the server's own listing is used. */
  models: z.array(modelProfile),
  defaultContextWindow: z.number().step(1).min(1),
  defaultMaxTokens: z.number().step(1).min(1),
})

/** Plugin configuration. */
export const Config = z.object({
  /** Named endpoints; an empty dictionary falls back to the built-in route. */
  routes: z.dict(routeProfile).default({}).volatile(),
  /** Model listing behaviour, read from the local server. */
  catalog: z.object({
    autoDiscover: z.boolean().default(true),
    maxAgeMs: z.number().step(1).min(0).default(DEFAULT_CATALOG_MAX_AGE_MS),
    timeoutMs: z.number().min(1).default(DEFAULT_CATALOG_TIMEOUT_MS),
    exclude: z.array(z.string()).default([...DEFAULT_EXCLUDED_IDS]),
    /** Whether ids without a `-free` suffix stay in the catalog. */
    includeNonFree: z.boolean().default(DEFAULT_INCLUDE_NON_FREE),
  }).default({}).volatile(),
})

/** One resolved route. */
export interface ResolvedRoute {
  provider: string
  displayName: string
  /** Endpoint the route talks to: the local server origin. */
  baseURL: string
  /** The local server's origin, credentials and deadlines. */
  local: LocalServerSettings
  /** Explicitly configured models, when the config names any. */
  configuredModels: ModelEntry[]
  defaultContextWindow: number
  defaultMaxTokens: number
  /** The listing decision this route was resolved under. */
  catalog?: CatalogSettings
}

/** The catalog decision a route admits its models under. */
export interface CatalogSettings {
  autoDiscover: boolean
  maxAgeMs: number
  timeoutMs: number
  exclude: string[]
  includeNonFree: boolean
}

/** One configured (or discovered) model. */
export interface ModelEntry {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
}

/** The raw configuration as the Loader hands it over. */
export type RawConfig = Record<string, unknown> | undefined

/**
 * Read one (possibly volatile) configuration section.
 * @param section - the raw section value.
 * @returns the plain object, or an empty object when absent.
 */
function plain<T> (section: unknown, fallback: T): T {
  if (section === null || section === undefined) return fallback
  if (typeof (section as { get?: unknown }).get === 'function') {
    return plain((section as { get: () => unknown }).get(), fallback)
  }
  return section as T
}

/**
 * Read the routes dictionary.
 * @param config - the row's configuration.
 * @returns provider id → raw route source.
 */
export function readRoutes (config: RawConfig): Record<string, Record<string, unknown>> {
  const routes = plain<Record<string, unknown>>(config?.routes, {}) ?? {}
  const out: Record<string, Record<string, unknown>> = {}
  for (const [provider, source] of Object.entries(routes)) {
    const value = plain<Record<string, unknown>>(source, {})
    if (value !== null && typeof value === 'object') out[provider] = value
  }
  /* An empty dictionary means the built-in route, so a bare `config: {}` works. */
  return Object.keys(out).length === 0 ? { [DEFAULT_ROUTE_ID]: {} } : out
}

/**
 * Read the catalog section.
 * @param config - the row's configuration.
 * @returns the listing settings, each defaulted.
 */
export function readCatalog (config: RawConfig): {
  autoDiscover: boolean
  maxAgeMs: number
  timeoutMs: number
  exclude: string[]
  includeNonFree: boolean
} {
  const raw = plain<Record<string, unknown>>(config?.catalog, {}) ?? {}
  const bool = (value: unknown, fallback: boolean): boolean => typeof value === 'boolean' ? value : fallback
  const num = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
  return {
    autoDiscover: bool(raw.autoDiscover, true),
    maxAgeMs: num(raw.maxAgeMs, DEFAULT_CATALOG_MAX_AGE_MS),
    timeoutMs: num(raw.timeoutMs, DEFAULT_CATALOG_TIMEOUT_MS) || DEFAULT_CATALOG_TIMEOUT_MS,
    exclude: Array.isArray(raw.exclude) ? raw.exclude.map(String) : [...DEFAULT_EXCLUDED_IDS],
    includeNonFree: bool(raw.includeNonFree, DEFAULT_INCLUDE_NON_FREE),
  }
}

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
export function readLocalPassword (local: Record<string, unknown>): string | undefined {
  const literal = local.password
  if (typeof literal === 'string' && literal.length > 0) return literal
  const declared = local.passwordEnv
  const names = typeof declared === 'string' && declared.length > 0 ? [declared] : [DEFAULT_LOCAL_PASSWORD_ENV]
  for (const name of names) {
    const value = process.env[name]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

/**
 * Resolve the facts the local-server transport needs.
 *
 * @param source - the route's configuration object.
 * @returns the server origin, provider id, credentials and deadlines.
 */
export function readLocalSettings (source: Record<string, unknown>): LocalServerSettings {
  const local = (source.local ?? {}) as Record<string, unknown>
  const num = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
  const password = readLocalPassword(local)
  return {
    serverURL: (typeof local.serverURL === 'string' && local.serverURL.length > 0
      ? local.serverURL
      : DEFAULT_SERVER_URL).replace(/\/+$/, ''),
    providerID: typeof local.providerID === 'string' && local.providerID.length > 0
      ? local.providerID
      : DEFAULT_LOCAL_PROVIDER_ID,
    ...password === undefined ? {} : { password },
    promptTimeoutMs: num(local.promptTimeoutMs, DEFAULT_PROMPT_TIMEOUT_MS),
    terminalTimeoutMs: num(local.terminalTimeoutMs, DEFAULT_TERMINAL_TIMEOUT_MS),
    autoStart: typeof local.autoStart === 'boolean' ? local.autoStart : true,
    startTimeoutMs: num(local.startTimeoutMs, DEFAULT_START_TIMEOUT_MS),
    serverCommand: typeof local.serverCommand === 'string' && local.serverCommand.length > 0
      ? local.serverCommand
      : DEFAULT_SERVER_COMMAND,
  }
}

/**
 * Resolve one route.
 *
 * @param provider - the route id.
 * @param source - the route's configuration object.
 * @returns the resolved route.
 */
export function resolveRoute (provider: string, source: Record<string, unknown>): ResolvedRoute {
  const displayName = typeof source.displayName === 'string' && source.displayName.length > 0
    ? source.displayName
    : DEFAULT_DISPLAY_NAME
  const local = readLocalSettings(source)
  const rawModels = (source.models ?? []) as ModelEntry[]
  const configuredModels = Array.isArray(rawModels)
    ? rawModels
      .filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.id === 'string' && entry.id.length > 0)
      .map((entry) => ({
        id: entry.id,
        ...typeof entry.name === 'string' && entry.name.length > 0 ? { name: entry.name } : {},
        ...typeof entry.contextWindow === 'number' ? { contextWindow: entry.contextWindow } : {},
        ...typeof entry.maxTokens === 'number' ? { maxTokens: entry.maxTokens } : {},
      }))
    : []
  const num = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
  return {
    provider,
    displayName,
    baseURL: local.serverURL,
    local,
    configuredModels,
    defaultContextWindow: num(source.defaultContextWindow, DEFAULT_CONTEXT_WINDOW),
    defaultMaxTokens: num(source.defaultMaxTokens, DEFAULT_MAX_TOKENS),
  }
}

/**
 * A stable text form of one route, for change detection across configuration
 * updates: identical input means the mounted adapter is still correct.
 * @param route - the resolved route.
 * @returns the fingerprint.
 */
export function routeFingerprint (route: ResolvedRoute): string {
  return JSON.stringify({
    provider: route.provider,
    displayName: route.displayName,
    local: route.local,
    catalog: route.catalog,
    models: route.configuredModels.map((model) => [model.id, model.name, model.contextWindow, model.maxTokens]),
    context: route.defaultContextWindow,
    maxTokens: route.defaultMaxTokens,
  })
}