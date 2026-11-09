/**
 * The browser half, checked without a browser.
 *
 * `client.js` is a plain module-loader artifact, so it can be evaluated in a
 * sandbox with a stub `window` and a stub `require`. That catches the failures
 * that would otherwise need a page reload to notice: a wrong loader id, a slot
 * registered under the wrong key, or an `apply` that throws on the services it
 * declares.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

/** Load `client.js` with a stub browser and return what it registered. */
function loadClient () {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const loaded = []
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load (definition) { loaded.push(definition) },
      },
    },
    navigator: { language: 'en-US' },
    console,
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'client.js' })
  assert.equal(loaded.length, 1, 'client.js registers exactly one module')
  return loaded[0]
}

/** React stub: the factory must not need a real renderer to be inspected. */
function reactStub () {
  const createElement = (type, props, ...children) => ({ type, props, children })
  const state = []
  return {
    createElement,
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    /* Present because the component memoizes the probe set; a stub missing a hook
       the component calls fails as `React.useMemo is not a function`, which is a
       stub bug masquerading as a page bug. */
    useMemo: (fn) => fn(),
    useRef: (value) => ({ current: value }),
    __state: state,
  }
}

/**
 * Expand function components so nested markup appears in the serialized tree.
 *
 * Without this, a child component's text is invisible to a test that only looks
 * at the element tree. Hooks are no-ops in the stub, so expansion is pure.
 *
 * @param node - an element, an array, or a leaf.
 * @returns the expanded tree.
 */
