/**
 * Static compatibility report.
 *
 * This plugin drives a local `opencode serve` process over HTTP, so it borrows
 * only a handful of Host symbols — some of which are not a public contract. A
 * DSH upgrade can therefore break the plugin without changing anything it
 * imports by name. `checkCompat()` in
 * `src/compat.ts` probes the loaded shapes at mount time; this script prints
 * the same information before a session is opened, so an upgrade can be
 * triaged without reading Host logs.
 *
 * Usage: node tools/compat-check.mjs [--json]
 */

import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const asJson = process.argv.includes('--json')

/** Build `lib/` so the probe reads this checkout's own build, orphans removed. */
function build () {
  const run = spawnSync(process.execPath, [fileURLToPath(new URL('./build.mjs', import.meta.url))], {
    stdio: asJson ? ['ignore', 2, 2] : 'inherit',
  })
  if (run.status !== 0) {
    console.error('compat-check: build failed')
    process.exit(1)
  }
}

/**
 * Read the version of one installed package without importing it.
 * @param {string} specifier - any specifier the package exports.
 * @returns {string} the version, or `unknown`.
 */
function versionOf (specifier) {
  let resolved
  try {
    resolved = fileURLToPath(import.meta.resolve(specifier))
  } catch {
    try {
      resolved = require.resolve(specifier)
    } catch {
      return 'unknown'
    }
  }
  let directory = resolved
  while (directory.length > 0) {
    const candidate = join(directory, 'package.json')
    if (existsSync(candidate)) {
      const manifest = JSON.parse(readFileSync(candidate, 'utf8'))
      if (typeof manifest.version === 'string') return manifest.version
    }
    const parent = join(directory, '..')
    if (parent === directory) break
    directory = parent
  }
  return 'unknown'
}

if (existsSync(new URL('../src/index.ts', import.meta.url))) build()

const { checkCompat, COMPAT_POINTS } = await import('../lib/compat.js')
const report = checkCompat()

const packages = [
  ['@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-llm/package.json'],
  ['@deepseek-ai/cordis', '@deepseek-ai/cordis/package.json'],
  ['@deepseek-ai/schemastery', '@deepseek-ai/schemastery/package.json'],
].map(([name, specifier]) => ({ name, version: versionOf(specifier) }))

if (asJson) {
  console.log(JSON.stringify({ ok: report.fatal.length === 0, packages, probe: report }, null, 2))
} else {
  console.log('runtime packages this plugin is built against:')
  for (const entry of packages) console.log(`  ${entry.name.padEnd(36)} ${entry.version}`)
  console.log(`\nshape probe (${COMPAT_POINTS.length} seams):`)
  if (report.fatal.length === 0 && report.warnings.length === 0) {
    console.log('  every seam is present')
  }
  for (const issue of report.fatal) console.log(`  FATAL   ${issue.point} ${issue.detail}`)
  for (const issue of report.warnings) console.log(`  warn    ${issue.point} ${issue.detail}`)
  console.log(report.fatal.length === 0
    ? '\nresult: compatible — routes may register'
    : '\nresult: INCOMPATIBLE — port src/compat.ts to this DSH release')
}

process.exit(report.fatal.length === 0 ? 0 : 1)
