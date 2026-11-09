/** Lazy startup; servers we launch are owned by the plugin lifetime. */

import { spawnOwnedServer } from './owner.js'
import { createConnection } from 'node:net'
import { DEFAULT_PORT_HINT } from './limits.js'

/** The minimum a spawned child must offer, so a test can stand in for one. */
export interface SpawnedChild {
  pid?: number
  stdin?: { end: () => void } | null
  kill?: (signal?: NodeJS.Signals | number) => boolean
  /** Detaches the child from the Host's event loop, so the Host can exit first. */
  unref?: () => void
  stdout?: {
    on: (event: string, listener: (chunk: unknown) => void) => unknown
    removeListener?: (event: string, listener: (chunk: unknown) => void) => unknown
    /** Stops the pipe from holding the Host open, without closing it. */
    unref?: () => void
  } | null
  on?: (event: string, listener: (...args: unknown[]) => void) => unknown
}

/** What `ensureServer` needs to know, resolved from the route and the plugin. */
export interface SupervisorSettings {
  /** Whether this plugin should start a server at all. */
  autoStart: boolean
  /** How long to wait for a freshly spawned server to answer. */
  startTimeoutMs: number
  /** How long one reachability probe may take. */
  probeTimeoutMs: number
  /** The server origin, e.g. `http://127.0.0.1:4399`. */
  serverURL: string
  /** The password to hand the server; when absent the server prints one and we read it. */
  password?: string
  /** The executable name or path. */
  command: string
  /**
   * Aborted when the plugin unloads. The probe loop then stops instead of
   * holding the Host's event loop open for the rest of the start deadline.
   */
  signal?: AbortSignal
}

/** What a supervision attempt did. */
export interface SupervisorOutcome {
  /** Whether this call left a server running that was not running before. */
  started: boolean
  /** The owner helper pid; descendants are managed as a tree. */
  pid?: number
  /**
   * Why nothing was started, when nothing was: an existing server, a
   * port that may already be occupied, a configuration decision, a spawn
   * failure, a server that never answered, or a cancelled probe.
   */
  reason?: 'already-running' | 'port-unconfirmed' | 'disabled' | 'spawn-failed' | 'never-answered' | 'cancelled'
}

/** Read the port from a server origin. @param serverURL - e.g. `http://127.0.0.1:4399`. @returns the port, or the default. */
export function portOf (serverURL: string): number {
  try {
    const url = new URL(serverURL)
    if (url.port.length > 0) return Number(url.port)
    return url.protocol === 'https:' ? 443 : 80
  } catch {
    return DEFAULT_PORT_HINT
  }
}

/** Read the host from a server origin. @param serverURL - e.g. `http://127.0.0.1:4399`. @returns the hostname. */
export function hostOf (serverURL: string): string {
  try {
    return new URL(serverURL).hostname
  } catch {
    return '127.0.0.1'
  }
}

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
export async function isReachable (
  serverURL: string,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const response = await fetchImpl(`${serverURL.replace(/\/+$/, '')}/api/model`, {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs),
    })
    void response.body?.cancel().catch(() => {})
    return response.status > 0
  } catch {
    return false
  }
}

/** Only a refused TCP connection confirms that it is safe to attempt a start. */
function portIsFree (serverURL: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({
      host: hostOf(serverURL).replace(/^\[|\]$/g, ''),
      port: portOf(serverURL),
    })
    const finish = (free: boolean): void => {
      socket.destroy()
      resolve(free)
    }
    socket.once('connect', () => finish(false))
    socket.once('error', (error: NodeJS.ErrnoException) => finish(error.code === 'ECONNREFUSED'))
    socket.setTimeout(timeoutMs, () => finish(false))
  })
}

