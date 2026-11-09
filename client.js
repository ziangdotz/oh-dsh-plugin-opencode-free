/**
 * Browser half of `dsh-plugin-opencode-free`.
 *
 * Two surfaces, both in Settings: an adapter extension area on the Models page
 * card, and a page of its own that lists the models the local OpenCode server
 * serves right now.
 *
 * The visual language is the one this profile's `dsh-plugin-custom-headers`
 * plugin established, and the host's own settings pages share it:
 *   - a page is an intro (title 16/24 at weight 500, lead 14/22 tertiary) and one
 *     card surface drawn with `--dsw-alias-settings-card-*` on
 *     `--dsw-radius-xl`, padded 12×14, holding a head row of meta plus actions;
 *   - controls are 36px page buttons with a `.5px` `--dsw-alias-border-l3` edge on
 *     `--dsw-radius-md`, and 28px icon buttons, both with a `focus-visible` ring;
 *   - every state has its own line: loading, counts with the updated time, an
 *     error marked `role="alert"`, and a dashed empty state that names the
 *     command to run — never a blank area;
 *   - icons are inline SVG paths, so the page pulls in no icon package;
 *   - colours come only from `--dsw-alias-*` theme tokens, so light and dark
 *     follow the app; spacing, radii and type sizes come from the same tokens
 *     the host pages use;
 *   - every visible string goes through the Client locale service;
 *   - component-scoped CSS ships as a React element, so unmounting removes it;
 *   - registrations live inside `apply`, each owned by a labelled `ctx.effect`;
 *   - a `settings.section` registration carries an inject face — without one the
 *     entry registers but stays inactive, and an inactive section renders nothing.
 *
 * Built as a plain lazy factory: React comes from the browser module table, so
 * this file must not import or bundle React.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-opencode-free',
  factory (require) {
    const React = require('react')
    const h = React.createElement

    /** Locale namespace for this plugin's browser strings. */
    const NS = 'opencode-free'

    /** The settings namespace the Host answers discovery for; equal to the Cordis row id. */
    const SETTINGS_NS = 'OpenCodeFree'

    /** The provider route id this bundle serves. */
    const ROUTE_ID = 'opencode-free'

    /** Nav position: after the shipped pages, before the next plugin's page. */
    const SECTION_ORDER = 25

    const en = {
      'meta.title': 'OpenCode Free',
      'page.title': 'OpenCode Free',
      'page.note': 'The models this OpenCode server offers right now. Refresh to ask it again; the Host caches the answer briefly.',
      'page.counts': '{total} model(s) · {free} free',
      'page.updated': 'Updated {time}',
      'page.action.refresh': 'Refresh',
      'page.action.refreshing': 'Refreshing…',
      'page.loading': 'Loading…',
      'page.empty': 'The server reported no model. Check that `opencode serve` is running, then refresh.',
      'page.shape': 'The Host answered the model listing in a shape this page does not recognize.',
      'page.unavailable': 'Model discovery is unavailable in this DSH release.',
      'page.column.id': 'Model id',
      'page.column.name': 'Name',
      'page.column.context': 'Context',
      'page.column.output': 'Max output',
      'page.column.tier': 'Tier',
      'page.tier.free': 'free',
      'page.tier.other': 'other',
      'card.title': 'Models served',
      'card.refresh': 'Ask the server again',
      'card.localNote': 'Served by a local `opencode serve` process, which brings its own identity — there is no key to store here.',
      'card.served.count': '{total} model(s) · {free} free',
      'card.served.none': 'No model reported. Check that `opencode serve` is running.',
      'card.failed': 'Failed: {message}',
      'common.dash': '—',
    }

    const zh = {
      'meta.title': 'OpenCode Free',
      'page.title': 'OpenCode Free',
      'page.note': '本机 OpenCode 服务器当前提供的模型。点「刷新」重新询问；Host 会短暂缓存结果。',
      'page.counts': '{total} 个模型 · {free} 个免费',
      'page.updated': '更新于 {time}',
      'page.action.refresh': '刷新',
      'page.action.refreshing': '刷新中…',
      'page.loading': '加载中…',
      'page.empty': '服务器没有报告任何模型。请确认 `opencode serve` 正在运行后刷新。',
      'page.shape': 'Host 返回的模型清单格式本页无法识别。',
      'page.unavailable': '当前 DSH 版本没有提供模型发现能力。',
      'page.column.id': '模型 id',
      'page.column.name': '名称',
      'page.column.context': '上下文',
      'page.column.output': '最大输出',
      'page.column.tier': '档位',
      'page.tier.free': '免费',
      'page.tier.other': '其他',
      'card.title': '服务器提供的模型',
      'card.refresh': '向服务器重新询问',
      'card.localNote': '由本机的 `opencode serve` 进程提供，身份由服务器自带——这里没有需要保存的密钥。',
      'card.served.count': '{total} 个模型 · {free} 个免费',
      'card.served.none': '服务器没有报告任何模型。请确认 `opencode serve` 正在运行。',
      'card.failed': '失败：{message}',
      'common.dash': '—',
    }

    /**
     * Fill `{name}` placeholders.
     * @param template - the translated text.
     * @param values - replacement values.
     * @returns the text with placeholders replaced.
     */
    function fill (template, values) {
      return String(template ?? '').replace(/\{(\w+)\}/g, (whole, key) =>
        values[key] === undefined ? whole : String(values[key]))
    }

    /**
     * How long a refresh stays visibly busy.
     *
     * A warm listing is answered by the Host in a few milliseconds, so without a
     * floor the control flips back to idle before a frame paints and the click
     * looks ignored. 450 ms reads as work without feeling like waiting, and it
     * never delays the answer itself — the rows are already on screen while the
     * control keeps acknowledging the click.
     */
    const MIN_BUSY_MS = 450

    /**
     * Wait, so a minimum visible duration needs no busy loop.
     * @param ms - how long to wait.
     * @returns a promise resolved after that delay.
     */
    function sleep (ms) {
      return new Promise((resolve) => setTimeout(resolve, ms))
    }

    /**
     * The visible-text lookup for one locale service.
     * @param locale - the Client locale service, when present.
     * @returns a translate function.
     */
    function createTranslator (locale) {
      let bound
      try {
        bound = typeof locale?.bind === 'function' ? locale.bind(NS) : undefined
      } catch {
        bound = undefined
      }
      return (key) => {
        const fromService = typeof bound === 'function' ? bound(key) : undefined
        if (typeof fromService === 'string' && fromService.length > 0 && fromService !== key) return fromService
        return en[key] ?? key
      }
    }

    /**
     * Re-render when the active locale changes, so text follows a language switch.
     * @param locale - the Client locale service, when present.
     */
    function useLocaleRevision (locale) {
      const [, bump] = React.useState(0)
      React.useEffect(() => {
        if (typeof locale?.subscribe !== 'function') return undefined
        const unsubscribe = locale.subscribe(() => { bump((value) => value + 1) })
        return typeof unsubscribe === 'function' ? unsubscribe : undefined
      }, [locale])
    }

    /**
     * Read the model rows out of a discovery reply.
     *
     * A reply wrapped in an envelope (`{ models: [...] }`) must not read as "no
     * models": that failure is silent and looks like an empty catalog.
     *
     * @param reply - whatever the remote resolved to.
     * @returns the rows, or `undefined` when the shape is unrecognized.
     */
    function asRows (reply) {
      if (Array.isArray(reply)) return reply
      if (reply !== null && typeof reply === 'object') {
        for (const key of ['models', 'data', 'items', 'rows']) {
          if (Array.isArray(reply[key])) return reply[key]
        }
      }
      return undefined
    }

    /**
     * Unwrap one remote reply.
     * @param response - `{ ok, value }`, `{ ok, error }`, or a bare value.
     * @returns the value, or the refusal message.
     */
    function unwrap (response) {
      if (response === null || typeof response !== 'object') return { value: response }
      if (typeof response.ok === 'boolean') {
        return response.ok ? { value: response.value } : { error: String(response.error ?? 'the Host refused the request') }
      }
      return { value: response }
    }

    /**
     * Whether one row is a free-tier model.
     * @param row - one row of the listing.
     * @returns true when the row is free.
     */
    function isFree (row) {
      if (typeof row?.free === 'boolean') return row.free
      return String(row?.id ?? '').toLowerCase().endsWith('-free')
    }

    /**
     * A wall-clock time for the "updated" line.
     * @param stamp - the listing's timestamp, or 0 before the first answer.
     * @returns the time, or an empty string while no listing exists.
     */
    function timeOf (stamp) {
      if (stamp === 0) return ''
      try {
        return new Date(stamp).toLocaleTimeString([], { hour12: false })
      } catch {
        return ''
      }
    }

    /* Type sizes, spacing and radii are the ones the host's settings pages and
     * this profile's `dsh-plugin-custom-headers` page use; colours come only from
     * theme tokens, so light and dark follow the app instead of being hard-coded. */
    const CSS = [
      '.ocf{display:flex;flex-direction:column;gap:12px;width:100%;max-width:720px;color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px}',
      '.ocf-intro{display:flex;flex-direction:column;gap:8px}',
      '.ocf-title{margin:0;font-size:16px;font-weight:500;line-height:24px;color:var(--dsw-alias-label-primary)}',
      '.ocf-lead{margin:0;font-size:14px;line-height:22px;color:var(--dsw-alias-label-tertiary)}',
      '.ocf-card{display:flex;flex-direction:column;gap:12px;padding:12px 14px;border:.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-settings-card-fill)}',
      '.ocf-cardHead{display:flex;flex-wrap:wrap;align-items:center;gap:8px 10px;min-width:0}',
      '.ocf-summary{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
      '.ocf-actions{display:inline-flex;align-items:center;gap:8px;margin-left:auto}',
      '.ocf-button{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:36px;min-width:8.5em;padding:0 14px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:none;font:inherit;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);cursor:pointer}',
      '.ocf-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-solid)}',
      /* A busy button is disabled for input, but it must not read as unavailable:
       * dimming it was why the click looked ignored. It keeps full contrast and
       * says "working" through the progress cursor and its occupied background. */
      '.ocf-button:disabled:not([aria-busy="true"]){opacity:.4;cursor:default}',
      '.ocf-button[aria-busy="true"]{background:var(--dsw-alias-interactive-bg-hover-solid);cursor:progress}',
      '.ocf-iconButton{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:none;border-radius:var(--dsw-radius-sm);background:none;color:var(--dsw-alias-label-tertiary);cursor:pointer}',
      '.ocf-iconButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.ocf-iconButton:disabled:not([aria-busy="true"]){opacity:.4;cursor:default}',
      '.ocf-iconButton[aria-busy="true"]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);cursor:progress}',
      '.ocf-button:focus-visible,.ocf-iconButton:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}',
      '.ocf-spin{animation:ocf-rotate .9s linear infinite}',
      '@keyframes ocf-rotate{from{transform:rotate(0)}to{transform:rotate(360deg)}}',
      '@media (prefers-reduced-motion:reduce){.ocf-spin{animation:none}}',
      '.ocf-table{width:100%;border-collapse:collapse;font-size:14px;line-height:22px}',
      '.ocf-table th{padding:0 12px 8px;border-bottom:.5px solid var(--dsw-alias-border-l2);font-size:12px;font-weight:400;line-height:18px;text-align:left;color:var(--dsw-alias-label-tertiary);white-space:nowrap}',
      '.ocf-table td{padding:10px 12px;border-bottom:.5px solid var(--dsw-alias-border-l1);vertical-align:middle}',
      '.ocf-table tbody tr:last-child td{border-bottom:none}',
      '.ocf-table tbody tr:hover td{background:var(--dsw-alias-interactive-bg-hover)}',
      '.ocf-id{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:12px;line-height:18px}',
      '.ocf-num{white-space:nowrap;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
      '.ocf-tier{width:1%;white-space:nowrap}',
      '.ocf-pill{display:inline-flex;align-items:center;height:20px;padding:0 8px;border:.5px solid transparent;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2);font-size:11px;line-height:16px;white-space:nowrap}',
      '.ocf-pill--free{color:var(--dsw-alias-state-success-primary)}',
      '.ocf-pill--other{color:var(--dsw-alias-state-idle-primary)}',
      '.ocf-empty{margin:0;padding:12px;border:1px dashed var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg);font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);text-align:center}',
      '.ocf-error{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}',
      '.ocf-hint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
      '.ocf-inline{display:flex;flex-direction:column;gap:6px;min-width:0}',
      '.ocf-inlineHead{display:flex;align-items:center;gap:8px;min-width:0}',
      '.ocf-cardTitle{margin:0;font-size:14px;font-weight:500;line-height:22px;color:var(--dsw-alias-label-primary)}',
      '.ocf-inlineHead .ocf-summary{margin-left:auto;white-space:nowrap}',
      '.ocf-tableScroll{overflow-x:auto}',
    ].join('')

    /** A 14px refresh arrow, drawn inline so the page needs no icon package. */
    function IconRefresh (props) {
      return h('svg', {
        width: 14,
        height: 14,
        viewBox: '0 0 16 16',
        fill: 'none',
        'aria-hidden': 'true',
        focusable: 'false',
        className: props.spinning === true ? 'ocf-spin' : undefined,
      }, h('path', {
        d: 'M13.5 8A5.5 5.5 0 1 1 11.6 3.9M13.5 2.5v3.2h-3.2',
        stroke: 'currentColor',
        strokeWidth: '1.4',
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      }))
    }

    /**
     * The one listing both surfaces read.
     *
     * A shared hook rather than two copies: the page and the provider card must
     * not disagree about what the server serves, and the states they can be in
     * (loading, rows, no rows, refused, unrecognized shape) are the same set.
     *
     * @param discover - the injected bridge, or `undefined` on an old release.
     * @param provider - the route to ask about.
     * @returns the listing state plus a `reload` that reports the row count.
     */
    function useModelListing (discover, provider) {
      const [rows, setRows] = React.useState([])
      const [loaded, setLoaded] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [failure, setFailure] = React.useState('')
      const [shape, setShape] = React.useState(false)
      const [updatedAt, setUpdatedAt] = React.useState(0)

      const reload = React.useCallback(async (minBusyMs = MIN_BUSY_MS) => {
        if (typeof discover !== 'function') return undefined
        const floor = typeof minBusyMs === 'number' && minBusyMs >= 0 ? minBusyMs : MIN_BUSY_MS
        const startedAt = Date.now()
        setBusy(true)
        setFailure('')
        setShape(false)
        try {
          const list = asRows(await discover({ provider }))
          setLoaded(true)
          if (list === undefined) {
            /* An unrecognized reply is its own state: reading it as "no models"
               would look like an empty server instead of a changed contract. */
            setShape(true)
            setRows([])
            return 0
          }
          setRows(list)
          setUpdatedAt(Date.now())
          return list.length
        } catch (error) {
          setLoaded(true)
          setFailure(error instanceof Error ? error.message : String(error))
          return undefined
        } finally {
          /* Hold the busy state for a readable moment after a click. The answer is
           * already applied above; this only keeps the control saying "working"
           * long enough that a refresh on a warm listing visibly did something.
           * A load nobody clicked passes 0: "Loading…" is its own posture. */
          const elapsed = Date.now() - startedAt
          if (elapsed < floor) await sleep(floor - elapsed)
          setBusy(false)
        }
      }, [discover, provider])

      return { rows, loaded, busy, failure, shape, updatedAt, reload }
    }

    /**
     * One line describing what the listing holds, or its loading posture.
     * @param listing - the hook's state.
     * @param t - the translator.
     * @param countKey - which count string to use.
     * @returns the text.
     */
    function summaryOf (listing, t, countKey) {
      if (!listing.loaded) return t('page.loading')
      const free = listing.rows.filter((row) => isFree(row)).length
      const counts = listing.rows.length === 0
        ? t('card.served.none')
        : fill(t(countKey), { total: listing.rows.length, free })
      const time = timeOf(listing.updatedAt)
      return time === '' ? counts : `${counts} · ${fill(t('page.updated'), { time })}`
    }

    /**
     * The adapter extension area on one Models page card.
     *
     * The host card already draws the surface, so this block adds no border: a
     * head row with the title, the live count and one icon refresh carrying
     * `aria-label` and `title`, then the explanation line.
     *
     * @param props - the owner's card share plus this plugin's bridges.
     * @returns the card element.
     */
    function ProviderCard (props) {
      const t = props?.t ?? ((key) => en[key] ?? key)
      useLocaleRevision(props?.locale)
      const provider = props?.provider ?? {}
      const discover = props?.discover
      const available = typeof discover === 'function'
      const listing = useModelListing(discover, provider.providerId ?? ROUTE_ID)

      /* A first load nobody clicked: "Loading…" is its own posture, so it does not
       * need the click acknowledgement held open. */
      React.useEffect(() => { void listing.reload(0) }, [listing.reload])

      return h('div', { className: 'ocf', 'data-plugin': 'dsh-plugin-opencode-free' },
        h('style', null, CSS),
        h('div', { className: 'ocf-inline' },
          h('div', { className: 'ocf-inlineHead' },
            h('p', { className: 'ocf-cardTitle' }, t('card.title')),
            h('span', { className: 'ocf-summary', role: 'status', 'aria-live': 'polite' },
              summaryOf(listing, t, 'card.served.count')),
            h('button', {
              className: 'ocf-iconButton',
              type: 'button',
              'aria-label': t('card.refresh'),
              title: t('card.refresh'),
              'aria-busy': listing.busy ? 'true' : 'false',
              disabled: listing.busy || !available,
              onClick: () => { void listing.reload() },
            }, h(IconRefresh, { spinning: listing.busy }))),
          h('p', { className: 'ocf-hint' }, t('card.localNote')),
          listing.failure === ''
            ? null
            : h('p', { className: 'ocf-error', role: 'alert' }, fill(t('card.failed'), { message: listing.failure })),
          listing.shape
            ? h('p', { className: 'ocf-error', role: 'alert' }, t('page.shape'))
            : null))
    }

    /**
     * The Settings page: every model the local server offers, right now.
     *
     * Layout follows the sibling settings pages: an intro, then one card that
     * holds the count line, the refresh action and the table. The card ends with
     * the listing: the password the local server needs is not the reader's
     * business here — when a request is refused, the Host's own error names the
     * setting to fill.
     *
     * @param props - the owner's section props plus this plugin's bridges.
     * @returns the page element.
     */
    function ModelsSection (props) {
      const t = props?.t ?? ((key) => en[key] ?? key)
      useLocaleRevision(props?.locale)
      const discover = props?.discover
      const available = typeof discover === 'function'
      const listing = useModelListing(discover, ROUTE_ID)

      /* One automatic retry: a page mounted during a Host restart can ask before
       * this plugin's discovery registration is visible, and an empty first answer
       * would otherwise look like an empty catalog. */
      React.useEffect(() => {
        let cancelled = false
        let timer
        const run = async () => {
          /* Both the first load and the automatic retry are nobody's click, so
           * neither holds the busy acknowledgement open. */
          const count = await listing.reload(0)
          if (cancelled || count === undefined || count > 0) return
          timer = setTimeout(() => { void run() }, 1500)
        }
        void run()
        return () => {
          cancelled = true
          if (timer !== undefined) clearTimeout(timer)
        }
      }, [listing.reload])

      const body = listing.rows.map((row) => {
        const freeRow = isFree(row)
        const contextWindow = typeof row?.contextWindow === 'number' ? String(row.contextWindow) : t('common.dash')
        const maxTokens = typeof row?.maxTokens === 'number' ? String(row.maxTokens) : t('common.dash')
        return h('tr', { key: String(row?.id ?? '') },
          h('td', { className: 'ocf-id' }, String(row?.id ?? '')),
          h('td', null, typeof row?.name === 'string' && row.name.length > 0 ? row.name : t('common.dash')),
          h('td', { className: 'ocf-num ocf-colContext' }, contextWindow),
          h('td', { className: 'ocf-num ocf-colContext' }, maxTokens),
          h('td', { className: 'ocf-tier' },
            h('span', { className: `ocf-pill ${freeRow ? 'ocf-pill--free' : 'ocf-pill--other'}` },
              freeRow ? t('page.tier.free') : t('page.tier.other'))))
      })

      const empty = listing.loaded && listing.rows.length === 0 && listing.failure === '' && !listing.shape

      return h('div', { className: 'ocf', 'data-plugin': 'dsh-plugin-opencode-free' },
        h('style', null, CSS),
        h('div', { className: 'ocf-intro' },
          h('h2', { className: 'ocf-title' }, t('page.title')),
          h('p', { className: 'ocf-lead' }, t('page.note'))),
        h('section', { className: 'ocf-card', 'aria-busy': listing.busy ? 'true' : 'false' },
          h('div', { className: 'ocf-cardHead' },
            h('p', { className: 'ocf-summary', role: 'status', 'aria-live': 'polite' },
              summaryOf(listing, t, 'page.counts')),
            h('div', { className: 'ocf-actions' },
              h('button', {
                className: 'ocf-button',
                type: 'button',
                'aria-busy': listing.busy ? 'true' : 'false',
                disabled: listing.busy || !available,
                onClick: () => { void listing.reload() },
              },
              h(IconRefresh, { spinning: listing.busy }),
              listing.busy ? t('page.action.refreshing') : t('page.action.refresh')))),
          !available
            ? h('p', { className: 'ocf-empty' }, t('page.unavailable'))
            : null,
          listing.shape
            ? h('p', { className: 'ocf-error', role: 'alert' }, t('page.shape'))
            : null,
          listing.failure === ''
            ? null
            : h('p', { className: 'ocf-error', role: 'alert' }, fill(t('card.failed'), { message: listing.failure })),
          empty
            ? h('p', { className: 'ocf-empty' }, t('page.empty'))
            : h('div', { className: 'ocf-tableScroll' }, h('table', { className: 'ocf-table' },
              h('thead', null,
                h('tr', null,
                  h('th', { scope: 'col' }, t('page.column.id')),
                  h('th', { scope: 'col' }, t('page.column.name')),
                  h('th', { scope: 'col', className: 'ocf-colContext' }, t('page.column.context')),
                  h('th', { scope: 'col', className: 'ocf-colContext' }, t('page.column.output')),
                  h('th', { scope: 'col', className: 'ocf-tier' }, t('page.column.tier')))),
              h('tbody', null, body)))))
    }

    /** Services this browser half needs before it can run. */
    const inject = ['slots', 'locale', 'remote', 'remote.llm']

    /**
     * Mount the browser surfaces.
     * @param ctx - the browser plugin context.
     */
    function apply (ctx) {
      const locale = ctx.locale
      if (typeof locale?.register === 'function') {
        ctx.effect(() => {
          try {
            return locale.register(NS, { en, zh })
          } catch (error) {
            console.warn(`dsh-plugin-opencode-free: locale dictionaries were not registered (${error instanceof Error ? error.message : String(error)}); the pages fall back to English text.`)
            return () => {}
          }
        }, 'opencode-free: dictionaries')
      } else {
        console.warn('dsh-plugin-opencode-free: the locale service is unavailable; the page falls back to English text.')
      }

      const t = createTranslator(locale)
      const remoteLlm = ctx.remote?.llm
      if (typeof remoteLlm?.discoverModels !== 'function') {
        console.warn('dsh-plugin-opencode-free: remote.llm.discoverModels() is gone; model listing is disabled.')
      }
      const discover = typeof remoteLlm?.discoverModels === 'function'
        ? async (request) => {
            const result = unwrap(await remoteLlm.discoverModels(SETTINGS_NS, { provider: request.provider }))
            if (result.error !== undefined) throw new Error(result.error)
            return result.value
          }
        : undefined

      const bridges = { discover, locale, t }

      const Card = (props) => h(ProviderCard, { ...props, ...bridges })
      ctx.effect(() => ctx.slots.inject('settings.models.provider-card', () => ctx.slots.register({
        name: 'settings.models.provider-card',
        key: SETTINGS_NS,
      }, Card)), 'opencode-free: provider card')

      const Section = (props) => h(ModelsSection, { ...props, ...bridges })
      ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'opencode-free',
        order: SECTION_ORDER,
        /* A thunk, so the shell re-reads the label after a locale switch without
         * this plugin re-registering. The text is the product name: the settings
         * rail is narrow, and a translated label was rendered truncated. */
        label: () => 'OpenCode Free',
        locale: NS,
        /* A section needs an inject face as well as the owner props. Without one
         * the entry registers but stays `active: false`, and an inactive section
         * renders nothing at all — measured on this release. */
        inject: () => ({}),
      }, Section)), 'opencode-free: settings section')
    }

    return { inject, apply }
  },
})
