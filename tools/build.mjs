/**
 * Build entry point: drop output whose source is gone, then compile.
 *
 * `tsc` never deletes an emitted file, and `lib/` is tracked on purpose (the
 * manifest's `main` points at `lib/index.js`, and a `github:` install copies the
 * checkout as-is). A module removed from `src/` therefore used to survive in
 * `lib/` as dead code, and the manifest's `files` list shipped it. This script
 * makes the build a function of `src/` alone.
 *
 * The clean is surgical rather than `rm -rf lib`: the profile installs this
 * checkout through a junction, so the running Host reads these same files, and
 * emptying the directory would leave it nothing to load. Only orphans — files no
 * source file maps to — are removed, and only on a successful mapping.
 *
 * Every script that compiles (`build`, `test`, `compat`) goes through this file,
 * because a compile invoked directly would skip the clean.
 *
 * @module dsh-plugin-opencode-free/tools/build
 */

import { readdirSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const source = join(root, 'src')
const output = join(root, 'lib')
/** Declaration files land outside `outDir` because tsconfig pins `declarationDir`. */
const types = join(output, 'types')

/**
 * Every file a directory tree holds, recursively.
 * @param directory - the tree to walk.
 * @returns absolute paths of the regular files found.
 */
function walk (directory) {
  let entries
  try {
    entries = readdirSync(directory, { withFileTypes: true })
  } catch {
    return []
  }
  const files = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...walk(path))
    else if (entry.isFile()) files.push(path)
  }
  return files
}

/** Source paths with their extension replaced, keyed by the emitted pair. */
const sources = walk(source).filter((path) => path.endsWith('.ts')).map((path) => relative(source, path))

/** The paths this build owns; anything else under `lib/` is an orphan. */
const expected = new Set()
for (const path of sources) {
  const stem = path.slice(0, -'.ts'.length)
  expected.add(join(output, `${stem}.js`))
  expected.add(join(types, `${stem}.d.ts`))
}

/** Paths under `lib/` that no source produces. */
const orphans = walk(output)
  .filter((path) => path.endsWith('.js') || path.endsWith('.d.ts'))
  .filter((path) => !expected.has(path))

for (const path of orphans) {
  try {
    rmSync(path, { force: true })
    console.log(`build: removed stale ${relative(root, path).split(sep).join('/')}`)
  } catch (error) {
    console.error(`build: could not remove ${relative(root, path)}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc')
const build = spawnSync(process.execPath, [tsc, '-p', join(root, 'tsconfig.json')], { stdio: 'inherit', cwd: root })
if (build.status !== 0) {
  console.error('build: tsc failed; lib/ was not updated')
  process.exit(build.status ?? 1)
}
console.log(`build: ${sources.length} source file(s) compiled to lib/`)