/**
 * Check the `opencode-free` transport against a real local OpenCode server.
 *
 * This is the step between "OpenCode is installed" and "DSH can use it": it
 * creates a session, sends one prompt through the same adapter a turn uses,
 * and prints what came back. It touches no DSH state and needs no restart, so a
 * broken endpoint contract is found here rather than inside a session.
 *
 * `opencode serve` prints `server password …` at startup and refuses requests
 * without it, so pass that value (or export `OPENCODE_SERVER_PASSWORD`):
 *
 * ```sh
 * node tools/local-smoke.mjs --password <printed password>
 * node tools/local-smoke.mjs --model glm-5.3-flash-free
 * node tools/local-smoke.mjs --serverURL http://127.0.0.1:4399
 * node tools/local-smoke.mjs --self-test         # no server needed
 * ```
 *
 * `--self-test` starts a throwaway mock on an ephemeral port and runs the same
 * path against it, so the transport can be exercised on a machine where
 * OpenCode is not running yet. The mock emits the same event names the adapter
 * reads, so a drift between the two shows up as a failing self-test.
 *
 * Not part of `npm test`: a live check must never make the suite depend on an
 * external process. The wire tests cover the protocol against a fake server.
 *
 * @module dsh-plugin-opencode-free/tools/local-smoke
 */

import { createServer } from 'node:http'
import { resolveRoute } from '../lib/config.js'
import { createLocalAdapter } from '../lib/local/adapter.js'

/** One model id to try when the caller names none. */
const DEFAULT_MODEL = 'deepseek-v4.1-flash-free'

/** The prompt this check sends; short enough to cost almost nothing. */
const DEFAULT_PROMPT = 'Reply with the single word OK.'

/** Read `--name value` pairs. */
function parseArgs (argv) {
  const args = { selfTest: argv.includes('--self-test') }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--serverURL') args.serverURL = argv[index + 1]
    if (token === '--model') args.model = argv[index + 1]
    if (token === '--password') args.password = argv[index + 1]
    if (token === '--prompt') args.prompt = argv[index + 1]
    if (token === '--timeoutMs') args.timeoutMs = Number(argv[index + 1])
  }
  return args
}

/** Build the route the adapter needs. */
function routeFor (serverURL, model, password) {
  const terminal = process.env.DSH_SMOKE_TERMINAL_MS
  const local = {
    serverURL,
    ...(password === undefined ? {} : { password }),
    ...(terminal === undefined ? {} : { terminalTimeoutMs: Number(terminal) }),
  }
  return resolveRoute('opencode-free', {
    displayName: 'OpenCode Free',
    local,
    models: [{ id: model, name: model }],
  })
}

/**
 * Run one turn through the local transport.
 *
 * @param options.serverURL - the origin to talk to.
 * @param options.model - the wire model id.
 * @param options.password - the password the server printed, when it requires one.
 * @param options.prompt - what to send.
 * @returns what happened, for the caller to print and judge.
 */
export async function runSmoke (options) {
  const route = routeFor(options.serverURL, options.model, options.password)
  const adapter = createLocalAdapter(route, route.local)
  const chunks = []
  const started = Date.now()
  for await (const chunk of adapter.stream({
    provider: route.provider,
    model: options.model,
    messages: [{ role: 'user', content: [{ type: 'text', text: options.prompt }] }],
  })) {
    chunks.push(chunk)
    if (Date.now() - started > (options.timeoutMs ?? 60000)) break
  }
  const text = chunks
    .filter((chunk) => chunk.type === 'text-delta')
    .map((chunk) => chunk.text)
    .join('')
  const finish = chunks.at(-1)
  return {
    ok: finish?.reason?.kind === 'stop' && text.length > 0,
    elapsedMs: Date.now() - started,
    text,
    finish: finish?.reason ?? { kind: 'none' },
    chunks: chunks.length,
  }
}

/** The session id the mock hands out, and the id every event it emits carries. */
const MOCK_SESSION = 'mock-session'

