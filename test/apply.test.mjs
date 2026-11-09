/**
 * The plugin entry point against a fake Cordis context.
 *
 * These assert the wiring the Host depends on: which route id is registered,
 * which settings namespace answers discovery, that a failure is isolated, and
 * that disposal withdraws the registration.
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'

import { apply, name, inject, SETTINGS_NAMESPACE } from '../lib/index.js'

/** A Cordis context stub that records what the plugin does to it. */
function fakeContext () {
  const calls = { adapters: [], discovery: [], directory: [], tools: [], disposers: [], listeners: [], logs: [], replacements: [] }
  const ctx = {
    get: (service) => service === 'tools'
      ? { register: (definition) => { calls.tools.push(definition); return () => {} } }
      : undefined,
    on: (event, listener) => {
      calls.listeners.push([event, listener])
      return () => {}
    },
    effect: (callback) => {
      const dispose = callback()
      if (typeof dispose === 'function') calls.disposers.push(dispose)
      return () => {}
    },
    logger: {
      info: (message) => calls.logs.push(['info', message]),
      warn: (message) => calls.logs.push(['warn', message]),
      error: (message) => calls.logs.push(['error', message]),
    },
    llm: {
      registerAdapter: (providers, adapter) => {
        calls.adapters.push({ providers, adapter })
        /* The real handle is a disposer that also carries `replace`, and a
         * `replace` is what publishes `llm/adapters-updated`. */
        const handle = () => { calls.disposed = (calls.disposed ?? 0) + 1 }
        handle.replace = (next) => { calls.replacements.push([...next]) }
        return handle
      },
      registerModelDiscovery: (namespace, discover) => {
        calls.discovery.push({ namespace, discover })
        return () => {}
      },
      registerConfigurableProviders: (entries) => {
        calls.directory.push(entries)
        return () => {}
      },
    },
  }
  return { ctx, calls }
}

/** Wait for the asynchronous first reconciliation to settle. */
async function settled (predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('the plugin did not finish mounting in time')
}

/** A fake local OpenCode server that answers the model listing. */
async function fakeServer (rows) {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/api/model') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ data: rows }))
      return
    }
    response.writeHead(404)
    response.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve) }),
  }
}

test('identity and injection are what the Loader expects', () => {
  assert.equal(name, 'dsh-plugin-opencode-free')
  assert.deepEqual(inject, ['llm'])
  assert.equal(SETTINGS_NAMESPACE, 'OpenCodeFree', 'the namespace equals the Cordis row id')
})

test('catalog-only volatile updates replace the adapter and disabled discovery starts nothing', async () => {
  const { ctx, calls } = fakeContext()
  const config = { routes: { r: { local: { serverCommand: 'must-not-run-disabled-discovery' } } }, catalog: { autoDiscover: false } }
  apply(ctx, config)
  await settled(() => calls.adapters.length === 1)
  assert.deepEqual(await calls.discovery[0].discover({ provider: 'r' }), [])
  assert.equal(calls.logs.some(([, message]) => /starting|started|supervising/.test(message)), false)
  config.catalog = { autoDiscover: true, maxAgeMs: 1, exclude: ['test'] }
  calls.listeners.find(([event]) => event === 'loader/volatile-update')[1]()
  await settled(() => calls.adapters.length === 2)
  assert.equal(calls.disposed, 1)
  for (const dispose of calls.disposers) dispose()
})

test('an empty configuration mounts the built-in route', async () => {
  const { ctx, calls } = fakeContext()
  /* autoStart off: this suite must not start a real server. */
  apply(ctx, { routes: { 'opencode-free': { local: { autoStart: false } } } })
  await settled(() => calls.adapters.length > 0)

  assert.equal(calls.adapters.length, 1)
  assert.deepEqual(calls.adapters[0].providers, ['opencode-free'])
  assert.equal(calls.adapters[0].adapter.providerInfo('opencode-free').name, 'OpenCode Free')
  assert.equal(calls.discovery.length, 1, 'the catalog has exactly one discovery offer')
  assert.equal(calls.discovery[0].namespace, 'OpenCodeFree')
  assert.ok(calls.listeners.some(([event]) => event === 'loader/volatile-update'))
})

