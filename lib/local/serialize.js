import { checkBytes, checkSize, MAX_PROMPT_BYTES } from './resources.js';
/**
 * Render one content block as prompt text.
 * @param block - a content block from a request message.
 * @returns the text it contributes, or an empty string when it contributes none.
 */
function blockText(block) {
    switch (block?.type) {
        case 'text':
            return typeof block.text === 'string' ? block.text : '';
        case 'image': {
            const mediaType = typeof block.attachment?.mediaType === 'string' ? block.attachment.mediaType : 'image';
            return `[image: ${mediaType}]`;
        }
        case 'file': {
            const name = typeof block.attachment?.name === 'string' ? block.attachment.name : 'file';
            return `[file: ${name}]`;
        }
        case 'tool-call': {
            const name = typeof block.name === 'string' ? block.name : 'tool';
            const args = typeof block.arguments === 'string' ? block.arguments : '';
            return `[tool call] ${name} ${args}`.trimEnd();
        }
        default:
            /* `reasoning`, `tool-addition`, `tool-removal` and anything newer are not
             * conversation the next turn needs. */
            return '';
    }
}
/**
 * Render one message as a labelled section.
 * @param message - a request message.
 * @returns its prompt text, or an empty string when it carries no text.
 */
function messageText(message) {
    const content = Array.isArray(message?.content) ? message.content : [];
    const parts = [];
    let bytes = 0;
    for (const block of content) {
        const part = blockText(block);
        bytes += Buffer.byteLength(part) + 1;
        checkBytes(part, MAX_PROMPT_BYTES, 'prompt block');
        checkSize(bytes, MAX_PROMPT_BYTES, 'prompt; compact the conversation');
        if (part.length > 0)
            parts.push(part);
    }
    const body = parts.join('\n').trim();
    if (body.length === 0)
        return '';
    switch (message.role) {
        case 'system':
            return `[System]\n${body}`;
        case 'developer':
            return `[Developer]\n${body}`;
        case 'user':
            return `[User]\n${body}`;
        case 'assistant':
            return `[Assistant]\n${body}`;
        case 'tool':
            return `[Tool result${message.isError === true ? ' (error)' : ''}]\n${body}`;
        default:
            return body;
    }
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
export function serializeConversation(request) {
    const parts = [];
    let bytes = 0;
    if (typeof request.system === 'string' && request.system.length > 0) {
        checkBytes(request.system, MAX_PROMPT_BYTES - 10, 'system prompt');
        parts.push(`[System]\n${request.system}`);
        bytes = Buffer.byteLength(parts[0]);
    }
    for (const message of request.messages ?? []) {
        const rendered = messageText(message);
        bytes += Buffer.byteLength(rendered) + 2;
        checkSize(bytes, MAX_PROMPT_BYTES, 'prompt; compact the conversation');
        if (rendered.length > 0)
            parts.push(rendered);
    }
    const prompt = parts.join('\n\n');
    checkBytes(prompt, MAX_PROMPT_BYTES, 'prompt; shorten or compact the conversation');
    return prompt;
}