/** Best-effort one-line description of a spawn failure. */
function describe (value: unknown): string {
  if (value instanceof Error) return value.message
  return String(value)
}

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
export async function ensureServer (
  settings: SupervisorSettings,
  logger: (level: 'info' | 'warn' | 'error', message: string) => void,
  spawnImpl: (command: string, args: string[], options: Record<string, unknown>) => SpawnedChild = spawnOwnedServer as unknown as (command: string, args: string[], options: Record<string, unknown>) => SpawnedChild,
  fetchImpl: typeof fetch = fetch,
  onPassword?: (password: string) => void,
): Promise<SupervisorOutcome> {
  if (await isReachable(settings.serverURL, settings.probeTimeoutMs, fetchImpl)) {
    logger('info', `a server already answers at ${settings.serverURL}; this plugin did not start one`)
    return { started: false, reason: 'already-running' }
  }
  if (!settings.autoStart) {
    logger('warn', `nothing answers at ${settings.serverURL} and local.autoStart is off; start it yourself with "${settings.command} serve --hostname ${hostOf(settings.serverURL)} --port ${String(portOf(settings.serverURL))}"`)
    return { started: false, reason: 'disabled' }
  }

  if (!await portIsFree(settings.serverURL, settings.probeTimeoutMs)) {
    logger('warn', `the port at ${settings.serverURL} is occupied or could not be checked; skipping OpenCode auto-start`)
    return { started: false, reason: 'port-unconfirmed' }
  }
  if (settings.signal?.aborted) return { started: false, reason: 'cancelled' }

  const args = ['serve', '--hostname', hostOf(settings.serverURL), '--port', String(portOf(settings.serverURL))]
  /* The one reason to keep a pipe at all: reading the password the server prints
   * when the configuration names none. Otherwise the child gets no stdio, so the
   * Host holds nothing that could keep it alive — and a pipe we closed later
   * could kill the server with EPIPE on its next write. */
  const wantsPrintedPassword = settings.password === undefined && onPassword !== undefined
  let child: SpawnedChild
  try {
    child = spawnImpl(settings.command, args, {
      windowsHide: true,
      // The owner helper holds the lifetime lease without keeping DSH alive.
      detached: false,
      stdio: ['ignore', wantsPrintedPassword ? 'pipe' : 'ignore', 'ignore'],
      /* The server adopts this value instead of printing a new one, which is what
       * makes the password in the configuration keep working after a restart. */
      env: { ...process.env, ...settings.password === undefined ? {} : { OPENCODE_SERVER_PASSWORD: settings.password } },
    })
  } catch (error) {
    logger('error', `starting "${settings.command}" failed: ${describe(error)}; start the server yourself with "${settings.command} ${args.join(' ')}"`)
    return { started: false, reason: 'spawn-failed' }
  }

  let stopped = false
  const stop = (): void => {
    if (stopped) return
    stopped = true
    if (child.stdin != null) child.stdin.end()
    else child.kill?.()
  }
  settings.signal?.addEventListener('abort', stop, { once: true })
  if (settings.signal?.aborted) stop()

  // The owner has its own lifetime lease and must not keep the Host event loop alive.
  try {
    child.unref?.()
  } catch {
    /* A stand-in need not implement it. */
  }

  let exited: { code: number | null, signal: string | null } | undefined
  child.on?.('exit', (code, signal) => {
    exited = { code: code as number | null, signal: signal as string | null }
    settings.signal?.removeEventListener('abort', stop)
  })
  child.on?.('error', (error) => {
    logger('error', `"${settings.command}" could not be started (${describe(error)}); start the server yourself with "${settings.command} ${args.join(' ')}"`)
  })

  /* When the configuration names no password, the server prints one; capture it
   * so the route can authenticate without the user copying it anywhere. */
  const onStdout = (chunk: unknown): void => {
    if (onPassword === undefined || settings.password !== undefined) return
    const text = String(chunk)
    const match = /server password\s*:?\s*(\S+)/i.exec(text)
    if (match === null) return
    onPassword(match[1])
    logger('info', 'adopted the password the local server printed at startup')
  }
  child.stdout?.on('data', onStdout)

  /**
   * Detach the one pipe kept for the printed password: listener gone, handle
   * `unref()`d so the Host can exit. The pipe stays open — closing it would make
   * the server's next write fail with EPIPE.
   */
  const releaseStdout = (): void => {
    try {
      child.stdout?.removeListener?.('data', onStdout)
      child.stdout?.unref?.()
    } catch {
      /* A stand-in may implement neither method. */
    }
  }

  const cancelled = (): boolean => settings.signal?.aborted === true

  try {
    const deadline = Date.now() + settings.startTimeoutMs
    while (Date.now() < deadline && !cancelled()) {
      if (await isReachable(settings.serverURL, settings.probeTimeoutMs, fetchImpl)) {
        logger('info', `started "${settings.command}" for ${settings.serverURL}; it stays resident with the plugin and closes when DSH exits`)
        return { started: true, ...child.pid === undefined ? {} : { pid: child.pid } }
      }
      if (exited !== undefined) break
      await new Promise((resolve) => setTimeout(resolve, 250))
    }

    if (cancelled()) {
      // The abort listener closes the owned process tree, including during startup.
      logger('info', `the probe for ${settings.serverURL} was cancelled; the owned server is closing`)
      return { started: false, reason: 'cancelled' }
    }

    const why = exited === undefined
      ? `it did not answer within ${String(settings.startTimeoutMs)}ms`
      : `it exited with code ${String(exited.code)}`
    logger('error', `"${settings.command}" was started but ${why}; start it yourself with "${settings.command} ${args.join(' ')}"`)
    try {
      stop()
    } catch {
      /* Nothing to clean up. */
    }
    return { started: false, reason: 'never-answered' }
  } finally {
    releaseStdout()
  }
}
