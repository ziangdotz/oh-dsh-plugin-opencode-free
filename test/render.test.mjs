/**
 * Render the browser surfaces for real, with a minimal hook runtime.
 *
 * The previous version of this suite rendered each component once, before its
 * async load could resolve, so the part that actually crashed — the table body,
 * which only runs when rows exist — was never executed. It reported a healthy
 * page for a page that threw on every real load.
 *
 * This runtime keeps state per component identity, runs effects, re-renders while
 * state settles, and therefore walks the same code a browser would.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

/** The listing a fake Host answers with. */
const ROWS = [
  { id: 'big-pickle', name: 'Big Pickle', free: false },
  { id: 'deepseek-v4.1-flash-free', name: 'DeepSeek V4.1 Flash Free', free: true },
  { id: 'pulse-alpha-free', name: 'Pulse Alpha Free', free: true, contextWindow: 1048576, maxTokens: 131072 },
]

/**
 * A hook runtime: one state bucket per component, effects after each pass.
 * @returns the hooks object plus the render driver.
 */
function createRuntime () {
  const buckets = new Map()
  let current = undefined
  let cursor = 0
  let effects = []
  let dirty = false

  const bucketOf = () => {
    const key = current ?? 'anonymous'
    if (!buckets.has(key)) buckets.set(key, [])
    return buckets.get(key)
  }
  const slot = (index, initial) => {
    const bucket = bucketOf()
    if (!(index in bucket)) bucket[index] = initial
    return bucket
  }

  const hooks = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState (initial) {
      const index = cursor++
      const bucket = slot(index, typeof initial === 'function' ? initial() : initial)
      return [bucket[index], (next) => {
        bucket[index] = typeof next === 'function' ? next(bucket[index]) : next
        dirty = true
      }]
    },
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useRef (value) {
      const index = cursor++
      const bucket = slot(index, { current: value })
      return bucket[index]
    },
    useEffect (fn) { effects.push(fn) },
  }

  /**
   * Render one component, running its effects and re-rendering while state moves.
   * @param component - the component function.
   * @param props - its props.
   * @param rounds - how many settle passes to allow.
   * @returns the last tree it produced.
   */
  const render = async (component, props, rounds = 4) => {
    let tree
    for (let round = 0; round <= rounds; round += 1) {
      current = component
      cursor = 0
      dirty = false
      tree = component(props)
      const run = effects
      effects = []
      for (const effect of run) effect()
      await new Promise((resolve) => setTimeout(resolve, 15))
      if (!dirty && run.length === 0) break
    }
    return tree
  }

  /**
   * Render once, without running effects or resetting state, so a test can read
   * the tree a click produced. Effects would start a second load and mask it.
   *
   * @param component - the component function.
   * @param props - its props.
   * @returns the tree this pass produced.
   */
  const renderNow = (component, props) => {
    current = component
    cursor = 0
    return component(props)
  }

  return { hooks, render, renderNow }
}

/** Wait a real moment; the control's busy window is wall-clock based. */
function sleep (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Find the first element in an expanded tree that satisfies a predicate.
 * @param node - the tree root.
 * @param predicate - the test.
 * @param depth - recursion guard.
 * @returns the element, or undefined.
 */
function findBy (node, predicate, depth = 0) {
  if (depth > 60 || node === null || typeof node !== 'object') return undefined
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findBy(child, predicate, depth + 1)
      if (hit !== undefined) return hit
    }
    return undefined
  }
  if (node.type === 'style') return undefined
  if (typeof node.type === 'function') return findBy(node.type(node.props ?? {}), predicate, depth + 1)
  if (predicate(node)) return node
  return findBy(node.children, predicate, depth + 1)
}

/** Whether one element is the page's 36px refresh button. */
function isRefreshButton (node) {
  return node.type === 'button'
    && typeof node.props?.className === 'string'
    && node.props.className.includes('ocf-button')
}

/** Flatten a tree into visible strings, rendering component elements. */
function textOf (node, render, out = [], depth = 0) {
  if (depth > 60 || node === null || node === undefined || node === false || node === true) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const child of node) textOf(child, render, out, depth + 1); return out }
  if (typeof node === 'object') {
    if (node.type === 'style') return out
    if (typeof node.type === 'function') {
      /* A nested component is rendered synchronously, with its own hook bucket,
       * because its output is what the user sees. */
      const element = node.type(node.props ?? {})
      textOf(element, render, out, depth + 1)
      return out
    }
    textOf(node.children, render, out, depth + 1)
  }
  return out
}

