/**
 * The server listing parser.
 *
 * The local API is the only catalog source now, so these cover the shapes it has
 * answered with and the admission rule the route applies on top.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { admitCatalog, displayNameOf, isFreeModelId, parseModelListing } from '../lib/catalog.js'

test('a data envelope of rows is parsed in order', () => {
  const rows = parseModelListing({
    data: [
      { id: 'deepseek-v4.1-flash-free', providerID: 'opencode', name: 'DeepSeek V4.1' },
      { id: 'glm-5.3-flash-free', providerID: 'opencode' },
    ],
  })
  assert.deepEqual(rows.map((row) => row.id), ['deepseek-v4.1-flash-free', 'glm-5.3-flash-free'])
  assert.equal(rows[0].name, 'DeepSeek V4.1')
  assert.equal(rows[1].name, 'GLM 5.3 Flash (Free)', 'a row without a name gets a readable one')
  assert.equal(rows[0].free, true)
})

test('a bare array and a keyed map are both accepted', () => {
  assert.deepEqual(parseModelListing([{ id: 'a-free' }]).map((row) => row.id), ['a-free'])
  assert.deepEqual(parseModelListing({ 'a-free': { providerID: 'opencode' } }).map((row) => row.id), ['a-free'])
})

test('rows are filtered to the provider that serves them', () => {
  const rows = parseModelListing({
    data: [
      { id: 'mine-free', providerID: 'opencode' },
      { id: 'theirs-free', providerID: 'other' },
    ],
  }, 'opencode')
  assert.deepEqual(rows.map((row) => row.id), ['mine-free'])
})

test('a duplicate id is listed once', () => {
  const rows = parseModelListing({ data: [{ id: 'a-free' }, { id: 'a-free' }] })
  assert.equal(rows.length, 1)
})

test('an unrecognizable payload yields no rows instead of a wrong one', () => {
  assert.deepEqual(parseModelListing(undefined), [])
  assert.deepEqual(parseModelListing(null), [])
  assert.deepEqual(parseModelListing({ nothing: 'here' }), [])
})

test('admission drops excluded ids and, by default, non-free ones', () => {
  const rows = parseModelListing({
    data: [
      { id: 'a-free' },
      { id: 'b-paid' },
      { id: 'test' },
    ],
  })
  assert.deepEqual(admitCatalog(rows, { includeNonFree: false, exclude: ['test'] }).map((row) => row.id), ['a-free'])
  assert.deepEqual(admitCatalog(rows, { includeNonFree: true, exclude: ['test'] }).map((row) => row.id), ['a-free', 'b-paid'])
})

test('display names keep vendor spelling and mark the free tier', () => {
  assert.equal(displayNameOf('deepseek-v4.1-flash-free'), 'DeepSeek V4.1 Flash (Free)')
  assert.equal(displayNameOf('nemotron-3.5-super-vl-free'), 'Nemotron 3.5 Super VL (Free)')
  assert.equal(displayNameOf('big-pickle'), 'Big Pickle')
  assert.equal(isFreeModelId('x-free'), true)
  assert.equal(isFreeModelId('x-paid'), false)
})