test('the route is declared in the configurable-provider directory for its card', async () => {
  const { ctx, calls } = fakeContext()
  apply(ctx, { routes: { 'opencode-free': { displayName: 'Mine' } } })
  await settled(() => calls.directory.length > 0)

  const entries = calls.directory[0]
  assert.equal(entries.length, 1)
  assert.equal(entries[0].provider, 'opencode-free')
  assert.equal(entries[0].displayName, 'Mine')
  assert.equal(entries[0].settingsNs, 'OpenCodeFree')
  assert.deepEqual(entries[0].settingsPath, ['routes', 'opencode-free'])
})

test('discovery answers with the models the local server serves', async () => {
  const server = await fakeServer([
    { id: 'deepseek-v4.1-flash-free', providerID: 'opencode', name: 'DeepSeek V4.1 Flash (Free)' },
    { id: 'pulse-alpha-free', providerID: 'opencode', limit: { context: 1048576, output: 131072 } },
  ])
  try {
    const { ctx, calls } = fakeContext()
    apply(ctx, { routes: { 'opencode-free': { local: { serverURL: server.origin, autoStart: false } } } })
    await settled(() => calls.discovery.length > 0)

    const rows = await calls.discovery[0].discover({ provider: 'opencode-free' })
    assert.deepEqual(rows.map((row) => row.id), ['deepseek-v4.1-flash-free', 'pulse-alpha-free'])
    assert.equal(rows[1].contextWindow, 1048576)
    assert.equal(rows[1].maxTokens, 131072)
  } finally {
    await server.close()
  }
})

test('explicitly configured models win over the server listing', async () => {
  const { ctx, calls } = fakeContext()
  apply(ctx, {
    routes: {
      'opencode-free': {
        local: { serverURL: 'http://127.0.0.1:51987', autoStart: false },
        models: [{ id: 'pinned-free', name: 'Pinned' }],
      },
    },
  })
  await settled(() => calls.discovery.length > 0)

  const rows = await calls.discovery[0].discover({ provider: 'opencode-free' })
  assert.deepEqual(rows.map((row) => row.id), ['pinned-free'])
  assert.equal(rows[0].name, 'Pinned')
})

test('the status tool reports the server, the password state and the pinned models', async () => {
  const { ctx, calls } = fakeContext()
  apply(ctx, {
    routes: {
      'opencode-free': {
        displayName: 'OpenCode Free',
        local: { serverURL: 'http://127.0.0.1:4399', password: 'secret', autoStart: false },
        models: [{ id: 'a-free' }],
      },
    },
  })
  await settled(() => calls.adapters.length > 0)

  assert.equal(calls.tools.length, 1)
  const tool = calls.tools[0]
  assert.equal(tool.name, 'opencode_free_status')
  const status = await tool.execute({}, {})
  assert.equal(status.provider, 'opencode-free')
  assert.equal(status.routes[0].serverURL, 'http://127.0.0.1:4399')
  assert.equal(status.routes[0].hasPassword, true)
  assert.deepEqual(status.routes[0].configuredModels, ['a-free'])

  const rendered = tool.output.render({}, status)
  assert.match(rendered[0].text, /opencode-free/)
  assert.match(rendered[0].text, /password configured/)
})

test('a release without the directory seam still mounts the route', async () => {
  const { ctx, calls } = fakeContext()
  delete ctx.llm.registerConfigurableProviders
  apply(ctx, { routes: { 'opencode-free': { local: { autoStart: false } } } })
  await settled(() => calls.adapters.length > 0)
  assert.ok(calls.logs.some(([level, message]) => level === 'warn' && message.includes('configurable-provider directory')))
})

