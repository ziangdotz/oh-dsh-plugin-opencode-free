import { closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

// Verify an isolated copy against the dependencies shipped by the desktop app.
const archive = resolve(process.argv[2] ?? 'C:/Tools/DeepSeek Harness/resources/app.asar')
const root = fileURLToPath(new URL('..', import.meta.url))
const target = mkdtempSync(join(tmpdir(), 'opencode-desktop-check-'))
const fd = openSync(archive, 'r')
const prefix = Buffer.alloc(16)
readSync(fd, prefix, 0, 16, 0)
const header = Buffer.alloc(prefix.readUInt32LE(12))
readSync(fd, header, 0, header.length, 16)
const tree = JSON.parse(header.toString())
const base = 8 + prefix.readUInt32LE(4)
function entryAt (path) {
  return path.split('/').reduce((entry, key) => entry.files[key], tree)
}
function bytes (entry) {
  if (entry.unpacked) return null
  const buffer = Buffer.alloc(entry.size)
  readSync(fd, buffer, 0, buffer.length, base + Number(entry.offset))
  return buffer
}
function extract (entry, path, destination) {
  if (entry.link) return extract(entryAt(entry.link), entry.link, destination)
  if (entry.files) {
    mkdirSync(destination, { recursive: true })
    for (const [name, child] of Object.entries(entry.files)) extract(child, `${path}/${name}`, join(destination, name))
    return
  }
  mkdirSync(dirname(destination), { recursive: true })
  const content = bytes(entry)
  if (content) writeFileSync(destination, content)
  else cpSync(join(`${archive}.unpacked`, path), destination)
}
const version = JSON.parse(bytes(entryAt('package.json'))).version
console.log(`Desktop ${version}, isolated workspace ${target}`)
const installed = new Set()
function install (name) {
  if (installed.has(name)) return
  installed.add(name)
  const path = `dsh/node_modules/${name}`
  const entry = entryAt(path)
  extract(entry, path, join(target, 'node_modules', name))
  const manifest = JSON.parse(bytes(entryAt(`${path}/package.json`)))
  for (const dependency of Object.keys(manifest.dependencies ?? {})) install(dependency)
  for (const dependency of Object.keys(manifest.peerDependencies ?? {})) {
    if (!manifest.peerDependenciesMeta?.[dependency]?.optional) install(dependency)
  }
}
for (const name of ['@deepseek-ai/dsh-llm', '@deepseek-ai/cordis', '@deepseek-ai/schemastery']) install(name)
closeSync(fd)
for (const name of ['typescript', '@types/node', 'undici-types']) {
  if (!existsSync(join(target, 'node_modules', name))) cpSync(join(root, 'node_modules', name), join(target, 'node_modules', name), { recursive: true })
}
for (const name of ['src', 'test', 'tools', 'package.json', 'tsconfig.json', 'client.js', 'cordis.patch.yml', 'locale', 'icon.svg']) {
  cpSync(join(root, name), join(target, name), { recursive: true })
}
for (const script of ['tools/compat-check.mjs', 'tools/run-tests.mjs']) {
  const run = spawnSync(process.execPath, [script], { cwd: target, stdio: 'inherit' })
  if (run.status !== 0) process.exit(run.status ?? 1)
}
