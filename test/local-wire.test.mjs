/**
 * The `opencode-free` transport against a fake local OpenCode server.
 *
 * The fake implements the endpoints this transport uses and enforces the same
 * contract a live `opencode serve` 1.18.x was measured to have (recorded in
 * `docs/VERIFICATION.md`): HTTP Basic credentials with the username `opencode`,
 * a global unnamed-event SSE stream at `/api/event` whose payloads carry
 * `{ type, data }`, `{ text }` on `/prompt`, and `{ prompt }` on `/generate`.
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'

import { resolveRoute } from '../lib/config.js'
import { createLocalAdapter } from '../lib/local/adapter.js'
import { serializeConversation } from '../lib/local/serialize.js'
import { readEvents } from '../lib/local/server.js'

/** Drain an async iterable into an array. */
async function collect (iterable) {
  const out = []
  for await (const chunk of iterable) out.push(chunk)
  return out
}

test('a terminal event can close the iterator while SSE cancellation is still pending', async () => {
  let releaseCancellation
  let cancellationStarted = false
  const stream = new ReadableStream({
    start (controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"session.execution.succeeded"}\n\n'))
    },
    cancel () {
      cancellationStarted = true
      return new Promise((resolve) => { releaseCancellation = resolve })
    },
  })
  const events = readEvents({ terminalTimeoutMs: 1000 }, new Response(stream))
  assert.equal((await events.next()).value.type, 'session.execution.succeeded')
  let timer
  try {
    const result = await Promise.race([
      events.return(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('iterator waited for SSE cancellation')), 500)
      }),
    ])
    assert.equal(result.done, true)
    assert.equal(cancellationStarted, true)
  } finally {
    clearTimeout(timer)
    releaseCancellation?.()
  }
})

/** Wait until a predicate holds, so fire-and-forget cleanup can be observed. */
async function waitFor (predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return predicate()
}

/** The Basic header a password produces. */
function basic (password) {
  return `Basic ${Buffer.from(`opencode:${password}`, 'utf8').toString('base64')}`
}

/** One event for this session, shaped like the live server's. */
function event (type, data, sessionID = 'sess-1') {
  return { id: `evt_${type}`, created: Date.now(), type, data: { sessionID, ...data } }
}

/**
 * Start a fake OpenCode server.
 *
 * @param options.password - when set, requests must carry matching Basic credentials.
 * @param options.events - events to write once the prompt arrives.
 * @param options.eventStatus - refuse `/api/event` with this status (fallback test).
 * @param options.generate - what `generate` answers.
 * @param options.holdOpen - leave the event stream open after the events.
 * @returns the origin, request log, observable state and `close`.
 */
async function fakeServer (options = {}) {
  const requests = []
  let releaseEvents
  const prompted = new Promise((resolve) => { releaseEvents = resolve })
  const state = { sessionBody: undefined, promptBody: undefined, generateBody: undefined, interrupted: false }

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    requests.push({ method: request.method, path: url.pathname, authorization: request.headers.authorization })

    const authorized = options.password === undefined || request.headers.authorization === basic(options.password)
    if (!authorized) {
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ _tag: 'UnauthorizedError', message: 'Authentication required' }))
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/session') {
      let body = ''
      request.on('data', (chunk) => { body += chunk })
      request.on('end', () => {
        state.sessionBody = JSON.parse(body)
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ data: { id: 'sess-1' } }))
      })
      return
    }

    if (request.method === 'GET' && url.pathname === '/api/event') {
      response.on('close', () => { state.eventClosed = true })
      if (options.eventStatus !== undefined) {
        response.writeHead(options.eventStatus, { 'content-type': 'application/json' })
        response.end('{"message":"refused"}')
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      void prompted.then(async () => {
        for (const item of options.events ?? []) {
          response.write(`data: ${JSON.stringify(item)}\n\n`)
          await new Promise((resolve) => setTimeout(resolve, 5))
        }
        if (options.holdOpen !== true) response.end()
      })
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/session/sess-1/prompt') {
      let body = ''
      request.on('data', (chunk) => { body += chunk })
      request.on('end', () => {
        state.promptBody = JSON.parse(body)
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end('{}')
        releaseEvents()
      })
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/session/sess-1/generate') {
      let body = ''
      request.on('data', (chunk) => { body += chunk })
      request.on('end', () => {
        state.generateBody = JSON.parse(body)
        const reply = options.generate ?? { data: { text: 'generated' } }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(reply))
      })
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/session/sess-1/interrupt') {
      state.interrupted = true
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{}')
      return
    }

    if (request.method === 'DELETE' && url.pathname === '/api/session/sess-1') {
      state.deleted = (state.deleted ?? 0) + 1
      response.writeHead(options.deleteStatus ?? 204)
      response.end()
      return
    }

    response.writeHead(404)
    response.end()
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    requests,
    state,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve) }),
  }
}