/**
 * Load the browser artifact and apply it to a recording context.
 * @returns the registered surfaces and the runtime.
 */
function mount (options = {}) {
  const source = readFileSync('client.js', 'utf8')
  let definition
  vm.createContext(
    (globalThis.__clientSandbox = {
      window: { __ModuleLoader__: { load: (value) => { definition = value } } },
      console,
      setTimeout,
      clearTimeout,
    }),
  )
  vm.runInContext(source, globalThis.__clientSandbox, { filename: 'client.js' })

  const runtime = createRuntime()
  const plugin = definition.factory(() => runtime.hooks)
  const registered = []
  const reply = options.reply !== undefined
    ? options.reply
    : (options.rows !== undefined ? options.rows : ROWS)
  const ctx = {
    slots: {
      inject: (name, callback) => { callback() },
      register: (options, entry) => { registered.push({ options, component: entry }) },
    },
    locale: {
      register: () => () => {},
      bind: () => (key) => key,
      getSnapshot: () => ({ revision: 0 }),
      subscribe: () => () => {},
    },
    remote: {
      llm: {
        discoverModels: options.failDiscovery === true
          ? async () => { throw new Error('fetch failed') }
          : async () => ({ ok: true, value: reply }),
      },
    },
    effect: (fn) => fn(),
    on: () => () => {},
    get: () => undefined,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  }
  plugin.apply(ctx)
  return { registered, runtime }
}

/**
 * Strip the thin registration wrapper: the component that owns the hooks is the
 * one inside it.
 * @param component - a registered component (wrapper or real one).
 * @param props - its props.
 * @returns the component to render and the props it expects.
 */
function leafOf (component, props) {
  const node = component(props)
  if (node !== null && typeof node === 'object' && typeof node.type === 'function') {
    return { component: node.type, props: node.props ?? {} }
  }
  return { component, props }
}

/** The props a settings surface receives. */
function surfaceProps (t) {
  return {
    t,
    provider: { providerId: 'opencode-free', displayName: 'OpenCode Free' },
    locale: { language: 'en' },
    discover: async () => ROWS,
    probe: async () => ROWS,
  }
}

test('the settings page lists every model the Host reports', async () => {
  const { registered, runtime } = mount()
  const section = registered.find((entry) => entry.options.name === 'settings.section')
  assert.ok(section !== undefined, 'the section is registered')

  const leaf = leafOf(section.component, surfaceProps((key) => key))
  const tree = await runtime.render(leaf.component, leaf.props)
  const text = textOf(tree, runtime.render)

  for (const row of ROWS) {
    assert.ok(text.includes(row.id), `the table shows ${row.id}`)
    assert.ok(text.includes(row.name), `the table shows the name of ${row.id}`)
  }
  assert.ok(text.includes('Model id') && text.includes('Tier'), 'the table has its column headings')
  assert.ok(text.includes('1048576') && text.includes('131072'), 'the table shows the reported context and output limits')
  assert.ok(text.includes('free') || text.includes('other'), 'the tier column is filled')
  assert.ok(text.some((line) => /model\(s\)/.test(line)), 'the page states how many models it found')
})

test('a failing discovery is reported on the page instead of rendering nothing', async () => {
  const { registered, runtime } = mount({ failDiscovery: true })
  const section = registered.find((entry) => entry.options.name === 'settings.section')
  const props = surfaceProps((key) => key)

  const leaf = leafOf(section.component, props)
  const tree = await runtime.render(leaf.component, leaf.props)
  const text = textOf(tree, runtime.render)
  assert.ok(
    text.some((line) => line.includes('Failed:') || line.includes('fetch failed')),
    `the page states the failure: ${JSON.stringify(text).slice(0, 300)}`,
  )
})

test('the provider card reports what the server serves', async () => {
  const { registered, runtime } = mount()
  const card = registered.find((entry) => entry.options.name === 'settings.models.provider-card')
  assert.ok(card !== undefined, 'the card is registered')

  const leaf = leafOf(card.component, surfaceProps((key) => key))
  const tree = await runtime.render(leaf.component, leaf.props)
  const text = textOf(tree, runtime.render)
  assert.ok(text.includes('Models served'), `the card names its capability: ${JSON.stringify(text).slice(0, 300)}`)
  assert.ok(
    text.some((line) => /model\(s\)/.test(line) || line.includes('No model reported')),
    `the card reports a count: ${JSON.stringify(text).slice(0, 200)}`,
  )
})

