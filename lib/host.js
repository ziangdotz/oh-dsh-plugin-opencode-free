/**
 * The Host surface this plugin consumes, kept small on purpose.
 *
 * The route is served by a local `opencode serve` process, so the plugin needs
 * no credential, attachment or image seam — only the LLM registry, a logger and
 * the tools registry. Narrowing this file is what makes the rest of `src/`
 * testable with a plain object instead of a Cordis context.
 *
 * @module dsh-plugin-opencode-free/host
 */
/**
 * Log without ever letting logging break mounting.
 * @param ctx - the plugin context.
 * @param level - preferred logger level, falling back to `debug`.
 * @param message - the line to write.
 */
export function safeLog(ctx, level, message) {
    const logger = ctx?.logger;
    try {
        const write = logger?.[level] ?? logger?.debug;
        write?.call(logger, message);
    }
    catch {
        /* A diagnostics sink must not take the plugin down with it. */
    }
}