/**
 * The events one mock turn emits, in the shape a live server uses.
 *
 * `session.text.delta` and `session.execution.succeeded` are the names
 * `src/local/adapter.ts` listens for. An older `session.next.*` spelling stood
 * here and made `--self-test` fail silently for a whole release; the mock is now
 * written against the adapter instead of against a remembered contract.
 */
const MOCK_EVENTS = [
  ['session.text.delta', { delta: 'O' }],
  ['session.text.delta', { delta: 'K' }],
  ['session.execution.succeeded', { finish: 'stop' }],
]

/** A throwaway server implementing the endpoints this transport uses. */
async function startMock () {
  let release
  const ready = new Promise((resolve) => { release = resolve })
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (request.method === 'POST' && url.pathname === '/api/session') {
      request.resume()
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ data: { id: MOCK_SESSION } }))
      })
      return
    }
    if (request.method === 'GET' && url.pathname === '/api/model') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        data: [{ id: DEFAULT_MODEL, providerID: 'opencode', name: 'DeepSeek V4.1 Flash (Free)' }],
      }))
      return
    }
    if (request.method === 'GET' && url.pathname.endsWith('/event')) {
      void ready.then(() => {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        /* The real stream is global, so every event names its session and the
         * adapter filters on it. The mock carries the id so the filter is
         * exercised here rather than only in the wire suite. */
        for (const [type, data] of MOCK_EVENTS) {
          response.write(`data: ${JSON.stringify({ type, data: { sessionID: MOCK_SESSION, ...data } })}\n\n`)
        }
        response.end()
      })
      return
    }
    if (request.method === 'POST' && url.pathname.endsWith('/prompt')) {
      request.resume()
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end('{}')
        release()
      })
      return
    }
    if (request.method === 'POST' && url.pathname.endsWith('/generate')) {
      request.resume()
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ data: { text: 'OK' } }))
      })
      return
    }
    if (request.method === 'POST' && url.pathname.endsWith('/interrupt')) {
      request.resume()
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end('{}')
      })
      return
    }
    /* The adapter discards the throwaway session when a turn ends. */
    if (request.method === 'DELETE' && url.pathname.startsWith('/api/session/')) {
      response.writeHead(204)
      response.end()
      return
    }
    /* Anything else is a contract change and must read as one. */
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: 'the self-test mock does not implement this path' }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve) }),
  }
}

/** CLI entry. */
async function main () {
  const args = parseArgs(process.argv.slice(2))
  const model = args.model ?? DEFAULT_MODEL
  const prompt = args.prompt ?? DEFAULT_PROMPT
  let mock
  let serverURL = args.serverURL ?? 'http://127.0.0.1:4399'

  if (args.selfTest) {
    mock = await startMock()
    serverURL = mock.origin
    console.log(`self-test: started a mock OpenCode server at ${serverURL}`)
  }

  console.log(`server: ${serverURL}`)
  console.log(`model:  ${model}`)
  const password = args.password ?? process.env.OPENCODE_SERVER_PASSWORD
  console.log(`auth:   ${password === undefined ? '(none — the server will answer 401 if it requires one)' : 'basic, password supplied'}`)
  try {
    const result = await runSmoke({ serverURL, model, prompt, password, timeoutMs: args.timeoutMs })
    console.log(`elapsed: ${result.elapsedMs}ms · chunks: ${result.chunks} · finish: ${result.finish.kind}`)
    console.log(`text: ${result.text.length === 0 ? '(none)' : JSON.stringify(result.text)}`)
    if (result.finish.kind === 'error') console.log(`error: ${result.finish.failure?.message ?? '(no message)'}`)
    console.log(result.ok ? '\nresult: the local transport works' : '\nresult: the local transport did not produce a usable answer')
    process.exitCode = result.ok ? 0 : 1
  } catch (error) {
    console.log(`\nresult: the local transport failed — ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  } finally {
    if (mock !== undefined) await mock.close()
  }
}

await main()