function expand (node) {
  if (node === null || node === undefined || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map(expand)
  const element = node
  if (typeof element.type === 'function') return expand(element.type(element.props))
  return {
    type: element.type,
    props: element.props,
    children: Array.isArray(element.children) ? element.children.map(expand) : element.children,
  }
}

/** The services the factory asks for, with recording doubles. */
function contextDouble () {
  const calls = { registers: [], injects: [], dicts: [], effects: [] }
  const ctx = {
    slots: {
      inject (name, factory) {
        calls.injects.push(name)
        factory()
      },
      register (options, component) {
        calls.registers.push({ options, component })
        return () => {}
      },
    },
    locale: {
      register (namespace, dictionaries) {
        calls.dicts.push({ namespace, dictionaries })
        return () => {}
      },
      /* The double resolves to the key itself, so assertions can prove that
         text goes through the locale service rather than a private table. */
      bind (namespace) {
        return (key) => `«${namespace}:${key}»`
      },
      getSnapshot () {
        return { active: 'en', locales: [], revision: 0 }
      },
      subscribe () {
        return () => {}
      },
      setLocale (id) {
        calls.setLocale = id
      },
    },
    remote: {
      /* Harness remotes answer envelopes, not bare values: `{ ok, value }`. The
         doubles match that shape, because reading the envelope as data is exactly
         the bug this suite exists to catch. */
      llm: { discoverModels: async () => ({ ok: true, value: [] }) },
      credentials: {
        describe: async () => ({ ok: true, value: {} }),
        set: async () => ({ ok: true }),
        unset: async () => ({ ok: true }),
      },
    },
    effect (callback, label) {
      calls.effect = true
      /* The label matters: a registration owned by a labelled effect is
         withdrawn with the plugin, and an unlabelled one used to leak. */
      calls.effects.push(label)
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
  }
  return { ctx, calls }
}

test('the artifact declares the package id the loader expects', () => {
  const definition = loadClient()
  assert.equal(definition.id, 'dsh-plugin-opencode-free')
  assert.equal(typeof definition.factory, 'function')
})

test('the factory asks only for services the harness provides', () => {
  const definition = loadClient()
  const plugin = definition.factory((specifier) => {
    assert.equal(specifier, 'react', 'the only baseline import is react')
    return reactStub()
  })
  /* Arrays created inside the vm realm carry that realm's prototypes, so they are
   copied into this realm before comparison. */
  assert.deepEqual([...plugin.inject], ['slots', 'locale', 'remote', 'remote.llm'], 'the credential remote is no longer needed: the local server brings its own identity')
  assert.equal(typeof plugin.apply, 'function')
})

test('apply registers the provider card and the models page', () => {
  const definition = loadClient()
  const { ctx, calls } = contextDouble()
  const plugin = definition.factory(() => reactStub())
  plugin.apply(ctx)

  /* Both option objects live in the vm realm, so they are read field by field. */
  assert.deepEqual([...calls.injects], ['settings.models.provider-card', 'settings.section'])
  assert.equal(calls.registers.length, 2)

  const card = calls.registers.find((entry) => entry.options.name === 'settings.models.provider-card')
  const section = calls.registers.find((entry) => entry.options.name === 'settings.section')
  assert.ok(card !== undefined, 'the provider card is registered')
  assert.ok(section !== undefined, 'the models page is registered')

  assert.equal(card.options.key, 'OpenCodeFree', 'the card key is the settings namespace (the row id) the Host answers')
  assert.equal(typeof card.component, 'function')

  assert.equal(section.options.id, 'opencode-free')
  assert.equal(section.options.order, 25)
  /* The nav label is a static product name, deliberately not localized: the
     settings rail is narrow (a Chinese label rendered as `OpenCode 免费…`), and a
     brand name is the surface's identity rather than translatable copy. */
  const label = typeof section.options.label === 'function' ? section.options.label() : section.options.label
  assert.equal(label, 'OpenCode Free', 'the nav label is the product name')
  assert.equal(typeof section.options.label, 'function',
    'a thunk, so the shell re-reads it after a locale switch without re-registering')
  assert.equal(typeof section.component, 'function')

  assert.equal(calls.dicts.length, 1, 'every dictionary registers in one call')
  assert.equal(calls.dicts[0].namespace, 'opencode-free')
  const { en: enDict, zh: zhDict } = calls.dicts[0].dictionaries
  assert.ok(Object.keys(enDict).length > 0)
  assert.deepEqual(Object.keys(enDict).sort(), Object.keys(zhDict).sort(), 'both locales carry the same key set')
  assert.ok(!('section.label' in enDict), 'the nav label is not a dictionary key: it is not localized')
})

test('apply survives a release without the locale service', () => {
  const definition = loadClient()
  const { ctx } = contextDouble()
  delete ctx.locale
  const plugin = definition.factory(() => reactStub())
  plugin.apply(ctx)
  assert.ok(true, 'a missing locale service does not throw')
})

test('the component renders key rows without a real renderer', () => {
  const definition = loadClient()
  const { ctx, calls } = contextDouble()
  const plugin = definition.factory(() => reactStub())
  plugin.apply(ctx)

  /* `apply` registers a thin wrapper that supplies the credential/discovery
     bridges, so the card is one element further down. */
  const card = calls.registers.find((entry) => entry.options.name === 'settings.models.provider-card')
  const wrapper = card.component({
    provider: { providerId: 'opencode-free', displayName: 'OpenCode Free' },
    configured: true,
    keyConfigured: false,
  })
  assert.equal(typeof wrapper.type, 'function')
  const element = wrapper.type(wrapper.props)
  assert.equal(element.type, 'div', 'a plain container: the Settings column owns the section layout')
  assert.equal(element.props['data-plugin'], 'dsh-plugin-opencode-free')
  const text = JSON.stringify(expand(element))
  assert.ok(text.includes('opencode-free:card.title'), 'the card has a title')
  assert.ok(text.includes('opencode-free:card.localNote'), 'the card says the local server brings its own identity')
  /* Before the first answer the card states a loading posture; the count and the
     empty state replace it once discovery resolves (test/render.test.mjs covers
     those two). */
  assert.ok(text.includes('opencode-free:page.loading'), 'the card shows a loading posture first')
  assert.ok(text.includes('opencode-free:card.refresh'), 'the refresh control is labelled for screen readers')
  assert.ok(!text.includes('OPENCODE_ZEN_API_KEY'), 'no credential reference survives: there is nothing to store')
  assert.ok(text.includes('--dsw-alias-'), 'styling uses harness theme tokens')
  assert.ok(text.includes('ocf-iconButton'), 'the refresh control is the 28px icon button the settings pages use')
  assert.ok(text.includes('"svg"'), 'the icon is drawn inline instead of typed as a glyph')
  assert.ok(text.includes('aria-busy'), 'the control reports whether it is working')
})

test('the models page renders its table shell', () => {
  const definition = loadClient()
  const { ctx, calls } = contextDouble()
  const plugin = definition.factory(() => reactStub())
  plugin.apply(ctx)

  const section = calls.registers.find((entry) => entry.options.name === 'settings.section')
  const wrapper = section.component({ close: () => {} })
  assert.equal(typeof wrapper.type, 'function')
  const element = wrapper.type(wrapper.props)
  assert.equal(element.type, 'div', 'a plain container: the Settings column owns the section layout')
  assert.equal(element.props['data-plugin'], 'dsh-plugin-opencode-free')

  const text = JSON.stringify(expand(element))
  assert.ok(text.includes('opencode-free:page.title'), 'the page heading goes through the locale namespace')
  assert.ok(!text.includes('section.label'), 'no raw locale key reaches the page')
  assert.ok(text.includes('opencode-free:page.column.id'), 'the table header goes through the locale namespace')
  assert.ok(text.includes('opencode-free:page.action.refresh'), 'the refresh control goes through the locale namespace')
  assert.ok(text.includes('--dsw-alias-'), 'styling uses harness theme tokens')
  assert.ok(text.includes('ocf-card'), 'the listing sits on the settings card surface')
  assert.ok(!text.includes('passwordHint'), 'the password hint line is not on the page')
  assert.ok(!text.includes('ocf-footer'), 'and no empty footer is left behind')
  assert.ok(text.includes('"role":"status"'), 'the count line is a status region, so a refresh is announced')
  assert.ok(text.includes('ocf-button'), 'refresh is a full page button with a 36px target')
  assert.ok(text.includes('ocf-button[aria-busy='),
    'a busy refresh keeps full contrast and a progress cursor instead of reading as disabled')
  /* docs/UI.md claims the stylesheet carries no literal colour; this is the check
     that makes the claim true. Theme tokens are the only source of colour. */
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(text), 'no literal hex colour anywhere in the tree')
  assert.ok(!/rgba?\(/.test(text), 'no literal rgb() colour anywhere in the tree')
  /* The page follows the application language; it must not offer its own
     language control, which would fight Settings → General → Language. */
  assert.ok(!text.includes('中文'), 'no in-page language toggle')
  assert.ok(!text.includes('"EN"'), 'no in-page language toggle')
})
test('the settings page carries an inject face, or it registers inactive', () => {
  const definition = loadClient()
  const { ctx, calls } = contextDouble()
  definition.factory(() => reactStub()).apply(ctx)

  const section = calls.registers.find((entry) => entry.options.name === 'settings.section')
  assert.ok(section !== undefined, 'the section is registered')
  /* Measured on this release: without a face the entry still appears in the slot
   * registry, but as `active: false`, and an inactive section renders nothing —
   * which is exactly the empty panel this test exists to prevent. */
  assert.equal(typeof section.options.inject, 'function', 'the registration supplies an inject face')
  assert.equal(typeof section.options.inject(), 'object', 'the face is an object, even when empty')
})

test('the section registration is owned by an effect, so it unregisters with the plugin', () => {
  const definition = loadClient()
  const { ctx, calls } = contextDouble()
  definition.factory(() => reactStub()).apply(ctx)

  assert.ok(calls.effects.some((label) => typeof label === 'string' && label.includes('settings section')),
    'the section injection is wrapped in a labelled effect')
})
