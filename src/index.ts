/**
 * `dsh-plugin-opencode-free` — the OpenCode Free provider route.
 *
 * The route is served by a local `opencode serve` process, which is the only
 * client the free tier accepts. This plugin adds what configuration alone
 * cannot: it creates a session per turn, streams the answer out of the server's
 * global event stream, filters that stream to this session, and keeps the model
 * catalog in step with what the server actually offers.
 *
 * The plugin does not speak the OpenAI wire format, and has no credential, key
 * pool or cooldown of its own: the local server brings its own identity, and a
 * password it requires is read from the row or from `OPENCODE_SERVER_PASSWORD`.
 *
 * @module dsh-plugin-opencode-free
 */

import { readCatalog, readRoutes, resolveRoute, routeFingerprint, type RawConfig, type ResolvedRoute } from './config.js'
import { admitCatalog, displayNameOf, isFreeModelId } from './catalog.js'
import { createLocalAdapter } from './local/adapter.js'
import { deadlineSignal, listModels, withDeadline } from './local/server.js'
import { ensureServer } from './local/supervisor.js'
import { DEFAULT_SERVER_COMMAND } from './local/limits.js'
import { safeLog, type PluginContext } from './host.js'
import { checkCompat } from './compat.js'
import type { LlmDiscoveredModel, LlmModelDiscoveryRequest } from './compat.js'
import { DEFAULT_ROUTE_ID } from './config.js'

/** Package name, as the Loader reports the row. */
export const name = 'dsh-plugin-opencode-free'

/** The plugin cannot register anything before the LLM seam exists. */
export const inject = ['llm']

export { Config } from './config.js'

/**
 * The settings namespace this plugin's surfaces edit.
 *
 * This **must equal the Cordis row id** in `cordis.patch.yml`: discovery is
 * offered for exactly this namespace, and the Models page dispatches the
 * provider card under it. Rename both together or neither.
 */
export const SETTINGS_NAMESPACE = 'OpenCodeFree'

/** Diagnostic prefix shared by every line this plugin writes. */
const PREFIX = 'dsh-plugin-opencode-free:'

/** One provider's mounted state. */
interface MountedRoute {
  fingerprint: string
  route: ResolvedRoute
  /**
   * The registration handle: calling it withdraws the route, and `replace`
   * re-announces it. `replace` is optional because a Host release is free to
   * return a bare disposer.
   */
  handle: (() => void) & { replace?: (providers: string[]) => void }
}

/** Describe a failure without losing the stable code the seam attached. */
function describeFailure (error: unknown): string {
  const code = (error as { code?: unknown })?.code
  const message = error instanceof Error ? error.message : String(error)
  return typeof code === 'string' ? `${code}: ${message}` : message
}

/**
 * The plugin entry point.
 *
 * @param ctx - the Cordis context.
 * @param config - the row's configuration.
 */
