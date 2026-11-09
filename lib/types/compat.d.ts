/**
 * The single import boundary between this plugin and the DSH runtime.
 *
 * This plugin used to borrow `PiAiAdapter` and pi-ai's protocol factories to
 * speak the OpenAI wire format. That transport is gone: a route is now served
 * by a local `opencode serve` process over its own HTTP API, so the only host
 * symbols left are the base adapter, the error type and the harness's own
 * identity headers. Keeping the boundary in one file still pays off — a DSH
 * upgrade that renames one of these is a one-file change.
 *
 * @module dsh-plugin-opencode-free/compat
 */
import z from '@deepseek-ai/schemastery';
import { attributionHeaders, LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm';
export { attributionHeaders, LlmAdapter, LlmError, z, };
export type { LlmDiscoveredModel, LlmModelDiscoveryRequest } from '@deepseek-ai/dsh-llm';
/** One blocking compatibility problem found at load time. */
export interface CompatIssue {
    point: string;
    detail: string;
}
/** The shape probe's result. Fatal problems stop route registration. */
export interface CompatReport {
    fatal: CompatIssue[];
    warnings: CompatIssue[];
}
/** Human-readable names for the seams this plugin depends on. */
export declare const COMPAT_POINTS: readonly ["dsh-llm LlmAdapter base class", "dsh-llm LlmError", "dsh-llm attribution headers", "schemastery Config schema"];
/**
 * Verify that the symbols imported from the host still exist with the shapes
 * this plugin calls. A missing import fails at module load; this catches a
 * value that loaded but is no longer usable.
 * @returns blocking problems and non-blocking warnings.
 */
export declare function checkCompat(): CompatReport;