test('a release without a tools registry still mounts the route', async () => {
  const { ctx, calls } = fakeContext()
  ctx.get = () => undefined
  apply(ctx, { routes: { 'opencode-free': { local: { autoStart: false } } } })
  await settled(() => calls.adapters.length > 0)
  assert.ok(calls.logs.some(([level, message]) => level === 'warn' && message.includes('tools registry')))
})

test('disposal withdraws the route registration', async () => {
  const { ctx, calls } = fakeContext()
  apply(ctx, { routes: { 'opencode-free': { local: { autoStart: false } } } })
  await settled(() => calls.adapters.length > 0)

  for (const dispose of calls.disposers) dispose()
  assert.equal(calls.disposed, 1, 'the adapter registration handle was disposed')
})

test('a configuration update reconciles instead of stacking registrations', async () => {
  const { ctx, calls } = fakeContext()
  apply(ctx, { routes: { 'opencode-free': { local: { autoStart: false } } } })
  await settled(() => calls.adapters.length > 0)

  const listener = calls.listeners.find(([event]) => event === 'loader/volatile-update')[1]
  listener()
  await new Promise((resolve) => setTimeout(resolve, 50))

  assert.equal(calls.adapters.length, 1, 'an unchanged configuration reuses the mounted adapter')
})

test('a failed auto-start is reported and the route still mounts', async () => {
  const { ctx, calls } = fakeContext()
  apply(ctx, {
    routes: {
      'opencode-free': {
        local: {
          /* A closed port, so the supervisor really tries to start something;
           * the command cannot exist, so it fails at once and nothing is left
           * running on this machine. */
          serverURL: 'http://127.0.0.1:51987',
          autoStart: true,
          serverCommand: 'dsh-plugin-opencode-free-no-such-binary',
          startTimeoutMs: 300,
        },
      },
    },
  })
  await settled(() => calls.adapters.length > 0)

  /* Nothing starts at mount any more: the first discovery is what asks for a
   * server. The listing then fails against the closed port, which the page
   * reports; here only the supervisor's own line matters. */
  await calls.discovery[0].discover({ provider: 'opencode-free' }).catch(() => {})

  assert.equal(calls.adapters.length, 1, 'the route is registered regardless')
  assert.ok(
    calls.logs.some(([level, message]) => level === 'error' && /serve --hostname 127\.0\.0\.1 --port/.test(message)),
    'the failure names the command a human would run instead',
  )
})

test('mounting starts no server: only a user action asks for one', async () => {
  const { ctx, calls } = fakeContext()
  apply(ctx, {
    routes: {
      'opencode-free': {
        local: {
          serverURL: 'http://127.0.0.1:51987',
          autoStart: true,
          serverCommand: 'dsh-plugin-opencode-free-no-such-binary',
          startTimeoutMs: 300,
        },
      },
    },
  })
  await settled(() => calls.adapters.length > 0)
  await new Promise((resolve) => setTimeout(resolve, 500))

  /* This is the regression that took the desktop app down on a cold boot:
   * mounting ran inside Host startup, and spawning a process there raced the
   * window's own authentication. */
  assert.ok(!calls.logs.some(([, message]) => /serve --hostname/.test(message)), 'no start was attempted at mount')

  await calls.discovery[0].discover({ provider: 'opencode-free' }).catch(() => {})
  assert.ok(
    calls.logs.some(([level, message]) => level === 'error' && /serve --hostname 127\.0\.0\.1 --port/.test(message)),
    'the first discovery is what tries, and it says how to run the server by hand',
  )
})