test('consumer return closes SSE, interrupts execution, and deletes its session', async () => {
  const server = await fakeServer({
    events: [{ type: 'session.text.delta', data: { sessionID: 'sess-1', delta: 'partial' } }],
    holdOpen: true,
  })
  try {
    const stream = adapterFor(server.origin).stream(request())
    assert.equal((await stream.next()).value.type, 'block-start')
    await stream.return()
    assert.equal(server.state.interrupted, true)
    assert.equal(server.state.deleted, 1)
    assert.ok(await waitFor(() => server.state.eventClosed))
  } finally { await server.close() }
})

test('total turn deadline cancels a live SSE connection and reports TIMEOUT', async () => {
  const server = await fakeServer({
    events: [{ type: 'session.text.delta', data: { sessionID: 'sess-1', delta: 'partial' } }],
    holdOpen: true,
  })
  try {
    const chunks = await collect(adapterFor(server.origin, { terminalTimeoutMs: 80 }).stream(request()))
    assert.equal(chunks.at(-1).reason.kind, 'error')
    assert.equal(chunks.at(-1).reason.failure.code, 'TIMEOUT')
    assert.equal(server.state.interrupted, true)
    assert.equal(server.state.deleted, 1)
    assert.ok(await waitFor(() => server.state.eventClosed))
  } finally { await server.close() }
})

test('oversized tool output fails explicitly, then cleans up', async () => {
  const server = await fakeServer({ events: [
    { type: 'session.tool.success', data: { sessionID: 'sess-1', id: 'large-tool', content: [{ type: 'text', text: 'a'.repeat(256 * 1024 + 1) }] } },
  ] })
  try {
    const chunks = await collect(adapterFor(server.origin).stream(request()))
    assert.match(chunks.at(-1).reason.failure.message, /tool result exceeds/)
    assert.equal(server.state.deleted, 1)
  } finally { await server.close() }
})

test('failed deletion retries three times and logs exhaustion; missing session is success', async () => {
  for (const status of [500, 404]) {
    const warnings = []
    const server = await fakeServer({ deleteStatus: status, events: [
      { type: 'session.text.delta', data: { sessionID: 'sess-1', delta: 'ok' } },
      { type: 'session.execution.succeeded', data: { sessionID: 'sess-1' } },
    ] })
    try {
      const route = localRoute(server.origin)
      const adapter = createLocalAdapter(route, route.local, { onCleanupFailed: (message) => warnings.push(message) })
      const chunks = await collect(adapter.stream(request()))
      assert.equal(chunks.at(-1).reason.kind, 'stop')
      assert.equal(server.state.deleted, status === 500 ? 3 : 1)
      assert.equal(warnings.length, status === 500 ? 1 : 0)
    } finally { await server.close() }
  }
})

/** A resolved route pointing at one origin, with optional `local` overrides. */
function localRoute (origin, local = {}) {
  return resolveRoute('opencode-free', {
    displayName: 'OpenCode Free',
    local: { serverURL: origin, providerID: 'opencode', ...local },
  })
}

/** One adapter wired to the route's own settings. */
function adapterFor (origin, local = {}) {
  const route = localRoute(origin, local)
  return createLocalAdapter(route, route.local)
}

/** The request one test sends. */
function request (extra = {}) {
  return {
    provider: 'opencode-local',
    model: 'deepseek-v4.1-flash-free',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    ...extra,
  }
}

