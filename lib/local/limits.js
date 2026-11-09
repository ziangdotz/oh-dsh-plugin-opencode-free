/**
 * Capacity fallbacks for models the local server does not describe.
 *
 * The server reports ids and names, not always a context window, so a route
 * needs a number to advertise. These match what a hand-declared route in the
 * harness uses.
 *
 * @module dsh-plugin-opencode-free/local/limits
 */
/** Context window advertised for a model that declares none. */
export const DEFAULT_CONTEXT_WINDOW = 200000;
/** Output cap advertised for a model that declares none. */
export const DEFAULT_MAX_TOKENS = 32000;
/** The port this project uses when a route names no server. */
export const DEFAULT_PORT_HINT = 4399;
/** How long a freshly started server gets to answer before the start is called a failure. */
export const DEFAULT_START_TIMEOUT_MS = 20000;
/** How long one reachability probe may take. */
export const DEFAULT_PROBE_TIMEOUT_MS = 1500;
/** The executable this plugin starts when `local.autoStart` is on. */
export const DEFAULT_SERVER_COMMAND = 'opencode';
/**
 * Per-request deadline for the model listing.
 *
 * The listing is the one call a settings page or the picker makes with no turn
 * around it, so it cannot borrow a turn's budget: without a deadline a half-open
 * port — a dropped SYN, a frozen process — holds the page instead of failing it.
 */
export const DEFAULT_CATALOG_TIMEOUT_MS = 5000;
