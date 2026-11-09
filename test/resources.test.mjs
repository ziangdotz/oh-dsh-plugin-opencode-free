import assert from 'node:assert/strict'
import { test } from 'node:test'
import { acquireTurn, scheduleCleanup, MAX_PROMPT_BYTES, MAX_EVENT_BYTES } from '../lib/local/resources.js'
import { serializeConversation } from '../lib/local/serialize.js'
import { readEvents } from '../lib/local/server.js'
import { readCatalog, resolveRoute, routeFingerprint } from '../lib/config.js'
import { createLocalAdapter } from '../lib/local/adapter.js'

test('origin queue serializes adapters, bounds waiting work, and cancels without occupying a slot', async () => {
  const release = await acquireTurn('queue-test')
  const controller = new AbortController()
  const cancelled = acquireTurn('queue-test', controller.signal)
  const queued = Array.from({ length: 7 }, () => acquireTurn('queue-test'))
  await assert.rejects(acquireTurn('queue-test'), /queue is full/)
  controller.abort()
  await assert.rejects(cancelled, /cancelled/)
  const other = await acquireTurn('other-origin')
  other()
  release()
  for (const pending of queued) (await pending)()
  // No stale busy state remains after the final release.
  ;(await acquireTurn('queue-test'))()
})

test('prompt cap uses UTF-8 bytes and rejects oversized histories', () => {
  assert.throws(() => serializeConversation({ system: '中'.repeat(MAX_PROMPT_BYTES / 3) }), /exceeds/)
  assert.throws(() => serializeConversation({ messages: Array.from({ length: 4 }, () => ({
    role: 'user', content: [{ type: 'text', text: 'a'.repeat(MAX_PROMPT_BYTES / 3) }],
  })) }), /exceeds/)
})

test('SSE parser cancels an oversized unterminated line', async () => {
  let cancelled = false
  const stream = new ReadableStream({
    start (controller) { controller.enqueue(new TextEncoder().encode('x'.repeat(MAX_EVENT_BYTES + 1))) },
    cancel () { cancelled = true },
  })
  const iterator = readEvents({ terminalTimeoutMs: 1000 }, new Response(stream))
  await assert.rejects(iterator.next(), /SSE line exceeds/)
  assert.equal(cancelled, true)
})

test('session cleanup retries, reports exhaustion, and continues draining', async () => {
  let attempts = 0
  const warnings = []
  await scheduleCleanup({ run: async () => ++attempts >= 3, warn: (s) => warnings.push(s) })
  assert.equal(attempts, 3)
  assert.deepEqual(warnings, [])
  await scheduleCleanup({ run: async () => false, warn: (s) => warnings.push(s) })
  assert.match(warnings[0], /failed after 3 attempts/)
  let drained = false
  await scheduleCleanup({ run: async () => { drained = true; return true }, warn: assert.fail })
  assert.equal(drained, true)
})

test('catalog settings participate in reconciliation; disabling discovery makes no network call', async () => {
  const route = resolveRoute('r', {})
  route.catalog = readCatalog({ catalog: { autoDiscover: false } })
  const adapter = createLocalAdapter(route, route.local)
  assert.deepEqual(await adapter.listModels('r'), [])
  const original = routeFingerprint(route)
  route.catalog = { ...route.catalog, autoDiscover: true }
  assert.notEqual(routeFingerprint(route), original)
  const enabled = routeFingerprint(route)
  route.catalog = { ...route.catalog, exclude: ['another'], maxAgeMs: 1 }
  assert.notEqual(routeFingerprint(route), enabled)
})
