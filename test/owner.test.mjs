import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnOwnedServer } from '../lib/local/owner.js'

async function waitFor (predicate, timeout = 10000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
  assert.fail('process lifetime condition timed out')
}
function alive (pid) { try { process.kill(pid, 0); return true } catch { return false } }

// An exiting launcher with a detached grandchild reproduces the important
// OpenCode behavior without contacting a provider or reading user configuration.
function launcher (file) {
  return `const {spawn}=require('node:child_process'); const {writeFileSync}=require('node:fs');
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
    child.unref(); writeFileSync(${JSON.stringify(file)},String(child.pid));`
}

test('owned server tree survives launcher exit, then closes on plugin unload', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'owner-test-'))
  const file = join(directory, 'pid')
  const owner = spawnOwnedServer(process.execPath, ['-e', launcher(file)], { stdio: ['ignore', 'ignore', 'ignore'] })
  let pid
  try {
    await waitFor(() => existsSync(file))
    pid = Number(readFileSync(file, 'utf8'))
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(alive(pid), true)
    owner.stdin.end()
    await waitFor(() => !alive(pid))
  } finally {
    owner.stdin?.end()
    if (pid && alive(pid)) process.kill(pid)
    rmSync(directory, { recursive: true, force: true })
  }
})

test('abrupt Host death closes its server tree without touching unrelated processes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'owner-crash-'))
  const file = join(directory, 'pid')
  const moduleURL = pathToFileURL(join(process.cwd(), 'lib/local/owner.js')).href
  const manual = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' })
  const host = spawn(process.execPath, ['--input-type=module', '-e', `
    import {spawnOwnedServer} from ${JSON.stringify(moduleURL)};
    spawnOwnedServer(process.execPath,['-e',${JSON.stringify(launcher(file))}],{stdio:['ignore','ignore','ignore']});
    setInterval(()=>{},1000);
  `], { stdio: 'ignore' })
  let pid
  try {
    await waitFor(() => existsSync(file))
    pid = Number(readFileSync(file, 'utf8'))
    host.kill('SIGKILL')
    await waitFor(() => !alive(pid))
    assert.equal(alive(manual.pid), true)
  } finally {
    host.kill('SIGKILL')
    manual.kill('SIGKILL')
    if (pid && alive(pid)) process.kill(pid)
    rmSync(directory, { recursive: true, force: true })
  }
})