test('a route resolves to the local server as its endpoint', () => {
  const route = localRoute('http://127.0.0.1:4399')
  assert.equal(route.baseURL, 'http://127.0.0.1:4399')
  assert.equal(route.local.serverURL, 'http://127.0.0.1:4399')
  assert.equal(route.local.providerID, 'opencode')
  assert.equal(route.local.promptTimeoutMs, 10000)
  assert.equal(route.local.terminalTimeoutMs, 120000)
  assert.equal(route.local.password, undefined, 'no password unless the row provides one')
  assert.equal(route.displayName, 'OpenCode Free')
})

test('the password comes from the row, or from the environment it names', () => {
  assert.equal(localRoute('http://127.0.0.1:4399', { password: 'row-secret' }).local.password, 'row-secret')

  const previous = process.env.OPENCODE_SERVER_PASSWORD
  process.env.OPENCODE_SERVER_PASSWORD = 'env-secret'
  try {
    assert.equal(localRoute('http://127.0.0.1:4399').local.password, 'env-secret')
    assert.equal(localRoute('http://127.0.0.1:4399', { passwordEnv: 'SOME_OTHER_NAME' }).local.password, undefined)
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_SERVER_PASSWORD
    else process.env.OPENCODE_SERVER_PASSWORD = previous
  }
})

test('the conversation is serialized into one labelled prompt', () => {
  const prompt = serializeConversation({
    system: 'be brief',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'assistant', content: [{ type: 'reasoning', text: 'hmm' }, { type: 'text', text: 'hi' }] },
      { role: 'user', content: [{ type: 'image', attachment: { mediaType: 'image/png' } }, { type: 'text', text: 'look' }] },
    ],
  })
  assert.equal(prompt, '[System]\nbe brief\n\n[User]\nhello\n\n[Assistant]\nhi\n\n[User]\n[image: image/png]\nlook')
  assert.ok(!prompt.includes('hmm'), 'reasoning is the model scratchpad, not conversation')
})

test('a turn streams text deltas and finishes on the execution-end event', async () => {
  const server = await fakeServer({
    events: [
      event('session.execution.started', {}),
      event('session.text.started', {}),
      event('session.text.delta', { delta: 'Hel' }),
      event('session.text.delta', { delta: 'lo' }),
      event('session.text.ended', { text: 'Hello' }),
      event('session.step.ended', { finish: 'stop', tokens: { input: 10, output: 2, reasoning: 0 } }),
      event('session.execution.succeeded', {}),
    ],
  })
  try {
    const chunks = await collect(adapterFor(server.origin).stream(request({ system: 'be brief' })))

    assert.deepEqual(chunks.map((chunk) => chunk.type), ['block-start', 'text-delta', 'text-delta', 'block-end', 'finish'])
    assert.equal(chunks[1].text + chunks[2].text, 'Hello')
    assert.deepEqual(chunks[3].block, { type: 'text', text: 'Hello' })
    assert.equal(chunks[4].reason.kind, 'stop')

    assert.deepEqual(server.state.sessionBody, { model: { id: 'deepseek-v4.1-flash-free', providerID: 'opencode' } })
    assert.deepEqual(server.state.promptBody, { text: '[System]\nbe brief\n\n[User]\nhi' })
  } finally {
    await server.close()
  }
})

test('tool steps keep streaming through to the final answer', async () => {
  const server = await fakeServer({
    events: [
      event('session.step.ended', { finish: 'tool-calls' }),
      event('session.tool.input.started', { id: 'call-a', name: 'bash' }),
      event('session.tool.called', { id: 'call-a', input: { command: 'echo hello' } }),
      event('session.tool.success', { id: 'call-a', content: [{ type: 'text', text: 'command output\n```' }] }),
      event('session.tool.success', { id: 'call-a', content: [{ type: 'text', text: 'duplicate' }] }),
      event('session.tool.input.started', { id: 'call-b', name: 'read' }),
      event('session.tool.failure', { id: 'call-b', error: 'missing file' }),
      event('session.tool.input.started', { id: 'call-c', name: 'write' }),
      event('session.tool.success', { id: 'call-c', content: [{ type: 'text', text: 'routine write details' }] }),
      event('session.text.delta', { delta: 'Done' }),
      event('session.text.ended', { text: 'Done.' }),
      event('session.execution.succeeded', {}),
    ],
  })
  try {
    const chunks = await collect(adapterFor(server.origin).stream(request()))
    const output = chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('')
    assert.ok(output.includes('**OpenCode · bash · Completed**\n\n````\n$ echo hello\n\ncommand output\n```\n````'))
    assert.ok(output.includes('**OpenCode · read · Failed**\n\n```\nmissing file'))
    assert.ok(!output.includes('duplicate'))
    assert.ok(!output.includes('routine write details'))
    assert.ok(output.endsWith('Done.'))
    assert.equal(chunks.at(-1).reason.kind, 'stop')
  } finally {
    await server.close()
  }
})

