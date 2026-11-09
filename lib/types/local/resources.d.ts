export declare const MAX_PROMPT_BYTES: number;
export declare const MAX_OUTPUT_BYTES: number;
export declare const MAX_EVENT_BYTES: number;
export declare const MAX_TOOL_BYTES: number;
/** One active turn per origin; waiting requests are bounded and cancellable. */
export declare function acquireTurn(origin: string, signal?: AbortSignal): Promise<() => void>;
export declare function checkBytes(text: string, limit: number, label: string): void;
export declare function checkSize(bytes: number, limit: number, label: string): void;
interface Cleanup {
    run: () => Promise<boolean>;
    warn: (message: string) => void;
}
/** Bounded queue; overload cleans in the caller while it still holds its turn slot. */
export declare function scheduleCleanup(task: Cleanup): Promise<void>;
export {};
