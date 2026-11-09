/**
 * Route and catalog resolution.
 *
 * The configuration surface is one transport now, so these assert the defaults a
 * bare row gets, the password lookup, and the stability the reconciler relies on.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  DEFAULT_ROUTE_ID,
  DEFAULT_SERVER_URL,
  readCatalog,
  readLocalPassword,
  readLocalSettings,
  readRoutes,
  resolveRoute,
  routeFingerprint,
} from '../lib/config.js'

test('an empty configuration means one built-in route at the default origin', () => {
  const routes = readRoutes({})
  assert.deepEqual(Object.keys(routes), [DEFAULT_ROUTE_ID])
  const route = resolveRoute(DEFAULT_ROUTE_ID, {})
  assert.equal(route.baseURL, DEFAULT_SERVER_URL)
  assert.match(route.local.serverURL, /^http:\/\/127\.0\.0\.1:\d+$/)
  assert.equal(route.displayName, 'OpenCode Free')
  assert.equal(route.local.providerID, 'opencode')
  assert.equal(route.local.password, undefined)
  assert.equal(route.local.promptTimeoutMs, 10000)
  assert.equal(route.local.terminalTimeoutMs, 120000)
  assert.equal(route.local.serverCommand, 'opencode')
  assert.equal(readLocalSettings({ local: { serverCommand: 'custom-opencode' } }).serverCommand, 'custom-opencode')
  assert.deepEqual(route.configuredModels, [])
})

test('a configured route overrides the display name, origin and deadlines', () => {
  const route = resolveRoute('mine', {
    displayName: 'My Local',
    local: { serverURL: 'http://127.0.0.1:5000/', password: 'p', promptTimeoutMs: 500, terminalTimeoutMs: 900 },
    models: [{ id: 'a-free', name: 'A', contextWindow: 8000, maxTokens: 1000 }],
  })
  assert.equal(route.displayName, 'My Local')
  assert.equal(route.baseURL, 'http://127.0.0.1:5000', 'a trailing slash is trimmed')
  assert.equal(route.local.promptTimeoutMs, 500)
  assert.equal(route.local.terminalTimeoutMs, 900)
  assert.deepEqual(route.configuredModels, [{ id: 'a-free', name: 'A', contextWindow: 8000, maxTokens: 1000 }])
})

test('model entries without an id are dropped rather than trusted', () => {
  const route = resolveRoute('mine', { models: [{ name: 'no id' }, { id: 'ok-free' }] })
  assert.deepEqual(route.configuredModels.map((model) => model.id), ['ok-free'])
})

test('the password comes from the row first, then from the named environment', () => {
  assert.equal(readLocalPassword({ password: 'literal' }), 'literal')

  const previous = process.env.OPENCODE_SERVER_PASSWORD
  process.env.OPENCODE_SERVER_PASSWORD = 'from-env'
  try {
    assert.equal(readLocalPassword({}), 'from-env')
    assert.equal(readLocalPassword({ passwordEnv: 'SOME_OTHER_VARIABLE' }), undefined, 'a named variable overrides the default one')
    assert.equal(readLocalSettings({}).password, 'from-env')
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_SERVER_PASSWORD
    else process.env.OPENCODE_SERVER_PASSWORD = previous
  }
})

test('the catalog section defaults to free models only', () => {
  const catalog = readCatalog({})
  assert.equal(catalog.autoDiscover, true)
  assert.equal(catalog.includeNonFree, false, 'this route is the free tier; a paid id needs an explicit opt-in')
  assert.ok(catalog.maxAgeMs > 0)
  assert.ok(catalog.timeoutMs > 0)
  assert.deepEqual(catalog.exclude, ['test'])
  assert.equal(readCatalog({ catalog: { includeNonFree: true } }).includeNonFree, true, 'a deployment may opt in')
  assert.equal(readCatalog({ catalog: { includeNonFree: false } }).includeNonFree, false)
})

test('the fingerprint changes when a wire fact changes and not otherwise', () => {
  const a = routeFingerprint(resolveRoute('r', { local: { serverURL: 'http://127.0.0.1:4399' } }))
  const same = routeFingerprint(resolveRoute('r', { local: { serverURL: 'http://127.0.0.1:4399' } }))
  const moved = routeFingerprint(resolveRoute('r', { local: { serverURL: 'http://127.0.0.1:5000' } }))
  const renamed = routeFingerprint(resolveRoute('r', { displayName: 'Other', local: { serverURL: 'http://127.0.0.1:4399' } }))
  assert.equal(a, same)
  assert.notEqual(a, moved)
  assert.notEqual(a, renamed)
})
