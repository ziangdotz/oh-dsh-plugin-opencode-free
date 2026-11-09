// Read-only HTTP workload: no inference, session creation, or user config edits.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createServer } from 'node:net'
import { execFileSync } from 'node:child_process'
import { spawnOwnedServer } from '../lib/local/owner.js'

const native = process.env.OPENCODE_PROBE_NATIVE ?? join(dirname(process.execPath), 'node_modules', '@opencode', 'cli', 'node_modules', '@opencode', 'cli-windows-x64', 'bin', 'opencode.exe')
const cases = [
  ['shim', process.env.OPENCODE_PROBE_SHIM ?? 'opencode', {}],
  ['native', native, {}],
  ['native-smol', native, { BUN_OPTIONS: '--smol' }],
  ['lean', native, { OPENCODE_CONFIG_CONTENT: JSON.stringify({lsp:false, enabled_providers:['opencode'], autoupdate:false, snapshot:false}), OPENCODE_DISABLE_PROJECT_CONFIG:'true', OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER:'true' }],

]
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
function snapshot (pid) {
  const script = `$rows=Get-CimInstance Win32_Process; $ids=[System.Collections.Generic.HashSet[int]]::new(); [void]$ids.Add(${pid}); do { $added=$false; foreach($row in $rows) { if($ids.Contains([int]$row.ParentProcessId) -and $ids.Add([int]$row.ProcessId)) {$added=$true} } } while($added); $items=@(Get-Process -Id @($ids) -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,@{n='WorkingSetMiB';e={[math]::Round($_.WorkingSet64/1MB,2)}},@{n='PrivateMiB';e={[math]::Round($_.PrivateMemorySize64/1MB,2)}}); @{physicalMiB=[math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory/1MB);processes=$items} | ConvertTo-Json -Depth 4 -Compress`
  return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], { windowsHide: true, timeout: 15000, encoding: 'utf8' }))
}
for (const [name, command, extra] of cases.filter(([name]) => process.argv.length < 3 || process.argv.slice(2).includes(name))) {
  const directory = name === 'lean' ? mkdtempSync(join(tmpdir(), 'opencode-lean-')) : undefined
  const reservation = createServer()
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve))
  const port = reservation.address().port
  await new Promise(resolve => reservation.close(resolve))
  const password = 'memory-probe-ephemeral'
  const owner = spawnOwnedServer(command, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: directory ?? process.cwd(),
    env: { ...process.env, OPENCODE_SERVER_PASSWORD: password, ...extra }, stdio: ['ignore', 'ignore', 'ignore'],
  })
  const url = `http://127.0.0.1:${port}/api/model`
  const probe = async (auth = false) => {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1500), headers: auth ? { authorization: `Basic ${Buffer.from('opencode:' + password).toString('base64')}` } : {} })
      const status = response.status
      await response.body?.cancel()
      return status
    } catch { return false }
  }
  try {
    let ready = false
    for (let i = 0; i < 100; i++) { if (await probe()) { ready = true; break }; await sleep(100) }
    if (!ready) throw Error(name + ' failed to start')
    await sleep(3000)
    console.log(JSON.stringify({ name, phase: 'startup-idle', ...snapshot(owner.pid) }))
    const status = await probe(true)
    await sleep(5000)
    console.log(JSON.stringify({ name, phase: 'catalog-idle', catalogStatus: status, ...snapshot(owner.pid) }))
    await sleep(15000)
    console.log(JSON.stringify({ name, phase: 'catalog-idle-20s', catalogStatus: status, ...snapshot(owner.pid) }))
  } finally {
    owner.stdin.end()
    for (let i = 0; i < 100 && await probe(); i++) await sleep(50)
    if (await probe()) throw Error(name + ' listener survived cleanup')
    if (directory) rmSync(directory, { recursive: true, force: true })
  }
}