test('a server that answers re-announces the route, so the picker rebuilds its catalog', async () => {
  /* The browser's model catalog is one snapshot per Host generation, and it is
   * rebuilt only on `llm/adapters-updated`. A user who opens the picker while
   * the server is down gets no group at all, and nothing else would ever tell
   * the client to ask again — so the plugin re-commits its routes. */
  const server = await fakeServer([{ id: 'deepseek-v4.1-flash-free', providerID: 'opencode' }])
  try {
    const { ctx, calls } = fakeContext()
    apply(ctx, { routes: { 'opencode-free': { local: { serverURL: server.origin, autoStart: false } } } })
    await settled(() => calls.adapters.length > 0)

    await calls.discovery[0].discover({ provider: 'opencode-free' })

    assert.deepEqual(calls.replacements, [['opencode-free']], 'the route was re-announced once')
    assert.ok(
      calls.logs.some(([level, message]) => level === 'info' && /re-announced "opencode-free"/.test(message)),
      'the log says why the picker is being told again',
    )
  } finally {
    await server.close()
  }
})

test('a route whose server is off and never started announces nothing', async () => {
  const { ctx, calls } = fakeContext()
  apply(ctx, { routes: { 'opencode-free': { local: { serverURL: 'http://127.0.0.1:51987', autoStart: false } } } })
  await settled(() => calls.adapters.length > 0)

  await calls.discovery[0].discover({ provider: 'opencode-free' }).catch(() => {})

  assert.deepEqual(calls.replacements, [], 'there is no new answer to make the picker read')
})

test('a refresh asks the port again, so a server closed by hand is noticed', async () => {
  /* The refresh button has to be a fresh question. A promise cached for the life
   * of the process turned it into a replay of the first answer: the page kept
   * saying "no models" after the user closed the server, and nothing could bring
   * it back short of an app restart. */
  const server = await fakeServer([{ id: 'deepseek-v4.1-flash-free', providerID: 'opencode' }])
  const { ctx, calls } = fakeContext()
  apply(ctx, { routes: { 'opencode-free': { local: { serverURL: server.origin, autoStart: false } } } })
  await settled(() => calls.adapters.length > 0)

  const first = await calls.discovery[0].discover({ provider: 'opencode-free' })
  assert.deepEqual(first.map((row) => row.id), ['deepseek-v4.1-flash-free'])

  await server.close()
  await assert.rejects(
    calls.discovery[0].discover({ provider: 'opencode-free' }),
    'the second ask really asks instead of replaying the first answer',
  )
  const notices = calls.logs.filter(([level, message]) => level === 'warn' && /nothing answers/.test(message))
  assert.equal(notices.length, 1, 'the supervisor probed again and found the port empty')
})

test('a refresh attempts the start again when the server is gone', async () => {
  const { ctx, calls } = fakeContext()
  apply(ctx, {
    routes: {
      'opencode-free': {
        local: {
          serverURL: 'http://127.0.0.1:51987',
          autoStart: true,
          serverCommand: 'dsh-plugin-opencode-free-no-such-binary',
          startTimeoutMs: 300,
        },
      },
    },
  })
  await settled(() => calls.adapters.length > 0)

  await calls.discovery[0].discover({ provider: 'opencode-free' }).catch(() => {})
  await calls.discovery[0].discover({ provider: 'opencode-free' }).catch(() => {})

  const attempts = calls.logs.filter(([level, message]) =>
    level === 'error' && /was started but/.test(message))
  assert.equal(attempts.length, 2, 'each ask tries to start again instead of replaying the first failure')
})

test("the picker's failed listing is reported once, and the picker still gets a list", async () => {
  const { ctx, calls } = fakeContext()
  apply(ctx, { routes: { 'opencode-free': { local: { serverURL: 'http://127.0.0.1:51987', autoStart: false } } } })
  await settled(() => calls.adapters.length > 0)

  const adapter = calls.adapters[0].adapter
  const first = await adapter.listModels('opencode-free')
  const second = await adapter.listModels('opencode-free')

  assert.deepEqual([first.length, second.length], [0, 0], 'a dead server yields no rows, not a throw')
  const reported = calls.logs.filter(([level, message]) => level === 'warn' && /model picker could not list/.test(message))
  assert.equal(reported.length, 1, 'the reason is said once, not on every refresh')
  assert.match(reported[0][1], /not reachable|ECONNREFUSED|failed/i)
})
