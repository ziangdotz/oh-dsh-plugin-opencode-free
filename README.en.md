# dsh-plugin-opencode-free

A DSH plugin for OpenCode Free models. This project designs and implements the provider routes, streaming adapter, model settings UI, server lifecycle management, and resource controls.

[简体中文](README.md) · [Documentation](docs/README.md)

## Features

- Stream text responses into DSH conversations.
- Discover, cache, and filter free models; support pinned catalogs and multiple routes.
- Manage the provider through a model settings card and a dedicated settings page.
- Start the local server on first discovery or conversation, rather than during plugin mounting.
- Keep the managed server resident with the plugin, then close it on plugin unload or DSH exit. Manually started servers remain user-managed.
- Bound concurrency, queues, and payload sizes; create a temporary session for each turn and attempt cleanup on completion.

DSH supplies the host environment and a separately installed local OpenCode Server supplies model services. Model availability and free usage allowances depend on that service.

## Installation

Requires Node.js 22+ and DSH `>=0.2.1-rc.3 <0.3.0`. See [package.json](package.json) for peer dependencies and [verification notes](docs/VERIFICATION.md) for tested host combinations and OpenCode protocol versions.

1. Install OpenCode locally and confirm that `opencode` runs in a terminal.
2. Install and register this plugin bundle in your DSH profile. Environments supporting GitHub plugin sources can use:

   ```sh
   dsh plugin add github:ziangdotz/oh-dsh-plugin-opencode-free
   ```

3. Restart DSH, open the OpenCode Free card in **Settings → Models**, and refresh the catalog before selecting a model in a conversation.

The default route is `opencode-free`, at `http://127.0.0.1:4399`. The conversation model picker does not start the server itself; use the model settings refresh on first use.

For source development, link this directory into the profile's `node_modules/dsh-plugin-opencode-free`, register the dependency in its `package.json`, and add it to `dsh.profile.bundles`. Run `npm run build` and restart DSH after updating source files.

## Configuration

The bundle includes a default configuration. Override the existing `OpenCodeFree` row in the profile's `cordis.patch.yml`; do not insert another row with the same id. The entire `config` object is replaced, so include all settings you need.

```yaml
- id: OpenCodeFree
  name: dsh-plugin-opencode-free
  config:
    routes:
      opencode-free:
        displayName: OpenCode Free
        local:
          serverURL: http://127.0.0.1:4399
          providerID: opencode
          autoStart: true
          serverCommand: opencode
    catalog:
      autoDiscover: true
      maxAgeMs: 3600000
      timeoutMs: 5000
      includeNonFree: false
```

Set `OPENCODE_SERVER_PASSWORD` in the environment that launches DSH, or configure `local.password`. Use `local.passwordEnv` for a different environment variable. Do not commit real credentials.

| Setting | Default | Purpose |
| --- | --- | --- |
| `local.serverURL` | `http://127.0.0.1:4399` | Server address |
| `local.serverCommand` | `opencode` | Executable name or absolute path |
| `local.providerID` | `opencode` | Server-side provider identifier |
| `local.autoStart` | `true` | Start the server when absent |
| `local.startTimeoutMs` | `20000` | Startup deadline in milliseconds |
| `local.promptTimeoutMs` | `10000` | Request admission deadline in milliseconds |
| `local.terminalTimeoutMs` | `120000` | Turn execution deadline in milliseconds |
| `routes.<id>.models` | Empty | Pinned models, taking precedence over discovery |
| `routes.<id>.defaultContextWindow` | `200000` | Context capacity fallback |
| `routes.<id>.defaultMaxTokens` | `32000` | Output capacity fallback |
| `catalog.autoDiscover` | `true` | Discover models; disable to use pinned models only |
| `catalog.maxAgeMs` | `3600000` | Catalog cache duration in milliseconds |
| `catalog.timeoutMs` | `5000` | Catalog request deadline in milliseconds |
| `catalog.exclude` | `["test"]` | Excluded model ids |
| `catalog.includeNonFree` | `false` | Retain models without a `-free` suffix |

Pin models with `models: [{ id: <model-id>, name: <display-name> }]`, optionally including `contextWindow` and `maxTokens`. Add distinct entries under `routes` for multiple routes. See the [profile example](examples/profile.patch.example.yml).

## Server lifecycle and memory

The plugin starts a server only when the target port has no listener. It reuses an existing service. Managed processes remain resident with the plugin and close on unload or DSH exit. Windows Job Objects own the process tree, including recovery after abrupt host termination. If the service stops, the next refresh or conversation can start it again.

Each server origin allows one active turn and eight queued turns, with cancellation while queued. UTF-8 limits are 1 MiB per prompt, 2 MiB cumulative output, 1 MiB per SSE line, and 256 KiB each for a tool result and cumulative tool metadata per turn. Oversized data fails explicitly. Session deletion gets three attempts with a one-second deadline each; exhausted cleanup is logged.

These controls bound plugin data accumulation and concurrency, rather than imposing a hard server memory limit. Local measurements with the native executable showed approximately 247–250 MiB for the idle process tree after catalog loading. This is neither a generation peak nor a guarantee for other machines. See [memory analysis](docs/MEMORY-ANALYSIS.md) for conditions and optimization estimates.

## Troubleshooting

- **Command not found:** check the PATH available to DSH, or set an absolute `local.serverCommand`.
- **No model group:** refresh in Settings → Models, then check filters and service logs.
- **Connection or authentication error:** check address, port, and password. An occupied port prevents another server from being started.
- **Manual service management:** set `local.autoStart: false`, run the following command, and keep the service running.

```powershell
$env:OPENCODE_SERVER_PASSWORD = '<your chosen password>'
opencode serve --hostname 127.0.0.1 --port 4399
```

The adapter currently returns text and does not expose DSH tool calls or forward its sandbox, approvals, or working directory. The server's own permissions and tools depend on its configuration.

## Development

```sh
npm install
npm run build
npm run check
npm test
node --check client.js
npm run local-smoke:self
npm run pack:check
```

DSH supplies runtime peer dependencies. Standalone development needs matching peers; desktop installations can use `npm run compat:desktop` for compatibility checks. Build output in `lib/` is committed, so rebuild before committing source changes.

- [Architecture](docs/ARCHITECTURE.md)
- [UI](docs/UI.md)
- [Verification](docs/VERIFICATION.md)
- [Changelog](CHANGELOG.md)

## License

[MIT](LICENSE). License and provenance notices are retained in LICENSE.
