import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

let executable: string | undefined
function windowsOwner (): string {
  if (executable !== undefined) return executable
  const source = fileURLToPath(new URL('../../tools/server-owner.cs', import.meta.url))
  const hash = createHash('sha256').update(readFileSync(source)).digest('hex').slice(0, 20)
  const cached = join(tmpdir(), `opencode-owner-${hash}.exe`)
  if (existsSync(cached)) { executable = cached; return cached }
  const directory = mkdtempSync(join(tmpdir(), 'opencode-owner-'))
  const output = join(directory, 'owner.exe')
  const compiler = join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
  try {
    execFileSync(compiler, ['/nologo', '/target:exe', `/out:${output}`, source], {
      windowsHide: true, timeout: 15000, stdio: 'pipe',
    })
  } catch (error) {
    rmSync(directory, { recursive: true, force: true })
    throw error
  }
  try { renameSync(output, cached) } catch (error) {
    if (!existsSync(cached)) throw error // Another Host may have compiled it first.
  } finally { rmSync(directory, { recursive: true, force: true }) }
  executable = cached
  return cached
}

/** The pipe is a lifetime lease, not a keep-alive handle in the Host. */
export function spawnOwnedServer (command: string, args: string[], options: Record<string, unknown>): ChildProcess {
  let child: ChildProcess
  if (process.platform === 'win32') {
    child = spawn(windowsOwner(), [command, ...args], {
      ...options, detached: false, stdio: ['pipe', options.stdio instanceof Array ? options.stdio[1] : 'ignore', 'ignore'],
    })
  } else {
    child = spawn(process.execPath, [fileURLToPath(new URL('../../tools/server-owner.mjs', import.meta.url)), command, ...args], {
      ...options, detached: true, stdio: ['pipe', options.stdio instanceof Array ? options.stdio[1] : 'ignore', 'ignore'],
    })
  }
  child.stdin?.on('error', () => {})
  ;(child.stdin as unknown as { unref?: () => void } | null)?.unref?.()
  return child
}