export function apply (ctx: PluginContext, config: RawConfig): void {
  const compat = checkCompat()
  for (const issue of compat.fatal) {
    safeLog(ctx, 'error', `${PREFIX} this DSH release is not compatible: ${issue.point} ${issue.detail}`)
  }
  if (compat.fatal.length > 0) return
  for (const issue of compat.warnings) {
    safeLog(ctx, 'warn', `${PREFIX} degraded: ${issue.point} ${issue.detail}`)
  }

  const mounted = new Map<string, MountedRoute>()

  /* Aborted when the plugin unloads, so a start already in progress stops
   * probing instead of holding the Host's event loop open. */
  const lifetime = new AbortController()

  /* Origin → the start currently in flight. Nothing runs it at mount: the first
   * Models page or the first turn asks for it. Mounting happens inside Host
   * startup, and spawning `opencode serve` there raced the desktop's own
   * welcome/authentication flow on a cold boot — the failure it produced was
   * `Web authentication failed` followed by a host that would not exit.
   *
   * The entry is a coalescing handle for a start in progress and is dropped as
   * soon as it settles: a server the user closed by hand has to be startable
   * again from the refresh button, and a promise kept for the life of the
   * process would turn that click into a replay of the first answer. */
  const started = new Map<string, Promise<void>>()
  const passwords = new Map<string, string>()
  const serverLifetimes = new Map<string, AbortController>()

  /** Confirm a server answers for one origin, starting it when nothing does. */
  const ensureOrigin = (route: ResolvedRoute): Promise<void> => {
    const origin = route.local.serverURL
    const remembered = passwords.get(origin)
    if (route.local.password === undefined && remembered !== undefined) route.local.password = remembered
    const existing = started.get(origin)
    if (existing !== undefined) return existing.then(() => {
      const password = passwords.get(origin)
      if (route.local.password === undefined && password !== undefined) route.local.password = password
    })
    const local = route.local
    let ownerLifetime = serverLifetimes.get(origin)
    if (ownerLifetime === undefined) {
      ownerLifetime = new AbortController()
      serverLifetimes.set(origin, ownerLifetime)
    }
    const serverSignal = AbortSignal.any([lifetime.signal, ownerLifetime.signal])
    const pending = (async () => {
      // The lifetime signal closes the owner's process tree, not a launcher pid.
      const outcome = await ensureServer(
        {
          autoStart: local.autoStart !== false,
          startTimeoutMs: local.startTimeoutMs ?? 20000,
          probeTimeoutMs: 1500,
          serverURL: origin,
          signal: serverSignal,
          ...local.password === undefined ? {} : { password: local.password },
          command: local.serverCommand ?? DEFAULT_SERVER_COMMAND,
        },
        (level, message) => { safeLog(ctx, level, `${PREFIX} ${message}`) },
        undefined,
        undefined,
        /* The server printed a password because the configuration named none:
         * adopt it in place, so every request from here on authenticates. */
        (password) => {
          local.password = password
          passwords.set(origin, password)
          for (const state of mounted.values()) {
            if (state.route.local.serverURL === origin && state.route.local.password === undefined) state.route.local.password = password
          }
        },
      )
      /* A server that answers now may not have been there when the browser
       * built its model catalog. That catalog is one snapshot per Host
       * generation, rebuilt only on `llm/adapters-updated` — which is exactly
       * what `replace` publishes. Without this, the picker keeps the empty
       * group it read while the server was down until the app restarts. */
      if (outcome.started === true || outcome.reason === 'already-running') {
        if (local.password !== undefined) {
          passwords.set(origin, local.password)
          for (const state of mounted.values()) {
            if (state.route.local.serverURL === origin && state.route.local.password === undefined) state.route.local.password = local.password
          }
        }
        announce(origin)
      }
    })().catch((error: unknown) => {
      safeLog(ctx, 'error', `${PREFIX} supervising ${origin} failed: ${describeFailure(error)}`)
    })
    started.set(origin, pending)
    /* Forget this ask once it is answered. The next refresh probes the port
     * again instead of replaying a resolved promise, which is what makes a
     * manually closed server come back. */
    void pending.then(() => {
      if (started.get(origin) === pending) started.delete(origin)
    })
    return pending
  }

  /**
   * Re-announce every route on one origin, so the browser rebuilds its catalog.
   *
   * `llm.registerAdapter()`'s handle publishes `llm/adapters-updated` when its
   * routes are committed *and* when they are replaced; the client's model
   * catalog listens for that and reloads. Re-registering is therefore not a
   * cosmetic nudge: it is the only event this plugin can raise that makes the
   * picker ask again — and it starts nothing.
   *
   * @param origin - the server origin whose routes should announce themselves.
   */
  const announce = (origin: string): void => {
    for (const state of mounted.values()) {
      if (state.route.local.serverURL !== origin) continue
      const replace = state.handle.replace
      if (typeof replace !== 'function') continue
      try {
        replace([state.route.provider])
        safeLog(ctx, 'info', `${PREFIX} re-announced "${state.route.provider}" so the model picker rebuilds its catalog`)
      } catch (error) {
        safeLog(ctx, 'warn', `${PREFIX} re-announcing "${state.route.provider}" failed: ${describeFailure(error)}`)
      }
    }
  }

  /** Unregister one route and forget its state. */
  const unmount = (provider: string): void => {
    const state = mounted.get(provider)
    if (state === undefined) return
    try {
      state.handle()
    } catch (error) {
      safeLog(ctx, 'warn', `${PREFIX} unregistering "${provider}" failed: ${describeFailure(error)}`)
    }
    mounted.delete(provider)
  }

  /** Mount one route, or replace it when its wire facts changed. */
  const reconcile = async (): Promise<void> => {
    const routes = readRoutes(config)
    const catalog = readCatalog(config)

    for (const provider of [...mounted.keys()]) {
      if (!(provider in routes)) {
        unmount(provider)
        safeLog(ctx, 'info', `${PREFIX} provider "${provider}" is no longer configured and was unregistered`)
      }
    }

    for (const [provider, source] of Object.entries(routes)) {
      let route: ResolvedRoute
      try {
        route = resolveRoute(provider, source)
      } catch (error) {
        safeLog(ctx, 'error', `${PREFIX} provider "${provider}" was not registered: ${describeFailure(error)}`)
        continue
      }
      /** The catalog decision is part of the route, so it participates in the fingerprint. */
      const withCatalog: ResolvedRoute = { ...route, catalog }
      const fingerprint = routeFingerprint(withCatalog)
      const current = mounted.get(provider)
      if (current !== undefined && current.fingerprint === fingerprint) continue

      unmount(provider)
      try {
        /* The server is started lazily by this callback — on the first turn —
         * instead of here, where mounting runs during Host startup. */
        const adapter = createLocalAdapter(withCatalog, withCatalog.local, {
          ensureStarted: () => ensureOrigin(withCatalog),
          /* The picker reads `listModels()`, which never starts the server: an
           * empty answer is dropped there without a line of its own, so the
           * reason has to be logged here or it is invisible. */
          signal: lifetime.signal,
          onCleanupFailed: (reason) => safeLog(ctx, 'warn', `${PREFIX} ${reason}`),
          onListingFailed: (reason) => {
            safeLog(ctx, 'warn', `${PREFIX} the model picker could not list "${provider}": ${reason}`)
          },
        })
        const handle = ctx.llm.registerAdapter([provider], adapter)
        mounted.set(provider, { fingerprint, route: withCatalog, handle })
        safeLog(ctx, 'info', `${PREFIX} registered provider "${provider}" (${withCatalog.displayName}, ${withCatalog.local.serverURL})`)
      } catch (error) {
        safeLog(ctx, 'error', `${PREFIX} provider "${provider}" was not registered: ${describeFailure(error)}`)
      }
    }
    const usedOrigins = new Set([...mounted.values()].map((state) => state.route.local.serverURL))
    for (const [origin, controller] of serverLifetimes) {
      if (usedOrigins.has(origin)) continue
      controller.abort()
      serverLifetimes.delete(origin)
      passwords.delete(origin)
    }
  }

  void reconcile().catch((error: unknown) => {
    safeLog(ctx, 'error', `${PREFIX} initial reconciliation failed: ${describeFailure(error)}`)
  })

  /* The Models page and this plugin's own page ask for discovery with this
   * namespace. The local server is the source: its `/api/model` is the same
   * listing the picker would accept. The handler reads the live configuration
   * on each call, so a Settings edit is picked up without a restart.
   *
   * Every call re-asks the port: a plugin instance that cached its first answer
   * for the life of the process could never recover a server the user closed by
   * hand, and "refresh" would be a button that lies. */
  const discover = async (
    request: LlmModelDiscoveryRequest,
    signal?: AbortSignal,
  ): Promise<LlmDiscoveredModel[]> => {
    const routes = readRoutes(config)
    const provider = request.provider ?? Object.keys(routes)[0] ?? DEFAULT_ROUTE_ID
    const route = resolveRoute(provider, routes[provider] ?? {})
    const catalog = readCatalog(config)
    if (route.configuredModels.length === 0 && !catalog.autoDiscover) return []
    /* Opening the Models page is a user action, so this is where a cold start is
     * allowed. Bounded: an unbounded wait would hang the page behind a server
     * that never answers. */
    if (route.configuredModels.length === 0) {
      await withDeadline(ensureOrigin(route), 25000, 'model discovery startup', signal)
    }
    const served = route.configuredModels.length > 0
      ? route.configuredModels.map((model) => ({
        id: model.id,
        name: model.name ?? displayNameOf(model.id),
        free: isFreeModelId(model.id),
        ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
        ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
      }))
      /* `catalog.timeoutMs` bounds the listing itself, so a half-open port fails
       * the request instead of holding the page open. */
      : await listModels(route.local, deadlineSignal(catalog.timeoutMs, signal))
    /* The picker and this page must never disagree about what exists, so both
     * go through the same admission rule the adapter applies. */
    const rows = admitCatalog(served, catalog)
    /* The server reports ids and names, not always a capacity. Leaving those out
     * would show a dash on the page while the picker advertises the route's
     * default, so the same default is applied here. */
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      contextWindow: row.contextWindow ?? route.defaultContextWindow,
      maxTokens: row.maxTokens ?? route.defaultMaxTokens,
    }))
  }
  ctx.effect(() => {
    try {
      return ctx.llm.registerModelDiscovery(SETTINGS_NAMESPACE, discover)
    } catch (error) {
      /* A missing discovery seam must not take the routes down with it. */
      safeLog(ctx, 'error', `${PREFIX} model discovery was not registered: ${describeFailure(error)}`)
      return () => {}
    }
  })

  /* The Models page only renders an adapter extension area for a directory row,
   * so the route is declared here as well as registered above. A release
   * without this seam keeps working: the card simply never appears. */
  ctx.effect(() => {
    const register = ctx.llm.registerConfigurableProviders
    if (typeof register !== 'function') {
      safeLog(ctx, 'warn', `${PREFIX} this DSH release has no configurable-provider directory; the Models page will not show this plugin's settings card`)
      return () => {}
    }
    try {
      const routes = readRoutes(config)
      const primary = DEFAULT_ROUTE_ID in routes ? DEFAULT_ROUTE_ID : (Object.keys(routes)[0] ?? DEFAULT_ROUTE_ID)
      const route = resolveRoute(primary, routes[primary] ?? {})
      return register([{
        provider: primary,
        displayName: route.displayName,
        settingsNs: SETTINGS_NAMESPACE,
        settingsPath: ['routes', primary],
        declared: true,
        defaultBaseURL: route.local.serverURL,
      }])
    } catch (error) {
      safeLog(ctx, 'warn', `${PREFIX} the provider card was not declared: ${describeFailure(error)}`)
      return () => {}
    }
  })

  /* A status tool, for two reasons: the settings card cannot reach Host-process
   * state, and a registered tool is observable proof that this plugin's apply()
   * ran in the live process. */
  ctx.effect(() => {
    const tools = ctx.get('tools') as { register?: (definition: unknown) => () => void } | undefined
    if (typeof tools?.register !== 'function') {
      safeLog(ctx, 'warn', `${PREFIX} this DSH release has no tools registry; the opencode_free_status tool stays unregistered`)
      return () => {}
    }
    const describe = async (): Promise<Record<string, unknown>> => {
      const catalog = readCatalog(config)
      return {
        provider: DEFAULT_ROUTE_ID,
        catalog: { ...catalog, exclude: [...catalog.exclude] },
        routes: [...mounted.values()].map((state) => ({
          id: state.route.provider,
          displayName: state.route.displayName,
          serverURL: state.route.local.serverURL,
          providerID: state.route.local.providerID,
          configuredModels: state.route.configuredModels.map((model) => model.id),
          hasPassword: state.route.local.password !== undefined,
        })),
      }
    }
    const render = (_args: unknown, value: unknown): unknown[] => {
      const status = value as Record<string, any>
      const lines: string[] = []
      const routes: any[] = Array.isArray(status.routes) ? status.routes : []
      if (routes.length === 0) lines.push('no route is registered')
      for (const route of routes) {
        lines.push(`${route.id} · ${route.displayName} → ${route.serverURL} (providerID ${route.providerID}, password ${route.hasPassword ? 'configured' : 'missing'})`)
        if (Array.isArray(route.configuredModels) && route.configuredModels.length > 0) {
          lines.push(`  pinned models: ${route.configuredModels.join(', ')}`)
        }
      }
      lines.push(`catalog: autoDiscover ${String(status.catalog?.autoDiscover)} · includeNonFree ${String(status.catalog?.includeNonFree)} · maxAgeMs ${String(status.catalog?.maxAgeMs)}`)
      return [{ type: 'text', text: lines.join('\n') }]
    }
    try {
      return tools.register({
        name: 'opencode_free_status',
        description: 'Report the OpenCode Free route this plugin serves: the local server it drives, whether the password is configured, the models the configuration pins (an empty list means the server listing is used), and the catalog settings. Use it when a session on this provider fails or before switching models.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        output: {
          schema: {
            type: 'object',
            properties: {
              provider: { type: 'string' },
              catalog: { type: 'object', additionalProperties: true },
              routes: { type: 'array', items: { type: 'object', additionalProperties: true } },
            },
            additionalProperties: true,
          },
          render,
        },
        execute: async () => describe(),
      })
    } catch (error) {
      safeLog(ctx, 'warn', `${PREFIX} the opencode_free_status tool was not registered: ${describeFailure(error)}`)
      return () => {}
    }
  })

  /* A profile-layer edit reaches a running Host as a volatile loader update;
   * reconcile from it so an edit is picked up without a restart. */
  ctx.on('loader/volatile-update', () => {
    void reconcile().catch((error: unknown) => {
      safeLog(ctx, 'error', `${PREFIX} reconciling providers after a configuration update failed: ${describeFailure(error)}`)
    })
  })

  ctx.effect(() => () => {
    /* Stop a start in progress first: its probe loop would otherwise keep the
     * Host alive for the rest of the start deadline after the plugin is gone. */
    lifetime.abort()
    for (const provider of [...mounted.keys()]) unmount(provider)
  })
}
