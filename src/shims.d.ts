/**
 * Ambient types for the modules this plugin consumes.
 *
 * The installed DSH build ships bundled `lib/index.js` files without their
 * declaration files, so the exact contracts were read from that compiled source
 * and the sibling `dsh-plugin-custom-headers` project instead (see
 * docs/ARCHITECTURE.md). These declarations describe only the symbols this
 * plugin imports; they stay loose at the boundary and precise where this plugin
 * itself depends on a shape.
 *
 * The pi-ai and `dsh-llm-pi-ai` declarations are gone with the direct transport:
 * this plugin no longer speaks the OpenAI wire format at all.
 */

declare module '@deepseek-ai/schemastery' {
  const z: any
  export default z
}

declare module '@deepseek-ai/dsh-llm' {
  /**
   * The abstract adapter every provider route implements.
   *
   * Only the members this plugin overrides or calls are declared: the runtime
   * class also carries default implementations (`prepareCall`,
   * `imageRequestTarget`, …) that a subclass inherits rather than redeclares.
   */
  export abstract class LlmAdapter {
    providerInfo (provider: string): { id: string, name: string }
    providerRetryPolicy (provider: string): unknown
    listModels (provider: string): Promise<readonly unknown[]>
    resolveModel (provider: string, model: string, signal?: AbortSignal): Promise<unknown>
    abstract stream (options: unknown): AsyncIterable<unknown>
    [key: string]: unknown
  }
  export class LlmError extends Error {
    constructor (message: string, code: string, options?: { cause?: unknown })
    readonly code: string
  }
  /** The harness's own identity headers; discovery sends them where a route sets none. */
  export function attributionHeaders (identity?: unknown): Record<string, string>
  /** One draft-provider interrogation request, as the Models page issues it. */
  export interface LlmModelDiscoveryRequest {
    provider?: string
    baseURL?: string
    api?: string
    apiKey?: string
  }
  /** One model an endpoint reports about itself. */
  export interface LlmDiscoveredModel {
    id: string
    name?: string
    contextWindow?: number
    maxTokens?: number
    inputModalities?: readonly ('text' | 'image')[]
  }
}