import { LlmError } from '../compat.js'

// Limits apply across adapters sharing an origin, including configuration reloads.
export const MAX_PROMPT_BYTES = 1024 * 1024
export const MAX_OUTPUT_BYTES = 2 * 1024 * 1024
export const MAX_EVENT_BYTES = 1024 * 1024
export const MAX_TOOL_BYTES = 256 * 1024
const MAX_QUEUED = 8
interface Waiter { start: () => void, cancel: () => void }
const origins = new Map<string, { busy: boolean, queue: Waiter[] }>()

/** One active turn per origin; waiting requests are bounded and cancellable. */
export function acquireTurn (origin: string, signal?: AbortSignal): Promise<() => void> {
  if (signal?.aborted) return Promise.reject(new LlmError('OpenCode queue cancelled', 'ABORTED'))
  let state = origins.get(origin)
  if (state === undefined) {
    state = { busy: false, queue: [] }
    origins.set(origin, state)
  }
  const current = state
  if (current.busy && current.queue.length >= MAX_QUEUED) {
    return Promise.reject(new LlmError('OpenCode queue is full (8 waiting turns)', 'TRANSPORT'))
  }
  return new Promise((resolve, reject) => {
    const waiter: Waiter = {
      start: () => {
        signal?.removeEventListener('abort', waiter.cancel)
        current.busy = true
        let released = false
        resolve(() => {
          if (released) return
          released = true
          const next = current.queue.shift()
          if (next !== undefined) next.start()
          else { current.busy = false; origins.delete(origin) }
        })
      },
      cancel: () => {
        const index = current.queue.indexOf(waiter)
        if (index >= 0) current.queue.splice(index, 1)
        signal?.removeEventListener('abort', waiter.cancel)
        reject(new LlmError('OpenCode queue cancelled', 'ABORTED'))
      },
    }
    if (!current.busy) waiter.start()
    else {
      current.queue.push(waiter)
      signal?.addEventListener('abort', waiter.cancel, { once: true })
    }
  })
}

export function checkBytes (text: string, limit: number, label: string): void {
  checkSize(Buffer.byteLength(text, 'utf8'), limit, label)
}

export function checkSize (bytes: number, limit: number, label: string): void {
  if (bytes > limit) {
    throw new LlmError(`OpenCode ${label} exceeds ${limit} bytes`, 'TRANSPORT')
  }
}

interface Cleanup { run: () => Promise<boolean>, warn: (message: string) => void }
interface PendingCleanup { task: Cleanup, resolve: () => void }
const cleanups: PendingCleanup[] = []
let cleaning = false

async function clean (task: Cleanup): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try { if (await task.run()) return } catch { /* Retry network failures. */ }
  }
  try { task.warn('OpenCode session cleanup failed after 3 attempts; the temporary session may remain') } catch {}
}

/** Bounded queue; overload cleans in the caller while it still holds its turn slot. */
export function scheduleCleanup (task: Cleanup): Promise<void> {
  if (cleanups.length >= 63) return clean(task)
  const completion = new Promise<void>((resolve) => cleanups.push({ task, resolve }))
  if (!cleaning) {
    cleaning = true
    void (async () => {
      try {
        while (cleanups.length > 0) {
          const next = cleanups.shift()!
          await clean(next.task)
          next.resolve()
        }
      } finally { cleaning = false }
    })()
  }
  return completion
}
