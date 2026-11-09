/** The request fields this module reads. */
export interface SerializableRequest {
    system?: string;
    messages?: readonly unknown[];
}
/**
 * Serialize one request into the single prompt the local server accepts.
 *
 * The system prompt comes first, then every message in order, so the model sees
 * exactly the conversation DSH would have sent a native adapter.
 *
 * @param request - the harness request (`system`, `messages`).
 * @returns the prompt text; empty only when the request carried nothing.
 */
export declare function serializeConversation(request: SerializableRequest): string;
