/**
 * The server supervisor.
 *
 * These run without a real `opencode`: the spawn and the reachability probe are
 * injected, because the interesting rules are decisions — never duplicate an
 * answering server, stay bounded, only kill what we started.
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'

import { ensureServer, hostOf, isReachable, portOf } from '../lib/local/supervisor.js'

/** Collect logger lines instead of printing them. */
function recorder () {
  const lines = []
  return { lines, log: (level, message) => { lines.push([level, message]) } }
}

/** A child stand-in that records how it was asked to run. */
function childStub (options = {}) {
  const calls = { args: [], env: undefined, killed: 0, unref: 0, stdoutUnref: 0, stdoutRemoved: 0, options: undefined }
  const listeners = new Map()
  const child = {
    pid: 4242,
    kill: () => { calls.killed += 1; return true },
    unref: () => { calls.unref += 1 },
    stdout: {
      on: (event, listener) => {
        if (event === 'data' && options.print !== undefined) setTimeout(() => listener(options.print), 5)
        return child.stdout
      },
      removeListener: () => { calls.stdoutRemoved += 1; return child.stdout },
      unref: () => { calls.stdoutUnref += 1 },
    },
    on: (event, listener) => {
      listeners.set(event, listener)
      if (event === 'exit' && options.exitCode !== undefined) setTimeout(() => listener(options.exitCode, null), 5)
      return child
    },
  }
  return {
    child,
    calls,
    spawn: (command, args, opts) => {
      calls.command = command
      calls.args = args
      calls.env = opts.env
      calls.options = opts
      return child
    },
  }
}

/** A probe stand-in: the port answers from call `after` on, refuses before. */
function probeStub (after) {
  let calls = 0
  return {
    get calls () { return calls },
    probe: async () => {
      calls += 1
      if (calls < after) throw new Error('fetch failed')
      return { status: 401 }
    },
  }
}

/** A probe stand-in for a port nothing holds. */
async function nothingListening () {
  throw new Error('fetch failed')
}

/** A probe stand-in for a server that already answers. */
async function alreadyListening () {
  return { status: 401 }
}

test('the port and host are read from the origin', () => {
  assert.equal(portOf('http://127.0.0.1:4399'), 4399)
  assert.equal(hostOf('http://127.0.0.1:4399'), '127.0.0.1')
  assert.equal(portOf('not a url'), 4399, 'a broken origin falls back to the project default')
  assert.equal(hostOf('not a url'), '127.0.0.1')
})

test('reachability asks the real thing: an open port answers, a closed one does not', async () => {
  const server = createServer((request, response) => {
    response.writeHead(401, { 'content-type': 'application/json' })
    response.end('{"message":"Authentication required"}')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  try {
    assert.equal(await isReachable(origin, 1000), true, 'a 401 still means a process holds the port')
  } finally {
    await new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve) })
  }
  assert.equal(await isReachable(origin, 500), false, 'a closed port is not reachable')
})

test('an answering server is never duplicated', async () => {
  const { lines, log } = recorder()
  const stub = childStub()
  const outcome = await ensureServer(
    { autoStart: true, startTimeoutMs: 1000, probeTimeoutMs: 100, serverURL: 'http://127.0.0.1:52987', command: 'opencode' },
    log,
    stub.spawn,
    alreadyListening,
  )
  assert.equal(outcome.started, false)
  assert.equal(outcome.reason, 'already-running')
  assert.equal(stub.calls.args.length, 0, 'nothing was spawned')
  assert.match(lines[0][1], /already answers/)
})

test('an occupied port never spawns another server when HTTP times out', async () => {
  const server = createServer(() => {})
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  try {
    const outcome = await ensureServer(
      { autoStart: true, startTimeoutMs: 500, probeTimeoutMs: 100, serverURL: origin, command: 'opencode' },
      recorder().log,
      () => assert.fail('an occupied port must not launch a child'),
    )
    assert.deepEqual(outcome, { started: false, reason: 'port-unconfirmed' })
  } finally {
    await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve) })
  }
})

test('autoStart off leaves the manual path alone and says what to run', async () => {
  const { lines, log } = recorder()
  const stub = childStub()
  const outcome = await ensureServer(
    { autoStart: false, startTimeoutMs: 1000, probeTimeoutMs: 100, serverURL: 'http://127.0.0.1:52987', command: 'opencode' },
    log,
    stub.spawn,
    nothingListening,
  )
  assert.equal(outcome.started, false)
  assert.equal(outcome.reason, 'disabled')
  assert.equal(stub.calls.args.length, 0)
  assert.match(lines[0][1], /opencode serve --hostname 127\.0\.0\.1 --port 52987/)
})

test('it starts the server on the configured port and hands it the password', async () => {
  const { lines, log } = recorder()
  const stub = childStub()
  const prober = probeStub(2)
  const outcome = await ensureServer(
    { autoStart: true, startTimeoutMs: 3000, probeTimeoutMs: 100, serverURL: 'http://127.0.0.1:52987', password: 'secret', command: 'opencode' },
    log,
    stub.spawn,
    prober.probe,
  )
  assert.equal(outcome.started, true)
  assert.equal(outcome.pid, 4242)
  assert.equal(stub.calls.command, 'opencode')
  assert.deepEqual(stub.calls.args, ['serve', '--hostname', '127.0.0.1', '--port', '52987'])
  assert.equal(stub.calls.env.OPENCODE_SERVER_PASSWORD, 'secret', 'the server adopts this instead of printing one')
  assert.ok(lines.some(([, message]) => /started "opencode"/.test(message)))
  assert.ok(lines.some(([, message]) => /closes when DSH exits/.test(message)),
    'the log describes the owned lifetime')
})

