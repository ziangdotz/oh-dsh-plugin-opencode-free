import { type ChildProcess } from 'node:child_process';
/** The pipe is a lifetime lease, not a keep-alive handle in the Host. */
export declare function spawnOwnedServer(command: string, args: string[], options: Record<string, unknown>): ChildProcess;