test('neither surface throws when the server answers with rows', async () => {
  const { registered, runtime } = mount()
  for (const { options, component } of registered) {
    const leaf = leafOf(component, surfaceProps((key) => key))
    const tree = await runtime.render(leaf.component, leaf.props)
    assert.doesNotThrow(() => textOf(tree, runtime.render), `${options.name} renders`)
  }
})

test('the page states when it last asked the server', async () => {
  const { registered, runtime } = mount()
  const section = registered.find((entry) => entry.options.name === 'settings.section')
  const leaf = leafOf(section.component, surfaceProps((key) => key))
  const tree = await runtime.render(leaf.component, leaf.props)
  const text = textOf(tree, runtime.render)

  assert.ok(text.some((line) => /model\(s\)/.test(line)), 'the count line survives the redesign')
  assert.ok(text.some((line) => /Updated \d{1,2}:\d{2}:\d{2}/.test(line)),
    `a successful listing records when it was taken: ${JSON.stringify(text).slice(0, 400)}`)
  assert.ok(!text.some((line) => line.includes('Loading')), 'the loading posture is gone once rows arrived')
})

test('an empty listing names the command to run instead of showing a bare table', async () => {
  const { registered, runtime } = mount({ rows: [] })
  const section = registered.find((entry) => entry.options.name === 'settings.section')
  const leaf = leafOf(section.component, surfaceProps((key) => key))
  const tree = await runtime.render(leaf.component, leaf.props)
  const text = textOf(tree, runtime.render)

  assert.ok(text.some((line) => line.includes('reported no model')),
    `the empty state has its own copy: ${JSON.stringify(text).slice(0, 400)}`)
  assert.ok(text.some((line) => line.includes('`opencode serve`')), 'the empty state names the command to run')
  assert.ok(!text.some((line) => line === 'Model id'), 'no empty table is drawn under it')
  assert.ok(text.some((line) => line.includes('No model reported')), 'the count line states that no model was reported')
})

test('the refresh control keeps saying "working" long enough to be seen', async () => {
  const { registered, runtime } = mount()
  const section = registered.find((entry) => entry.options.name === 'settings.section')
  const leaf = leafOf(section.component, surfaceProps((key) => key))

  /* Let the automatic first load finish, so the click starts from idle. */
  await runtime.render(leaf.component, leaf.props)
  await sleep(700)

  const idle = runtime.renderNow(leaf.component, leaf.props)
  const idleButton = findBy(idle, isRefreshButton)
  assert.ok(idleButton !== undefined, 'the page has a refresh button')
  assert.equal(idleButton.props['aria-busy'], 'false', 'it starts idle')

  idleButton.props.onClick()
  const clicked = runtime.renderNow(leaf.component, leaf.props)
  assert.equal(findBy(clicked, isRefreshButton).props['aria-busy'], 'true',
    'a click marks the control busy on the spot, before the Host answers')

  /* The Host answers a warm listing in a few milliseconds. Without a floor the
   * control would be idle again before a frame painted, which is the click that
   * looked ignored; the assertion is therefore about time, not about the answer. */
  await sleep(80)
  const during = runtime.renderNow(leaf.component, leaf.props)
  assert.equal(findBy(during, isRefreshButton).props['aria-busy'], 'true',
    'it is still busy well after the round trip')

  await sleep(700)
  const after = runtime.renderNow(leaf.component, leaf.props)
  assert.equal(findBy(after, isRefreshButton).props['aria-busy'], 'false', 'and it settles back to idle')
})

test('an unrecognized reply is its own state, not an empty catalog', async () => {
  const { registered, runtime } = mount({ reply: { unexpected: true } })
  const section = registered.find((entry) => entry.options.name === 'settings.section')
  const leaf = leafOf(section.component, surfaceProps((key) => key))
  const tree = await runtime.render(leaf.component, leaf.props)
  const text = textOf(tree, runtime.render)

  assert.ok(text.some((line) => line.includes('does not recognize')),
    `a changed envelope is reported as such: ${JSON.stringify(text).slice(0, 400)}`)
  assert.ok(!text.some((line) => line.includes('reported no model')), 'it does not read as "the server has no models"')
})