test('a server that never answers is reported, then killed', async () => {
  const { lines, log } = recorder()
  const stub = childStub()
  const outcome = await ensureServer(
    { autoStart: true, startTimeoutMs: 400, probeTimeoutMs: 100, serverURL: 'http://127.0.0.1:52987', command: 'opencode' },
    log,
    stub.spawn,
    nothingListening,
  )
  assert.equal(outcome.started, false)
  assert.equal(outcome.reason, 'never-answered')
  assert.equal(stub.calls.killed, 1, 'a process that never answered is not left running')
  assert.ok(lines.some(([level, message]) => level === 'error' && /did not answer|exited with code/.test(message)))
})

test('a server that exits immediately is reported with the command to run by hand', async () => {
  const { lines, log } = recorder()
  const stub = childStub({ exitCode: 1 })
  const outcome = await ensureServer(
    { autoStart: true, startTimeoutMs: 3000, probeTimeoutMs: 50, serverURL: 'http://127.0.0.1:52987', command: 'opencode' },
    log,
    stub.spawn,
    nothingListening,
  )
  assert.equal(outcome.started, false)
  assert.ok(lines.some(([, message]) => /exited with code 1/.test(message)))
  assert.ok(lines.some(([, message]) => /opencode serve --hostname 127\.0\.0\.1 --port 52987/.test(message)))
})

test('a password the server prints is adopted when the configuration names none', async () => {
  const { log } = recorder()
  const stub = childStub({ print: 'server password: abc123\n' })
  const adopted = []
  /* Down first, up after the spawn: the point of this test is the spawn. */
  const prober = probeStub(2)
  const outcome = await ensureServer(
    { autoStart: true, startTimeoutMs: 2000, probeTimeoutMs: 50, serverURL: 'http://127.0.0.1:52987', command: 'opencode' },
    log,
    stub.spawn,
    prober.probe,
    (password) => adopted.push(password),
  )
  assert.equal(outcome.started, true)
  assert.equal(stub.calls.env.OPENCODE_SERVER_PASSWORD, undefined, 'no value is imposed when none was configured')
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.deepEqual(adopted, ['abc123'])
  assert.deepEqual(stub.calls.options.stdio, ['ignore', 'pipe', 'ignore'],
    'the only pipe kept is the one that carries the printed password')
  assert.equal(stub.calls.stdoutRemoved, 1, 'the listener is detached once the start is decided')
  assert.equal(stub.calls.stdoutUnref, 1, 'the pipe is unref()d, not closed: closing it would make the server write into a broken pipe')
})

test('the supervisor delegates ownership without keeping the Host alive', async () => {
  const { log } = recorder()
  const stub = childStub()
  const outcome = await ensureServer(
    { autoStart: true, startTimeoutMs: 3000, probeTimeoutMs: 50, serverURL: 'http://127.0.0.1:52987', password: 'secret', command: 'opencode' },
    log,
    stub.spawn,
    probeStub(2).probe,
  )
  assert.equal(outcome.started, true)
  assert.equal(stub.calls.options.detached, false, 'ownership is delegated to the lifetime helper')
  assert.deepEqual(stub.calls.options.stdio, ['ignore', 'ignore', 'ignore'],
    'with the password supplied there is nothing to read, so the Host holds no pipe at all')
  assert.equal(stub.calls.unref, 1, 'the Host never waits for the launcher pid')
})

test('a server stopped by hand is started again by the next ask', async () => {
  /* The refresh button is a fresh ask, not a replay: the plugin calls this on
   * every discovery and every turn, so a port that went quiet has to be retried
   * rather than remembered as answered. */
  const { lines, log } = recorder()
  const stub = childStub()
  const settings = {
    autoStart: true,
    startTimeoutMs: 2000,
    probeTimeoutMs: 50,
    serverURL: 'http://127.0.0.1:52987',
    password: 'secret',
    command: 'opencode',
  }
  let answering = true
  const probe = async () => {
    if (!answering) throw new Error('fetch failed')
    return { status: 401 }
  }
  /* Spawning is what brings the port back, exactly as the real process would. */
  const spawn = (command, args, options) => {
    answering = true
    return stub.spawn(command, args, options)
  }

  const first = await ensureServer(settings, log, spawn, probe)
  assert.equal(first.reason, 'already-running')
  assert.equal(stub.calls.args.length, 0, 'an answering server is not duplicated')

  answering = false
  const second = await ensureServer(settings, log, spawn, probe)
  assert.equal(second.started, true, 'the next ask starts it again')
  assert.deepEqual(stub.calls.args, ['serve', '--hostname', '127.0.0.1', '--port', '52987'])
  assert.ok(lines.some(([, message]) => /started "opencode"/.test(message)))
})

test('an unloading plugin stops probing and closes its server', async () => {
  const { lines, log } = recorder()
  const stub = childStub()
  const controller = new AbortController()
  let probes = 0
  const probe = async () => {
    probes += 1
    /* Abort mid-probe: this is what a plugin dispose looks like to the loop. */
    if (probes >= 3) controller.abort()
    throw new Error('fetch failed')
  }
  const outcome = await ensureServer(
    {
      autoStart: true, startTimeoutMs: 5000, probeTimeoutMs: 50,
      serverURL: 'http://127.0.0.1:52987', command: 'opencode', signal: controller.signal,
    },
    log,
    stub.spawn,
    probe,
  )
  assert.equal(outcome.started, false)
  assert.equal(outcome.reason, 'cancelled')
  assert.equal(stub.calls.killed, 1, 'only the process this supervisor launched is stopped')
  assert.ok(lines.some(([, message]) => /cancelled/.test(message)), 'the log says the probe stopped')
})
