/**
 * `dsh-plugin-opencode-free` — the OpenCode Free provider route.
 *
 * The route is served by a local `opencode serve` process, which is the only
 * client the free tier accepts. This plugin adds what configuration alone
 * cannot: it creates a session per turn, streams the answer out of the server's
 * global event stream, filters that stream to this session, and keeps the model
 * catalog in step with what the server actually offers.
 *
 * The plugin does not speak the OpenAI wire format, and has no credential, key
 * pool or cooldown of its own: the local server brings its own identity, and a
 * password it requires is read from the row or from `OPENCODE_SERVER_PASSWORD`.
 *
 * @module dsh-plugin-opencode-free
 */
import { type RawConfig } from './config.js';
import { type PluginContext } from './host.js';
/** Package name, as the Loader reports the row. */
export declare const name = "dsh-plugin-opencode-free";
/** The plugin cannot register anything before the LLM seam exists. */
export declare const inject: string[];
export { Config } from './config.js';
/**
 * The settings namespace this plugin's surfaces edit.
 *
 * This **must equal the Cordis row id** in `cordis.patch.yml`: discovery is
 * offered for exactly this namespace, and the Models page dispatches the
 * provider card under it. Rename both together or neither.
 */
export declare const SETTINGS_NAMESPACE = "OpenCodeFree";
/**
 * The plugin entry point.
 *
 * @param ctx - the Cordis context.
 * @param config - the row's configuration.
 */
export declare function apply(ctx: PluginContext, config: RawConfig): void;