test('a tool-only turn keeps its result and explains the missing reply', async () => {
  const server = await fakeServer({
    events: [
      event('session.tool.success', { id: 'call-a', content: [{ type: 'text', text: 'saved' }] }),
      event('session.execution.succeeded', {}),
    ],
  })
  try {
    const chunks = await collect(adapterFor(server.origin).stream(request()))
    assert.match(chunks.find((chunk) => chunk.type === 'block-end').block.text, /saved[\s\S]+did not return a final reply/)
    assert.equal(chunks.at(-1).reason.kind, 'stop')
  } finally {
    await server.close()
  }
})

test('a turn with only successful file tools shows a concise completion summary', async () => {
  const server = await fakeServer({
    events: [
      event('session.tool.input.started', { id: 'call-a', name: 'read' }),
      event('session.tool.success', { id: 'call-a', content: [{ type: 'text', text: 'file contents' }] }),
      event('session.execution.succeeded', {}),
    ],
  })
  try {
    const chunks = await collect(adapterFor(server.origin).stream(request()))
    assert.match(chunks.find((chunk) => chunk.type === 'block-end').block.text, /^OpenCode completed 1 file operation/)
    assert.equal(chunks.at(-1).reason.kind, 'stop')
  } finally {
    await server.close()
  }
})

test('a turn waits for the server to be ready before it creates a session', async () => {
  const server = await fakeServer({
    events: [
      event('session.text.delta', { delta: 'ok' }),
      event('session.execution.succeeded', { finish: 'stop' }),
    ],
  })
  let release
  const ready = new Promise((resolve) => { release = resolve })
  const route = localRoute(server.origin)
  const adapter = createLocalAdapter(route, route.local, { ensureStarted: () => ready })
  try {
    const pending = collect(adapter.stream(request()))
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.equal(server.state.sessionBody, undefined, 'nothing is sent before the server reports ready')
    release()
    const chunks = await pending
    assert.equal(chunks.at(-1).reason.kind, 'stop')
    assert.deepEqual(server.state.sessionBody, { model: { id: 'deepseek-v4.1-flash-free', providerID: 'opencode' } })
  } finally {
    await server.close()
  }
})

test('a finished turn deletes the session it created', async () => {
  const server = await fakeServer({
    events: [
      event('session.text.delta', { delta: 'done' }),
      event('session.execution.succeeded', { finish: 'stop' }),
    ],
  })
  try {
    await collect(adapterFor(server.origin).stream(request()))
    /* Cleanup is fire-and-forget: the answer is already yielded, so the delete
     * may still be in flight when the generator ends. */
    assert.ok(await waitFor(() => server.state.deleted === 1),
      'the throwaway session is removed once the turn ends')
    assert.deepEqual(
      server.requests.filter((entry) => entry.method === 'DELETE').map((entry) => entry.path),
      ['/api/session/sess-1'],
      'exactly one delete, of this turn\'s session',
    )
  } finally {
    await server.close()
  }
})

test('a turn that failed still deletes its session', async () => {
  const server = await fakeServer({
    events: [
      event('session.text.delta', { delta: 'partial' }),
      event('session.step.failed', { message: 'provider exploded' }),
    ],
  })
  try {
    const chunks = await collect(adapterFor(server.origin).stream(request()))
    assert.equal(chunks.at(-1).reason.kind, 'error')
    assert.ok(await waitFor(() => server.state.deleted === 1),
      'a refused turn leaves no session behind either')
  } finally {
    await server.close()
  }
})

