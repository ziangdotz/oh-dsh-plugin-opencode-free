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
export const DEFAULT_EXCLUDED_IDS = ['test'];
/** Vendor spellings that title-casing would get wrong. */
const BRAND_NAMES = {
    deepseek: 'DeepSeek',
    mimo: 'MiMo',
    glm: 'GLM',
    gpt: 'GPT',
    nemotron: 'Nemotron',
    claude: 'Claude',
    gemini: 'Gemini',
    qwen: 'Qwen',
    minimax: 'MiniMax',
    kimi: 'Kimi',
    grok: 'Grok',
    mistral: 'Mistral',
    llama: 'Llama',
    muse: 'Muse',
    laguna: 'Laguna',
    flint: 'Flint',
    jev: 'JEV',
};
/** Short segments that read as acronyms. */
const ACRONYMS = new Set(['vl', 'ai', 'asr', 'omni']);
/**
 * Whether an id advertises the free tier.
 * @param id - a model id.
 * @returns true for ids ending in `-free`.
 */
export function isFreeModelId(id) {
    return id.toLowerCase().endsWith('-free');
}
/**
 * A readable label for an id, for surfaces that show a name.
 *
 * `deepseek-v4.1-flash-free` becomes `DeepSeek V4.1 Flash (Free)`.
 *
 * @param id - a model id.
 * @returns the label.
 */
export function displayNameOf(id) {
    const free = isFreeModelId(id);
    const base = free ? id.slice(0, -'-free'.length) : id;
    const words = base.split(/[-_]/).filter((word) => word.length > 0).map((word, index) => {
        const brand = index === 0 ? BRAND_NAMES[word.toLowerCase()] : undefined;
        if (brand !== undefined)
            return brand;
        if (ACRONYMS.has(word.toLowerCase()))
            return word.toUpperCase();
        return word.charAt(0).toUpperCase() + word.slice(1);
    });
    const label = words.join(' ');
    return free ? `${label} (Free)` : label;
}
function tokenLimit(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
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
export function parseModelListing(payload, providerID) {
    const body = payload !== null && typeof payload === 'object' && 'data' in payload
        ? payload.data
        : payload;
    const rows = Array.isArray(body)
        ? body
        : body !== null && typeof body === 'object'
            ? Object.entries(body)
                /* A map of row objects is a listing; a map of scalars (a health probe, a
                 * version object) is not, and must not become a model. */
                .filter(([, value]) => value !== null && typeof value === 'object')
                .map(([key, value]) => ({ id: key, ...value }))
            : [];
    const seen = new Set();
    const entries = [];
    for (const row of rows) {
        if (row === null || typeof row !== 'object')
            continue;
        const record = row;
        const id = typeof record.id === 'string' && record.id.length > 0
            ? record.id
            : (typeof record.modelID === 'string' ? record.modelID : undefined);
        if (id === undefined || seen.has(id))
            continue;
        const servedBy = typeof record.providerID === 'string'
            ? record.providerID
            : (typeof record.provider === 'string' ? record.provider : undefined);
        if (providerID !== undefined && servedBy !== undefined && servedBy !== providerID)
            continue;
        seen.add(id);
        const name = typeof record.name === 'string' && record.name.length > 0 ? record.name : displayNameOf(id);
        const limit = record.limit !== null && typeof record.limit === 'object'
            ? record.limit
            : {};
        const contextWindow = tokenLimit(limit.context) ?? tokenLimit(record.contextWindow) ?? tokenLimit(record.context);
        const maxTokens = tokenLimit(limit.output) ?? tokenLimit(record.maxTokens);
        entries.push({
            id,
            name,
            free: isFreeModelId(id),
            ...contextWindow === undefined ? {} : { contextWindow },
            ...maxTokens === undefined ? {} : { maxTokens },
        });
    }
    return entries;
}
/**
 * Keep only the rows a route may offer.
 *
 * @param rows - the parsed catalog.
 * @param options.includeNonFree - whether ids without a `-free` suffix stay.
 * @param options.exclude - ids that must never be offered.
 * @returns the admitted rows.
 */
export function admitCatalog(rows, options) {
    return rows.filter((row) => {
        if (options.exclude.includes(row.id))
            return false;
        return options.includeNonFree || row.free;
    });
}
