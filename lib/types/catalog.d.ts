/**
 * The model catalog of the local OpenCode server.
 *
 * This plugin used to carry a seed list and a gateway listing because it talked
 * to the Zen endpoint directly. With the direct transport gone, the catalog has
 * one source of truth: the server itself, through `GET /api/model`. Only the
 * display-name helper survives, and only for a label on a row the server
 * already named.
 *
 * @module dsh-plugin-opencode-free/catalog
 */
/** Ids a listing includes but no session should ever select. */
export declare const DEFAULT_EXCLUDED_IDS: readonly ["test"];
/** One catalog row, as the settings page and the picker both see it. */
export interface CatalogEntry {
    id: string;
    name: string;
    /** `true` when the id advertises the provider's free tier. */
    free: boolean;
    contextWindow?: number;
    maxTokens?: number;
}
/**
 * Whether an id advertises the free tier.
 * @param id - a model id.
 * @returns true for ids ending in `-free`.
 */
export declare function isFreeModelId(id: string): boolean;
/**
 * A readable label for an id, for surfaces that show a name.
 *
 * `deepseek-v4.1-flash-free` becomes `DeepSeek V4.1 Flash (Free)`.
 *
 * @param id - a model id.
 * @returns the label.
 */
export declare function displayNameOf(id: string): string;
/**
 * Normalize one `GET /api/model` payload into catalog rows.
 *
 * The live server answers `{ data: [ { id, providerID, name?, ... } ] }`; older
 * shapes wrap rows in `{ models: … }` or key them by id. All three are accepted
 * so a server upgrade does not empty the picker, and anything unrecognizable
 * yields no rows rather than a wrong one.
 *
 * @param payload - parsed JSON from the endpoint.
 * @param providerID - when given, keep only rows this provider serves.
 * @returns the rows, de-duplicated by id, in the order the server listed them.
 */
export declare function parseModelListing(payload: unknown, providerID?: string): CatalogEntry[];
/**
 * Keep only the rows a route may offer.
 *
 * @param rows - the parsed catalog.
 * @param options.includeNonFree - whether ids without a `-free` suffix stay.
 * @param options.exclude - ids that must never be offered.
 * @returns the admitted rows.
 */
export declare function admitCatalog(rows: readonly CatalogEntry[], options: {
    includeNonFree: boolean;
    exclude: readonly string[];
}): CatalogEntry[];