test('events belonging to another session are never mixed into the answer', async () => {
  const server = await fakeServer({
    events: [
      event('session.text.delta', { delta: 'WRONG' }, 'sess-other'),
      event('session.text.delta', { delta: 'mine' }),
      event('session.execution.succeeded', { finish: 'stop' }, 'sess-other'),
      event('session.execution.succeeded', { finish: 'stop' }),
    ],
  })
  try {
    const chunks = await collect(adapterFor(server.origin).stream(request()))
    const text = chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('')
    assert.equal(text, 'mine', 'the other session\'s delta must be filtered out')
    assert.equal(chunks.at(-1).reason.kind, 'stop')
  } finally {
    await server.close()
  }
})

test('a completed-text event is used only when no deltas arrived', async () => {
  const server = await fakeServer({
    events: [
      event('session.text.ended', { text: 'whole answer' }),
      event('session.execution.succeeded', { finish: 'stop' }),
    ],
  })
  try {
    const chunks = await collect(adapterFor(server.origin).stream(request()))
    assert.equal(chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join(''), 'whole answer')
    assert.equal(chunks.at(-1).reason.kind, 'stop')
  } finally {
    await server.close()
  }
})

test('a server that refuses the event stream still answers through generate', async () => {
  const server = await fakeServer({ eventStatus: 404, generate: { data: { text: 'from generate' } } })
  try {
    const chunks = await collect(adapterFor(server.origin).stream(request()))
    assert.deepEqual(chunks.map((chunk) => chunk.type), ['block-start', 'text-delta', 'block-end', 'finish'])
    assert.equal(chunks[1].text, 'from generate')
    assert.deepEqual(server.state.generateBody, { prompt: '[User]\nhi' })
  } finally {
    await server.close()
  }
})

test('the configured password is sent as Basic credentials', async () => {
  const server = await fakeServer({ password: 'pp-123', events: [event('session.text.delta', { delta: 'x' }), event('session.execution.succeeded', { finish: 'stop' })] })
  try {
    const chunks = await collect(adapterFor(server.origin, { password: 'pp-123' }).stream(request()))
    assert.equal(chunks.at(-1).reason.kind, 'stop')
    assert.equal(server.requests[0].authorization, basic('pp-123'))
  } finally {
    await server.close()
  }
})

test('a server that wants a password says so, and names the fix', async () => {
  const server = await fakeServer({ password: 'pp-123' })
  try {
    const chunks = await collect(adapterFor(server.origin).stream(request()))
    const finish = chunks.at(-1)
    assert.equal(finish.reason.kind, 'error')
    assert.equal(finish.reason.failure.code, 'INVALID_CREDENTIAL')
    assert.match(finish.reason.failure.message, /local\.password|OPENCODE_SERVER_PASSWORD/)
  } finally {
    await server.close()
  }
})

test('a failure event becomes a terminal error and interrupts the session', async () => {
  const server = await fakeServer({
    events: [
      event('session.text.delta', { delta: 'partial' }),
      event('session.step.failed', { message: 'model exploded' }),
    ],
  })
  try {
    const chunks = await collect(adapterFor(server.origin).stream(request()))
    const finish = chunks.at(-1)
    assert.equal(finish.reason.kind, 'error')
    assert.equal(finish.reason.failure.message, 'model exploded')
    assert.ok(await waitFor(() => server.state.interrupted), 'the session was interrupted on failure')
  } finally {
    await server.close()
  }
})

test('the caller abort interrupts the session', async () => {
  const server = await fakeServer({ holdOpen: true, events: [event('session.text.delta', { delta: 'partial' })] })
  try {
    const controller = new AbortController()
    const stream = adapterFor(server.origin, { terminalTimeoutMs: 200 }).stream(request({ signal: controller.signal }))
    const collected = (async () => {
      const chunks = []
      for await (const chunk of stream) chunks.push(chunk)
      return chunks
    })()
    setTimeout(() => controller.abort(), 80)

    const chunks = await collected
    assert.equal(chunks.at(-1).reason.kind, 'aborted', `unexpected finish ${JSON.stringify(chunks.at(-1))}`)
    assert.ok(await waitFor(() => server.state.interrupted), 'the session was interrupted after abort')
  } finally {
    await server.close()
  }
})

test('an unreachable server names the command that fixes it', async () => {
  const chunks = await collect(adapterFor('http://127.0.0.1:1').stream(request()))
  const finish = chunks.at(-1)
  assert.equal(finish.reason.kind, 'error')
  assert.match(finish.reason.failure.message, /opencode serve/, 'the error says how to start the server')
})
