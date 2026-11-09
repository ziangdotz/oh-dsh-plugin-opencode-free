/**
 * Test entry point: build, then run every `test/*.test.mjs` with node:test.
 *
 * The build goes through `tools/build.mjs` rather than `tsc` directly, so a
 * suite never reads output left behind by a module that no longer exists.
 *
 * An optional argument filters the files, so `npm run test -- adapter` runs the
 * wire tests alone.
 */

import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const filter = process.argv[2]

const build = spawnSync(process.execPath, [join(root, 'tools', 'build.mjs')], { stdio: 'inherit' })
if (build.status !== 0) {
  console.error('build failed; tests were not run')
  process.exit(build.status ?? 1)
}

const files = readdirSync(join(root, 'test'))
  .filter((name) => name.endsWith('.test.mjs'))
  .filter((name) => filter === undefined || name.includes(filter))
  .map((name) => join('test', name))

if (files.length === 0) {
  console.error(filter === undefined ? 'no test files found' : `no test file matches "${filter}"`)
  process.exit(1)
}

/* Each file is executed directly rather than through `node --test`: the
 * runner forks a child per file and captures its output over a pipe, which a
 * confined Windows sandbox refuses (EPERM). `node <file>` runs the same
 * `node:test` registrations in-process and still reports a failing exit code.
 *
 * `--test-force-exit` matters here: a test that touches the network leaves an
 * idle keep-alive socket behind, and a suite must end when its assertions do
 * rather than wait for the socket to time out. */
let failures = 0
const testEnv = { ...process.env }
for (const key of Object.keys(testEnv)) {
  if (key.toUpperCase() === 'OPENCODE_SERVER_PASSWORD') delete testEnv[key]
}
for (const file of files) {
  console.log(`\n== ${file} ==`)
  const run = spawnSync(process.execPath, ['--test-force-exit', file], { stdio: 'inherit', env: testEnv })
  if (run.status !== 0) failures += 1
}
if (failures > 0) {
  console.error(`\n${failures} test file(s) failed`)
  process.exit(1)
}
console.log(`\nall ${files.length} test file(s) passed`)
